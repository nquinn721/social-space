//! Makes profile pictures with ComfyUI running on this computer.
//! Requests go only to loopback addresses, so prompts and images never leave the device.
//! Two looks are offered: "fast" (an SDXL checkpoint) and "detailed" (Qwen-Image).
//! Refining starts from an earlier generated picture (image to image), never from an
//! arbitrary photo, so the feature cannot be pointed at a real person's face.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::Manager;

const STATUS_TIMEOUT: Duration = Duration::from_secs(5);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);
/// Qwen-Image on a 12 GB laptop GPU can take several minutes, the first run longest.
const GENERATE_TIMEOUT: Duration = Duration::from_secs(20 * 60);
const POLL_INTERVAL: Duration = Duration::from_millis(1_000);
const IMAGE_FOLDER: &str = "profile-images";
const SAVE_PREFIX: &str = "socialspace/profile";
const IMAGE_SIZE: u32 = 1024;
const MAX_PROMPT_CHARS: usize = 2_000;
const MAX_IMAGE_BYTES: usize = 16 * 1024 * 1024;
const DEFAULT_REFINE_STRENGTH: f64 = 0.5;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Look {
    Fast,
    Detailed,
}

/// The model files ComfyUI reported, picked per look.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
struct Models {
    checkpoint: Option<String>,
    qwen_unet: Option<String>,
    qwen_clip: Option<String>,
    qwen_vae: Option<String>,
}

impl Models {
    fn looks(&self) -> Vec<Look> {
        let mut looks = Vec::new();
        if self.checkpoint.is_some() {
            looks.push(Look::Fast);
        }
        if self.qwen_unet.is_some() && self.qwen_clip.is_some() && self.qwen_vae.is_some() {
            looks.push(Look::Detailed);
        }
        looks
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageAiStatus {
    running: bool,
    looks: Vec<Look>,
    can_start: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImageRequest {
    base_url: String,
    prompt: String,
    #[serde(default)]
    negative: String,
    look: Look,
    seed: Option<u64>,
    /// An earlier generated picture to refine.
    source_path: Option<String>,
    /// How much refining may change it, 0.1 to 0.9.
    strength: Option<f64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneratedImage {
    path: String,
    seed: u64,
    preview: String,
}

fn local_base(base_url: &str) -> Result<url::Url, String> {
    let mut url: url::Url = base_url
        .trim()
        .parse()
        .map_err(|_| "Enter a valid ComfyUI address, like http://127.0.0.1:8188.")?;
    let local = match url.host() {
        Some(url::Host::Domain(host)) => host.eq_ignore_ascii_case("localhost"),
        Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
        Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
        None => false,
    };
    if !matches!(url.scheme(), "http" | "https")
        || !local
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("Image generation only connects to ComfyUI running on this computer.".into());
    }
    url.set_query(None);
    url.set_fragment(None);
    if !url.path().ends_with('/') {
        let path = format!("{}/", url.path());
        url.set_path(&path);
    }
    Ok(url)
}

fn endpoint(base_url: &str, path: &str) -> Result<url::Url, String> {
    local_base(base_url)?
        .join(path)
        .map_err(|_| "Invalid ComfyUI address.".into())
}

fn client(timeout: Duration) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(timeout)
        .no_proxy()
        .build()
        .map_err(|_| "Could not prepare the ComfyUI connection.".into())
}

fn unreachable(_: reqwest::Error) -> String {
    "Could not reach ComfyUI. Press Start ComfyUI, or open Comfy Desktop.".into()
}

async fn get_json(http: &reqwest::Client, url: url::Url) -> Result<Value, String> {
    let response = http.get(url).send().await.map_err(unreachable)?;
    if !response.status().is_success() {
        return Err(format!("ComfyUI returned an error ({}).", response.status()));
    }
    response
        .json()
        .await
        .map_err(|_| "ComfyUI sent an unexpected reply.".into())
}

fn names(value: &Value) -> Vec<String> {
    value
        .as_array()
        .map(|items| items.iter().filter_map(|item| item.as_str().map(str::to_owned)).collect())
        .unwrap_or_default()
}

fn pick(files: &[String], wanted: &[&str], avoid: &[&str]) -> Option<String> {
    files
        .iter()
        .find(|file| {
            let lower = file.to_ascii_lowercase();
            wanted.iter().all(|part| lower.contains(part)) && !avoid.iter().any(|part| lower.contains(part))
        })
        .cloned()
}

fn choose_models(checkpoints: &[String], unets: &[String], clips: &[String], vaes: &[String]) -> Models {
    let checkpoint = pick(checkpoints, &["xl"], &["refiner", "3d", "inpaint", "turbo_video"])
        .or_else(|| pick(checkpoints, &[], &["refiner", "3d", "inpaint", "video", "svd"]));
    Models {
        checkpoint,
        qwen_unet: pick(unets, &["qwen_image"], &["edit", "layered", "control"]),
        qwen_clip: pick(clips, &["qwen_2.5_vl"], &[]),
        qwen_vae: pick(vaes, &["qwen_image_vae"], &[]),
    }
}

async fn models(http: &reqwest::Client, base_url: &str) -> Result<Models, String> {
    let list = |folder: &str| endpoint(base_url, &format!("models/{folder}"));
    let checkpoints = names(&get_json(http, list("checkpoints")?).await?);
    let unets = names(&get_json(http, list("diffusion_models")?).await.unwrap_or_default());
    let clips = names(&get_json(http, list("text_encoders")?).await.unwrap_or_default());
    let vaes = names(&get_json(http, list("vae")?).await.unwrap_or_default());
    Ok(choose_models(&checkpoints, &unets, &clips, &vaes))
}

/// Builds the ComfyUI API graph for one picture. `source` is an uploaded input image to refine.
fn workflow(look: Look, models: &Models, prompt: &str, negative: &str, seed: u64, source: Option<&str>, strength: f64) -> Result<Value, String> {
    let missing = || "That model is not installed in ComfyUI.".to_string();
    let denoise = if source.is_some() { strength } else { 1.0 };
    let mut graph = match look {
        Look::Fast => json!({
            "1": { "class_type": "CheckpointLoaderSimple", "inputs": { "ckpt_name": models.checkpoint.as_ref().ok_or_else(missing)? } },
            "2": { "class_type": "CLIPTextEncode", "inputs": { "text": prompt, "clip": ["1", 1] } },
            "3": { "class_type": "CLIPTextEncode", "inputs": { "text": negative, "clip": ["1", 1] } },
            "5": { "class_type": "KSampler", "inputs": { "seed": seed, "steps": 30, "cfg": 6.0, "sampler_name": "dpmpp_2m", "scheduler": "karras", "denoise": denoise, "model": ["1", 0], "positive": ["2", 0], "negative": ["3", 0], "latent_image": ["4", 0] } },
            "6": { "class_type": "VAEDecode", "inputs": { "samples": ["5", 0], "vae": ["1", 2] } },
        }),
        Look::Detailed => json!({
            "1": { "class_type": "UNETLoader", "inputs": { "unet_name": models.qwen_unet.as_ref().ok_or_else(missing)?, "weight_dtype": "default" } },
            "9": { "class_type": "ModelSamplingAuraFlow", "inputs": { "model": ["1", 0], "shift": 3.1 } },
            "10": { "class_type": "CLIPLoader", "inputs": { "clip_name": models.qwen_clip.as_ref().ok_or_else(missing)?, "type": "qwen_image", "device": "default" } },
            "11": { "class_type": "VAELoader", "inputs": { "vae_name": models.qwen_vae.as_ref().ok_or_else(missing)? } },
            "2": { "class_type": "CLIPTextEncode", "inputs": { "text": prompt, "clip": ["10", 0] } },
            "3": { "class_type": "CLIPTextEncode", "inputs": { "text": negative, "clip": ["10", 0] } },
            "5": { "class_type": "KSampler", "inputs": { "seed": seed, "steps": 20, "cfg": 2.5, "sampler_name": "euler", "scheduler": "simple", "denoise": denoise, "model": ["9", 0], "positive": ["2", 0], "negative": ["3", 0], "latent_image": ["4", 0] } },
            "6": { "class_type": "VAEDecode", "inputs": { "samples": ["5", 0], "vae": ["11", 0] } },
        }),
    };
    let vae = match look { Look::Fast => json!(["1", 2]), Look::Detailed => json!(["11", 0]) };
    graph["4"] = match source {
        Some(image) => {
            graph["8"] = json!({ "class_type": "LoadImage", "inputs": { "image": image } });
            json!({ "class_type": "VAEEncode", "inputs": { "pixels": ["8", 0], "vae": vae } })
        }
        None => json!({ "class_type": match look { Look::Fast => "EmptyLatentImage", Look::Detailed => "EmptySD3LatentImage" }, "inputs": { "width": IMAGE_SIZE, "height": IMAGE_SIZE, "batch_size": 1 } }),
    };
    graph["7"] = json!({ "class_type": "SaveImage", "inputs": { "filename_prefix": SAVE_PREFIX, "images": ["6", 0] } });
    Ok(graph)
}

fn image_folder(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|path| path.join(IMAGE_FOLDER))
        .map_err(|_| "Could not locate the app data folder.".into())
}

/// Only pictures this feature made can be refined.
fn generated_source(folder: &Path, path: &str) -> Result<PathBuf, String> {
    let wrong = || "Only generated pictures can be refined.".to_string();
    let file = Path::new(path).canonicalize().map_err(|_| wrong())?;
    let folder = folder.canonicalize().map_err(|_| wrong())?;
    if file.parent() != Some(folder.as_path()) || file.extension().and_then(|ext| ext.to_str()) != Some("png") {
        return Err(wrong());
    }
    Ok(file)
}

fn random_seed() -> u64 {
    let mut bytes = [0u8; 8];
    let _ = getrandom::fill(&mut bytes);
    // ComfyUI accepts seeds up to 2^64 - 1, but JavaScript numbers are exact only to 2^53.
    u64::from_le_bytes(bytes) & ((1 << 53) - 1)
}

fn clean_text(text: &str) -> String {
    text.chars().filter(|c| !c.is_control() || *c == '\n').take(MAX_PROMPT_CHARS).collect::<String>().trim().to_owned()
}

/// Reads ComfyUI's error for a rejected prompt into one readable line.
fn prompt_error(body: &Value) -> String {
    let base = body["error"]["message"].as_str().unwrap_or("ComfyUI rejected the request.");
    let detail = body["node_errors"]
        .as_object()
        .and_then(|nodes| nodes.values().next())
        .and_then(|node| node["errors"].get(0))
        .and_then(|error| error["details"].as_str().or(error["message"].as_str()));
    match detail {
        Some(detail) if !detail.is_empty() => format!("{base} {detail}"),
        _ => base.to_owned(),
    }
}

async fn upload(http: &reqwest::Client, base_url: &str, file: &Path) -> Result<String, String> {
    let bytes = std::fs::read(file).map_err(|_| "Could not read the picture to refine.")?;
    let name = file.file_name().and_then(|name| name.to_str()).unwrap_or("socialspace.png").to_owned();
    let part = reqwest::multipart::Part::bytes(bytes)
        .file_name(name)
        .mime_str("image/png")
        .map_err(|_| "Could not prepare the picture.")?;
    let form = reqwest::multipart::Form::new()
        .part("image", part)
        .text("type", "input")
        .text("subfolder", "socialspace")
        .text("overwrite", "true");
    let response = http
        .post(endpoint(base_url, "upload/image")?)
        .multipart(form)
        .send()
        .await
        .map_err(unreachable)?;
    if !response.status().is_success() {
        return Err("ComfyUI did not accept the picture to refine.".into());
    }
    let body: Value = response.json().await.map_err(|_| "ComfyUI sent an unexpected reply.")?;
    let name = body["name"].as_str().ok_or("ComfyUI sent an unexpected reply.")?;
    Ok(match body["subfolder"].as_str() {
        Some(sub) if !sub.is_empty() => format!("{sub}/{name}"),
        _ => name.to_owned(),
    })
}

/// Waits for the queued prompt and returns the saved picture's location.
async fn wait_for_image(http: &reqwest::Client, base_url: &str, prompt_id: &str) -> Result<Value, String> {
    let started = Instant::now();
    let url = endpoint(base_url, &format!("history/{prompt_id}"))?;
    loop {
        if started.elapsed() > GENERATE_TIMEOUT {
            return Err("ComfyUI took too long. Try the Fast look.".into());
        }
        tokio::time::sleep(POLL_INTERVAL).await;
        let history = get_json(http, url.clone()).await?;
        let Some(entry) = history.get(prompt_id) else { continue };
        if entry["status"]["status_str"].as_str() == Some("error") {
            let message = entry["status"]["messages"]
                .as_array()
                .and_then(|messages| messages.iter().find(|item| item[0] == "execution_error"))
                .and_then(|item| item[1]["exception_message"].as_str())
                .unwrap_or("unknown error");
            return Err(format!("ComfyUI could not make the picture: {}", message.trim()));
        }
        if let Some(image) = entry["outputs"]["7"]["images"].get(0) {
            return Ok(image.clone());
        }
        if entry["status"]["completed"].as_bool() == Some(true) {
            return Err("ComfyUI finished without a picture.".into());
        }
    }
}

#[tauri::command]
pub async fn image_ai_status(base_url: String) -> Result<ImageAiStatus, String> {
    let can_start = find_installation().is_some();
    let http = client(STATUS_TIMEOUT)?;
    if get_json(&http, endpoint(&base_url, "system_stats")?).await.is_err() {
        return Ok(ImageAiStatus { running: false, looks: Vec::new(), can_start });
    }
    let looks = models(&http, &base_url).await.map(|found| found.looks()).unwrap_or_default();
    Ok(ImageAiStatus { running: true, looks, can_start })
}

#[tauri::command]
pub async fn generate_profile_image(app: tauri::AppHandle, request: ImageRequest) -> Result<GeneratedImage, String> {
    let prompt = clean_text(&request.prompt);
    if prompt.is_empty() {
        return Err("Describe the picture first.".into());
    }
    let negative = clean_text(&request.negative);
    let seed = request.seed.unwrap_or_else(random_seed);
    let strength = request.strength.unwrap_or(DEFAULT_REFINE_STRENGTH).clamp(0.1, 0.9);
    let folder = image_folder(&app)?;
    let http = client(REQUEST_TIMEOUT)?;
    let found = models(&http, &request.base_url).await?;
    let source = match request.source_path.as_deref().filter(|path| !path.is_empty()) {
        Some(path) => Some(upload(&http, &request.base_url, &generated_source(&folder, path)?).await?),
        None => None,
    };
    let graph = workflow(request.look, &found, &prompt, &negative, seed, source.as_deref(), strength)?;
    let response = http
        .post(endpoint(&request.base_url, "prompt")?)
        .json(&json!({ "prompt": graph, "client_id": "socialspace" }))
        .send()
        .await
        .map_err(unreachable)?;
    let ok = response.status().is_success();
    let body: Value = response.json().await.map_err(|_| "ComfyUI sent an unexpected reply.")?;
    if !ok {
        return Err(prompt_error(&body));
    }
    let prompt_id = body["prompt_id"].as_str().ok_or("ComfyUI did not queue the picture.")?.to_owned();
    let image = wait_for_image(&http, &request.base_url, &prompt_id).await?;
    let mut view = endpoint(&request.base_url, "view")?;
    view.query_pairs_mut()
        .append_pair("filename", image["filename"].as_str().unwrap_or_default())
        .append_pair("subfolder", image["subfolder"].as_str().unwrap_or_default())
        .append_pair("type", image["type"].as_str().unwrap_or("output"));
    let bytes = http.get(view).send().await.map_err(unreachable)?.bytes().await.map_err(unreachable)?;
    if bytes.is_empty() || bytes.len() > MAX_IMAGE_BYTES || !bytes.starts_with(b"\x89PNG") {
        return Err("ComfyUI sent a picture that could not be read.".into());
    }
    std::fs::create_dir_all(&folder).map_err(|_| "Could not create the pictures folder.")?;
    let path = folder.join(format!("profile-{}-{seed}.png", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|time| time.as_millis()).unwrap_or_default()));
    std::fs::write(&path, &bytes).map_err(|_| "Could not save the picture.")?;
    Ok(GeneratedImage {
        path: path.to_string_lossy().into_owned(),
        seed,
        preview: format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(&bytes)),
    })
}

/// A ComfyUI install found on disk and how to run it without its window.
#[derive(Debug, Clone, PartialEq)]
struct Installation {
    python: PathBuf,
    working_dir: PathBuf,
    args: Vec<String>,
}

/// Looks for Comfy Desktop's install first, then a portable ComfyUI with a .venv in Documents.
fn find_installation() -> Option<Installation> {
    let appdata = PathBuf::from(std::env::var_os("APPDATA")?);
    let desktop = appdata.join("Comfy Desktop");
    if let Some(found) = desktop_installation(&desktop) {
        return Some(found);
    }
    let documents = PathBuf::from(std::env::var_os("USERPROFILE")?).join("Documents").join("ComfyUI");
    let python = documents.join(".venv").join("Scripts").join("python.exe");
    (python.is_file() && documents.join("main.py").is_file()).then(|| Installation {
        python,
        working_dir: documents.clone(),
        args: vec!["-s".into(), "main.py".into()],
    })
}

fn desktop_installation(desktop: &Path) -> Option<Installation> {
    let read = |name: &str| -> Option<Value> { serde_json::from_slice(&std::fs::read(desktop.join(name)).ok()?).ok() };
    let installs = read("installations.json")?;
    let preferred = read("last-session.json").and_then(|session| session["installationId"].as_str().map(str::to_owned));
    let settings = read("settings.json").unwrap_or(Value::Null);
    let list = installs.as_array()?;
    let ordered = list
        .iter()
        .filter(|item| preferred.as_deref() == item["id"].as_str())
        .chain(list.iter());
    for item in ordered {
        let (Some(id), Some(root)) = (item["id"].as_str(), item["installPath"].as_str()) else { continue };
        let root = PathBuf::from(root);
        let python = root.join("ComfyUI").join(".venv").join("Scripts").join("python.exe");
        if !python.is_file() || !root.join("ComfyUI").join("main.py").is_file() {
            continue;
        }
        let mut args = vec!["-s".to_string(), "ComfyUI\\main.py".to_string()];
        let paths = desktop.join("instance-model-paths").join(format!("{id}.yaml"));
        if paths.is_file() {
            args.extend(["--extra-model-paths-config".into(), paths.to_string_lossy().into_owned()]);
        }
        for (flag, key) in [("--input-directory", "inputDir"), ("--output-directory", "outputDir")] {
            if let Some(dir) = settings[key].as_str() {
                args.extend([flag.to_string(), dir.to_string()]);
            }
        }
        return Some(Installation { python, working_dir: root, args });
    }
    None
}

/// Starts the installed ComfyUI in the background on the address's port.
#[tauri::command]
pub async fn start_image_ai(base_url: String) -> Result<(), String> {
    let base = local_base(&base_url)?;
    let port = base.port_or_known_default().unwrap_or(8188);
    let install = find_installation().ok_or("ComfyUI is not installed. Install Comfy Desktop from comfy.org, then try again.")?;
    let mut command = std::process::Command::new(&install.python);
    command
        .current_dir(&install.working_dir)
        .args(&install.args)
        .args(["--listen", "127.0.0.1", "--port", &port.to_string()])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command.spawn().map_err(|_| "Could not start ComfyUI.")?;
    // Wait until it answers, so the caller can refresh straight away.
    let http = client(STATUS_TIMEOUT)?;
    let started = Instant::now();
    while started.elapsed() < Duration::from_secs(180) {
        tokio::time::sleep(Duration::from_secs(2)).await;
        if get_json(&http, base.join("system_stats").map_err(|_| "Invalid address.")?).await.is_ok() {
            return Ok(());
        }
    }
    Err("ComfyUI is still starting. Wait a moment, then press Check.".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strings(items: &[&str]) -> Vec<String> {
        items.iter().map(|item| item.to_string()).collect()
    }

    fn all_models() -> Models {
        choose_models(
            &strings(&["hunyuan3d-dit-v2_fp16.safetensors", "sd_xl_base_1.0.safetensors"]),
            &strings(&["wan2.2_i2v.safetensors", "qwen_image_edit.safetensors", "qwen_image_2512_fp8_e4m3fn.safetensors"]),
            &strings(&["umt5_xxl.safetensors", "qwen_2.5_vl_7b_fp8_scaled.safetensors"]),
            &strings(&["wan_2.1_vae.safetensors", "qwen_image_vae.safetensors"]),
        )
    }

    #[test]
    fn picks_sdxl_and_qwen_image_files() {
        let models = all_models();
        assert_eq!(models.checkpoint.as_deref(), Some("sd_xl_base_1.0.safetensors"));
        assert_eq!(models.qwen_unet.as_deref(), Some("qwen_image_2512_fp8_e4m3fn.safetensors"));
        assert_eq!(models.qwen_clip.as_deref(), Some("qwen_2.5_vl_7b_fp8_scaled.safetensors"));
        assert_eq!(models.qwen_vae.as_deref(), Some("qwen_image_vae.safetensors"));
        assert_eq!(models.looks(), vec![Look::Fast, Look::Detailed]);
        assert_eq!(choose_models(&[], &[], &[], &[]).looks(), Vec::<Look>::new());
    }

    #[test]
    fn builds_text_to_image_and_refine_graphs() {
        let models = all_models();
        let fresh = workflow(Look::Fast, &models, "a portrait", "blurry", 7, None, 0.5).unwrap();
        assert_eq!(fresh["4"]["class_type"], "EmptyLatentImage");
        assert_eq!(fresh["5"]["inputs"]["denoise"], 1.0);
        assert_eq!(fresh["5"]["inputs"]["seed"], 7);
        assert!(fresh.get("8").is_none());
        let refined = workflow(Look::Detailed, &models, "a portrait", "", 7, Some("socialspace/a.png"), 0.4).unwrap();
        assert_eq!(refined["4"]["class_type"], "VAEEncode");
        assert_eq!(refined["4"]["inputs"]["vae"], json!(["11", 0]));
        assert_eq!(refined["8"]["inputs"]["image"], "socialspace/a.png");
        assert_eq!(refined["5"]["inputs"]["denoise"], 0.4);
        assert_eq!(refined["7"]["class_type"], "SaveImage");
        assert!(workflow(Look::Detailed, &Models::default(), "x", "", 1, None, 0.5).is_err());
    }

    #[test]
    fn only_loopback_comfyui_addresses_are_allowed() {
        assert_eq!(endpoint("http://127.0.0.1:8188", "prompt").unwrap().as_str(), "http://127.0.0.1:8188/prompt");
        assert!(endpoint("http://localhost:8188/", "prompt").is_ok());
        assert!(endpoint("http://192.168.1.5:8188", "prompt").is_err());
        assert!(endpoint("https://example.com", "prompt").is_err());
    }

    #[test]
    fn refining_only_accepts_generated_pictures() {
        let folder = tempfile::tempdir().unwrap();
        let inside = folder.path().join("profile-1.png");
        std::fs::write(&inside, b"x").unwrap();
        let outside = tempfile::tempdir().unwrap();
        let other = outside.path().join("someone.png");
        std::fs::write(&other, b"x").unwrap();
        assert!(generated_source(folder.path(), inside.to_str().unwrap()).is_ok());
        assert!(generated_source(folder.path(), other.to_str().unwrap()).is_err());
        assert!(generated_source(folder.path(), "missing.png").is_err());
    }

    /// Needs ComfyUI running on 127.0.0.1:8188: cargo test live_comfyui -- --ignored
    #[tokio::test]
    #[ignore]
    async fn live_comfyui_makes_and_refines_pictures() {
        let base = "http://127.0.0.1:8188";
        let http = client(GENERATE_TIMEOUT).unwrap();
        let found = models(&http, base).await.unwrap();
        let only = std::env::var("LIVE_LOOK").unwrap_or_default();
        for look in found.looks().into_iter().filter(|look| only.is_empty() || format!("{look:?}").eq_ignore_ascii_case(&only)) {
            let started = Instant::now();
            let graph = workflow(look, &found, "photorealistic headshot portrait of a fictional person, smiling, natural light", "blurry, text", 42, None, 0.5).unwrap();
            let body: Value = http.post(endpoint(base, "prompt").unwrap()).json(&json!({ "prompt": graph })).send().await.unwrap().json().await.unwrap();
            let id = body["prompt_id"].as_str().unwrap_or_else(|| panic!("{look:?} rejected: {}", prompt_error(&body))).to_owned();
            let image = wait_for_image(&http, base, &id).await.unwrap();
            println!("{look:?} made {} in {:?}", image["filename"], started.elapsed());
            let mut view = endpoint(base, "view").unwrap();
            view.query_pairs_mut().append_pair("filename", image["filename"].as_str().unwrap()).append_pair("subfolder", image["subfolder"].as_str().unwrap()).append_pair("type", "output");
            let bytes = http.get(view).send().await.unwrap().bytes().await.unwrap();
            let file = std::env::temp_dir().join(format!("socialspace-live-{look:?}.png"));
            std::fs::write(&file, &bytes).unwrap();
            let source = upload(&http, base, &file).await.unwrap();
            let graph = workflow(look, &found, "photorealistic headshot portrait of a fictional person, smiling, wearing glasses", "blurry", 43, Some(&source), 0.5).unwrap();
            let body: Value = http.post(endpoint(base, "prompt").unwrap()).json(&json!({ "prompt": graph })).send().await.unwrap().json().await.unwrap();
            let id = body["prompt_id"].as_str().unwrap_or_else(|| panic!("{look:?} refine rejected: {}", prompt_error(&body))).to_owned();
            let image = wait_for_image(&http, base, &id).await.unwrap();
            println!("{look:?} refined {} after {:?}", image["filename"], started.elapsed());
        }
    }

    #[test]
    fn reads_comfyui_errors() {
        let body = json!({ "error": { "message": "Prompt outputs failed validation" }, "node_errors": { "1": { "errors": [{ "message": "Value not in list", "details": "ckpt_name: 'x' not in []" }] } } });
        assert_eq!(prompt_error(&body), "Prompt outputs failed validation ckpt_name: 'x' not in []");
        assert!(random_seed() < (1 << 53));
    }
}

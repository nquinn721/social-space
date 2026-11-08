//! Talks to a local Ollama server for the in-app assistant.
//! Requests go only to loopback addresses, so emails and workspace data shown
//! to the model never leave the device through this module.

use std::time::Duration;

use serde_json::{json, Value};

const MODELS_TIMEOUT: Duration = Duration::from_secs(10);
const CHAT_TIMEOUT: Duration = Duration::from_secs(600);
const MAX_MODEL_NAME: usize = 200;

fn local_base(base_url: &str) -> Result<url::Url, String> {
    let mut url: url::Url = base_url
        .trim()
        .parse()
        .map_err(|_| "Enter a valid Ollama address, like http://127.0.0.1:11434.")?;
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
        return Err("The assistant only connects to Ollama running on this computer.".into());
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
        .map_err(|_| "Invalid Ollama address.".into())
}

fn client(timeout: Duration) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(timeout)
        .no_proxy()
        .build()
        .map_err(|_| "Could not prepare the Ollama connection.".into())
}

fn unreachable(error: reqwest::Error) -> String {
    if error.is_timeout() {
        "Ollama took too long to answer. Try a smaller model.".into()
    } else {
        "Could not reach Ollama. Make sure it is running (ollama serve).".into()
    }
}

#[tauri::command]
pub async fn ollama_models(base_url: String) -> Result<Vec<String>, String> {
    let response = client(MODELS_TIMEOUT)?
        .get(endpoint(&base_url, "api/tags")?)
        .send()
        .await
        .map_err(unreachable)?;
    if !response.status().is_success() {
        return Err(format!("Ollama returned an error ({}).", response.status()));
    }
    let body: Value = response
        .json()
        .await
        .map_err(|_| "Ollama sent an unexpected reply.")?;
    Ok(body["models"]
        .as_array()
        .map(|models| {
            models
                .iter()
                .filter_map(|model| model["name"].as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default())
}

/// Sends one non-streaming chat turn and returns Ollama's `message` object.
#[tauri::command]
pub async fn ollama_chat(
    base_url: String,
    model: String,
    messages: Value,
    tools: Value,
    think: Option<bool>,
) -> Result<Value, String> {
    let model = model.trim();
    if model.is_empty() || model.len() > MAX_MODEL_NAME || model.chars().any(char::is_control) {
        return Err("Choose an Ollama model in the assistant settings.".into());
    }
    if !messages.is_array() || !(tools.is_array() || tools.is_null()) {
        return Err("Invalid chat request.".into());
    }
    let mut body = json!({ "model": model, "messages": messages, "stream": false });
    if tools.is_array() {
        body["tools"] = tools;
    }
    if let Some(think) = think {
        body["think"] = Value::Bool(think);
    }
    let address = endpoint(&base_url, "api/chat")?;
    let http = client(CHAT_TIMEOUT)?;
    let send = |body: &Value| http.post(address.clone()).json(body).send();
    let mut response = send(&body).await.map_err(unreachable)?;
    let mut status = response.status();
    let mut reply: Value = response
        .json()
        .await
        .map_err(|_| "Ollama sent an unexpected reply.")?;
    // Models without a thinking mode reject the `think` flag; retry without it.
    let rejected_think = reply["error"]
        .as_str()
        .is_some_and(|error| error.to_ascii_lowercase().contains("think"));
    if !status.is_success() && rejected_think && body.get("think").is_some() {
        body.as_object_mut().map(|object| object.remove("think"));
        response = send(&body).await.map_err(unreachable)?;
        status = response.status();
        reply = response
            .json()
            .await
            .map_err(|_| "Ollama sent an unexpected reply.")?;
    }
    if !status.is_success() {
        let detail = reply["error"].as_str().unwrap_or("unknown error");
        return Err(if status == reqwest::StatusCode::NOT_FOUND {
            format!("Model \"{model}\" is not installed. Run: ollama pull {model}")
        } else {
            format!("Ollama returned an error: {detail}")
        });
    }
    reply
        .get("message")
        .cloned()
        .ok_or_else(|| "Ollama sent an empty reply.".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_loopback_ollama_addresses_are_allowed() {
        assert_eq!(
            endpoint("http://127.0.0.1:11434", "api/chat").unwrap().as_str(),
            "http://127.0.0.1:11434/api/chat"
        );
        assert!(endpoint("http://localhost:11434/", "api/tags").is_ok());
        assert!(endpoint("http://[::1]:11434", "api/tags").is_ok());
        assert!(endpoint("http://192.168.1.5:11434", "api/chat").is_err());
        assert!(endpoint("https://example.com", "api/chat").is_err());
        assert!(endpoint("file:///etc/hosts", "api/chat").is_err());
        let with_userinfo = format!("http://{}@127.0.0.1:11434", ["someone", "x"].join(":"));
        assert!(endpoint(&with_userinfo, "api/chat").is_err());
    }
}

use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager};

const QUEUE_FILE: &str = "video-queue.json";
const DATA_LOCK: &str = "video-queue-data.lock";
const PUBLISH_LOCK: &str = "video-queue-publisher.lock";
const MAX_JOBS: usize = 1000;
const MAX_FIELD: usize = 4096;
const MAX_CAPTION: usize = 2200;
const POLL_SECONDS: u64 = 15;
const LOCK_ATTEMPTS: usize = 50;
const LOCK_WAIT_MILLIS: u64 = 10;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum QueuePlatform {
    X,
    Instagram,
    Tiktok,
    Youtube,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum QueueMode {
    Automatic,
    Manual,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum QueueStatus {
    Scheduled,
    Publishing,
    Posted,
    ManualDue,
    NeedsReview,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NewQueueJob {
    id: String,
    platform: QueuePlatform,
    channel_id: String,
    channel_name: String,
    channel_handle: String,
    media_source: String,
    caption: String,
    scheduled_at: u64,
    mode: QueueMode,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QueueJob {
    #[serde(flatten)]
    input: NewQueueJob,
    status: QueueStatus,
    error: Option<String>,
    instagram_account_id: Option<String>,
}

fn root(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|_| "Could not locate the queue folder.".to_string())
}
fn lock(path: &Path) -> Result<File, String> {
    let dir = path.parent().ok_or("Invalid queue lock path.")?;
    fs::create_dir_all(dir).map_err(|_| "Could not create the queue folder.")?;
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)
        .map_err(|_| "Could not open the queue lock.")?;
    for _ in 0..LOCK_ATTEMPTS {
        if file.try_lock().is_ok() {
            return Ok(file);
        }
        std::thread::sleep(Duration::from_millis(LOCK_WAIT_MILLIS));
    }
    Err("The video queue is busy. Please try again.".into())
}
fn try_publisher_lock(path: &Path) -> Result<Option<File>, String> {
    fs::create_dir_all(path.parent().ok_or("Invalid queue lock path.")?)
        .map_err(|_| "Could not create the queue folder.")?;
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)
        .map_err(|_| "Could not open the publisher lock.")?;
    if file.try_lock().is_ok() {
        Ok(Some(file))
    } else {
        Ok(None)
    }
}
fn read(path: &Path) -> Result<Vec<QueueJob>, String> {
    match fs::read(path) {
        Ok(data) => serde_json::from_slice(&data).map_err(|_| {
            "Could not read the video queue. Your existing data was not changed.".into()
        }),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(_) => Err("Could not open the video queue.".into()),
    }
}
fn write(path: &Path, jobs: &[QueueJob]) -> Result<(), String> {
    let dir = path.parent().ok_or("Invalid queue path.")?;
    fs::create_dir_all(dir).map_err(|_| "Could not create the queue folder.")?;
    let data = serde_json::to_vec_pretty(jobs).map_err(|_| "Could not encode the video queue.")?;
    let mut tmp =
        tempfile::NamedTempFile::new_in(dir).map_err(|_| "Could not prepare the queue file.")?;
    tmp.write_all(&data)
        .and_then(|_| tmp.as_file().sync_all())
        .map_err(|_| "Could not write the video queue.")?;
    tmp.persist(path)
        .map_err(|_| "Could not save the video queue.")?;
    Ok(())
}
fn transaction<T>(
    dir: &Path,
    change: impl FnOnce(&mut Vec<QueueJob>) -> Result<T, String>,
) -> Result<T, String> {
    let _lock = lock(&dir.join(DATA_LOCK))?;
    let path = dir.join(QUEUE_FILE);
    let mut jobs = read(&path)?;
    let output = change(&mut jobs)?;
    write(&path, &jobs)?;
    Ok(output)
}
fn normalize_handle(value: &str) -> String {
    value.trim().trim_start_matches('@').to_lowercase()
}
fn valid_instagram_url(value: &str) -> bool {
    let Ok(url) = url::Url::parse(value) else {
        return false;
    };
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return false;
    }
    matches!(url.host(), Some(url::Host::Domain(host)) if host.contains('.') && !host.ends_with(".local") && !host.ends_with(".localhost"))
}
fn validate(input: &NewQueueJob) -> Result<(), String> {
    if input.id.is_empty()
        || input.id.len() > 128
        || !input
            .id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err("Invalid queue item ID.".into());
    }
    if input.channel_id.trim().is_empty()
        || input.channel_name.trim().is_empty()
        || input.media_source.trim().is_empty()
        || input.scheduled_at == 0
    {
        return Err("Choose a channel, video, and posting time.".into());
    }
    if [
        &input.channel_id,
        &input.channel_name,
        &input.channel_handle,
        &input.media_source,
    ]
    .iter()
    .any(|s| s.len() > MAX_FIELD)
        || input.caption.chars().count() > MAX_CAPTION
    {
        return Err("Queue item details are too long.".into());
    }
    if input.mode == QueueMode::Automatic
        && (input.platform != QueuePlatform::Instagram
            || !valid_instagram_url(input.media_source.trim())
            || normalize_handle(&input.channel_handle).is_empty())
    {
        return Err(
            "Automatic posting requires an Instagram channel handle and a public HTTPS video URL."
                .into(),
        );
    }
    Ok(())
}
fn verify_channel_snapshot(job: &NewQueueJob, workspace: &crate::Workspace) -> Result<(), String> {
    let channel = workspace
        .channels
        .iter()
        .find(|channel| channel.id == job.channel_id)
        .ok_or("The selected channel no longer exists. Choose a channel again.")?;
    let same_platform = matches!(
        (&job.platform, channel.platform),
        (QueuePlatform::X, crate::Platform::X)
            | (QueuePlatform::Instagram, crate::Platform::Instagram)
            | (QueuePlatform::Tiktok, crate::Platform::Tiktok)
            | (QueuePlatform::Youtube, crate::Platform::Youtube)
    );
    if !same_platform || channel.name != job.channel_name || channel.handle != job.channel_handle {
        return Err("The selected channel changed. Refresh and choose it again.".into());
    }
    Ok(())
}
fn instagram_identity() -> Result<(String, String), String> {
    let identity = crate::instagram::instagram_connection()?
        .ok_or("Connect your Instagram API account before scheduling automatic posting.")?;
    let value =
        serde_json::to_value(identity).map_err(|_| "Could not read the Instagram account.")?;
    let id = value
        .get("id")
        .and_then(|v| v.as_str())
        .ok_or("Could not read the Instagram account ID.")?;
    let name = value
        .get("username")
        .and_then(|v| v.as_str())
        .ok_or("Could not read the Instagram username.")?;
    Ok((id.to_string(), name.to_string()))
}
fn matches_identity(job: &QueueJob, id: &str, username: &str) -> bool {
    job.instagram_account_id.as_deref() == Some(id)
        && normalize_handle(&job.input.channel_handle) == normalize_handle(username)
}
fn now_ms() -> Result<u64, String> {
    let time = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "The system clock is invalid.")?
        .as_millis();
    u64::try_from(time).map_err(|_| "The system clock is invalid.".into())
}

#[tauri::command]
pub async fn choose_video_file() -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        rfd::FileDialog::new()
            .set_title("Choose a video")
            .add_filter("Video", &["mp4", "mov", "m4v", "webm"])
            .pick_file()
            .map(|path| {
                path.to_str()
                    .map(str::to_owned)
                    .ok_or_else(|| "The selected path is not valid Unicode.".to_string())
            })
            .transpose()
    })
    .await
    .map_err(|_| "Could not open the video picker.".to_string())?
}
#[tauri::command]
pub fn list_queue(app: AppHandle) -> Result<Vec<QueueJob>, String> {
    let dir = root(&app)?;
    let _lock = lock(&dir.join(DATA_LOCK))?;
    read(&dir.join(QUEUE_FILE))
}
#[tauri::command]
pub fn add_queue_job(app: AppHandle, job: NewQueueJob) -> Result<QueueJob, String> {
    validate(&job)?;
    {
        let storage = app.state::<crate::StorageLock>();
        let _guard = storage
            .0
            .lock()
            .map_err(|_| "Workspace storage is unavailable.")?;
        let workspace = crate::read_workspace(&crate::workspace_path(&app)?)?;
        verify_channel_snapshot(&job, &workspace)?;
    }
    let instagram_account_id = if job.mode == QueueMode::Automatic {
        let (id, username) = instagram_identity()?;
        if normalize_handle(&job.channel_handle) != normalize_handle(&username) {
            return Err(format!(
                "The selected channel does not match the connected Instagram account @{username}."
            ));
        }
        Some(id)
    } else {
        None
    };
    let item = QueueJob {
        input: job,
        status: QueueStatus::Scheduled,
        error: None,
        instagram_account_id,
    };
    transaction(&root(&app)?, |jobs| {
        if jobs.len() >= MAX_JOBS {
            return Err("The queue is full. Remove completed items first.".into());
        }
        if jobs
            .iter()
            .any(|existing| existing.input.id == item.input.id)
        {
            return Err("This queue item already exists.".into());
        }
        jobs.push(item.clone());
        Ok(item)
    })
}
#[tauri::command]
pub fn complete_queue_job(app: AppHandle, id: String) -> Result<QueueJob, String> {
    transaction(&root(&app)?, |jobs| {
        let job = jobs
            .iter_mut()
            .find(|job| job.input.id == id)
            .ok_or("Queue item not found.")?;
        if !matches!(
            job.status,
            QueueStatus::ManualDue | QueueStatus::NeedsReview
        ) {
            return Err("Only items due for manual posting or review can be marked posted.".into());
        }
        job.status = QueueStatus::Posted;
        job.error = None;
        Ok(job.clone())
    })
}
#[tauri::command]
pub fn delete_queue_job(app: AppHandle, id: String) -> Result<(), String> {
    transaction(&root(&app)?, |jobs| {
        let index = jobs
            .iter()
            .position(|job| job.input.id == id)
            .ok_or("Queue item not found.")?;
        if jobs[index].status == QueueStatus::Publishing {
            return Err("This item is being published. Wait for it to finish.".into());
        }
        jobs.remove(index);
        Ok(())
    })
}

fn take_due(dir: &Path, now: u64) -> Result<Option<QueueJob>, String> {
    transaction(dir, |jobs| {
        // The cross-process publisher lock is held here. Any old in-progress item
        // was interrupted, so its outcome cannot safely be retried automatically.
        for item in jobs
            .iter_mut()
            .filter(|item| item.status == QueueStatus::Publishing)
        {
            item.status = QueueStatus::NeedsReview;
            item.error = Some(
                "Posting was interrupted. Check Instagram before taking further action.".into(),
            );
        }
        for item in jobs.iter_mut().filter(|item| {
            item.status == QueueStatus::Scheduled
                && item.input.scheduled_at <= now
                && item.input.mode == QueueMode::Manual
        }) {
            item.status = QueueStatus::ManualDue;
        }
        let item = jobs
            .iter_mut()
            .filter(|item| {
                item.status == QueueStatus::Scheduled
                    && item.input.scheduled_at <= now
                    && item.input.mode == QueueMode::Automatic
            })
            .min_by_key(|item| item.input.scheduled_at);
        if let Some(item) = item {
            item.status = QueueStatus::Publishing;
            return Ok(Some(item.clone()));
        }
        Ok(None)
    })
}
fn finish(dir: &Path, id: &str, result: Result<(), String>) -> Result<(), String> {
    transaction(dir, |jobs| {
        let item = jobs
            .iter_mut()
            .find(|item| item.input.id == id)
            .ok_or("Queue item not found.")?;
        if item.status != QueueStatus::Publishing {
            return Err("Queue item no longer publishing.".into());
        }
        match result {
            Ok(()) => {
                item.status = QueueStatus::Posted;
                item.error = None;
            }
            Err(error) => {
                item.status = QueueStatus::NeedsReview;
                item.error = Some(error);
            }
        }
        Ok(())
    })
}
fn run_once(dir: &Path) -> Result<(), String> {
    let Some(_publisher) = try_publisher_lock(&dir.join(PUBLISH_LOCK))? else {
        return Ok(());
    };
    let Some(item) = take_due(dir, now_ms()?)? else {
        return Ok(());
    };
    let result = (|| {
        let (id, username) = instagram_identity()?;
        if !matches_identity(&item, &id, &username) {
            return Err("Connected Instagram account changed. Reconnect the correct account and review this item.".into());
        }
        tauri::async_runtime::block_on(crate::instagram::publish_instagram_reel(
            item.input.media_source.clone(),
            item.input.caption.clone(),
        ))
        .map(|_| ())
    })();
    finish(dir, &item.input.id, result)
}
pub fn start_scheduler(app: AppHandle) {
    std::thread::spawn(move || loop {
        if let Ok(dir) = root(&app) {
            let _ = run_once(&dir);
        }
        std::thread::sleep(Duration::from_secs(POLL_SECONDS));
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    fn item(mode: QueueMode, platform: QueuePlatform, time: u64) -> QueueJob {
        QueueJob {
            input: NewQueueJob {
                id: "job-1".into(),
                platform,
                channel_id: "channel-1".into(),
                channel_name: "Studio".into(),
                channel_handle: "@studio".into(),
                media_source: "https://cdn.example.com/video.mp4".into(),
                caption: "caption".into(),
                scheduled_at: time,
                mode,
            },
            status: QueueStatus::Scheduled,
            error: None,
            instagram_account_id: Some("42".into()),
        }
    }
    #[test]
    fn queue_requires_the_actual_saved_channel_snapshot() {
        let job = item(QueueMode::Automatic, QueuePlatform::Instagram, 100);
        let mut workspace = crate::Workspace {
            business_name: String::new(),
            accounts: vec![],
            channels: vec![crate::Channel {
                id: "channel-1".into(),
                platform: crate::Platform::Instagram,
                name: "Studio".into(),
                handle: "@studio".into(),
                account_id: None,
                notes: String::new(),
            }],
        };
        assert!(verify_channel_snapshot(&job.input, &workspace).is_ok());
        workspace.channels[0].handle = "@someone_else".into();
        assert!(verify_channel_snapshot(&job.input, &workspace).is_err());
        workspace.channels.clear();
        assert!(verify_channel_snapshot(&job.input, &workspace).is_err());
    }
    #[test]
    fn automatic_posts_require_instagram_and_public_video_url() {
        let mut job = item(QueueMode::Automatic, QueuePlatform::Instagram, 100);
        assert!(validate(&job.input).is_ok());
        job.input.media_source = "C:\\private.mp4".into();
        assert!(validate(&job.input).is_err());
        job.input.media_source = "https://cdn.example.com/video.mp4".into();
        job.input.platform = QueuePlatform::Tiktok;
        assert!(validate(&job.input).is_err());
    }
    #[test]
    fn identity_is_pinned_and_handles_are_normalized() {
        let job = item(QueueMode::Automatic, QueuePlatform::Instagram, 100);
        assert!(matches_identity(&job, "42", "Studio"));
        assert!(!matches_identity(&job, "43", "studio"));
        assert!(!matches_identity(&job, "42", "other"));
    }
    #[test]
    fn queue_claims_once_and_recovers_interrupted_posts_as_review() {
        let dir = tempfile::tempdir().unwrap();
        let job = item(QueueMode::Automatic, QueuePlatform::Instagram, 100);
        write(&dir.path().join(QUEUE_FILE), &[job]).unwrap();
        assert!(take_due(dir.path(), 99).unwrap().is_none());
        assert_eq!(
            take_due(dir.path(), 100).unwrap().unwrap().status,
            QueueStatus::Publishing
        );
        assert!(take_due(dir.path(), 101).unwrap().is_none());
        let stored = read(&dir.path().join(QUEUE_FILE)).unwrap();
        assert_eq!(stored[0].status, QueueStatus::NeedsReview);
        assert!(stored[0]
            .error
            .as_ref()
            .unwrap()
            .contains("Check Instagram"));
    }
    #[test]
    fn manual_jobs_become_due_without_network_and_bad_data_is_preserved() {
        let dir = tempfile::tempdir().unwrap();
        write(
            &dir.path().join(QUEUE_FILE),
            &[item(QueueMode::Manual, QueuePlatform::Tiktok, 50)],
        )
        .unwrap();
        assert!(take_due(dir.path(), 50).unwrap().is_none());
        assert_eq!(
            read(&dir.path().join(QUEUE_FILE)).unwrap()[0].status,
            QueueStatus::ManualDue
        );
        fs::write(dir.path().join(QUEUE_FILE), b"broken").unwrap();
        assert!(take_due(dir.path(), 60).is_err());
        assert_eq!(fs::read(dir.path().join(QUEUE_FILE)).unwrap(), b"broken");
    }
    #[test]
    fn publisher_lock_excludes_other_instances() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(PUBLISH_LOCK);
        let first = try_publisher_lock(&path).unwrap().unwrap();
        assert!(try_publisher_lock(&path).unwrap().is_none());
        drop(first);
        assert!(try_publisher_lock(&path).unwrap().is_some());
    }
}

use serde_json::Value;
use sha2::{Digest, Sha256};
use souvlaki::{MediaControls, MediaMetadata, MediaPlayback, MediaPosition};
use std::{path::Path, time::Duration};

pub fn update(controls: &mut MediaControls, state: &Value, root: &Path, last_metadata: &mut Value) {
    let progress = Some(MediaPosition(Duration::from_millis(
        state["positionMs"].as_u64().unwrap_or(0),
    )));
    let playback = match state["state"].as_str() {
        Some("playing") => MediaPlayback::Playing { progress },
        Some("paused") => MediaPlayback::Paused { progress },
        _ => MediaPlayback::Stopped,
    };
    let _ = controls.set_playback(playback);
    let metadata = serde_json::json!([
        state["title"],
        state["artist"],
        state["album"],
        state["cover"]
    ]);
    if *last_metadata != metadata {
        let cover = state["cover"].as_str().and_then(|s| {
            use base64::Engine as _;
            let data = base64::engine::general_purpose::STANDARD.decode(s).ok()?;
            if data.len() > 16 * 1024 * 1024 {
                return None;
            }
            let directory = root.join("media-covers");
            std::fs::create_dir_all(&directory).ok()?;
            let digest = Sha256::digest(&data)
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect::<String>();
            let file = directory.join(format!("{digest}.jpg"));
            if !file.is_file() {
                std::fs::write(&file, data).ok()?;
                // Keep only our own hashed artwork cache files, with bounded
                // disk usage. The current image remains valid for SMTC reads.
                let mut entries: Vec<_> = std::fs::read_dir(&directory)
                    .ok()?
                    .flatten()
                    .filter_map(|entry| {
                        let name = entry.file_name().to_string_lossy().to_string();
                        if name.len() != 68
                            || !name.ends_with(".jpg")
                            || !name.as_bytes()[..64].iter().all(u8::is_ascii_hexdigit)
                            || !entry.file_type().ok()?.is_file()
                        {
                            return None;
                        }
                        let metadata = entry.metadata().ok()?;
                        Some((entry.path(), metadata.len(), metadata.modified().ok()?))
                    })
                    .collect();
                entries.sort_by_key(|entry| entry.2);
                let mut bytes: u64 = entries.iter().map(|entry| entry.1).sum();
                let mut count = entries.len();
                for (path, size, _) in entries {
                    if count <= 64 && bytes <= 64 * 1024 * 1024 {
                        break;
                    }
                    if path != file && std::fs::remove_file(path).is_ok() {
                        count -= 1;
                        bytes = bytes.saturating_sub(size);
                    }
                }
            }
            #[cfg(windows)]
            return Some(format!("file://{}", file.display()));
            #[cfg(not(windows))]
            url::Url::from_file_path(file).ok().map(|s| s.to_string())
        });
        let result = controls.set_metadata(MediaMetadata {
            title: state["title"].as_str(),
            artist: state["artist"].as_str(),
            album: state["album"].as_str(),
            duration: state["durationMs"].as_u64().map(Duration::from_millis),
            cover_url: cover.as_deref(),
        });
        if result.is_ok() {
            *last_metadata = metadata;
        }
    }
}

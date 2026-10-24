use serde_json::Value;
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
            let file = root.join("light-cover.jpg");
            std::fs::write(&file, data).ok()?;
            url::Url::from_file_path(file).ok().map(|s| s.to_string())
        });
        let _ = controls.set_metadata(MediaMetadata {
            title: state["title"].as_str(),
            artist: state["artist"].as_str(),
            album: state["album"].as_str(),
            duration: Some(Duration::from_millis(
                state["durationMs"].as_u64().unwrap_or(0),
            )),
            cover_url: cover.as_deref(),
        });
        *last_metadata = metadata;
    }
}

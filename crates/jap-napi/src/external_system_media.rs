//! Read and control the media session that NetEase publishes to Windows.
use napi::bindgen_prelude::{AsyncTask, Buffer};
use napi::{Env, Task};
use napi_derive::napi;

#[napi(object)]
pub struct ExternalSystemMedia {
    pub source_id: String,
    pub track_key: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub state: String,
    pub position_ms: f64,
    pub duration_ms: f64,
    pub can_play: bool,
    pub can_pause: bool,
    pub can_next: bool,
    pub can_previous: bool,
    pub cover: Option<Buffer>,
}

pub struct ExternalSystemMediaTask {
    action: String,
    source_id: Option<String>,
    known_cover: Option<String>,
}

impl Task for ExternalSystemMediaTask {
    type Output = Option<ExternalSystemMedia>;
    type JsValue = Self::Output;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        #[cfg(windows)]
        {
            win::read(self).map_err(|error| napi::Error::from_reason(error.to_string()))
        }
        #[cfg(not(windows))]
        {
            let _ = (&self.action, &self.source_id, &self.known_cover);
            Ok(None)
        }
    }

    fn resolve(&mut self, _: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(output)
    }
}

#[napi(ts_return_type = "Promise<ExternalSystemMedia | null>")]
pub fn external_system_media(
    action: String,
    source_id: Option<String>,
    known_cover: Option<String>,
) -> AsyncTask<ExternalSystemMediaTask> {
    AsyncTask::new(ExternalSystemMediaTask {
        action,
        source_id,
        known_cover,
    })
}

#[cfg(windows)]
mod win {
    use super::{ExternalSystemMedia, ExternalSystemMediaTask};
    use std::time::{SystemTime, UNIX_EPOCH};
    use windows::Media::Control::{
        GlobalSystemMediaTransportControlsSessionManager as Manager,
        GlobalSystemMediaTransportControlsSessionMediaProperties as Properties,
        GlobalSystemMediaTransportControlsSessionPlaybackStatus as PlaybackStatus,
    };
    use windows::Storage::Streams::DataReader;
    use windows::Win32::Foundation::E_FAIL;
    use windows::Win32::System::WinRT::{RO_INIT_MULTITHREADED, RoInitialize, RoUninitialize};
    use windows::core::{Error, Result};

    struct Apartment;

    impl Drop for Apartment {
        fn drop(&mut self) {
            // SAFETY: read initialized this apartment on this worker thread.
            unsafe { RoUninitialize() };
        }
    }

    fn is_netease(source: &str) -> bool {
        let source = source.to_ascii_lowercase();
        matches!(
            source.as_str(),
            "cloudmusic" | "cloudmusic.exe" | "netease.cloudmusic" | "neteasecloudmusic"
        ) || source.ends_with("\\netease\\cloudmusic\\cloudmusic.exe")
    }

    fn thumbnail(properties: &Properties) -> Result<Vec<u8>> {
        let stream = properties.Thumbnail()?.OpenReadAsync()?.join()?;
        let size = stream.Size()?;
        if !(1..=8 * 1024 * 1024).contains(&size) {
            return Ok(Vec::new());
        }
        let reader = DataReader::CreateDataReader(&stream.GetInputStreamAt(0)?)?;
        let loaded = reader.LoadAsync(size as u32)?.join()?;
        if u64::from(loaded) != size {
            return Ok(Vec::new());
        }
        let mut bytes = vec![0; loaded as usize];
        reader.ReadBytes(&mut bytes)?;
        Ok(bytes)
    }

    pub fn read(task: &ExternalSystemMediaTask) -> Result<Option<ExternalSystemMedia>> {
        // SAFETY: this blocking task runs on a Node worker and balances WinRT initialization.
        unsafe { RoInitialize(RO_INIT_MULTITHREADED)? };
        let _apartment = Apartment;
        let manager = Manager::RequestAsync()?.join()?;
        let session = manager.GetSessions()?.into_iter().find(|session| {
            session.SourceAppUserModelId().is_ok_and(|id| {
                let id = id.to_string_lossy();
                is_netease(&id)
                    && (task.action == "status" || task.source_id.as_deref() == Some(&id))
            })
        });
        let Some(session) = session else {
            return Ok(None);
        };
        let accepted = match task.action.as_str() {
            "status" => true,
            "pause" => session.TryPauseAsync()?.join()?,
            "resume" => session.TryPlayAsync()?.join()?,
            "next" => session.TrySkipNextAsync()?.join()?,
            "previous" => session.TrySkipPreviousAsync()?.join()?,
            _ => false,
        };
        if !accepted {
            return Err(Error::new(E_FAIL, "网易云未接受该系统媒体控制"));
        }
        let source_id = session.SourceAppUserModelId()?.to_string_lossy();
        let properties = session.TryGetMediaPropertiesAsync()?.join()?;
        let title: String = properties
            .Title()?
            .to_string_lossy()
            .chars()
            .take(512)
            .collect();
        let artist: String = properties
            .Artist()?
            .to_string_lossy()
            .chars()
            .take(512)
            .collect();
        let album: String = properties
            .AlbumTitle()?
            .to_string_lossy()
            .chars()
            .take(512)
            .collect();
        let playback = session.GetPlaybackInfo()?;
        let status = playback.PlaybackStatus()?;
        let state = match status {
            PlaybackStatus::Playing => "playing",
            PlaybackStatus::Paused => "paused",
            _ => "stopped",
        };
        let timeline = session.GetTimelineProperties()?;
        let start = timeline.StartTime()?.Duration;
        let duration_ms =
            (timeline.EndTime()?.Duration.saturating_sub(start).max(0) / 10_000) as f64;
        let mut position_ms =
            (timeline.Position()?.Duration.saturating_sub(start).max(0) / 10_000) as f64;
        if status == PlaybackStatus::Playing {
            let rate = playback
                .PlaybackRate()
                .and_then(|rate| rate.Value())
                .unwrap_or(1.0);
            let updated = timeline.LastUpdatedTime()?.UniversalTime / 10_000;
            let now = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as i64
                + 11_644_473_600_000;
            if duration_ms > 0.0 && updated > 0 && rate.is_finite() && rate > 0.0 {
                position_ms = (position_ms + now.saturating_sub(updated).max(0) as f64 * rate)
                    .min(duration_ms);
            }
        }
        let track_key = serde_json::json!([source_id, title, artist, album]).to_string();
        let cover = (task.known_cover.as_deref() != Some(&track_key))
            .then(|| {
                thumbnail(&properties)
                    .ok()
                    .filter(|bytes| !bytes.is_empty())
            })
            .flatten()
            .map(Into::into);
        let controls = playback.Controls()?;
        Ok(Some(ExternalSystemMedia {
            source_id,
            track_key,
            title,
            artist,
            album,
            state: state.into(),
            position_ms,
            duration_ms,
            can_play: controls.IsPlayEnabled().unwrap_or(false),
            can_pause: controls.IsPauseEnabled().unwrap_or(false),
            can_next: controls.IsNextEnabled().unwrap_or(false),
            can_previous: controls.IsPreviousEnabled().unwrap_or(false),
            cover,
        }))
    }
}

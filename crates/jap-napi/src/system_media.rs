//! Native SMTC session independent of the audio output backend or HTML media.
use napi::bindgen_prelude::Buffer;
use napi_derive::napi;

#[napi(object)]
pub struct SystemMediaState {
    pub title: String,
    pub artist: String,
    pub album: String,
    pub state: String,
    pub duration_ms: f64,
    pub position_ms: f64,
    pub cover: Option<Buffer>,
}

#[cfg(windows)]
mod win {
    use super::SystemMediaState;
    use std::cell::RefCell;
    use std::collections::VecDeque;
    use std::sync::{Arc, Mutex};
    use windows::Foundation::{TimeSpan, TypedEventHandler};
    use windows::Media::{
        MediaPlaybackStatus, MediaPlaybackType, SystemMediaTransportControls,
        SystemMediaTransportControlsButton, SystemMediaTransportControlsTimelineProperties,
    };
    use windows::Storage::Streams::{
        DataWriter, InMemoryRandomAccessStream, RandomAccessStreamReference,
    };
    use windows::Win32::Foundation::HWND;
    use windows::Win32::System::WinRT::ISystemMediaTransportControlsInterop;
    use windows::core::{HSTRING, Result, factory};

    struct Session {
        controls: SystemMediaTransportControls,
        buttons: Arc<Mutex<VecDeque<String>>>,
        token: i64,
        metadata: (String, String, String),
        art: Vec<u8>,
    }
    impl Drop for Session {
        fn drop(&mut self) {
            let _ = self.controls.RemoveButtonPressed(self.token);
            let _ = self.controls.SetIsEnabled(false);
        }
    }
    thread_local! { static SESSION: RefCell<Option<Session>> = const { RefCell::new(None) }; }
    pub fn init(hwnd: isize) -> Result<()> {
        let interop: ISystemMediaTransportControlsInterop =
            factory::<SystemMediaTransportControls, _>()?;
        // SAFETY: this HWND comes from our Electron top-level BrowserWindow and
        // the N-API function is invoked on its owning main thread.
        let controls: SystemMediaTransportControls =
            unsafe { interop.GetForWindow(HWND(hwnd as *mut _))? };
        controls.SetIsPlayEnabled(true)?;
        controls.SetIsPauseEnabled(true)?;
        controls.SetIsNextEnabled(true)?;
        controls.SetIsPreviousEnabled(true)?;
        controls.SetIsStopEnabled(true)?;
        controls.SetIsEnabled(true)?;
        let buttons = Arc::new(Mutex::new(VecDeque::new()));
        let queue = Arc::clone(&buttons);
        let token = controls.ButtonPressed(&TypedEventHandler::new(
            move |_,
                  event: windows::core::Ref<
                '_,
                windows::Media::SystemMediaTransportControlsButtonPressedEventArgs,
            >| {
                if let Some(event) = event.as_ref() {
                    let button = event.Button()?;
                    let action = if button == SystemMediaTransportControlsButton::Play {
                        "play"
                    } else if button == SystemMediaTransportControlsButton::Pause {
                        "pause"
                    } else if button == SystemMediaTransportControlsButton::Next {
                        "next"
                    } else if button == SystemMediaTransportControlsButton::Previous {
                        "previous"
                    } else if button == SystemMediaTransportControlsButton::Stop {
                        "stop"
                    } else {
                        ""
                    };
                    if !action.is_empty()
                        && let Ok(mut queue) = queue.lock()
                        && queue.len() < 32
                    {
                        queue.push_back(action.to_owned());
                    }
                }
                Ok(())
            },
        ))?;
        SESSION.with(|slot| {
            *slot.borrow_mut() = Some(Session {
                controls,
                buttons,
                token,
                metadata: (String::new(), String::new(), String::new()),
                art: Vec::new(),
            })
        });
        Ok(())
    }
    pub fn update(state: SystemMediaState) -> Result<()> {
        SESSION.with(|slot| {
            let mut slot = slot.borrow_mut();
            let Some(session) = slot.as_mut() else {
                return Ok(());
            };
            let playing = match state.state.as_str() {
                "playing" => MediaPlaybackStatus::Playing,
                "paused" => MediaPlaybackStatus::Paused,
                _ => MediaPlaybackStatus::Stopped,
            };
            session.controls.SetPlaybackStatus(playing)?;
            session.controls.SetIsEnabled(!state.title.is_empty())?;
            let metadata = (state.title, state.artist, state.album);
            let art = state.cover.as_ref().map(|b| b.to_vec()).unwrap_or_default();
            if session.metadata != metadata || session.art != art {
                let display = session.controls.DisplayUpdater()?;
                display.ClearAll()?;
                display.SetType(MediaPlaybackType::Music)?;
                let music = display.MusicProperties()?;
                music.SetTitle(&HSTRING::from(&metadata.0))?;
                music.SetArtist(&HSTRING::from(&metadata.1))?;
                music.SetAlbumTitle(&HSTRING::from(&metadata.2))?;
                if !art.is_empty() {
                    let stream = InMemoryRandomAccessStream::new()?;
                    let writer = DataWriter::CreateDataWriter(&stream)?;
                    writer.WriteBytes(&art)?;
                    writer.StoreAsync()?.join()?;
                    writer.DetachStream()?;
                    stream.Seek(0)?;
                    display
                        .SetThumbnail(&RandomAccessStreamReference::CreateFromStream(&stream)?)?;
                }
                display.Update()?;
                session.metadata = metadata;
                session.art = art;
            }
            let timeline = SystemMediaTransportControlsTimelineProperties::new()?;
            let duration = (state.duration_ms.max(0.0) * 10000.0) as i64;
            timeline.SetStartTime(TimeSpan { Duration: 0 })?;
            timeline.SetEndTime(TimeSpan { Duration: duration })?;
            timeline.SetMinSeekTime(TimeSpan { Duration: 0 })?;
            timeline.SetMaxSeekTime(TimeSpan { Duration: duration })?;
            timeline.SetPosition(TimeSpan {
                Duration: (state.position_ms.max(0.0) * 10000.0) as i64,
            })?;
            session.controls.UpdateTimelineProperties(&timeline)?;
            Ok(())
        })
    }
    pub fn buttons() -> Vec<String> {
        SESSION.with(|slot| {
            slot.borrow()
                .as_ref()
                .and_then(|s| s.buttons.lock().ok().map(|mut q| q.drain(..).collect()))
                .unwrap_or_default()
        })
    }
    pub fn close() {
        SESSION.with(|slot| *slot.borrow_mut() = None);
    }
}

#[napi]
pub fn init_system_media(handle: Buffer) -> napi::Result<bool> {
    #[cfg(windows)]
    {
        let bytes: [u8; 8] = handle
            .as_ref()
            .try_into()
            .map_err(|_| napi::Error::from_reason("无效 HWND"))?;
        win::init(isize::from_le_bytes(bytes))
            .map_err(|e| napi::Error::from_reason(e.to_string()))?;
        Ok(true)
    }
    #[cfg(not(windows))]
    {
        let _ = handle;
        Ok(false)
    }
}
#[napi]
pub fn update_system_media(state: SystemMediaState) -> napi::Result<()> {
    #[cfg(windows)]
    {
        win::update(state).map_err(|e| napi::Error::from_reason(e.to_string()))
    }
    #[cfg(not(windows))]
    {
        let _ = state;
        Ok(())
    }
}
#[napi]
pub fn poll_system_media() -> Vec<String> {
    #[cfg(windows)]
    {
        win::buttons()
    }
    #[cfg(not(windows))]
    {
        Vec::new()
    }
}
#[napi]
pub fn close_system_media() {
    #[cfg(windows)]
    win::close();
}

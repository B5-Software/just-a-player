//! 输出层：把成品音频送到设备。后端通过 [`OutputBackend`] 抽象，真机与测试共用同一套引擎代码。

#[cfg(all(target_os = "linux", not(target_env = "ohos")))]
mod alsa_backend;
#[cfg(target_os = "android")]
pub mod android;
#[cfg(windows)]
mod asio_backend;
mod backend;
mod capture;
#[cfg(target_os = "macos")]
mod coreaudio_guard;
mod error;
mod negotiate;
#[cfg(any(
    target_os = "macos",
    all(target_os = "linux", not(target_env = "ohos"))
))]
mod portable_backend;
mod system;
#[cfg(any(target_os = "android", target_env = "ohos", test))]
mod usb_audio;
#[cfg(windows)]
mod wasapi_backend;

pub use backend::{
    OpenRequest, OpenedStream, OutputBackend, RenderSource, StreamEvent, StreamHandle,
};
pub use capture::CaptureBackend;
pub use error::{OutputError, Result};
pub use negotiate::{candidate_formats, holds_exactly};
pub use system::SystemBackend;

#[cfg(target_env = "ohos")]
pub mod ohos;

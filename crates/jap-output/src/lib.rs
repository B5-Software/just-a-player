//! 输出层：把成品音频送到设备。后端通过 [`OutputBackend`] 抽象，真机与测试共用同一套引擎代码。

#[cfg(target_os = "linux")]
mod alsa_backend;
#[cfg(windows)]
mod asio_backend;
mod backend;
mod capture;
#[cfg(target_os = "macos")]
mod coreaudio_guard;
mod error;
mod negotiate;
#[cfg(any(target_os = "macos", target_os = "linux"))]
mod portable_backend;
mod system;
#[cfg(windows)]
mod wasapi_backend;

pub use backend::{
    OpenRequest, OpenedStream, OutputBackend, RenderSource, StreamEvent, StreamHandle,
};
pub use capture::CaptureBackend;
pub use error::{OutputError, Result};
pub use negotiate::{candidate_formats, holds_exactly};
pub use system::SystemBackend;

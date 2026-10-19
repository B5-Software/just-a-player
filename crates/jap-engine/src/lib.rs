//! 播放引擎：命令/事件协议、会话管理、生产者线程与信号链。

mod convert;
mod engine;
mod producer;
mod ring;
mod session;
mod signal;
mod timeline;
mod viz;

pub use engine::{Engine, EventSink};
pub use jap_decode::{Cover, read_cover};
mod dsp;
mod quality;

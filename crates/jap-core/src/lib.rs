//! 引擎与 UI 之间共享的类型与协议。
//! 带 `#[ts(export)]` 的类型会在 `cargo test` 时导出到 `apps/desktop/src/shared/protocol`。

pub mod device;
pub mod dsp;
pub mod format;
pub mod protocol;
pub mod quality;
pub mod signal;
pub mod track;

pub use device::{DeviceInfo, OutputApi, OutputConfig};
pub use dsp::DspConfig;
pub use format::{AudioFormat, SampleFormat, StreamConfig};
pub use protocol::{Command, Event, PlaybackState, Query, QueryResponse};
pub use quality::{QualityFinding, QualityReport};
pub use signal::{Fidelity, NodeKind, SignalNode, SignalPath, Verdict};
pub use track::TrackInfo;

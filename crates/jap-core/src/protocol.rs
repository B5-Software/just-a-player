use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::device::{DeviceInfo, OutputConfig};
use crate::format::StreamConfig;
use crate::signal::SignalPath;
use crate::track::TrackInfo;
use crate::{DspConfig, QualityReport};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum PlaybackState {
    Stopped,
    Playing,
    Paused,
}

/// UI -> 引擎，单向投递，不等待返回。
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(export)]
pub enum Command {
    Play {
        path: String,
        #[serde(default)]
        #[ts(optional, type = "number")]
        start_ms: Option<u64>,
    },
    /// 预载下一首以实现无缝衔接；`None` 清除已预载的曲目。
    QueueNext {
        path: Option<String>,
    },
    Pause,
    Resume,
    Stop,
    Seek {
        #[ts(type = "number")]
        position_ms: u64,
    },
    SetOutput {
        config: OutputConfig,
    },
    SetDsp {
        config: DspConfig,
    },
    SetVolume {
        gain: f32,
    },
    ResetBuffer,
    AnalyzeQuality {
        path: String,
    },
}

/// 引擎 -> UI。
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(export)]
pub enum Event {
    State {
        state: PlaybackState,
    },
    TrackChanged {
        track: TrackInfo,
    },
    Position {
        #[ts(type = "number")]
        position_ms: u64,
        #[ts(type = "number | null")]
        duration_ms: Option<u64>,
    },
    SignalPath {
        path: SignalPath,
    },
    /// 当前曲目自然播完且没有预载曲目。
    QueueEnded,
    DspChanged {
        config: DspConfig,
    },
    Volume {
        gain: f32,
    },
    BufferReset {
        automatic: bool,
    },
    Quality {
        report: QualityReport,
    },
    QualityError {
        path: String,
        message: String,
    },
    Error {
        message: String,
    },
}

/// UI -> 引擎，同步查询。
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(export)]
pub enum Query {
    ListOutputDevices {
        api: crate::OutputApi,
    },
    ListDevices,
    ListAsioDevices,
    /// 列出设备在独占模式下支持的格式。
    ProbeExclusive {
        device_id: Option<String>,
    },
    /// 只读取曲目信息，不开始播放。
    ProbeTrack {
        path: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(export)]
pub enum QueryResponse {
    Devices { devices: Vec<DeviceInfo> },
    ExclusiveFormats { formats: Vec<StreamConfig> },
    Track { track: TrackInfo },
    Error { message: String },
}

use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum OutputApi {
    WasapiShared,
    WasapiExclusive,
    Asio,
    CoreAudio,
    CoreAudioExclusive,
    AlsaShared,
    AlsaExclusive,
    /// 丢弃音频的测试后端，用于 CI 与校验。
    Null,
}

impl OutputApi {
    /// 绕过系统混音器、按源格式协商的接口；测试用的 `Null` 也按此建模。
    pub const fn is_exclusive(self) -> bool {
        matches!(
            self,
            Self::WasapiExclusive
                | Self::Asio
                | Self::CoreAudioExclusive
                | Self::AlsaExclusive
                | Self::Null
        )
    }
    pub const fn platform_default() -> Self {
        if cfg!(target_os = "macos") {
            Self::CoreAudio
        } else if cfg!(target_os = "linux") {
            Self::AlsaShared
        } else {
            Self::WasapiShared
        }
    }
    pub const fn platform_exclusive() -> Self {
        if cfg!(target_os = "macos") {
            Self::CoreAudioExclusive
        } else if cfg!(target_os = "linux") {
            Self::AlsaExclusive
        } else {
            Self::WasapiExclusive
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct DeviceInfo {
    pub id: String,
    pub name: String,
    pub is_default: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct OutputConfig {
    pub api: OutputApi,
    /// `None` 表示系统默认设备。
    pub device_id: Option<String>,
    /// 目标缓冲时长（毫秒），实际值由设备对齐要求决定。
    pub buffer_ms: u32,
    #[serde(default)]
    pub dsd_mode: DsdMode,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum DsdMode {
    #[default]
    Pcm,
    Dop,
    Native,
}

impl Default for OutputConfig {
    fn default() -> Self {
        Self {
            api: OutputApi::platform_default(),
            device_id: None,
            buffer_ms: 20,
            dsd_mode: DsdMode::Pcm,
        }
    }
}

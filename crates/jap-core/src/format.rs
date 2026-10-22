use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// 送往设备的采样排布。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum SampleFormat {
    I16,
    /// 24 位有效数据左对齐放入 32 位容器。
    I24In32,
    /// 3 字节紧凑 24 位。
    I24Packed,
    I32,
    F32,
    F64,
    Dop24,
    Dop32,
    DsdU8Lsb,
    DsdU8Msb,
}

impl SampleFormat {
    pub const fn container_bytes(self) -> usize {
        match self {
            Self::I16 => 2,
            Self::F64 => 8,
            Self::I24Packed | Self::Dop24 => 3,
            Self::I24In32 | Self::I32 | Self::F32 | Self::Dop32 => 4,
            Self::DsdU8Lsb | Self::DsdU8Msb => 1,
        }
    }

    pub const fn valid_bits(self) -> u32 {
        match self {
            Self::I16 => 16,
            Self::I24In32 | Self::I24Packed | Self::Dop24 | Self::Dop32 => 24,
            Self::I32 | Self::F32 => 32,
            Self::F64 => 64,
            Self::DsdU8Lsb | Self::DsdU8Msb => 1,
        }
    }

    pub const fn is_float(self) -> bool {
        matches!(self, Self::F32 | Self::F64)
    }

    pub const fn is_dsd(self) -> bool {
        matches!(
            self,
            Self::Dop24 | Self::Dop32 | Self::DsdU8Lsb | Self::DsdU8Msb
        )
    }
}

/// 设备流配置：采样率、声道数与采样排布。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct StreamConfig {
    pub sample_rate: u32,
    pub channels: u16,
    pub format: SampleFormat,
}

impl StreamConfig {
    pub const fn bytes_per_frame(&self) -> usize {
        self.format.container_bytes() * self.channels as usize
    }

    pub const fn audio_format(&self) -> AudioFormat {
        AudioFormat {
            sample_rate: if matches!(self.format, SampleFormat::DsdU8Lsb | SampleFormat::DsdU8Msb) {
                self.sample_rate * 8
            } else {
                self.sample_rate
            },
            channels: self.channels,
            bits: Some(self.format.valid_bits()),
            float: self.format.is_float(),
        }
    }
}

/// 与容器无关的 PCM 描述，用于曲目信息与信号链展示。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct AudioFormat {
    pub sample_rate: u32,
    pub channels: u16,
    /// 有损编码没有固有位深，此时为 `None`。
    pub bits: Option<u32>,
    pub float: bool,
}

impl AudioFormat {
    pub const fn is_dsd(&self) -> bool {
        matches!(self.bits, Some(1)) && !self.float
    }
    /// 无固有位深的有损源按 24 位处理，其余取源位深。
    pub fn effective_bits(&self) -> u32 {
        self.bits.unwrap_or(24)
    }
}

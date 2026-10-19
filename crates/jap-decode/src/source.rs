use jap_core::{AudioFormat, SampleFormat, TrackInfo};

use crate::error::Result;

/// 已解码音频的统一来源。
///
/// 输出为交错的 `f64`，整数源按 `2^(bits-1)` 归一化，因此 `<= 32` 位整数经过它是无损往返的。
pub trait AudioSource: Send {
    fn info(&self) -> &TrackInfo;
    fn playback_format(&self) -> AudioFormat {
        self.format()
    }
    fn set_transport(&mut self, _format: Option<SampleFormat>) {}
    fn read_encoded(
        &mut self,
        _format: SampleFormat,
        _out: &mut Vec<u8>,
        _preview: &mut Vec<f64>,
    ) -> Result<usize> {
        Err(crate::DecodeError::Unsupported(
            "该音源没有 DSD 数据".into(),
        ))
    }

    fn format(&self) -> AudioFormat {
        self.info().format
    }

    /// 追加一块交错样本到 `out`，返回追加的帧数；`0` 表示已到结尾。
    fn read(&mut self, out: &mut Vec<f64>) -> Result<usize>;

    /// 跳转到指定毫秒，返回实际落点（毫秒）。
    fn seek(&mut self, position_ms: u64) -> Result<u64>;

    /// 下一帧在曲目时间线上的序号。
    fn position_frames(&self) -> u64;
}

//! 解码层：把各种容器/编码统一成交错 `f64` 的 [`AudioSource`]。

mod cd;
mod cover;
mod dsd;
mod dst;
mod dst_dff;
mod error;
mod ffmpeg;
mod ncm;
mod sacd;
mod source;
mod symphonia_source;

use std::path::Path;

pub use cover::{Cover, read_cover};
pub use error::{DecodeError, Result};
pub use ncm::NcmReader;
pub use source::AudioSource;
pub use symphonia_source::SymphoniaSource;

/// DSF/DFF 使用流式 DSD 读取器，其余容器使用 Symphonia。
pub fn open(path: &Path) -> Result<Box<dyn AudioSource>> {
    // Raw DTS sync words can be misidentified as MPEG audio by a generic probe.
    if path.extension().is_some_and(|ext| {
        ["dts", "dtshd", "ape"]
            .iter()
            .any(|v| ext.eq_ignore_ascii_case(v))
    }) {
        return Ok(Box::new(ffmpeg::FfmpegSource::open(path)?));
    }
    if path
        .extension()
        .is_some_and(|v| v.eq_ignore_ascii_case("iso"))
    {
        return match sacd::open(path) {
            Ok(source) => Ok(Box::new(source)),
            Err(_) => Ok(Box::new(cd::CdSource::open(path)?)),
        };
    }
    if path
        .extension()
        .is_some_and(|v| v.eq_ignore_ascii_case("cue"))
    {
        return Ok(Box::new(cd::CdSource::open(path)?));
    }
    if path
        .extension()
        .and_then(|v| v.to_str())
        .is_some_and(|v| v.eq_ignore_ascii_case("dsf") || v.eq_ignore_ascii_case("dff"))
    {
        return Ok(Box::new(dsd::DsdSource::open(path)?));
    }
    match SymphoniaSource::open(path) {
        Ok(source) => Ok(Box::new(source)),
        Err(_)
            if path.extension().is_some_and(|ext| {
                ["ape", "dts", "dtshd", "wv"]
                    .iter()
                    .any(|v| ext.eq_ignore_ascii_case(v))
            }) =>
        {
            Ok(Box::new(ffmpeg::FfmpegSource::open(path)?))
        }
        Err(error) => Err(error),
    }
}

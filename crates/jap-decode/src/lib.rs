//! 解码层：把各种容器/编码统一成交错 `f64` 的 [`AudioSource`]。

mod cd;
mod cover;
pub mod disc;
mod dsd;
mod dst;
mod dst_dff;
mod error;
mod ffmpeg;
mod lyrics;
pub mod midi;
mod ncm;
mod sacd;
mod source;
mod symphonia_source;
mod wave;
pub use lyrics::read_lyrics;

use std::path::Path;

pub use cover::sniff_mime as cover_mime;
pub use cover::{Cover, read_cover};
pub use error::{DecodeError, Result};
pub use ncm::NcmReader;
pub use source::AudioSource;
pub use symphonia_source::SymphoniaSource;

/// DSF/DFF 使用流式 DSD 读取器，其余容器使用 Symphonia。
pub fn open(path: &Path) -> Result<Box<dyn AudioSource>> {
    if path
        .extension()
        .is_some_and(|v| v.eq_ignore_ascii_case("wav") || v.eq_ignore_ascii_case("wave"))
        && let Ok(source) = wave::WaveSource::open(path)
    {
        return Ok(Box::new(source));
    }
    if let Some((source, track)) = disc::parse(path)? {
        return disc::open(&source, Some(track));
    }
    if midi::is_midi(path) {
        return Ok(Box::new(midi::MidiSource::open(path)?));
    }
    // Raw DTS sync words can be misidentified as MPEG audio by a generic probe.
    if path.extension().is_some_and(|ext| {
        ["dts", "dtshd", "ape"]
            .iter()
            .any(|v| ext.eq_ignore_ascii_case(v))
    }) {
        return Ok(Box::new(ffmpeg::FfmpegSource::open(path)?));
    }
    if path.extension().is_some_and(|v| {
        ["iso", "bin", "img"]
            .iter()
            .any(|e| v.eq_ignore_ascii_case(e))
    }) {
        return disc::open(path, None);
    }
    if path
        .extension()
        .is_some_and(|v| v.eq_ignore_ascii_case("cue"))
    {
        return disc::open(path, None);
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
                [
                    "ape", "dts", "dtshd", "wv", "flac", "wav", "wave", "aiff", "aif",
                ]
                .iter()
                .any(|v| ext.eq_ignore_ascii_case(v))
            }) =>
        {
            // Keep a streaming fallback for codecs/containers outside the native
            // reader. The patched native FLAC reader supports all 20-bit rates.
            Ok(Box::new(ffmpeg::FfmpegSource::open(path)?))
        }
        Err(error) => Err(error),
    }
}

#[cfg(test)]
mod high_rate_tests {
    use super::*;
    #[test]
    fn native_768khz_flac_seeks_inside_its_final_frame_sample_exactly() {
        let path =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../../scripts/fixtures/pcm24-768.flac");
        let mut source = SymphoniaSource::open(&path).unwrap();
        assert_eq!(source.info().format.sample_rate, 768000);
        source.seek(5).unwrap();
        let mut samples = Vec::new();
        while source.read(&mut samples).unwrap() > 0 {}
        assert_eq!(samples.len(), (8192 - 3840) * 2);
        for i in 3840..8192usize {
            assert_eq!(
                samples[(i - 3840) * 2],
                (((i * 3511) % 14000001) as f64 - 7000000.) / 8388608.
            );
            assert_eq!(
                samples[(i - 3840) * 2 + 1],
                (7000000. - ((i * 7193) % 14000001) as f64) / 8388608.
            );
        }
        source.seek(0).unwrap();
        samples.clear();
        assert!(source.read(&mut samples).unwrap() > 0);
        assert_eq!(samples[0], -7000000. / 8388608.);
    }
}

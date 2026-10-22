//! Bounded RIFF/RF64 PCM reader, including WAVE_EXTENSIBLE IEEE float64.
use crate::{AudioSource, DecodeError, Result};
use jap_core::{AudioFormat, TrackInfo};
use std::{
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::Path,
};

pub struct WaveSource {
    file: File,
    info: TrackInfo,
    start: u64,
    frames: u64,
    position: u64,
    align: usize,
    bytes: Vec<u8>,
}
impl WaveSource {
    pub fn open(path: &Path) -> Result<Self> {
        let mut file = File::open(path)?;
        let length = file.metadata()?.len();
        let mut head = [0; 12];
        file.read_exact(&mut head)?;
        if !matches!(&head[..4], b"RIFF" | b"RF64" | b"BW64") || &head[8..] != b"WAVE" {
            return Err(DecodeError::Unsupported("不是 RIFF/RF64 WAVE".into()));
        }
        let mut format = None;
        let mut data = None;
        let mut rf64_data = None;
        let (mut title, mut artist, mut album) = (None, None, None);
        while file.stream_position()?.saturating_add(8) <= length {
            let mut h = [0; 8];
            file.read_exact(&mut h)?;
            let mut size = u64::from(u32::from_le_bytes(h[4..].try_into().unwrap()));
            let start = file.stream_position()?;
            if &h[..4] == b"data" && size == u64::from(u32::MAX) {
                size = rf64_data.ok_or_else(|| DecodeError::Decode("RF64 缺少 ds64".into()))?;
            }
            let end = start
                .checked_add(size)
                .filter(|&v| v <= length)
                .ok_or_else(|| DecodeError::Decode("截断的 WAVE 数据块".into()))?;
            match &h[..4] {
                b"ds64" if size >= 28 => {
                    let mut ds = [0; 28];
                    file.read_exact(&mut ds)?;
                    rf64_data = Some(u64::from_le_bytes(ds[8..16].try_into().unwrap()));
                }
                b"fmt " if (16..=4096).contains(&size) => {
                    let mut fmt = vec![0; size as usize];
                    file.read_exact(&mut fmt)?;
                    let mut kind = u16::from_le_bytes(fmt[..2].try_into().unwrap());
                    let channels = u16::from_le_bytes(fmt[2..4].try_into().unwrap());
                    let rate = u32::from_le_bytes(fmt[4..8].try_into().unwrap());
                    let align = u16::from_le_bytes(fmt[12..14].try_into().unwrap());
                    let bits = u16::from_le_bytes(fmt[14..16].try_into().unwrap());
                    let mut valid = bits;
                    if kind == 0xfffe && fmt.len() >= 40 {
                        valid = u16::from_le_bytes(fmt[18..20].try_into().unwrap());
                        if valid == 0 {
                            valid = bits;
                        }
                        if fmt[26..40] != [0, 0, 0, 0, 16, 0, 128, 0, 0, 170, 0, 56, 155, 113] {
                            return Err(DecodeError::Unsupported("WAVE 子格式 GUID".into()));
                        }
                        kind = u16::from_le_bytes(fmt[24..26].try_into().unwrap());
                    }
                    if channels == 0
                        || channels > 32
                        || rate == 0
                        || rate > 12_288_000
                        || align as u32 != u32::from(channels) * u32::from(bits) / 8
                        || valid > bits
                        || valid == 0
                        || !(kind == 1 && [8, 16, 24, 32].contains(&bits)
                            || kind == 3 && [32, 64].contains(&bits))
                    {
                        return Err(DecodeError::Unsupported("WAVE PCM 参数/编码".into()));
                    }
                    format = Some((
                        AudioFormat {
                            sample_rate: rate,
                            channels,
                            bits: Some(u32::from(valid)),
                            float: kind == 3,
                        },
                        usize::from(align),
                        bits,
                    ));
                }
                b"data" if data.is_none() => data = Some((start, size)),
                b"LIST" if (4..=1_048_576).contains(&size) => {
                    let mut tags = vec![0; size as usize];
                    file.read_exact(&mut tags)?;
                    if &tags[..4] == b"INFO" {
                        let mut at = 4;
                        while at + 8 <= tags.len() {
                            let n = u32::from_le_bytes(tags[at + 4..at + 8].try_into().unwrap())
                                as usize;
                            if at + 8 + n > tags.len() {
                                break;
                            }
                            let text = String::from_utf8_lossy(&tags[at + 8..at + 8 + n])
                                .trim_matches('\0')
                                .trim()
                                .to_owned();
                            let slot = match &tags[at..at + 4] {
                                b"INAM" => Some(&mut title),
                                b"IART" => Some(&mut artist),
                                b"IPRD" => Some(&mut album),
                                _ => None,
                            };
                            if let Some(slot) = slot
                                && !text.is_empty()
                            {
                                *slot = Some(text);
                            }
                            at += 8 + n + (n % 2);
                        }
                    }
                }
                _ => {}
            }
            file.seek(SeekFrom::Start(end.saturating_add(size % 2)))?;
        }
        let (format, align, storage_bits) =
            format.ok_or_else(|| DecodeError::Decode("WAVE 缺少 fmt".into()))?;
        let (start, size) = data.ok_or_else(|| DecodeError::Decode("WAVE 缺少 data".into()))?;
        if size % align as u64 != 0 {
            return Err(DecodeError::Decode("WAVE 帧被截断".into()));
        }
        // Keep storage width separate: extensible PCM valid bits are left aligned.
        let codec = format!(
            "PCM {}{} / {}",
            if format.float { "F" } else { "S" },
            storage_bits,
            if &head[..4] == b"RIFF" {
                "WAVE"
            } else {
                "RF64-WAVE"
            }
        );
        let frames = size / align as u64;
        let info = TrackInfo {
            path: path.display().to_string(),
            codec,
            format,
            duration_ms: Some(frames * 1000 / u64::from(format.sample_rate)),
            lossless: true,
            bitrate_kbps: None,
            title,
            artist,
            album,
        };
        file.seek(SeekFrom::Start(start))?;
        Ok(Self {
            file,
            info,
            start,
            frames,
            position: 0,
            align,
            bytes: Vec::new(),
        })
    }
}
impl AudioSource for WaveSource {
    fn info(&self) -> &TrackInfo {
        &self.info
    }
    fn read(&mut self, out: &mut Vec<f64>) -> Result<usize> {
        let frames = (self.frames - self.position).min(16_384) as usize;
        self.bytes.resize(frames * self.align, 0);
        self.file.read_exact(&mut self.bytes)?;
        let width = self.align / usize::from(self.info.format.channels);
        for s in self.bytes.chunks_exact(width) {
            let value = if self.info.format.float {
                if width == 8 {
                    f64::from_le_bytes(s.try_into().unwrap())
                } else {
                    f32::from_le_bytes(s.try_into().unwrap()) as f64
                }
            } else {
                match width {
                    1 => (f64::from(s[0]) - 128.) / 128.,
                    2 => f64::from(i16::from_le_bytes(s.try_into().unwrap())) / 32768.,
                    3 => f64::from(i32::from_le_bytes([0, s[0], s[1], s[2]])) / 2147483648.,
                    4 => f64::from(i32::from_le_bytes(s.try_into().unwrap())) / 2147483648.,
                    _ => unreachable!(),
                }
            };
            out.push(value);
        }
        self.position += frames as u64;
        Ok(frames)
    }
    fn seek(&mut self, ms: u64) -> Result<u64> {
        self.position = (u128::from(ms) * u128::from(self.info.format.sample_rate) / 1000)
            .min(u128::from(self.frames)) as u64;
        self.file.seek(SeekFrom::Start(
            self.start + self.position * self.align as u64,
        ))?;
        Ok(self.position * 1000 / u64::from(self.info.format.sample_rate))
    }
    fn position_frames(&self) -> u64 {
        self.position
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    struct Fixture(std::path::PathBuf);
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }
    fn fixture(bytes: &[u8]) -> Fixture {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "jap-wave-{}-{}.wav",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::write(&path, bytes).unwrap();
        Fixture(path)
    }
    fn rf64(rate: u32, frames: usize) -> Vec<u8> {
        let mut b = Vec::new();
        b.extend(b"RF64");
        b.extend(u32::MAX.to_le_bytes());
        b.extend(b"WAVEds64");
        b.extend(28u32.to_le_bytes());
        b.extend((96 + frames as u64 * 16).to_le_bytes());
        b.extend((frames as u64 * 16).to_le_bytes());
        b.extend((frames as u64).to_le_bytes());
        b.extend(0u32.to_le_bytes());
        b.extend(b"fmt ");
        b.extend(40u32.to_le_bytes());
        b.extend(0xfffeu16.to_le_bytes());
        b.extend(2u16.to_le_bytes());
        b.extend(rate.to_le_bytes());
        b.extend(rate.saturating_mul(16).to_le_bytes());
        b.extend(16u16.to_le_bytes());
        b.extend(64u16.to_le_bytes());
        b.extend(22u16.to_le_bytes());
        b.extend(64u16.to_le_bytes());
        b.extend(3u32.to_le_bytes());
        b.extend([3, 0, 0, 0, 0, 0, 16, 0, 128, 0, 0, 170, 0, 56, 155, 113]);
        b.extend(b"data");
        b.extend(u32::MAX.to_le_bytes());
        for i in 0..frames {
            b.extend((i as f64 / 65536.).to_le_bytes());
            b.extend((-(i as f64) / 65536.).to_le_bytes());
        }
        b
    }
    #[test]
    fn rf64_extensible_float64_is_bounded_and_sample_exact_after_seek() {
        let f = fixture(&rf64(6_144_000, 40_000));
        let mut s = WaveSource::open(&f.0).unwrap();
        assert_eq!(s.info.format.sample_rate, 6_144_000);
        assert_eq!(s.info.format.bits, Some(64));
        assert!(s.info.format.float);
        let mut out = Vec::new();
        let first = s.read(&mut out).unwrap();
        assert_eq!(first, 16_384);
        assert_eq!(out.len(), first * 2);
        for (i, pair) in out.as_chunks::<2>().0.iter().enumerate() {
            assert_eq!(pair, &[i as f64 / 65536., -(i as f64) / 65536.]);
        }
        assert_eq!(s.seek(3).unwrap(), 3);
        out.clear();
        let n = s.read(&mut out).unwrap();
        assert!(n <= 16_384);
        assert_eq!(out[0], 18432. / 65536.);
        assert_eq!(s.position_frames(), 18432 + n as u64);
        s.seek(500).unwrap();
        out.clear();
        assert_eq!(s.read(&mut out).unwrap(), 0);
    }
    #[test]
    fn rf64_u64_bounds_and_truncated_frames_are_rejected() {
        let mut bytes = rf64(48000, 10);
        bytes[28..36].copy_from_slice(&(1u64 << 34).to_le_bytes());
        let f = fixture(&bytes);
        assert!(WaveSource::open(&f.0).is_err());
        let mut bytes = rf64(48000, 10);
        bytes[28..36].copy_from_slice(&159u64.to_le_bytes());
        let f = fixture(&bytes);
        assert!(WaveSource::open(&f.0).is_err());
        let f = fixture(&rf64(0, 10));
        assert!(WaveSource::open(&f.0).is_err());
    }
}

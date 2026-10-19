//! Raw CD-DA images with a matching CUE descriptor. Never guess PCM from data ISO bytes.
use crate::{AudioSource, DecodeError, Result};
use jap_core::{AudioFormat, TrackInfo};
use std::{
    fs::{self, File},
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
};
pub struct CdSource {
    file: File,
    info: TrackInfo,
    start: u64,
    frames: u64,
    pos: u64,
    big_endian: bool,
}
impl CdSource {
    pub fn open(path: &Path) -> Result<Self> {
        let cue = if path
            .extension()
            .is_some_and(|v| v.eq_ignore_ascii_case("cue"))
        {
            path.to_path_buf()
        } else {
            path.with_extension("cue")
        };
        let text = fs::read_to_string(&cue).map_err(|_| {
            DecodeError::Unsupported(
                "CD-DA 镜像需要同名 .cue 来确认音轨布局；数据 ISO 不会当作 PCM 播放".into(),
            )
        })?;
        let mut image: Option<PathBuf> = None;
        let mut audio = false;
        let mut start = None;
        let mut end = None;
        let mut big_endian = false;
        for line in text.lines() {
            let line = line.trim();
            let upper = line.to_ascii_uppercase();
            if upper.starts_with("FILE ") {
                if !upper.ends_with("BINARY") && !upper.ends_with("MOTOROLA") {
                    return Err(DecodeError::Unsupported(
                        "压缩音频 / WAV CUE 请导入其音频文件；CD 镜像支持 BINARY / MOTOROLA 扇区"
                            .into(),
                    ));
                }
                if image.is_some() {
                    return Err(DecodeError::Unsupported(
                        "多文件 CUE 请分别导入音频文件".into(),
                    ));
                }
                let name = line
                    .split('"')
                    .nth(1)
                    .or_else(|| line.split_whitespace().nth(1))
                    .unwrap_or("");
                image = Some(cue.parent().unwrap_or(Path::new("")).join(name));
                big_endian = upper.ends_with("MOTOROLA");
            } else if upper.starts_with("TRACK ") {
                audio = upper.ends_with("AUDIO");
            } else if upper.starts_with("INDEX 01 ") {
                let parts: Vec<_> = line
                    .split_whitespace()
                    .nth(2)
                    .unwrap_or("")
                    .split(':')
                    .filter_map(|v| v.parse::<u64>().ok())
                    .collect();
                if parts.len() != 3 || parts[1] >= 60 || parts[2] >= 75 {
                    return Err(DecodeError::Decode("CUE 时间码无效".into()));
                }
                let sector = (parts[0] * 60 + parts[1]) * 75 + parts[2];
                if audio && start.is_none() {
                    start = Some(sector * 2352)
                } else if !audio && start.is_some() && end.is_none() {
                    end = Some(sector * 2352)
                }
            }
        }
        let image = image.ok_or_else(|| DecodeError::Decode("CUE 缺少 FILE".into()))?;
        let mut file = File::open(image)?;
        let len = file.metadata()?.len();
        let start = start.ok_or_else(|| DecodeError::Unsupported("CUE 没有 AUDIO 音轨".into()))?;
        let end = end.unwrap_or(len);
        if end <= start || end > len || !(end - start).is_multiple_of(2352) {
            return Err(DecodeError::Decode("CD-DA sector bounds".into()));
        }
        file.seek(SeekFrom::Start(start))?;
        let frames = (end - start) / 4;
        let info = TrackInfo {
            path: path.display().to_string(),
            codec: "CD image / PCM".into(),
            format: AudioFormat {
                sample_rate: 44100,
                channels: 2,
                bits: Some(16),
                float: false,
            },
            duration_ms: Some(frames * 1000 / 44100),
            lossless: true,
            bitrate_kbps: Some(1411),
            title: path.file_stem().map(|s| s.to_string_lossy().into_owned()),
            artist: None,
            album: None,
        };
        Ok(Self {
            file,
            info,
            start,
            frames,
            pos: 0,
            big_endian,
        })
    }
}
impl AudioSource for CdSource {
    fn info(&self) -> &TrackInfo {
        &self.info
    }
    fn read(&mut self, out: &mut Vec<f64>) -> Result<usize> {
        let n = (self.frames - self.pos).min(4096) as usize;
        let mut bytes = vec![0; n * 4];
        self.file.read_exact(&mut bytes)?;
        for b in bytes.as_chunks::<2>().0 {
            out.push(
                f64::from(if self.big_endian {
                    i16::from_be_bytes(*b)
                } else {
                    i16::from_le_bytes(*b)
                }) / 32768.,
            )
        }
        self.pos += n as u64;
        Ok(n)
    }
    fn seek(&mut self, ms: u64) -> Result<u64> {
        self.pos = (ms * 44100 / 1000).min(self.frames);
        self.file.seek(SeekFrom::Start(self.start + self.pos * 4))?;
        Ok(self.pos * 1000 / 44100)
    }
    fn position_frames(&self) -> u64 {
        self.pos
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cue_image_reads_exact_cd_samples_and_seeks() {
        let dir = std::env::temp_dir().join(format!("jap-cd-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let image = dir.join("disc.iso");
        let cue = dir.join("disc.cue");
        let samples: Vec<i16> = (0..588 * 2 * 3)
            .map(|i| (i % 30000 - 15000) as i16)
            .collect();
        let bytes: Vec<u8> = samples.iter().flat_map(|s| s.to_le_bytes()).collect();
        std::fs::write(&image, bytes).unwrap();
        std::fs::write(
            &cue,
            "FILE \"disc.iso\" BINARY\n TRACK 01 AUDIO\n INDEX 01 00:00:00\n",
        )
        .unwrap();
        let mut source = CdSource::open(&image).unwrap();
        let mut out = Vec::new();
        assert_eq!(source.read(&mut out).unwrap(), 1764);
        assert_eq!(
            out,
            samples
                .iter()
                .map(|&s| f64::from(s) / 32768.)
                .collect::<Vec<_>>()
        );
        source.seek(20).unwrap();
        assert_eq!(source.position_frames(), 882);
        drop(source);
        std::fs::remove_file(&cue).unwrap();
        assert!(CdSource::open(&image).is_err());
        std::fs::remove_file(image).unwrap();
        std::fs::remove_dir(dir).unwrap();
    }
}

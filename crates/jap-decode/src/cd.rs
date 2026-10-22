//! CD-DA images with CUE track boundaries and album/track CD-Text.
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
struct CueTrack {
    image: PathBuf,
    big_endian: bool,
    audio: bool,
    start: Option<u64>,
    title: Option<String>,
    artist: Option<String>,
    number: u32,
}
struct Cue {
    path: PathBuf,
    album: Option<String>,
    artist: Option<String>,
    tracks: Vec<CueTrack>,
}
fn bad(s: &str) -> DecodeError {
    DecodeError::Decode(s.into())
}
fn value(line: &str) -> String {
    let value = line
        .split_once(char::is_whitespace)
        .map_or("", |(_, v)| v)
        .trim();
    value
        .strip_prefix('"')
        .and_then(|v| v.strip_suffix('"'))
        .unwrap_or(value)
        .to_owned()
}
fn parse(path: &Path) -> Result<Cue> {
    let cue = if path
        .extension()
        .is_some_and(|v| v.eq_ignore_ascii_case("cue"))
    {
        path.to_path_buf()
    } else {
        let name = path.with_extension("cue");
        if name.exists() {
            name
        } else {
            path.with_extension("CUE")
        }
    };
    let len = fs::metadata(&cue)
        .map_err(|_| {
            DecodeError::Unsupported(
                "CD-DA 镜像需要配套 CUE 轨道表；普通数据 ISO 不包含 CD 音轨边界".into(),
            )
        })?
        .len();
    if len > 16 * 1024 * 1024 {
        return Err(bad("CUE 超过大小限制"));
    }
    let bytes = fs::read(&cue)?;
    let text = if bytes.starts_with(&[0xff, 0xfe]) {
        encoding_rs::UTF_16LE.decode(&bytes[2..]).0.into_owned()
    } else if bytes.starts_with(&[0xfe, 0xff]) {
        encoding_rs::UTF_16BE.decode(&bytes[2..]).0.into_owned()
    } else {
        String::from_utf8(bytes.clone())
            .unwrap_or_else(|_| encoding_rs::GBK.decode(&bytes).0.into_owned())
    };
    let (mut album, mut artist, mut image) = (None, None, None::<PathBuf>);
    let mut big_endian = false;
    let mut tracks: Vec<CueTrack> = Vec::new();
    for line in text.trim_start_matches('\u{feff}').lines().map(str::trim) {
        let key = line
            .split_whitespace()
            .next()
            .unwrap_or("")
            .to_ascii_uppercase();
        match key.as_str() {
            "FILE" => {
                let v = value(line);
                let (name, kind) = if let Some(quoted) = v.strip_prefix('"') {
                    let end = quoted.rfind('"').ok_or_else(|| bad("CUE FILE 引号无效"))?;
                    (&quoted[..end], quoted[end + 1..].trim())
                } else {
                    v.rsplit_once(char::is_whitespace)
                        .ok_or_else(|| bad("CUE FILE 无效"))?
                };
                if !kind.eq_ignore_ascii_case("BINARY") && !kind.eq_ignore_ascii_case("MOTOROLA") {
                    return Err(DecodeError::Unsupported(
                        "CD CUE 支持 BINARY / MOTOROLA 原始扇区镜像".into(),
                    ));
                }
                if name.is_empty() {
                    return Err(bad("CUE FILE 为空"));
                }
                image = Some(
                    cue.parent()
                        .unwrap_or(Path::new(""))
                        .join(name.replace('\\', "/")),
                );
                big_endian = kind.eq_ignore_ascii_case("MOTOROLA");
            }
            "TRACK" => {
                let mut parts = line.split_whitespace().skip(1);
                let number = parts
                    .next()
                    .and_then(|v| v.parse::<u32>().ok())
                    .ok_or_else(|| bad("CUE TRACK 无效"))?;
                if tracks.len() >= 255 {
                    return Err(bad("CUE 曲目超过限制"));
                }
                let audio = parts
                    .next()
                    .is_some_and(|v| v.eq_ignore_ascii_case("AUDIO"));
                tracks.push(CueTrack {
                    image: image.clone().ok_or_else(|| bad("CUE 缺少 FILE"))?,
                    big_endian,
                    audio,
                    start: None,
                    title: None,
                    artist: None,
                    number,
                });
            }
            "TITLE" => {
                if let Some(t) = tracks.last_mut() {
                    t.title = Some(value(line));
                } else {
                    album = Some(value(line));
                }
            }
            "PERFORMER" => {
                if let Some(t) = tracks.last_mut() {
                    t.artist = Some(value(line));
                } else {
                    artist = Some(value(line));
                }
            }
            "INDEX" => {
                let parts: Vec<_> = line.split_whitespace().collect();
                if parts.get(1) != Some(&"01") {
                    continue;
                }
                let numbers: Vec<_> = parts
                    .get(2)
                    .unwrap_or(&"")
                    .split(':')
                    .filter_map(|v| v.parse::<u64>().ok())
                    .collect();
                if numbers.len() != 3 || numbers[0] > 999 || numbers[1] >= 60 || numbers[2] >= 75 {
                    return Err(bad("CUE 时间码无效"));
                }
                let start = ((numbers[0] * 60 + numbers[1]) * 75 + numbers[2]) * 2352;
                tracks
                    .last_mut()
                    .ok_or_else(|| bad("CUE INDEX 缺少 TRACK"))?
                    .start = Some(start);
            }
            _ => {}
        }
    }
    if !tracks.iter().any(|t| t.audio) {
        return Err(bad("CUE 没有 AUDIO 音轨"));
    }
    Ok(Cue {
        path: cue,
        album,
        artist,
        tracks,
    })
}
fn bounds(cue: &Cue, index: usize) -> Result<(u64, u64)> {
    let selected = &cue.tracks[index];
    let len = fs::metadata(&selected.image)?.len();
    let start = selected.start.ok_or_else(|| bad("CUE 音轨缺少 INDEX 01"))?;
    let end = cue
        .tracks
        .get(index + 1)
        .filter(|t| t.image == selected.image)
        .map(|t| t.start.ok_or_else(|| bad("CUE 音轨缺少 INDEX 01")))
        .transpose()?
        .unwrap_or(len);
    if end <= start || end > len || !(end - start).is_multiple_of(2352) {
        return Err(bad("CD-DA 音轨扇区越界"));
    }
    Ok((start, (end - start) / 4))
}
fn info(
    path: &Path,
    cue: &Cue,
    index: usize,
    ordinal: usize,
    frames: u64,
    virtual_path: bool,
) -> TrackInfo {
    let selected = &cue.tracks[index];
    TrackInfo {
        path: if virtual_path {
            crate::disc::track_path(&cue.path, ordinal)
        } else {
            path.display().to_string()
        },
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
        title: selected
            .title
            .clone()
            .or_else(|| Some(format!("曲目 {:02}", selected.number))),
        artist: selected.artist.clone().or_else(|| cue.artist.clone()),
        album: cue.album.clone(),
    }
}
pub fn tracks(path: &Path) -> Result<Vec<TrackInfo>> {
    let cue = parse(path)?;
    let mut out = Vec::new();
    for (index, t) in cue.tracks.iter().enumerate().filter(|(_, t)| t.audio) {
        let (_, frames) = bounds(&cue, index)?;
        let _ = t;
        out.push(info(path, &cue, index, out.len() + 1, frames, true));
    }
    Ok(out)
}
impl CdSource {
    pub fn open_track(path: &Path, track: Option<usize>) -> Result<Self> {
        let cue = parse(path)?;
        let ordinal = track.unwrap_or(1);
        let index = ordinal
            .checked_sub(1)
            .and_then(|n| {
                cue.tracks
                    .iter()
                    .enumerate()
                    .filter(|(_, t)| t.audio)
                    .nth(n)
                    .map(|(i, _)| i)
            })
            .ok_or_else(|| bad("CD 音轨不存在"))?;
        let selected = &cue.tracks[index];
        let (start, frames) = bounds(&cue, index)?;
        let mut file = File::open(&selected.image)?;
        file.seek(SeekFrom::Start(start))?;
        Ok(Self {
            file,
            info: info(path, &cue, index, ordinal, frames, track.is_some()),
            start,
            frames,
            pos: 0,
            big_endian: selected.big_endian,
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
            );
        }
        self.pos += n as u64;
        Ok(n)
    }
    fn seek(&mut self, ms: u64) -> Result<u64> {
        self.pos = (u128::from(ms) * 44100 / 1000).min(u128::from(self.frames)) as u64;
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
    fn mixed_mode_and_multiple_files_split_with_cd_text() {
        let dir = std::env::temp_dir().join(format!("jap-cd-multi-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let first = dir.join("disc one.bin");
        let second = dir.join("disc two.bin");
        fs::write(&first, vec![0x10; 2352 * 5]).unwrap();
        fs::write(&second, vec![0x20; 2352 * 2]).unwrap();
        let cue = dir.join("album.cue");
        fs::write(&cue, "TITLE \"Album\"\nPERFORMER \"Artist\"\nFILE \"disc one.bin\" BINARY\nTRACK 01 AUDIO\nTITLE \"First\"\nINDEX 01 00:00:00\nTRACK 02 AUDIO\nTITLE \"Second\"\nPERFORMER \"Guest\"\nINDEX 01 00:00:02\nTRACK 03 MODE1/2352\nINDEX 01 00:00:04\nFILE \"disc two.bin\" MOTOROLA\nTRACK 04 AUDIO\nTITLE \"Last\"\nINDEX 01 00:00:00\n").unwrap();
        let entries = tracks(&cue).unwrap();
        assert_eq!(entries.len(), 3);
        assert_eq!(entries[1].title.as_deref(), Some("Second"));
        assert_eq!(entries[1].artist.as_deref(), Some("Guest"));
        for track in entries {
            assert_eq!(track.album.as_deref(), Some("Album"));
            let mut source = crate::open(Path::new(&track.path)).unwrap();
            let mut samples = Vec::new();
            assert_eq!(source.read(&mut samples).unwrap(), 588 * 2);
            assert_eq!(source.read(&mut samples).unwrap(), 0);
            source.seek(10).unwrap();
            assert_eq!(source.read(&mut Vec::new()).unwrap(), 1176 - 441);
        }
        for path in [first, second, cue] {
            fs::remove_file(path).unwrap();
        }
        fs::remove_dir(dir).unwrap();
    }
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
        let mut source = CdSource::open_track(&image, None).unwrap();
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
        assert!(CdSource::open_track(&image, None).is_err());
        std::fs::remove_file(image).unwrap();
        std::fs::remove_dir(dir).unwrap();
    }
}

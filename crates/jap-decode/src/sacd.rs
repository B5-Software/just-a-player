//! SACD ISO sector/packet reader. Raw DSD and lossless DST share the DSD transport.
//! Scarlet Book structures cross-checked against sacd-ripper (GPL-2.0-or-later).
use crate::{
    DecodeError, Result,
    dsd::{DsdSource, RawDsd},
    dst::DstDecoder,
};
use jap_core::{AudioFormat, TrackInfo};
use std::{
    collections::VecDeque,
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::Path,
};
const SECTOR: u64 = 2048;
fn bad(msg: &str) -> DecodeError {
    DecodeError::Decode(msg.into())
}
fn be32(b: &[u8]) -> u32 {
    u32::from_be_bytes(b.try_into().unwrap())
}
fn sector(file: &mut File, lsn: u64) -> Result<[u8; 2048]> {
    let mut b = [0; 2048];
    file.seek(SeekFrom::Start(lsn * SECTOR))?;
    file.read_exact(&mut b)?;
    Ok(b)
}
fn time(b: &[u8]) -> Result<u64> {
    if b.len() < 3 || b[1] >= 60 || b[2] >= 75 {
        return Err(bad("SACD timecode"));
    }
    Ok((u64::from(b[0]) * 60 + u64::from(b[1])) * 75 + u64::from(b[2]))
}
struct Frame {
    time: u64,
    dst: bool,
    data: Vec<u8>,
}
struct IsoReader {
    file: File,
    start: u64,
    end: u64,
    lsn: u64,
    channels: usize,
    base: u64,
    pending: Option<Frame>,
    ready: VecDeque<Frame>,
    raw: Vec<u8>,
    raw_offset: usize,
    decoder: DstDecoder,
}
impl IsoReader {
    fn step(&mut self) -> Result<()> {
        if self.lsn > self.end {
            if let Some(frame) = self.pending.take() {
                self.ready.push_back(frame)
            }
            return Ok(());
        }
        let b = sector(&mut self.file, self.lsn)?;
        self.lsn += 1;
        let packets = usize::from(b[0] >> 5);
        let frames = usize::from((b[0] >> 2) & 7);
        let dst = b[0] & 1 != 0;
        let header = 1 + packets * 2;
        let frame_size = if dst { 4 } else { 3 };
        let mut data = header + frames * frame_size;
        let mut frame_index = 0;
        if data > 2048 {
            return Err(bad("SACD sector header"));
        }
        for i in 0..packets {
            let p = &b[1 + i * 2..3 + i * 2];
            let len = (usize::from(p[0] & 7) << 8) | usize::from(p[1]);
            let kind = (p[0] >> 3) & 7;
            if data + len > 2048 {
                return Err(bad("SACD packet exceeds sector"));
            }
            if kind == 2 {
                if p[0] & 128 != 0 {
                    if frame_index >= frames {
                        return Err(bad("SACD missing frame timecode"));
                    }
                    if let Some(frame) = self.pending.take() {
                        self.ready.push_back(frame)
                    }
                    let at = time(&b[header + frame_index * frame_size..])?;
                    frame_index += 1;
                    self.pending = Some(Frame {
                        time: at,
                        dst,
                        data: Vec::new(),
                    });
                }
                if let Some(frame) = self.pending.as_mut() {
                    if frame.data.len() + len > 65536 {
                        return Err(bad("SACD frame exceeds limit"));
                    }
                    frame.data.extend_from_slice(&b[data..data + len]);
                }
            }
            data += len;
        }
        Ok(())
    }
    fn frame(&mut self) -> Result<Option<Frame>> {
        loop {
            if let Some(frame) = self.ready.pop_front() {
                return Ok(Some(frame));
            }
            if self.lsn > self.end && self.pending.is_none() {
                return Ok(None);
            }
            self.step()?;
        }
    }
    fn decode(&mut self, frame: Frame) -> Result<()> {
        self.raw = if frame.dst {
            self.decoder.decode(&frame.data)?
        } else {
            frame.data
        };
        if self.raw.len() != 4704 * self.channels {
            return Err(bad("SACD DSD frame length mismatch"));
        }
        self.raw_offset = 0;
        Ok(())
    }
    fn probe_time(&mut self, lsn: u64) -> Result<Option<u64>> {
        for lsn in lsn..=(lsn + 32).min(self.end) {
            let b = sector(&mut self.file, lsn)?;
            let n = usize::from((b[0] >> 2) & 7);
            if n > 0 {
                let h = 1 + usize::from(b[0] >> 5) * 2;
                return time(&b[h..]).map(Some);
            }
        }
        Ok(None)
    }
}
impl RawDsd for IsoReader {
    fn read(&mut self, out: &mut Vec<u8>, max: usize) -> Result<usize> {
        let mut left = max * self.channels;
        let before = out.len();
        while left > 0 {
            if self.raw_offset == self.raw.len() {
                let Some(frame) = self.frame()? else { break };
                self.decode(frame)?;
            }
            let n = left.min(self.raw.len() - self.raw_offset);
            out.extend_from_slice(&self.raw[self.raw_offset..self.raw_offset + n]);
            self.raw_offset += n;
            left -= n;
        }
        Ok((out.len() - before) / self.channels)
    }
    fn seek(&mut self, frame: u64) -> Result<u64> {
        let target = self.base + frame / 4704;
        let mut lo = self.start;
        let mut hi = self.end;
        while hi.saturating_sub(lo) > 64 {
            let mid = (lo + hi) / 2;
            match self.probe_time(mid)? {
                Some(t) if t < target => lo = mid,
                Some(_) => hi = mid,
                None => hi = mid,
            }
        }
        self.lsn = lo.saturating_sub(32).max(self.start);
        self.pending = None;
        self.ready.clear();
        self.raw.clear();
        self.raw_offset = 0;
        loop {
            let Some(next) = self.frame()? else {
                return Ok(frame);
            };
            if next.time >= target {
                let actual = (next.time.saturating_sub(self.base)) * 4704;
                self.decode(next)?;
                let within = if actual <= frame {
                    (frame - actual).min(4703)
                } else {
                    0
                };
                self.raw_offset = within as usize * self.channels;
                return Ok(actual + within);
            }
        }
    }
}
pub fn is_sacd(path: &Path) -> Result<bool> {
    let mut file = File::open(path)?;
    if file.metadata()?.len() < 511 * SECTOR {
        return Ok(false);
    }
    Ok(&sector(&mut file, 510)?[..8] == b"SACDMTOC")
}

struct DiscTrack {
    start: u64,
    end: u64,
    time: u64,
    duration: u64,
    title: Option<String>,
    artist: Option<String>,
}
struct Disc {
    channels: usize,
    dst: bool,
    album: Option<String>,
    artist: Option<String>,
    tracks: Vec<DiscTrack>,
}
fn be16(b: &[u8]) -> usize {
    usize::from(u16::from_be_bytes(b.try_into().unwrap()))
}
fn text(bytes: &[u8], pos: usize, charset: u8) -> Option<String> {
    if pos == 0 || pos >= bytes.len() {
        return None;
    }
    let data = &bytes[pos..];
    let data = &data[..data.iter().position(|&b| b == 0).unwrap_or(data.len())];
    let value = match charset & 7 {
        3 => encoding_rs::SHIFT_JIS.decode(data).0.into_owned(),
        4 => encoding_rs::EUC_KR.decode(data).0.into_owned(),
        5 => encoding_rs::GBK.decode(data).0.into_owned(),
        6 => encoding_rs::BIG5.decode(data).0.into_owned(),
        2 | 7 => data.iter().map(|&b| char::from(b)).collect(),
        _ => String::from_utf8_lossy(data).into_owned(),
    };
    let value = value.trim();
    (!value.is_empty()).then(|| value.to_owned())
}
fn track_text(data: &[u8], index: usize, charset: u8) -> (Option<String>, Option<String>) {
    let offset = 8 + index * 2;
    if offset + 2 > data.len() {
        return (None, None);
    }
    let pos = be16(&data[offset..offset + 2]);
    if pos == 0 || pos + 4 > data.len() {
        return (None, None);
    }
    let mut cursor = pos + 4;
    let (mut title, mut artist) = (None, None);
    for _ in 0..data[pos] {
        if cursor + 2 >= data.len() {
            break;
        }
        let kind = data[cursor];
        cursor += 2;
        match kind {
            1 => title = text(data, cursor, charset),
            2 => artist = text(data, cursor, charset),
            _ => {}
        }
        while cursor < data.len() && data[cursor] != 0 {
            cursor += 1;
        }
        while cursor < data.len() && data[cursor] == 0 {
            cursor += 1;
        }
    }
    (title, artist)
}
fn directory(file: &mut File) -> Result<Disc> {
    let size = file.metadata()?.len();
    let master = sector(file, 510)?;
    if &master[..8] != b"SACDMTOC" {
        return Err(bad("不是 SACD ISO"));
    }
    let (mut area, mut toc) = (0, [0; 2048]);
    // Prefer the stereo area; the other area is another mix of the same album.
    for offset in [64, 72, 68, 76] {
        let lsn = u64::from(be32(&master[offset..offset + 4]));
        if lsn == 0 || (lsn + 1) * SECTOR > size {
            continue;
        }
        let candidate = sector(file, lsn)?;
        if &candidate[..8] == b"TWOCHTOC" {
            area = lsn;
            toc = candidate;
            break;
        }
        if area == 0 && &candidate[..8] == b"MULCHTOC" {
            area = lsn;
            toc = candidate;
        }
    }
    if area == 0 {
        return Err(bad("SACD 缺少有效的区域目录"));
    }
    let channels = usize::from(toc[32]);
    let area_start = u64::from(be32(&toc[72..76]));
    let area_end = u64::from(be32(&toc[76..80]));
    if !(1..=6).contains(&channels) || area_start > area_end || (area_end + 1) * SECTOR > size {
        return Err(bad("SACD area bounds"));
    }
    let (mut album, mut artist) = (None, None);
    // Each language's master text occupies one sector. Prefer the first with text.
    for i in 0..8 {
        let bytes = sector(file, 511 + i)?;
        if &bytes[..8] != b"SACDText" {
            continue;
        }
        let charset = master[138 + i as usize * 4];
        album = text(&bytes, be16(&bytes[16..18]), charset)
            .or_else(|| text(&bytes, be16(&bytes[32..34]), charset));
        artist = text(&bytes, be16(&bytes[18..20]), charset)
            .or_else(|| text(&bytes, be16(&bytes[34..36]), charset));
        if album.is_some() || artist.is_some() {
            break;
        }
    }
    let sectors = be16(&toc[10..12]);
    if sectors > 96 || (area + sectors as u64) * SECTOR > size {
        return Err(bad("SACD TOC 长度无效"));
    }
    let mut data = Vec::with_capacity(sectors * 2048);
    for i in 0..sectors {
        data.extend_from_slice(&sector(file, area + i as u64)?);
    }
    let find = |id: &[u8; 8]| -> Option<&[u8]> {
        (1..sectors)
            .find(|&i| &data[i * 2048..i * 2048 + 8] == id)
            .map(|i| &data[i * 2048..])
    };
    let count = usize::from(toc[69]);
    if count == 0 {
        // Some early rips only contain a continuous area with no track table.
        return Ok(Disc {
            channels,
            dst: toc[21] & 15 == 0,
            album,
            artist,
            tracks: vec![DiscTrack {
                start: area_start,
                end: area_end,
                time: 0,
                duration: time(&toc[64..67])?,
                title: None,
                artist: None,
            }],
        });
    }
    let offsets = find(b"SACDTRL1").ok_or_else(|| bad("SACD 缺少曲目扇区表"))?;
    let times = find(b"SACDTRL2").ok_or_else(|| bad("SACD 缺少曲目时间表"))?;
    if offsets.len() < 2048 || times.len() < 2048 {
        return Err(bad("SACD 曲目表被截断"));
    }
    let names = find(b"SACDTTxt");
    let mut tracks = Vec::with_capacity(count);
    for i in 0..count {
        let start = u64::from(be32(&offsets[8 + i * 4..12 + i * 4]));
        let length = u64::from(be32(&offsets[1028 + i * 4..1032 + i * 4]));
        let end = start
            .checked_add(length)
            .and_then(|v| v.checked_sub(1))
            .ok_or_else(|| bad("SACD 曲目长度无效"))?;
        let at = time(&times[8 + i * 4..11 + i * 4])?;
        let duration = time(&times[1028 + i * 4..1031 + i * 4])?;
        if start < area_start || end > area_end || length == 0 || duration == 0 {
            return Err(bad("SACD 曲目越过音频区域"));
        }
        if tracks
            .last()
            .is_some_and(|previous: &DiscTrack| previous.start >= start || previous.time >= at)
        {
            return Err(bad("SACD 曲目顺序无效"));
        }
        let (title, track_artist) = names.map(|v| track_text(v, i, toc[90])).unwrap_or_default();
        tracks.push(DiscTrack {
            start,
            end,
            time: at,
            duration,
            title,
            artist: track_artist,
        });
    }
    Ok(Disc {
        channels,
        dst: toc[21] & 15 == 0,
        album,
        artist,
        tracks,
    })
}
fn info(path: &Path, disc: &Disc, index: usize, virtual_path: bool) -> TrackInfo {
    let track = &disc.tracks[index];
    TrackInfo {
        path: if virtual_path {
            crate::disc::track_path(path, index + 1)
        } else {
            path.display().to_string()
        },
        codec: if disc.dst {
            "SACD ISO / DST → DSD"
        } else {
            "SACD ISO / DSD"
        }
        .into(),
        format: AudioFormat {
            sample_rate: 2822400,
            channels: disc.channels as u16,
            bits: Some(1),
            float: false,
        },
        duration_ms: Some(track.duration * 1000 / 75),
        lossless: true,
        bitrate_kbps: Some(2822400 * disc.channels as u32 / 1000),
        title: track
            .title
            .clone()
            .or_else(|| Some(format!("曲目 {:02}", index + 1))),
        artist: track.artist.clone().or_else(|| disc.artist.clone()),
        album: disc.album.clone(),
    }
}
pub fn tracks(path: &Path) -> Result<Vec<TrackInfo>> {
    let disc = directory(&mut File::open(path)?)?;
    Ok((0..disc.tracks.len())
        .map(|i| info(path, &disc, i, true))
        .collect())
}
pub fn open_track(path: &Path, track: Option<usize>) -> Result<DsdSource> {
    let mut file = File::open(path)?;
    let disc = directory(&mut file)?;
    let index = track
        .unwrap_or(1)
        .checked_sub(1)
        .filter(|&i| i < disc.tracks.len())
        .ok_or_else(|| bad("SACD 曲目不存在"))?;
    let selected = &disc.tracks[index];
    let info = info(path, &disc, index, track.is_some());
    let mut reader = IsoReader {
        file,
        start: selected.start,
        end: selected.end,
        lsn: selected.start,
        channels: disc.channels,
        base: selected.time,
        pending: None,
        ready: VecDeque::new(),
        raw: Vec::new(),
        raw_offset: 0,
        decoder: DstDecoder::new(disc.channels as u32)?,
    };
    reader.seek(0)?;
    Ok(DsdSource::from_raw(
        info,
        selected.duration * 4704,
        Box::new(reader),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::AudioSource;
    use jap_core::SampleFormat;
    #[test]
    fn track_table_text_and_bounded_dsd_seek() {
        let mut image = vec![0; 630 * 2048];
        image[510 * 2048..510 * 2048 + 8].copy_from_slice(b"SACDMTOC");
        image[510 * 2048 + 64..510 * 2048 + 68].copy_from_slice(&544u32.to_be_bytes());
        let toc = &mut image[544 * 2048..545 * 2048];
        toc[..8].copy_from_slice(b"TWOCHTOC");
        toc[10..12].copy_from_slice(&8u16.to_be_bytes());
        toc[21] = 2;
        toc[32] = 2;
        toc[69] = 2;
        toc[72..76].copy_from_slice(&600u32.to_be_bytes());
        toc[76..80].copy_from_slice(&629u32.to_be_bytes());
        toc[90] = 5; // GB2312 metadata, including strings crossing a text sector.
        for (track, start) in [600u32, 615].into_iter().enumerate() {
            let offsets = &mut image[545 * 2048..546 * 2048];
            offsets[..8].copy_from_slice(b"SACDTRL1");
            offsets[8 + track * 4..12 + track * 4].copy_from_slice(&start.to_be_bytes());
            offsets[1028 + track * 4..1032 + track * 4].copy_from_slice(&15u32.to_be_bytes());
            let times = &mut image[546 * 2048..547 * 2048];
            times[..8].copy_from_slice(b"SACDTRL2");
            times[9 + track * 4] = 2;
            times[10 + track * 4] = track as u8 * 3;
            times[1030 + track * 4] = 3;
            let names = &mut image[549 * 2048..552 * 2048];
            names[..8].copy_from_slice(b"SACDTTxt");
            let pos = 4096 + track * 32;
            names[8 + track * 2..10 + track * 2].copy_from_slice(&(pos as u16).to_be_bytes());
            names[pos] = 1;
            names[pos + 4..pos + 6].copy_from_slice(&[1, 0x20]);
            names[pos + 6..pos + 8].copy_from_slice(if track == 0 {
                &[0xd2, 0xbb]
            } else {
                &[0xb6, 0xfe]
            });
            for frame in 0..3 {
                let raw = vec![0x69 + track as u8; 9408];
                for (i, payload) in raw.chunks(2000).enumerate() {
                    let lsn = start as usize + frame * 5 + i;
                    let sector = &mut image[lsn * 2048..(lsn + 1) * 2048];
                    sector[0] = 32 + if i == 0 { 4 } else { 0 };
                    sector[1] = 16 + if i == 0 { 128 } else { 0 } + ((payload.len() >> 8) as u8);
                    sector[2] = payload.len() as u8;
                    let header = if i == 0 {
                        sector[4] = 2;
                        sector[5] = (track * 3 + frame) as u8;
                        6
                    } else {
                        3
                    };
                    sector[header..header + payload.len()].copy_from_slice(payload);
                }
            }
        }
        let path = std::env::temp_dir().join(format!("jap-sacd-tracks-{}.iso", std::process::id()));
        std::fs::write(&path, &image).unwrap();
        let tracks = tracks(&path).unwrap();
        assert_eq!(tracks.len(), 2);
        assert_eq!(tracks[0].title.as_deref(), Some("一"));
        assert_eq!(tracks[1].title.as_deref(), Some("二"));
        for (index, track) in tracks.iter().enumerate() {
            assert_eq!(track.duration_ms, Some(40));
            let mut source = crate::open(Path::new(&track.path)).unwrap();
            let (mut bytes, mut preview) = (Vec::new(), Vec::new());
            while source
                .read_encoded(SampleFormat::DsdU8Msb, &mut bytes, &mut preview)
                .unwrap()
                > 0
            {}
            assert_eq!(bytes, vec![0x69 + index as u8; 9408 * 3]);
            assert_eq!(source.seek(20).unwrap(), 20);
            bytes.clear();
            while source
                .read_encoded(SampleFormat::DsdU8Msb, &mut bytes, &mut preview)
                .unwrap()
                > 0
            {}
            assert_eq!(bytes.len(), 9408 * 3 / 2);
            assert_eq!(source.seek(1000).unwrap(), 40);
            assert_eq!(
                source
                    .read_encoded(SampleFormat::DsdU8Msb, &mut bytes, &mut preview)
                    .unwrap(),
                0
            );
        }
        image[545 * 2048 + 8..545 * 2048 + 12].copy_from_slice(&500u32.to_be_bytes());
        std::fs::write(&path, image).unwrap();
        assert!(super::tracks(&path).is_err());
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    #[ignore = "Read-only verification of a local commercial ISO; set SACD_TEST_PATH"]
    fn local_iso_all_tracks_decode_and_seek_independently() {
        let path = std::env::var("SACD_TEST_PATH").unwrap();
        let tracks = tracks(Path::new(&path)).unwrap();
        assert!(tracks.len() > 1);
        for track in tracks {
            let mut source = crate::open(Path::new(&track.path)).unwrap();
            let (mut bytes, mut preview) = (Vec::new(), Vec::new());
            assert!(
                source
                    .read_encoded(SampleFormat::DsdU8Msb, &mut bytes, &mut preview)
                    .unwrap()
                    > 0
            );
            let prefix = bytes.clone();
            let duration = track.duration_ms.unwrap();
            source.seek(duration / 2).unwrap();
            bytes.clear();
            assert!(
                source
                    .read_encoded(SampleFormat::DsdU8Msb, &mut bytes, &mut preview)
                    .unwrap()
                    > 0
            );
            source.seek(duration.saturating_sub(30)).unwrap();
            bytes.clear();
            let mut n = 0;
            while source
                .read_encoded(SampleFormat::DsdU8Msb, &mut bytes, &mut preview)
                .unwrap()
                > 0
            {
                n += 1;
                assert!(n < 10);
            }
            assert!(bytes.len() <= 4704 * 3 * usize::from(track.format.channels));
            source.seek(0).unwrap();
            bytes.clear();
            source
                .read_encoded(SampleFormat::DsdU8Msb, &mut bytes, &mut preview)
                .unwrap();
            assert_eq!(bytes, prefix);
            println!(
                "{} · {:?}: OK",
                track.title.unwrap_or_default(),
                track.duration_ms
            );
        }
    }
    #[test]
    fn raw_and_dst_iso_packets_reach_native_dsd_without_changing_bytes() {
        for dst in [false, true] {
            let mut image = vec![0; 610 * 2048];
            image[510 * 2048..510 * 2048 + 8].copy_from_slice(b"SACDMTOC");
            image[510 * 2048 + 64..510 * 2048 + 68].copy_from_slice(&544u32.to_be_bytes());
            let toc = &mut image[544 * 2048..545 * 2048];
            toc[..8].copy_from_slice(b"TWOCHTOC");
            toc[21] = if dst { 0 } else { 2 };
            toc[32] = 2;
            toc[66] = 1;
            toc[72..76].copy_from_slice(&600u32.to_be_bytes());
            toc[76..80].copy_from_slice(&604u32.to_be_bytes());
            let original: Vec<u8> = (0..9408).map(|i| (i % 251) as u8).collect();
            let mut encoded = Vec::new();
            if dst {
                encoded.push(0)
            }
            encoded.extend_from_slice(&original);
            for (i, payload) in encoded.chunks(2000).enumerate() {
                let b = &mut image[(600 + i) * 2048..(601 + i) * 2048];
                let first = i == 0;
                b[0] = 32 + if first { 4 } else { 0 } + u8::from(dst);
                b[1] = 16 + if first { 128 } else { 0 } + ((payload.len() >> 8) as u8);
                b[2] = payload.len() as u8;
                let header = 3 + if first { if dst { 4 } else { 3 } } else { 0 };
                b[header..header + payload.len()].copy_from_slice(payload);
            }
            let path =
                std::env::temp_dir().join(format!("jap-sacd-{}-{dst}.iso", std::process::id()));
            std::fs::write(&path, image).unwrap();
            let mut source = open_track(&path, None).unwrap();
            let mut raw = Vec::new();
            let mut preview = Vec::new();
            while source
                .read_encoded(SampleFormat::DsdU8Msb, &mut raw, &mut preview)
                .unwrap()
                > 0
            {}
            assert_eq!(raw, original);
            source.seek(0).unwrap();
            let mut pcm = Vec::new();
            assert!(source.read(&mut pcm).unwrap() > 0);
            assert!(pcm.iter().all(|v| v.is_finite()));
            drop(source);
            std::fs::remove_file(path).unwrap();
        }
    }
}

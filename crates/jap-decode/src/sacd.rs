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
                return Ok(actual);
            }
        }
    }
}
pub fn open(path: &Path) -> Result<DsdSource> {
    let mut file = File::open(path)?;
    let size = file.metadata()?.len();
    let master = sector(&mut file, 510)?;
    if &master[..8] != b"SACDMTOC" {
        return Err(DecodeError::Unsupported("不是 SACD ISO".into()));
    }
    let area1 = u64::from(be32(&master[64..68]));
    let area2 = u64::from(be32(&master[72..76]));
    let area = if area1 != 0 { area1 } else { area2 };
    let toc = sector(&mut file, area)?;
    if ![b"TWOCHTOC", b"MULCHTOC"].contains(&toc[..8].try_into().unwrap()) {
        return Err(bad("SACD area TOC"));
    }
    let channels = usize::from(toc[32]);
    let start = u64::from(be32(&toc[72..76]));
    let end = u64::from(be32(&toc[76..80]));
    if !(1..=6).contains(&channels) || start > end || (end + 1) * SECTOR > size {
        return Err(bad("SACD area bounds"));
    }
    let duration = time(&toc[64..67])?;
    let mut reader = IsoReader {
        file,
        start,
        end,
        lsn: start,
        channels,
        base: 0,
        pending: None,
        ready: VecDeque::new(),
        raw: Vec::new(),
        raw_offset: 0,
        decoder: DstDecoder::new(channels as u32)?,
    };
    let first = reader.frame()?.ok_or_else(|| bad("SACD has no audio"))?;
    reader.base = first.time;
    reader.ready.push_front(first);
    let codec = if toc[21] & 15 == 0 {
        "SACD ISO / DST → DSD"
    } else {
        "SACD ISO / DSD"
    };
    let info = TrackInfo {
        path: path.display().to_string(),
        codec: codec.into(),
        format: AudioFormat {
            sample_rate: 2822400,
            channels: channels as u16,
            bits: Some(1),
            float: false,
        },
        duration_ms: Some(duration * 1000 / 75),
        lossless: true,
        bitrate_kbps: Some(2822400 * channels as u32 / 1000),
        title: path.file_stem().map(|s| s.to_string_lossy().into_owned()),
        artist: None,
        album: None,
    };
    Ok(DsdSource::from_raw(info, duration * 4704, Box::new(reader)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::AudioSource;
    use jap_core::SampleFormat;
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
            let mut source = open(&path).unwrap();
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

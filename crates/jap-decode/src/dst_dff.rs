use crate::{
    DecodeError, Result,
    dsd::{DsdSource, RawDsd},
    dst::DstDecoder,
};
use jap_core::{AudioFormat, TrackInfo};
use std::{
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::Path,
};
fn bad() -> DecodeError {
    DecodeError::Decode("无效 DST DSDIFF 块或帧参数".into())
}
fn chunks(file: &mut File, start: u64, end: u64) -> Result<Vec<([u8; 4], u64, u64)>> {
    let mut out = Vec::new();
    let mut at = start;
    while at + 12 <= end {
        file.seek(SeekFrom::Start(at))?;
        let mut h = [0; 12];
        file.read_exact(&mut h)?;
        let len = u64::from_be_bytes(h[4..].try_into().unwrap());
        let next = (at + 12)
            .checked_add(len)
            .filter(|&v| v <= end)
            .ok_or_else(bad)?;
        out.push((h[..4].try_into().unwrap(), at + 12, len));
        if out.len() > 1_000_000 {
            return Err(bad());
        }
        at = next + (len & 1);
    }
    Ok(out)
}
pub fn open(path: &Path) -> Result<DsdSource> {
    let mut file = File::open(path)?;
    let len = file.metadata()?.len();
    let mut head = [0; 16];
    file.read_exact(&mut head)?;
    let end = u64::from_be_bytes(head[4..12].try_into().unwrap())
        .checked_add(12)
        .filter(|&n| n <= len)
        .ok_or_else(bad)?;
    let mut rate = 0;
    let mut channels = 0;
    let mut frames = Vec::new();
    let mut declared = 0;
    for (tag, p, n) in chunks(&mut file, 16, end)? {
        if &tag == b"PROP" && n >= 4 {
            for (t, p, n) in chunks(&mut file, p + 4, p + n)? {
                file.seek(SeekFrom::Start(p))?;
                if &t == b"FS  " && n >= 4 {
                    let mut b = [0; 4];
                    file.read_exact(&mut b)?;
                    rate = u32::from_be_bytes(b)
                } else if &t == b"CHNL" && n >= 2 {
                    let mut b = [0; 2];
                    file.read_exact(&mut b)?;
                    channels = u16::from_be_bytes(b)
                }
            }
        } else if &tag == b"DST " {
            for (t, p, n) in chunks(&mut file, p, p + n)? {
                if &t == b"FRTE" && n == 6 {
                    file.seek(SeekFrom::Start(p))?;
                    let mut b = [0; 6];
                    file.read_exact(&mut b)?;
                    declared = u32::from_be_bytes(b[..4].try_into().unwrap());
                    if u16::from_be_bytes(b[4..].try_into().unwrap()) != 75 {
                        return Err(bad());
                    }
                } else if &t == b"DSTF" {
                    if n == 0 || n > 65536 {
                        return Err(bad());
                    }
                    frames.push((p, n as usize))
                }
            }
        }
    }
    if rate != 2822400
        || !(1..=6).contains(&channels)
        || frames.is_empty()
        || declared as usize != frames.len()
    {
        return Err(bad());
    }
    let total = frames.len() as u64 * 4704;
    let info = TrackInfo {
        path: path.display().to_string(),
        codec: "DSDIFF / DST → DSD".into(),
        format: AudioFormat {
            sample_rate: rate,
            channels,
            bits: Some(1),
            float: false,
        },
        duration_ms: Some(total * 8000 / u64::from(rate)),
        lossless: true,
        bitrate_kbps: Some(rate * u32::from(channels) / 1000),
        title: None,
        artist: None,
        album: None,
    };
    let source = Frames {
        file,
        frames,
        index: 0,
        channels: usize::from(channels),
        raw: Vec::new(),
        offset: 0,
        decoder: DstDecoder::new(u32::from(channels))?,
    };
    Ok(DsdSource::from_raw(info, total, Box::new(source)))
}
struct Frames {
    file: File,
    frames: Vec<(u64, usize)>,
    index: usize,
    channels: usize,
    raw: Vec<u8>,
    offset: usize,
    decoder: DstDecoder,
}
impl Frames {
    fn next(&mut self) -> Result<bool> {
        let Some(&(at, len)) = self.frames.get(self.index) else {
            return Ok(false);
        };
        self.file.seek(SeekFrom::Start(at))?;
        let mut encoded = vec![0; len];
        self.file.read_exact(&mut encoded)?;
        self.raw = self.decoder.decode(&encoded)?;
        self.offset = 0;
        self.index += 1;
        Ok(true)
    }
}
impl RawDsd for Frames {
    fn read(&mut self, out: &mut Vec<u8>, max: usize) -> Result<usize> {
        let mut left = max * self.channels;
        let before = out.len();
        while left > 0 {
            if self.offset == self.raw.len() && !self.next()? {
                break;
            }
            let n = left.min(self.raw.len() - self.offset);
            out.extend_from_slice(&self.raw[self.offset..self.offset + n]);
            self.offset += n;
            left -= n
        }
        Ok((out.len() - before) / self.channels)
    }
    fn seek(&mut self, frame: u64) -> Result<u64> {
        self.index = (frame / 4704) as usize;
        self.raw.clear();
        self.offset = 0;
        if !frame.is_multiple_of(4704) && self.next()? {
            self.offset = (frame % 4704) as usize * self.channels
        }
        Ok(frame)
    }
}

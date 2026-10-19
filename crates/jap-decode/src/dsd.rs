//! Streaming DSF and uncompressed DSDIFF reader. Stored bytes are canonicalized
//! to MSB-first before either DoP packing or ASIO native transfer.
use crate::{AudioSource, DecodeError, Result};
use jap_core::{AudioFormat, SampleFormat, TrackInfo};
use std::{
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::Path,
};

fn invalid(s: &str) -> DecodeError {
    DecodeError::Decode(s.into())
}
fn u32le(b: &[u8]) -> u32 {
    u32::from_le_bytes(b.try_into().unwrap())
}
fn u64le(b: &[u8]) -> u64 {
    u64::from_le_bytes(b.try_into().unwrap())
}
fn u32be(b: &[u8]) -> u32 {
    u32::from_be_bytes(b.try_into().unwrap())
}
fn u64be(b: &[u8]) -> u64 {
    u64::from_be_bytes(b.try_into().unwrap())
}

pub struct DsdSource {
    file: Option<File>,
    raw_source: Option<Box<dyn RawDsd>>,
    info: TrackInfo,
    data: u64,
    data_len: u64,
    frames: u64,
    pos: u64,
    block: usize,
    lsb: bool,
    cache: Vec<u8>,
    cache_group: u64,
    pcm: DsdPcm,
    raw: Vec<u8>,
    transport: Option<SampleFormat>,
}
pub(crate) trait RawDsd: Send {
    fn read(&mut self, out: &mut Vec<u8>, max_frames: usize) -> Result<usize>;
    fn seek(&mut self, frame: u64) -> Result<u64>;
}

impl DsdSource {
    pub(crate) fn from_raw(info: TrackInfo, frames: u64, source: Box<dyn RawDsd>) -> Self {
        let rate = info.format.sample_rate;
        let channels = usize::from(info.format.channels);
        Self {
            file: None,
            raw_source: Some(source),
            info,
            data: 0,
            data_len: 0,
            frames,
            pos: 0,
            block: 0,
            lsb: false,
            cache: Vec::new(),
            cache_group: u64::MAX,
            pcm: DsdPcm::new(rate, channels),
            raw: Vec::new(),
            transport: None,
        }
    }
    pub fn open(path: &Path) -> Result<Self> {
        let mut file = File::open(path)?;
        let len = file.metadata()?.len();
        let mut head = [0; 16];
        file.read_exact(&mut head)?;
        let (data, data_len, frames, rate, channels, block, lsb, codec) = if &head[..4] == b"DSD " {
            if u64le(&head[4..12]) != 28 {
                return Err(invalid("DSF DSD header 长度错误"));
            }
            file.seek(SeekFrom::Start(28))?;
            let mut fmt = [0; 52];
            file.read_exact(&mut fmt)?;
            if &fmt[..4] != b"fmt "
                || u64le(&fmt[4..12]) != 52
                || u32le(&fmt[12..16]) != 1
                || u32le(&fmt[16..20]) != 0
            {
                return Err(invalid("不支持的 DSF fmt"));
            }
            let channels = u32le(&fmt[24..28]);
            let rate = u32le(&fmt[28..32]);
            let bits = u32le(&fmt[32..36]);
            let samples = u64le(&fmt[36..44]);
            let block = u32le(&fmt[44..48]) as usize;
            if !matches!(bits, 1 | 8) || block == 0 || block > 1_048_576 {
                return Err(invalid("DSF 位序或块大小无效"));
            }
            let mut chunk = [0; 12];
            file.read_exact(&mut chunk)?;
            let size = u64le(&chunk[4..]);
            if &chunk[..4] != b"data" || size < 12 {
                return Err(invalid("DSF 缺少 data"));
            }
            (
                92,
                size - 12,
                samples.div_ceil(8),
                rate,
                channels,
                block,
                bits == 1,
                "DSF",
            )
        } else if &head[..4] == b"FRM8" && &head[12..16] == b"DSD " {
            let end = u64be(&head[4..12])
                .checked_add(12)
                .ok_or_else(|| invalid("DSDIFF 长度溢出"))?;
            if end > len {
                return Err(invalid("DSDIFF 文件被截断"));
            }
            let (mut rate, mut channels, mut data, mut size) = (0, 0, 0, 0);
            let mut cursor = 16u64;
            while cursor + 12 <= end {
                file.seek(SeekFrom::Start(cursor))?;
                let mut ch = [0; 12];
                file.read_exact(&mut ch)?;
                let n = u64be(&ch[4..]);
                let payload = cursor + 12;
                let next = payload
                    .checked_add(n)
                    .filter(|&v| v <= end)
                    .ok_or_else(|| invalid("DSDIFF chunk 越界"))?;
                match &ch[..4] {
                    b"PROP" if n >= 4 => {
                        let mut typ = [0; 4];
                        file.read_exact(&mut typ)?;
                        if &typ == b"SND " {
                            let mut p = payload + 4;
                            while p + 12 <= next {
                                file.seek(SeekFrom::Start(p))?;
                                let mut sub = [0; 12];
                                file.read_exact(&mut sub)?;
                                let sz = u64be(&sub[4..]);
                                let stop = (p + 12)
                                    .checked_add(sz)
                                    .filter(|&v| v <= next)
                                    .ok_or_else(|| invalid("DSDIFF PROP 越界"))?;
                                let mut value = [0; 4];
                                match &sub[..4] {
                                    b"FS  " if sz >= 4 => {
                                        file.read_exact(&mut value)?;
                                        rate = u32be(&value);
                                    }
                                    b"CHNL" if sz >= 2 => {
                                        file.read_exact(&mut value[..2])?;
                                        channels =
                                            u16::from_be_bytes(value[..2].try_into().unwrap())
                                                as u32;
                                    }
                                    b"CMPR" if sz >= 4 => {
                                        file.read_exact(&mut value)?;
                                        if &value == b"DST " {
                                            return crate::dst_dff::open(path);
                                        }
                                        if &value != b"DSD " {
                                            return Err(DecodeError::Unsupported(
                                                "DST 压缩暂不支持，请解压为 DSF/DSD DFF".into(),
                                            ));
                                        }
                                    }
                                    _ => {}
                                }
                                p = stop + (sz & 1);
                            }
                        }
                    }
                    b"DSD " => {
                        data = payload;
                        size = n;
                    }
                    b"DST " => return crate::dst_dff::open(path),
                    _ => {}
                }
                cursor = next + (n & 1);
            }
            if data == 0 || channels == 0 {
                return Err(invalid("DSDIFF 缺少音频数据或声道信息"));
            }
            (
                data,
                size,
                size / u64::from(channels),
                rate,
                channels,
                0,
                false,
                "DSDIFF",
            )
        } else {
            return Err(invalid("不是 DSF / DSDIFF 文件"));
        };
        if !(1..=8).contains(&channels)
            || ![
                2_822_400, 5_644_800, 11_289_600, 22_579_200, 3_072_000, 6_144_000, 12_288_000,
                24_576_000,
            ]
            .contains(&rate)
        {
            return Err(invalid("DSD 声道数或采样率无效"));
        }
        if data.checked_add(data_len).is_none_or(|v| v > len) {
            return Err(invalid("DSD 数据被截断"));
        }
        let required = if block > 0 {
            frames
                .div_ceil(block as u64)
                .checked_mul(block as u64)
                .and_then(|n| n.checked_mul(u64::from(channels)))
        } else {
            frames.checked_mul(u64::from(channels))
        }
        .ok_or_else(|| invalid("DSD sample count 溢出"))?;
        if required > data_len {
            return Err(invalid("DSD sample count 超过 data 长度"));
        }
        let info = TrackInfo {
            path: path.to_string_lossy().into(),
            codec: codec.into(),
            format: AudioFormat {
                sample_rate: rate,
                channels: channels as u16,
                bits: Some(1),
                float: false,
            },
            duration_ms: Some(
                (u128::from(frames) * 8000 / u128::from(rate)).min(u128::from(u64::MAX)) as u64,
            ),
            lossless: true,
            bitrate_kbps: Some(rate * channels / 1000),
            title: None,
            artist: None,
            album: None,
        };
        Ok(Self {
            file: Some(file),
            raw_source: None,
            info,
            data,
            data_len,
            frames,
            pos: 0,
            block,
            lsb,
            cache: Vec::new(),
            cache_group: u64::MAX,
            pcm: DsdPcm::new(rate, channels as usize),
            raw: Vec::new(),
            transport: None,
        })
    }

    fn bytes(&mut self, out: &mut Vec<u8>, max_frames: usize) -> Result<usize> {
        let channels = self.info.format.channels as usize;
        let n = (self.frames - self.pos).min(max_frames as u64) as usize;
        if let Some(source) = self.raw_source.as_mut() {
            let n = source.read(out, n)?;
            self.pos += n as u64;
            return Ok(n);
        }
        let file = self.file.as_mut().unwrap();
        if self.block == 0 {
            file.seek(SeekFrom::Start(self.data + self.pos * channels as u64))?;
            let start = out.len();
            out.resize(start + n * channels, 0);
            file.read_exact(&mut out[start..])?;
        } else {
            for i in 0..n {
                let p = self.pos + i as u64;
                let group = p / self.block as u64;
                if group != self.cache_group {
                    let offset = group * (self.block * channels) as u64;
                    if offset + (self.block * channels) as u64 > self.data_len {
                        return Err(invalid("DSF 块越界"));
                    }
                    file.seek(SeekFrom::Start(self.data + offset))?;
                    self.cache.resize(self.block * channels, 0);
                    file.read_exact(&mut self.cache)?;
                    self.cache_group = group;
                }
                for ch in 0..channels {
                    let v = self.cache[ch * self.block + p as usize % self.block];
                    out.push(if self.lsb { v.reverse_bits() } else { v });
                }
            }
        }
        self.pos += n as u64;
        Ok(n)
    }
}

impl AudioSource for DsdSource {
    fn info(&self) -> &TrackInfo {
        &self.info
    }
    fn playback_format(&self) -> AudioFormat {
        AudioFormat {
            sample_rate: self.info.format.sample_rate / 64,
            channels: self.info.format.channels,
            bits: Some(24),
            float: false,
        }
    }
    fn set_transport(&mut self, format: Option<SampleFormat>) {
        self.transport = format;
    }
    fn read(&mut self, out: &mut Vec<f64>) -> Result<usize> {
        let mut raw = std::mem::take(&mut self.raw);
        raw.clear();
        self.bytes(&mut raw, 4096)?;
        let before = out.len();
        self.pcm.push(&raw, out);
        self.raw = raw;
        Ok((out.len() - before) / self.info.format.channels as usize)
    }
    fn read_encoded(
        &mut self,
        format: SampleFormat,
        out: &mut Vec<u8>,
        preview: &mut Vec<f64>,
    ) -> Result<usize> {
        let mut raw = std::mem::take(&mut self.raw);
        raw.clear();
        let n = self.bytes(&mut raw, 4096)?;
        self.pcm.push(&raw, preview);
        let ch = self.info.format.channels as usize;
        match format {
            SampleFormat::DsdU8Msb => out.extend_from_slice(&raw),
            SampleFormat::DsdU8Lsb => out.extend(raw.iter().map(|v| v.reverse_bits())),
            SampleFormat::Dop24 | SampleFormat::Dop32 => {
                for frame in 0..n.div_ceil(2) {
                    for c in 0..ch {
                        let a = raw[frame * 2 * ch + c];
                        let b = raw.get((frame * 2 + 1) * ch + c).copied().unwrap_or(0x69);
                        // DoP puts the earlier 8 DSD bits in bits 15..8.
                        if format == SampleFormat::Dop32 {
                            out.push(0);
                        }
                        out.extend_from_slice(&[b, a, 0x05]); // marker continuity is owned by the output ring
                    }
                }
            }
            _ => return Err(invalid("不是 DSD transport")),
        }
        self.raw = raw;
        Ok(
            if matches!(format, SampleFormat::Dop24 | SampleFormat::Dop32) {
                n.div_ceil(2)
            } else {
                n
            },
        )
    }
    fn seek(&mut self, ms: u64) -> Result<u64> {
        self.pos = (ms.saturating_mul(u64::from(self.info.format.sample_rate)) / 8000)
            .min(self.frames)
            / 8
            * 8;
        if let Some(source) = self.raw_source.as_mut() {
            self.pos = source.seek(self.pos)?;
        }
        self.pcm = DsdPcm::new(
            self.info.format.sample_rate,
            self.info.format.channels as usize,
        );
        Ok(self.pos * 8000 / u64::from(self.info.format.sample_rate))
    }
    fn position_frames(&self) -> u64 {
        match self.transport {
            Some(SampleFormat::Dop24 | SampleFormat::Dop32) => self.pos / 2,
            Some(_) => self.pos,
            None => self.pos / 8,
        }
    }
}

// Integer CIC4 decimation by 8 followed by a Blackman FIR decimator by 8.
// Only the monitoring / explicit PCM path uses this; passthrough bytes are untouched.
struct DsdPcm {
    states: Vec<PcmChannel>,
    taps: Vec<f64>,
    head: usize,
    count: usize,
}
struct PcmChannel {
    integrator: [i64; 4],
    comb: [i64; 4],
    history: Vec<f64>,
}
impl DsdPcm {
    fn new(rate: u32, channels: usize) -> Self {
        let n = 511;
        let cutoff = (30000f64.min(f64::from(rate) / 64. * 0.47)) / (f64::from(rate) / 8.);
        let mut taps: Vec<f64> = (0..n)
            .map(|i| {
                let x = i as f64 - (n - 1) as f64 / 2.;
                let sinc = if x == 0. {
                    2. * cutoff
                } else {
                    (2. * std::f64::consts::PI * cutoff * x).sin() / (std::f64::consts::PI * x)
                };
                sinc * (0.42 - 0.5 * (2. * std::f64::consts::PI * i as f64 / (n - 1) as f64).cos()
                    + 0.08 * (4. * std::f64::consts::PI * i as f64 / (n - 1) as f64).cos())
            })
            .collect();
        let sum: f64 = taps.iter().sum();
        for v in &mut taps {
            *v /= sum;
        }
        Self {
            states: (0..channels)
                .map(|_| PcmChannel {
                    integrator: [0; 4],
                    comb: [0; 4],
                    history: vec![0.; n],
                })
                .collect(),
            taps,
            head: 0,
            count: 0,
        }
    }
    fn push(&mut self, raw: &[u8], out: &mut Vec<f64>) {
        for frame in raw.chunks_exact(self.states.len()) {
            for (s, &byte) in self.states.iter_mut().zip(frame) {
                for bit in (0..8).rev() {
                    let mut v = if byte & (1 << bit) != 0 { 1i64 } else { -1i64 };
                    for acc in &mut s.integrator {
                        *acc = acc.wrapping_add(v);
                        v = *acc;
                    }
                }
                let mut v = s.integrator[3];
                for delay in &mut s.comb {
                    let prev = v;
                    v = v.wrapping_sub(*delay);
                    *delay = prev;
                }
                s.history[self.head] = v as f64 / 4096.;
            }
            self.count += 1;
            if self.count.is_multiple_of(8) {
                for s in &self.states {
                    out.push(
                        self.taps
                            .iter()
                            .enumerate()
                            .map(|(i, t)| {
                                t * s.history[(self.head + self.taps.len() - i) % self.taps.len()]
                            })
                            .sum::<f64>(),
                    );
                }
            }
            self.head = (self.head + 1) % self.taps.len();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    static ID: AtomicU64 = AtomicU64::new(0);
    struct Fixture(std::path::PathBuf);
    impl Fixture {
        fn new(bytes: &[u8], ext: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "jap-dsd-{}-{}.{}",
                std::process::id(),
                ID.fetch_add(1, Ordering::Relaxed),
                ext
            ));
            std::fs::write(&path, bytes).unwrap();
            Self(path)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }
    fn dsf(raw: &[u8], lsb: bool) -> Vec<u8> {
        let frames = raw.len() / 2;
        let block = 16;
        let size = frames.div_ceil(block) * block * 2;
        let mut b = Vec::new();
        b.extend(b"DSD ");
        b.extend(28u64.to_le_bytes());
        b.extend((92u64 + size as u64).to_le_bytes());
        b.extend(0u64.to_le_bytes());
        b.extend(b"fmt ");
        b.extend(52u64.to_le_bytes());
        for value in [1u32, 0, 2, 2, 2_822_400, if lsb { 1 } else { 8 }] {
            b.extend(value.to_le_bytes());
        }
        b.extend((frames as u64 * 8).to_le_bytes());
        b.extend((block as u32).to_le_bytes());
        b.extend(0u32.to_le_bytes());
        b.extend(b"data");
        b.extend((12u64 + size as u64).to_le_bytes());
        for group in 0..frames.div_ceil(block) {
            for ch in 0..2 {
                for i in 0..block {
                    let v = raw
                        .get((group * block + i) * 2 + ch)
                        .copied()
                        .unwrap_or(0x69);
                    b.push(if lsb { v.reverse_bits() } else { v });
                }
            }
        }
        b
    }
    fn chunk(tag: &[u8; 4], data: &[u8]) -> Vec<u8> {
        let mut b = tag.to_vec();
        b.extend((data.len() as u64).to_be_bytes());
        b.extend(data);
        if data.len() % 2 == 1 {
            b.push(0);
        }
        b
    }
    fn dff(raw: &[u8], compression: &[u8; 4]) -> Vec<u8> {
        let mut prop = b"SND ".to_vec();
        prop.extend(chunk(b"FS  ", &2_822_400u32.to_be_bytes()));
        prop.extend(chunk(
            b"CHNL",
            &[0, 2, b'S', b'L', b'F', b'T', b'S', b'R', b'G', b'T'],
        ));
        prop.extend(chunk(b"CMPR", compression));
        let mut body = b"DSD ".to_vec();
        body.extend(chunk(b"PROP", &prop));
        body.extend(chunk(b"DSD ", raw));
        let mut b = b"FRM8".to_vec();
        b.extend((body.len() as u64).to_be_bytes());
        b.extend(body);
        b
    }
    #[test]
    fn dsf_planar_and_both_bit_orders_match_dff_interleaved() {
        let raw: Vec<u8> = (0..10003u32)
            .flat_map(|i| [(i * 31) as u8, (i * 17 + 1) as u8])
            .collect();
        for (bytes, ext) in [
            (dsf(&raw, true), "dsf"),
            (dsf(&raw, false), "dsf"),
            (dff(&raw, b"DSD "), "dff"),
        ] {
            let fixture = Fixture::new(&bytes, ext);
            let mut source = DsdSource::open(&fixture.0).unwrap();
            let mut encoded = Vec::new();
            let mut preview = Vec::new();
            while source
                .read_encoded(SampleFormat::DsdU8Msb, &mut encoded, &mut preview)
                .unwrap()
                > 0
            {}
            assert_eq!(encoded, raw);
            assert_eq!(preview.len(), raw.len() / 16 * 2);
        }
    }
    #[test]
    fn dop_has_earlier_bits_in_high_payload_byte_and_padding_is_balanced_silence() {
        let fixture = Fixture::new(&dsf(&[0x12, 0x34, 0x56, 0x78, 0xab, 0xcd], true), "dsf");
        let mut source = DsdSource::open(&fixture.0).unwrap();
        let mut encoded = Vec::new();
        let mut preview = Vec::new();
        source
            .read_encoded(SampleFormat::Dop24, &mut encoded, &mut preview)
            .unwrap();
        assert_eq!(
            encoded,
            [
                0x56, 0x12, 0x05, 0x78, 0x34, 0x05, 0x69, 0xab, 0x05, 0x69, 0xcd, 0x05
            ]
        );
    }
    #[test]
    fn native_lsb_reverses_only_bits_not_channel_order() {
        let fixture = Fixture::new(&dff(&[0x12, 0x34, 0x56, 0x78], b"DSD "), "dff");
        let mut source = DsdSource::open(&fixture.0).unwrap();
        let mut out = Vec::new();
        source
            .read_encoded(SampleFormat::DsdU8Lsb, &mut out, &mut Vec::new())
            .unwrap();
        assert_eq!(out, [0x48, 0x2c, 0x6a, 0x1e]);
    }
    #[test]
    fn seek_maps_to_transport_time_and_pcm_silence_stays_finite() {
        let fixture = Fixture::new(&dsf(&vec![0x69; 100000], true), "dsf");
        let mut source = DsdSource::open(&fixture.0).unwrap();
        source.set_transport(Some(SampleFormat::Dop24));
        let ms = source.seek(100).unwrap();
        assert!((99..=100).contains(&ms));
        assert_eq!(source.position_frames(), 35280 / 2);
        source.seek(0).unwrap();
        let mut pcm = Vec::new();
        source.read(&mut pcm).unwrap();
        assert!(pcm.iter().all(|x| x.is_finite()));
        assert!(pcm[1000..].iter().all(|v| v.abs() < 1e-8));
    }
    #[test]
    fn truncated_and_invalid_dst_files_fail_explicitly() {
        let mut bytes = dsf(&[0x69; 100], true);
        bytes.pop();
        let fixture = Fixture::new(&bytes, "dsf");
        assert!(DsdSource::open(&fixture.0).is_err());
        let fixture = Fixture::new(&dff(&[0; 20], b"DST "), "dff");
        assert!(DsdSource::open(&fixture.0).is_err());
    }
}

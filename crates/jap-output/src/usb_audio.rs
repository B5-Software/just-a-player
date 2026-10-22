//! Bounds-checked USB Audio descriptors and allocation-free isochronous pacing.
//! Kept independent of Android so malformed descriptors and packetization run in CI.
use jap_core::{SampleFormat, StreamConfig};

#[derive(Debug, Clone)]
pub(crate) struct Alternate {
    pub interface: u8,
    pub alternate: u8,
    pub protocol: u8,
    pub control_interface: u8,
    pub terminal: u8,
    pub clock: u8,
    pub endpoint: u8,
    pub feedback: u8,
    pub feedback_size: u8,
    pub interval: u8,
    pub max_packet: usize,
    pub channels: u16,
    pub subslot: u8,
    pub bits: u8,
    pub formats: u32,
    pub rates: Vec<u32>,
    pub rate_range: Option<(u32, u32)>,
    pub raw_dsd: bool,
}

impl Alternate {
    pub fn accepts(&self, config: StreamConfig) -> bool {
        if self.channels != config.channels {
            return false;
        }
        let rate = self.clock_rate(config);
        if !self.rates.is_empty() && !self.rates.contains(&rate) {
            return false;
        }
        if let Some((lo, hi)) = self.rate_range
            && !(lo..=hi).contains(&rate)
        {
            return false;
        }
        match config.format {
            SampleFormat::I16 => self.formats & 1 != 0 && self.subslot == 2 && self.bits == 16,
            SampleFormat::I24Packed | SampleFormat::Dop24 => {
                self.formats & 1 != 0 && self.subslot == 3 && self.bits == 24
            }
            SampleFormat::I24In32 | SampleFormat::Dop32 => {
                self.formats & 1 != 0 && self.subslot == 4 && self.bits == 24
            }
            SampleFormat::I32 => self.formats & 1 != 0 && self.subslot == 4 && self.bits == 32,
            SampleFormat::F32 => self.formats & 4 != 0 && self.subslot == 4 && self.bits == 32,
            // This transport currently implements UAC1/UAC2 Type I subslots,
            // whose PCM/IEEE-float layouts stop at four bytes.
            SampleFormat::F64 => false,
            SampleFormat::DsdU8Msb => self.raw_dsd,
            SampleFormat::DsdU8Lsb => false,
        }
    }
    pub fn clock_rate(&self, config: StreamConfig) -> u32 {
        config.sample_rate
            / if config.format == SampleFormat::DsdU8Msb {
                u32::from(self.subslot)
            } else {
                1
            }
    }
}

fn u24(d: &[u8]) -> u32 {
    u32::from(d[0]) | u32::from(d[1]) << 8 | u32::from(d[2]) << 16
}
fn u32le(d: &[u8]) -> u32 {
    u32::from_le_bytes(d[..4].try_into().unwrap())
}

pub(crate) fn parse(data: &[u8], vendor: u16, product: u16) -> Vec<Alternate> {
    let mut result = Vec::new();
    let mut current: Option<Alternate> = None;
    let mut control = 0;
    let mut clocks = [0_u8; 256];
    let mut offset = 0;
    while offset + 2 <= data.len() {
        let len = usize::from(data[offset]);
        if len < 2 || offset + len > data.len() {
            break;
        }
        let d = &data[offset..offset + len];
        offset += len;
        if d[1] == 4 && len >= 9 {
            if let Some(a) = current.take()
                && a.endpoint != 0
            {
                result.push(a);
            }
            if d[5] == 1 && d[6] == 1 {
                control = d[2];
            }
            if d[5] == 1 && d[6] == 2 && d[3] > 0 {
                current = Some(Alternate {
                    interface: d[2],
                    alternate: d[3],
                    protocol: d[7],
                    control_interface: control,
                    terminal: 0,
                    clock: 0,
                    endpoint: 0,
                    feedback: 0,
                    feedback_size: 0,
                    interval: 1,
                    max_packet: 0,
                    channels: 0,
                    subslot: 0,
                    bits: 0,
                    formats: 0,
                    rates: Vec::new(),
                    rate_range: None,
                    raw_dsd: false,
                });
            }
        } else if d[1] == 0x24 && current.is_none() && len >= 8 && d[2] == 2 {
            // UAC2 input terminal: bCSourceID at byte 7. UAC1 clocks aren't used.
            clocks[usize::from(d[3])] = d[7];
        } else if let Some(a) = &mut current {
            if d[1] == 0x24 && len >= 4 {
                match (a.protocol, d[2]) {
                    (0x20, 1) if len >= 11 => {
                        a.terminal = d[3];
                        a.formats = u32le(&d[6..]);
                        a.channels = u16::from(d[10]);
                    }
                    (0x20, 2) if len >= 6 && d[3] == 1 => {
                        a.subslot = d[4];
                        a.bits = d[5];
                    }
                    (0, 1) if len >= 7 => {
                        a.terminal = d[3];
                        a.formats = if d[5] == 1 {
                            1
                        } else if d[5] == 3 {
                            4
                        } else {
                            0
                        };
                    }
                    (0, 2) if len >= 8 && d[3] == 1 => {
                        a.channels = u16::from(d[4]);
                        a.subslot = d[5];
                        a.bits = d[6];
                        let count = usize::from(d[7]);
                        if count == 0 && len >= 14 {
                            a.rate_range = Some((u24(&d[8..]), u24(&d[11..])));
                        } else if len >= 8 + count * 3 {
                            a.rates = (0..count).map(|n| u24(&d[8 + n * 3..])).collect();
                        }
                    }
                    _ => {}
                }
            } else if d[1] == 5 && len >= 7 && d[3] & 3 == 1 {
                if d[2] & 0x80 == 0 {
                    a.endpoint = d[2];
                    a.interval = d[6].clamp(1, 16);
                    let size = u16::from_le_bytes([d[4], d[5]]);
                    a.max_packet = usize::from(size & 0x7ff) * (1 + usize::from((size >> 11) & 3));
                    if len >= 9 && d[8] & 0x80 != 0 {
                        a.feedback = d[8];
                    }
                } else if d[3] & 0x30 == 0x10 {
                    a.feedback = d[2];
                    a.feedback_size = (u16::from_le_bytes([d[4], d[5]]) & 0x7ff).min(4) as u8;
                }
            }
        }
    }
    if let Some(a) = current
        && a.endpoint != 0
    {
        result.push(a);
    }
    result.retain_mut(|a| {
        a.clock = clocks[usize::from(a.terminal)];
        // RAW_DATA is not universally DSD. Dawn Pro 2 DSD_U32_BE is documented by
        // ALSA's 35d8:011d DSD_RAW quirk. Never infer native DSD from PCM rates.
        a.raw_dsd = a.formats & 0x8000_0000 != 0
            && ((a.subslot == 1 && a.bits == 1)
                || (vendor == 0x35d8 && product == 0x011d && a.subslot == 4));
        a.channels > 0 && a.channels <= 32 && (1..=4).contains(&a.subslot) && a.max_packet > 0
    });
    result
}

pub(crate) struct Pacer {
    rate: f64,
    fraction: f64,
    nominal: f64,
}

/// Only use a Feature Unit on this streaming terminal's direct signal path.
pub(crate) fn volume_feature(data: &[u8], a: &Alternate) -> Option<(u8, Vec<u8>)> {
    let mut offset = 0;
    let mut interface = 255;
    while offset + 2 <= data.len() {
        let len = usize::from(data[offset]);
        if len < 2 || offset + len > data.len() {
            break;
        }
        let d = &data[offset..offset + len];
        offset += len;
        if d[1] == 4 && len >= 9 {
            interface = d[2];
        }
        if interface != a.control_interface
            || len < 7
            || d[1] != 0x24
            || d[2] != 6
            || d[4] != a.terminal
        {
            continue;
        }
        let mut supported = Vec::new();
        for ch in 0..=a.channels.min(32) as u8 {
            let writable = if a.protocol == 0x20 {
                let p = 5 + usize::from(ch) * 4;
                p + 4 < len && (u32le(&d[p..]) >> 2) & 3 == 3
            } else {
                let size = usize::from(d[5]);
                let p = 6 + usize::from(ch) * size;
                size > 0 && size <= 4 && p + size < len && d[p] & 2 != 0
            };
            if writable {
                supported.push(ch);
            }
        }
        if supported.contains(&0) {
            return Some((d[3], vec![0]));
        }
        if supported.len() == usize::from(a.channels) {
            return Some((d[3], supported));
        }
    }
    None
}
impl Pacer {
    pub fn new(rate: u32, intervals: f64) -> Self {
        let nominal = f64::from(rate) / intervals;
        Self {
            rate: nominal,
            fraction: 0.0,
            nominal,
        }
    }
    pub fn feedback(&mut self, value: f64) {
        // Reject corrupt/stale feedback instead of overrunning the endpoint.
        if value.is_finite() && (self.nominal * 0.98..=self.nominal * 1.02).contains(&value) {
            self.rate = value;
        }
    }
    pub fn next(&mut self, max_frames: usize) -> usize {
        self.fraction += self.rate;
        let frames = self.fraction.floor() as usize;
        self.fraction -= frames as f64;
        frames.min(max_frames)
    }
}

/// Byte-interleaved DSD from the engine -> per-channel USB RAW_DATA subslots.
pub(crate) fn pack_dsd(input: &[u8], output: &mut [u8], channels: usize, subslot: usize) {
    for (src, dst) in input
        .chunks_exact(channels * subslot)
        .zip(output.chunks_exact_mut(channels * subslot))
    {
        for ch in 0..channels {
            for byte in 0..subslot {
                dst[ch * subslot + byte] = src[byte * channels + ch];
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fractional_44100_has_no_drift() {
        let mut p = Pacer::new(44100, 8000.0);
        assert_eq!((0..80000).map(|_| p.next(64)).sum::<usize>(), 441000);
        p.feedback(f64::NAN);
        p.feedback(9000.0);
        assert_eq!((0..80000).map(|_| p.next(64)).sum::<usize>(), 441000);
    }
    #[test]
    fn raw_dsd_channel_order() {
        let mut out = [0; 16];
        pack_dsd(
            &[1, 11, 2, 12, 3, 13, 4, 14, 5, 15, 6, 16, 7, 17, 8, 18],
            &mut out,
            2,
            4,
        );
        assert_eq!(
            out,
            [1, 2, 3, 4, 11, 12, 13, 14, 5, 6, 7, 8, 15, 16, 17, 18]
        );
    }
    #[test]
    fn uac1_and_malformed_descriptors() {
        let mut d = vec![
            9, 4, 1, 1, 1, 1, 2, 0, 0, 7, 0x24, 1, 1, 1, 1, 0, 11, 0x24, 2, 1, 2, 3, 24, 1, 0x44,
            0xac, 0, 9, 5, 1, 5, 0x00, 0x04, 1, 0, 0,
        ];
        let a = parse(&d, 0, 0);
        assert_eq!(a.len(), 1);
        assert_eq!(
            (a[0].interface, a[0].alternate, a[0].control_interface),
            (1, 1, 0)
        );
        assert_eq!(a[0].rates, [44100]);
        assert!(a[0].accepts(StreamConfig {
            sample_rate: 44100,
            channels: 2,
            format: SampleFormat::I24Packed
        }));
        assert!(!a[0].accepts(StreamConfig {
            sample_rate: 48000,
            channels: 2,
            format: SampleFormat::I24Packed
        }));
        d.extend_from_slice(&[255, 0x24]);
        assert_eq!(parse(&d, 0, 0).len(), 1);
        for n in 0..d.len() {
            let _ = parse(&d[..n], 0, 0);
        }
    }
    #[test]
    fn dawn_raw_is_a_quirk_not_pcm_guess() {
        let d = [
            9, 4, 1, 4, 1, 1, 2, 0x20, 0, 16, 0x24, 1, 1, 0, 1, 0, 0, 0, 0x80, 2, 0, 0, 0, 0, 0, 6,
            0x24, 2, 1, 4, 32, 7, 5, 1, 5, 0x00, 0x14, 1,
        ];
        let a = parse(&d, 0x35d8, 0x011d);
        assert!(a[0].raw_dsd);
        let c = StreamConfig {
            sample_rate: 1411200,
            channels: 2,
            format: SampleFormat::DsdU8Msb,
        };
        assert!(a[0].accepts(c));
        assert_eq!(a[0].clock_rate(c), 352800);
        assert!(!parse(&d, 123, 456)[0].raw_dsd);
    }
    #[test]
    fn volume_must_belong_to_streaming_terminal() {
        let d = [
            9, 4, 0, 0, 0, 1, 1, 0x20, 0, 18, 0x24, 6, 9, 1, 12, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        ];
        let stream = [
            9, 4, 1, 1, 1, 1, 2, 0, 0, 7, 0x24, 1, 1, 1, 1, 0, 11, 0x24, 2, 1, 2, 3, 24, 1, 0x44,
            0xac, 0, 9, 5, 1, 5, 0, 4, 1, 0, 0,
        ];
        let mut a = parse(&stream, 0, 0).remove(0);
        a.protocol = 0x20;
        assert_eq!(volume_feature(&d, &a), Some((9, vec![0])));
        a.terminal = 2;
        assert_eq!(volume_feature(&d, &a), None);
    }
}

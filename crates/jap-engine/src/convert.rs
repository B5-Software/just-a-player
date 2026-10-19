//! 样本格式转换与声道映射。所有函数都不依赖设备，便于单测。

use jap_core::SampleFormat;

/// 把归一化的 `f64` 样本量化成设备字节，追加到 `out`。
///
/// 整数源以 `2^(bits-1)` 归一化后，在位深不缩减的前提下往返无损；
/// 这里不加抖动，抖动属于 DSP 链的职责。
pub fn quantize_into(samples: &[f64], format: SampleFormat, out: &mut Vec<u8>) {
    out.reserve(samples.len() * format.container_bytes());
    match format {
        SampleFormat::I16 => {
            for &v in samples {
                let x = to_int(v, 32_768.0, -32_768.0, 32_767.0) as i16;
                out.extend_from_slice(&x.to_le_bytes());
            }
        }
        SampleFormat::I24Packed => {
            for &v in samples {
                let x = to_int(v, 8_388_608.0, -8_388_608.0, 8_388_607.0) as i32;
                out.extend_from_slice(&x.to_le_bytes()[..3]);
            }
        }
        SampleFormat::I24In32 => {
            for &v in samples {
                let x = to_int(v, 8_388_608.0, -8_388_608.0, 8_388_607.0) as i32;
                out.extend_from_slice(&(x << 8).to_le_bytes());
            }
        }
        SampleFormat::I32 => {
            for &v in samples {
                let x = to_int(v, 2_147_483_648.0, -2_147_483_648.0, 2_147_483_647.0) as i32;
                out.extend_from_slice(&x.to_le_bytes());
            }
        }
        SampleFormat::F32 => {
            for &v in samples {
                out.extend_from_slice(&(v as f32).to_le_bytes());
            }
        }
        SampleFormat::Dop24
        | SampleFormat::Dop32
        | SampleFormat::DsdU8Lsb
        | SampleFormat::DsdU8Msb => {
            unreachable!("DSD 数据不能经过 PCM 量化")
        }
    }
}

#[inline]
fn to_int(v: f64, scale: f64, min: f64, max: f64) -> i64 {
    (v * scale).round().clamp(min, max) as i64
}

/// 声道数不一致时的映射方案。
#[derive(Debug, Clone)]
pub enum ChannelMap {
    Identity,
    MonoToStereo,
    /// 每个输入声道对 (左, 右) 的贡献系数。
    Downmix(Vec<(f64, f64)>),
}

impl ChannelMap {
    /// 返回 `None` 表示不支持这种映射（例如把立体声扩成多声道）。
    pub fn new(in_channels: usize, out_channels: usize) -> Option<Self> {
        match (in_channels, out_channels) {
            (a, b) if a == b => Some(Self::Identity),
            (1, 2) => Some(Self::MonoToStereo),
            (n, 2) if n > 2 => Some(Self::Downmix(downmix_matrix(n))),
            _ => None,
        }
    }

    /// 是否改变了样本值（用于信号链判定）。
    pub fn is_transforming(&self) -> bool {
        !matches!(self, Self::Identity)
    }

    pub fn apply(&self, input: &[f64], in_channels: usize, out: &mut Vec<f64>) {
        match self {
            Self::Identity => out.extend_from_slice(input),
            Self::MonoToStereo => {
                out.reserve(input.len() * 2);
                for &s in input {
                    out.push(s);
                    out.push(s);
                }
            }
            Self::Downmix(coef) => {
                out.reserve(input.len() / in_channels * 2);
                for frame in input.chunks_exact(in_channels) {
                    let (mut l, mut r) = (0.0, 0.0);
                    for (&s, &(cl, cr)) in frame.iter().zip(coef) {
                        l += s * cl;
                        r += s * cr;
                    }
                    out.push(l);
                    out.push(r);
                }
            }
        }
    }
}

/// 按常见的 FL FR FC LFE BL BR SL SR 顺序折叠到立体声，并整体归一化避免削波。
fn downmix_matrix(channels: usize) -> Vec<(f64, f64)> {
    const C: f64 = std::f64::consts::FRAC_1_SQRT_2;
    let mut m: Vec<(f64, f64)> = match channels {
        3 => vec![(1.0, 0.0), (0.0, 1.0), (C, C)],
        4 => vec![(1.0, 0.0), (0.0, 1.0), (C, 0.0), (0.0, C)],
        5 => vec![(1.0, 0.0), (0.0, 1.0), (C, C), (C, 0.0), (0.0, C)],
        6 => vec![
            (1.0, 0.0),
            (0.0, 1.0),
            (C, C),
            (0.0, 0.0),
            (C, 0.0),
            (0.0, C),
        ],
        8 => vec![
            (1.0, 0.0),
            (0.0, 1.0),
            (C, C),
            (0.0, 0.0),
            (C, 0.0),
            (0.0, C),
            (C, 0.0),
            (0.0, C),
        ],
        n => (0..n)
            .map(|i| if i % 2 == 0 { (1.0, 0.0) } else { (0.0, 1.0) })
            .collect(),
    };
    let peak = m
        .iter()
        .map(|c| c.0)
        .sum::<f64>()
        .max(m.iter().map(|c| c.1).sum::<f64>());
    if peak > 1.0 {
        for c in &mut m {
            c.0 /= peak;
            c.1 /= peak;
        }
    }
    m
}

#[cfg(test)]
mod tests {
    use super::*;

    fn norm(x: i64, bits: u32) -> f64 {
        x as f64 / (1u64 << (bits - 1)) as f64
    }

    #[test]
    fn int_roundtrip_is_exact_for_every_container() {
        let probes16: [i64; 6] = [-32_768, -32_767, -1, 0, 1, 32_767];
        let probes24: [i64; 6] = [-8_388_608, -8_388_607, -1, 0, 1, 8_388_607];
        let probes32: [i64; 6] = [
            i32::MIN as i64,
            i32::MIN as i64 + 1,
            -1,
            0,
            1,
            i32::MAX as i64,
        ];

        for (bits, probes) in [(16u32, &probes16), (24, &probes24), (32, &probes32)] {
            let samples: Vec<f64> = probes.iter().map(|&x| norm(x, bits)).collect();

            // 向更宽的容器写入必须逐位保留原值
            let mut out = Vec::new();
            quantize_into(&samples, SampleFormat::I32, &mut out);
            let shift = 32 - bits;
            for (chunk, &x) in out.as_chunks::<4>().0.iter().zip(probes.iter()) {
                let got = i32::from_le_bytes(*chunk) as i64;
                assert_eq!(got >> shift, x, "{bits}-bit -> I32");
            }
        }
    }

    #[test]
    fn native_containers_keep_values() {
        let s16: Vec<f64> = [-32_768i64, -1, 0, 1, 32_767]
            .iter()
            .map(|&x| norm(x, 16))
            .collect();
        let mut out = Vec::new();
        quantize_into(&s16, SampleFormat::I16, &mut out);
        let back: Vec<i16> = out
            .as_chunks::<2>()
            .0
            .iter()
            .map(|c| i16::from_le_bytes(*c))
            .collect();
        assert_eq!(back, [-32_768, -1, 0, 1, 32_767]);

        let s24: Vec<f64> = [-8_388_608i64, -1, 0, 1, 8_388_607]
            .iter()
            .map(|&x| norm(x, 24))
            .collect();
        let mut packed = Vec::new();
        quantize_into(&s24, SampleFormat::I24Packed, &mut packed);
        let back: Vec<i32> = packed
            .as_chunks::<3>()
            .0
            .iter()
            .map(|c| {
                i32::from_le_bytes([c[0], c[1], c[2], if c[2] & 0x80 != 0 { 0xFF } else { 0 }])
            })
            .collect();
        assert_eq!(back, [-8_388_608, -1, 0, 1, 8_388_607]);

        let mut in32 = Vec::new();
        quantize_into(&s24, SampleFormat::I24In32, &mut in32);
        let back: Vec<i32> = in32
            .as_chunks::<4>()
            .0
            .iter()
            .map(|c| i32::from_le_bytes(*c) >> 8)
            .collect();
        assert_eq!(back, [-8_388_608, -1, 0, 1, 8_388_607]);
    }

    #[test]
    fn out_of_range_samples_clip_instead_of_wrapping() {
        let mut out = Vec::new();
        quantize_into(&[1.5, -1.5], SampleFormat::I16, &mut out);
        let back: Vec<i16> = out
            .as_chunks::<2>()
            .0
            .iter()
            .map(|c| i16::from_le_bytes(*c))
            .collect();
        assert_eq!(back, [32_767, -32_768]);
    }

    #[test]
    fn mono_is_duplicated_and_surround_never_clips() {
        let mut out = Vec::new();
        ChannelMap::new(1, 2)
            .unwrap()
            .apply(&[0.25, -0.5], 1, &mut out);
        assert_eq!(out, [0.25, 0.25, -0.5, -0.5]);

        let map = ChannelMap::new(6, 2).unwrap();
        let mut out = Vec::new();
        map.apply(&[1.0; 6], 6, &mut out);
        assert!(out.iter().all(|&v| v <= 1.0 + 1e-12));
        assert!(ChannelMap::new(2, 6).is_none());
    }
}

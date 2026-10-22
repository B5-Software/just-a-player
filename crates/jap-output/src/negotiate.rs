use jap_core::{AudioFormat, OutputApi, SampleFormat, StreamConfig};

/// 按源格式给出候选输出格式，顺序即偏好，设备会接受其中第一个。
///
/// 共享模式使用系统混音格式；独占模式优先保留源精度。
pub fn candidate_formats(
    src: &AudioFormat,
    api: OutputApi,
    out_channels: u16,
) -> Vec<StreamConfig> {
    use SampleFormat::{F32, F64, I16, I24In32, I24Packed, I32};

    let order: &[SampleFormat] = if !api.is_exclusive() {
        &[F32]
    } else if src.float && src.effective_bits() > 32 {
        &[F64, F32, I32, I24In32, I24Packed, I16]
    } else if src.float {
        &[F32, F64, I32, I24In32, I24Packed, I16]
    } else {
        // 有损编码没有固有位深，解码结果按 24 位整数送出最贴合 DAC
        match src.effective_bits() {
            ..=16 if src.bits.is_some() => &[I16, I24In32, I24Packed, I32],
            ..=24 => &[I24In32, I24Packed, I32, F32, I16],
            _ => &[I32, F32, I24In32, I24Packed, I16],
        }
    };

    let mut rates = vec![src.sample_rate];
    let family = if src.sample_rate.is_multiple_of(44100) {
        44100
    } else {
        48000
    };
    let mut lower: Vec<u32> = [
        12_288_000, 11_289_600, 6_144_000, 5_644_800, 3_072_000, 2_822_400, 1_536_000, 1_411_200,
        768000, 705600, 384000, 352800, 192000, 176400, 96000, 88200, 48000, 44100, 32000, 24000,
        22050, 16000, 12000, 11025, 8000,
    ]
    .into_iter()
    .filter(|&v| v < src.sample_rate)
    .collect();
    lower.sort_by_key(|&v| (v % family != 0, std::cmp::Reverse(v)));
    rates.extend(lower);
    for rate in [48000, 44100] {
        if !rates.contains(&rate) {
            rates.push(rate);
        }
    }
    let mut configs: Vec<_> = rates
        .into_iter()
        .flat_map(|rate| {
            order.iter().map(move |&format| StreamConfig {
                sample_rate: rate,
                channels: out_channels,
                format,
            })
        })
        .collect();
    // Downmix only after every native-channel option has been tried.
    if out_channels > 2 {
        let mut stereo = *src;
        stereo.channels = 2;
        configs.extend(candidate_formats(&stereo, api, 2));
    }
    configs
}

/// `out` 的容器能否逐位容纳 `src`（整数源在位深不缩减时是无损的）。
pub fn holds_exactly(src: &AudioFormat, out: SampleFormat) -> bool {
    if src.float {
        return (out == SampleFormat::F32 && src.bits == Some(32))
            || (out == SampleFormat::F64 && src.bits.is_some_and(|bits| bits <= 64));
    }
    match src.bits {
        Some(bits) => !out.is_float() && out.valid_bits() >= bits,
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pcm(bits: u32) -> AudioFormat {
        AudioFormat {
            sample_rate: 44_100,
            channels: 2,
            bits: Some(bits),
            float: false,
        }
    }

    #[test]
    fn sixteen_bit_prefers_native_container() {
        let c = candidate_formats(&pcm(16), OutputApi::WasapiExclusive, 2);
        assert_eq!(c[0].format, SampleFormat::I16);
    }

    #[test]
    fn twenty_four_bit_tries_exact_before_narrowing() {
        let c = candidate_formats(&pcm(24), OutputApi::WasapiExclusive, 2);
        assert_eq!(c[0].format, SampleFormat::I24In32);
        assert!(c.iter().any(|c| c.format == SampleFormat::I16));
    }

    #[test]
    fn shared_mode_is_float_only() {
        let c = candidate_formats(&pcm(24), OutputApi::WasapiShared, 2);
        assert!(c.iter().all(|c| c.format == SampleFormat::F32));
    }

    #[test]
    fn widening_is_exact_but_narrowing_is_not() {
        assert!(holds_exactly(&pcm(16), SampleFormat::I24In32));
        assert!(holds_exactly(&pcm(24), SampleFormat::I24Packed));
        assert!(!holds_exactly(&pcm(32), SampleFormat::I24In32));
        assert!(!holds_exactly(&pcm(24), SampleFormat::F32));
    }
}

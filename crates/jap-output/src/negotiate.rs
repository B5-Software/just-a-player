use jap_core::{AudioFormat, OutputApi, SampleFormat, StreamConfig};

/// 按源格式给出候选输出格式，顺序即偏好，设备会接受其中第一个。
///
/// 共享模式只给 `F32`：系统混音器本来就以浮点工作，位深不会损失。
pub fn candidate_formats(
    src: &AudioFormat,
    api: OutputApi,
    out_channels: u16,
) -> Vec<StreamConfig> {
    use SampleFormat::{F32, I16, I24In32, I24Packed, I32};

    let order: &[SampleFormat] = if !api.is_exclusive() {
        &[F32]
    } else if src.float {
        &[F32, I32, I24In32, I24Packed]
    } else {
        // 有损编码没有固有位深，解码结果按 24 位整数送出最贴合 DAC
        match src.effective_bits() {
            ..=16 if src.bits.is_some() => &[I16, I24In32, I24Packed, I32],
            ..=24 => &[I24In32, I24Packed, I32, F32],
            _ => &[I32, F32, I24In32, I24Packed],
        }
    };

    order
        .iter()
        .map(|&format| StreamConfig {
            sample_rate: src.sample_rate,
            channels: out_channels,
            format,
        })
        .collect()
}

/// `out` 的容器能否逐位容纳 `src`（整数源在位深不缩减时是无损的）。
pub fn holds_exactly(src: &AudioFormat, out: SampleFormat) -> bool {
    if src.float {
        return out == SampleFormat::F32 && src.bits == Some(32);
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
    fn twenty_four_bit_never_offers_sixteen() {
        let c = candidate_formats(&pcm(24), OutputApi::WasapiExclusive, 2);
        assert!(c.iter().all(|c| c.format != SampleFormat::I16));
    }

    #[test]
    fn shared_mode_is_float_only() {
        let c = candidate_formats(&pcm(24), OutputApi::WasapiShared, 2);
        assert_eq!(c.len(), 1);
        assert_eq!(c[0].format, SampleFormat::F32);
    }

    #[test]
    fn widening_is_exact_but_narrowing_is_not() {
        assert!(holds_exactly(&pcm(16), SampleFormat::I24In32));
        assert!(holds_exactly(&pcm(24), SampleFormat::I24Packed));
        assert!(!holds_exactly(&pcm(32), SampleFormat::I24In32));
        assert!(!holds_exactly(&pcm(24), SampleFormat::F32));
    }
}

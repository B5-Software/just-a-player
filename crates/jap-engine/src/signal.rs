//! 信号链：把“从文件到 DAC 的每一步”整理成可展示、可判定的节点列表。

use jap_core::{
    AudioFormat, Fidelity, NodeKind, SampleFormat, SignalNode, SignalPath, StreamConfig, TrackInfo,
    Verdict,
};
use jap_output::holds_exactly;

use crate::convert::ChannelMap;

pub struct OutputDetails {
    pub device_name: String,
    pub api_label: String,
    pub exclusive: bool,
    pub buffer_frames: u32,
}

#[cfg(test)]
pub fn build(track: &TrackInfo, config: StreamConfig, out: &OutputDetails) -> SignalPath {
    build_with_dsp(track, config, out, &jap_core::DspConfig::default())
}

#[cfg(test)]
pub fn build_with_dsp(
    track: &TrackInfo,
    config: StreamConfig,
    out: &OutputDetails,
    dsp: &jap_core::DspConfig,
) -> SignalPath {
    build_with_controls(track, config, out, dsp, 1.)
}

pub fn build_with_controls(
    track: &TrackInfo,
    config: StreamConfig,
    out: &OutputDetails,
    dsp: &jap_core::DspConfig,
    volume: f32,
) -> SignalPath {
    let src = track.format;
    let mut nodes = Vec::with_capacity(6);

    nodes.push(SignalNode {
        kind: NodeKind::Source,
        title: file_name(&track.path),
        detail: format!("{} · {}", track.codec, describe_format(&src)),
        format: Some(src),
        fidelity: if track.lossless {
            Fidelity::Exact
        } else {
            Fidelity::Lossy
        },
    });

    nodes.push(SignalNode {
        kind: NodeKind::Decoder,
        title: if src.is_dsd() {
            if config.format.is_dsd() {
                "DSD 解封装"
            } else {
                "DSD → PCM 解码"
            }
        } else {
            "解码"
        }
        .into(),
        detail: if src.is_dsd() {
            if config.format.is_dsd() {
                "DSF / DSDIFF / SACD ISO · DST 无损解压后保留 DSD，绕过 PCM 与 DSP".into()
            } else {
                "DSD → PCM · CIC4 + Blackman FIR 低通 / 64 倍抽取".into()
            }
        } else if track.lossless {
            "Symphonia · 64 位浮点内部格式，整数源往返无损".into()
        } else {
            "Symphonia · 有损解码".into()
        },
        format: None,
        fidelity: if src.is_dsd() && !config.format.is_dsd() {
            Fidelity::Transformed
        } else if track.lossless {
            Fidelity::Exact
        } else {
            Fidelity::Lossy
        },
    });

    if dsp.enabled && !config.format.is_dsd() {
        nodes.push(SignalNode {
            kind: NodeKind::Dsp,
            title: "DSP · 10 段 EQ".into(),
            detail: format!(
                "前级 {:+.1} dB · 宽度 {:.0}% · 串音 {:.0}% · 限幅 {}",
                dsp.preamp_db,
                dsp.stereo_width * 100.,
                dsp.crossfeed * 100.,
                if dsp.limiter { "开" } else { "关" }
            ),
            format: None,
            fidelity: Fidelity::Transformed,
        });
    }

    let mapped = ChannelMap::new(src.channels as usize, config.channels as usize);
    if volume < 1. && !config.format.is_dsd() {
        nodes.push(SignalNode {
            kind: NodeKind::Dsp,
            title: "应用内音量".into(),
            detail: if volume == 0. {
                "静音".into()
            } else {
                format!("{:.0}% · {:.1} dB", volume * 100., 20. * volume.log10())
            },
            format: None,
            fidelity: Fidelity::Transformed,
        });
    }
    if mapped.as_ref().is_some_and(ChannelMap::is_transforming) {
        nodes.push(SignalNode {
            kind: NodeKind::ChannelMap,
            title: "声道映射".into(),
            detail: format!("{} 声道 -> {} 声道", src.channels, config.channels),
            format: None,
            fidelity: Fidelity::Transformed,
        });
    }

    let exact = if src.is_dsd() {
        config.format.is_dsd()
    } else if dsp.enabled {
        false
    } else {
        holds_exactly(&src, config.format)
    };
    nodes.push(SignalNode {
        kind: NodeKind::Quantizer,
        title: if config.format.is_dsd() {
            "DSD 传输封装".into()
        } else {
            "输出量化".into()
        },
        detail: describe_sample_format(config.format).into(),
        format: Some(config.audio_format()),
        fidelity: if exact {
            Fidelity::Exact
        } else {
            Fidelity::Transformed
        },
    });

    let buffer_ms = f64::from(out.buffer_frames) * 1000.0 / f64::from(config.sample_rate);
    nodes.push(SignalNode {
        kind: NodeKind::Output,
        title: out.api_label.clone(),
        detail: if out.exclusive {
            format!("缓冲 {buffer_ms:.1} ms · 绕过系统混音器")
        } else {
            format!("缓冲 {buffer_ms:.1} ms · 由系统混音，可能重采样")
        },
        format: None,
        fidelity: if out.exclusive {
            Fidelity::Exact
        } else {
            Fidelity::Transformed
        },
    });

    nodes.push(SignalNode {
        kind: NodeKind::Device,
        title: out.device_name.clone(),
        detail: describe_format(&config.audio_format()),
        format: Some(config.audio_format()),
        fidelity: Fidelity::Exact,
    });

    let verdict = if !out.exclusive {
        Verdict::SystemMixed
    } else if !track.lossless {
        Verdict::Lossy
    } else if nodes.iter().any(|n| n.fidelity == Fidelity::Transformed) {
        Verdict::Processed
    } else {
        Verdict::BitPerfect
    };

    SignalPath { nodes, verdict }
}

fn file_name(path: &str) -> String {
    std::path::Path::new(path)
        .file_name()
        .map_or_else(|| path.to_owned(), |n| n.to_string_lossy().into_owned())
}

fn describe_format(f: &AudioFormat) -> String {
    if f.is_dsd() {
        return format!(
            "DSD{} · {:.4} MHz · {} 声道",
            f.sample_rate
                / if f.sample_rate.is_multiple_of(44100) {
                    44100
                } else {
                    48000
                },
            f.sample_rate as f64 / 1e6,
            f.channels
        );
    }
    let depth = match (f.bits, f.float) {
        (Some(b), true) => format!("{b}-bit 浮点"),
        (Some(b), false) => format!("{b}-bit"),
        (None, _) => "有损".to_owned(),
    };
    let rate = f64::from(f.sample_rate) / 1000.0;
    let channels = match f.channels {
        1 => "单声道".to_owned(),
        2 => "立体声".to_owned(),
        n => format!("{n} 声道"),
    };
    format!("{depth} / {rate} kHz · {channels}")
}

fn describe_sample_format(format: SampleFormat) -> &'static str {
    match format {
        SampleFormat::I16 => "16-bit 整数",
        SampleFormat::I24Packed => "24-bit 整数（3 字节紧凑）",
        SampleFormat::I24In32 => "24-bit 整数（左对齐于 32 位容器）",
        SampleFormat::I32 => "32-bit 整数",
        SampleFormat::F32 => "32-bit 浮点",
        SampleFormat::Dop24 => "DoP 1.1 · 24-bit 载波 · 原始 DSD 不变",
        SampleFormat::Dop32 => "DoP 1.1 · 24-in-32 载波 · 原始 DSD 不变",
        SampleFormat::DsdU8Lsb => "ASIO 原生 DSD · LSB-first",
        SampleFormat::DsdU8Msb => "ASIO 原生 DSD · MSB-first",
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;

    fn track(bits: Option<u32>, lossless: bool) -> TrackInfo {
        TrackInfo {
            path: "C:/m/a.flac".into(),
            codec: "FLAC".into(),
            format: AudioFormat {
                sample_rate: 96_000,
                channels: 2,
                bits,
                float: false,
            },
            duration_ms: Some(1000),
            lossless,
            bitrate_kbps: None,
            title: None,
            artist: None,
            album: None,
        }
    }

    fn details(exclusive: bool) -> OutputDetails {
        OutputDetails {
            device_name: "DAC".into(),
            api_label: "WASAPI".into(),
            exclusive,
            buffer_frames: 960,
        }
    }

    fn cfg(format: SampleFormat) -> StreamConfig {
        StreamConfig {
            sample_rate: 96_000,
            channels: 2,
            format,
        }
    }

    #[test]
    fn lossless_exclusive_native_depth_is_bit_perfect() {
        let p = build(
            &track(Some(24), true),
            cfg(SampleFormat::I24In32),
            &details(true),
        );
        assert_eq!(p.verdict, Verdict::BitPerfect);
        assert!(p.nodes.iter().all(|n| n.fidelity == Fidelity::Exact));
    }

    #[test]
    fn truncating_depth_is_processed_not_bit_perfect() {
        let p = build(
            &track(Some(32), true),
            cfg(SampleFormat::I24In32),
            &details(true),
        );
        assert_eq!(p.verdict, Verdict::Processed);
    }

    #[test]
    fn shared_mode_is_never_bit_perfect() {
        let p = build(
            &track(Some(16), true),
            cfg(SampleFormat::F32),
            &details(false),
        );
        assert_eq!(p.verdict, Verdict::SystemMixed);
    }

    #[test]
    fn dsp_and_dsd_conversion_are_never_labeled_bit_perfect() {
        let dsp = jap_core::DspConfig {
            enabled: true,
            ..Default::default()
        };
        let p = build_with_dsp(
            &track(Some(24), true),
            cfg(SampleFormat::I24In32),
            &details(true),
            &dsp,
        );
        assert_eq!(p.verdict, Verdict::Processed);
        assert!(p.nodes.iter().any(|n| n.kind == NodeKind::Dsp));
        assert!(
            p.nodes
                .iter()
                .any(|n| n.kind == NodeKind::Quantizer && n.fidelity == Fidelity::Transformed)
        );
        let mut dsd = track(Some(1), true);
        dsd.format.sample_rate = 2_822_400;
        let p = build(
            &dsd,
            StreamConfig {
                sample_rate: 44100,
                ..cfg(SampleFormat::I24In32)
            },
            &details(true),
        );
        assert_eq!(p.verdict, Verdict::Processed);
        let p = build(
            &dsd,
            StreamConfig {
                sample_rate: 176400,
                ..cfg(SampleFormat::Dop24)
            },
            &details(true),
        );
        assert_eq!(p.verdict, Verdict::BitPerfect);
    }

    #[test]
    fn lossy_source_is_flagged() {
        let p = build(
            &track(None, false),
            cfg(SampleFormat::I24In32),
            &details(true),
        );
        assert_eq!(p.verdict, Verdict::Lossy);
        let _ = Arc::new(p);
    }
}

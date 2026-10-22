//! 命令行工具：不依赖 Electron 就能验证解码、设备枚举与播放。

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
use clap::{Parser, Subcommand};
use jap_core::{
    Command, Event, OutputApi, OutputConfig, Query, QueryResponse, SignalPath, Verdict,
};
use jap_engine::{Engine, EventSink};
use sha2::{Digest, Sha256};

#[derive(Parser)]
#[command(name = "jap-cli", about = "Just A Player 命令行工具")]
struct Cli {
    #[command(subcommand)]
    command: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// 列出渲染设备
    Devices,
    /// 列出设备在独占模式下支持的格式
    Probe {
        #[arg(long)]
        device: Option<String>,
    },
    /// 显示文件的解码信息
    Info {
        path: PathBuf,
    },
    /// List each subsong of a SACD ISO or CD/CUE image without decoding audio.
    Tracks {
        path: PathBuf,
    },
    /// 离线分析真实音频样本（最多 32 秒，多位置抽样）
    Analyze {
        path: PathBuf,
    },
    AsioDevices,
    /// 解码并输出交错 s32 的 SHA-256，可与 `ffmpeg -f s32le` 的结果比对
    Hash {
        path: PathBuf,
    },
    /// 播放文件
    Play {
        path: PathBuf,
        /// 使用 WASAPI 独占模式（默认共享）
        #[arg(long)]
        exclusive: bool,
        #[arg(long)]
        asio: bool,
        #[arg(long, default_value = "pcm", value_parser = ["pcm", "dop", "native"])]
        dsd: String,
        #[arg(long)]
        device: Option<String>,
        #[arg(long, default_value_t = 20)]
        buffer_ms: u32,
        /// 起播位置（毫秒）
        #[arg(long)]
        start: Option<u64>,
    },
}

fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_env("JAP_LOG")
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("warn")),
        )
        .init();

    match Cli::parse().command {
        Cmd::Devices => devices(),
        Cmd::Probe { device } => probe(device),
        Cmd::Info { path } => info(&path),
        Cmd::Tracks { path } => {
            println!(
                "{}",
                serde_json::to_string_pretty(&jap_decode::disc::tracks(&path)?)?
            );
            Ok(())
        }
        Cmd::AsioDevices => {
            println!(
                "{}",
                serde_json::to_string_pretty(&silent_engine().query(Query::ListAsioDevices))?
            );
            Ok(())
        }
        Cmd::Analyze { path } => {
            let (tx, rx) = std::sync::mpsc::channel();
            let engine = Engine::new(Arc::new(move |event| {
                let _ = tx.send(event);
            }));
            engine.send(Command::AnalyzeQuality {
                path: path.display().to_string(),
            });
            for event in rx {
                match event {
                    Event::Quality { report } => {
                        println!("{}", serde_json::to_string_pretty(&report)?);
                        break;
                    }
                    Event::QualityError { message, .. } => bail!(message),
                    _ => {}
                }
            }
            Ok(())
        }
        Cmd::Hash { path } => hash(&path),
        Cmd::Play {
            path,
            exclusive,
            asio,
            dsd,
            device,
            buffer_ms,
            start,
        } => {
            let api = if asio {
                OutputApi::Asio
            } else if exclusive {
                OutputApi::platform_exclusive()
            } else {
                OutputApi::platform_default()
            };
            let mode = match dsd.as_str() {
                "dop" => jap_core::device::DsdMode::Dop,
                "native" => jap_core::device::DsdMode::Native,
                _ => jap_core::device::DsdMode::Pcm,
            };
            play(
                &path,
                OutputConfig {
                    api,
                    device_id: device,
                    buffer_ms,
                    dsd_mode: mode,
                },
                start,
            )
        }
    }
}

fn silent_engine() -> Engine {
    Engine::new(Arc::new(|_| {}))
}

fn devices() -> Result<()> {
    match silent_engine().query(Query::ListDevices) {
        QueryResponse::Devices { devices } => {
            for d in devices {
                println!(
                    "{}{}\n    {}",
                    if d.is_default { "* " } else { "  " },
                    d.name,
                    d.id
                );
            }
            Ok(())
        }
        QueryResponse::Error { message } => bail!(message),
        QueryResponse::ExclusiveFormats { .. }
        | QueryResponse::Track { .. }
        | QueryResponse::Tracks { .. }
        | QueryResponse::Lyrics { .. } => unreachable!(),
    }
}

fn probe(device: Option<String>) -> Result<()> {
    match silent_engine().query(Query::ProbeExclusive { device_id: device }) {
        QueryResponse::ExclusiveFormats { formats } => {
            if formats.is_empty() {
                println!("设备在独占模式下没有接受任何格式");
            }
            for f in formats {
                println!("{:>7} Hz  {} ch  {:?}", f.sample_rate, f.channels, f.format);
            }
            Ok(())
        }
        QueryResponse::Error { message } => bail!(message),
        QueryResponse::Devices { .. }
        | QueryResponse::Track { .. }
        | QueryResponse::Tracks { .. }
        | QueryResponse::Lyrics { .. } => unreachable!(),
    }
}

fn info(path: &Path) -> Result<()> {
    let source = jap_decode::open(path).with_context(|| path.display().to_string())?;
    println!("{}", serde_json::to_string_pretty(source.info())?);
    Ok(())
}

fn hash(path: &Path) -> Result<()> {
    let mut source = jap_decode::open(path).with_context(|| path.display().to_string())?;
    let mut hasher = Sha256::new();
    let (mut buf, mut bytes, mut frames) = (Vec::new(), Vec::new(), 0u64);
    loop {
        buf.clear();
        let n = source.read(&mut buf)?;
        if n == 0 {
            break;
        }
        frames += n as u64;
        bytes.clear();
        for &v in &buf {
            let x = (v * 2_147_483_648.0)
                .round()
                .clamp(-2_147_483_648.0, 2_147_483_647.0) as i32;
            bytes.extend_from_slice(&x.to_le_bytes());
        }
        hasher.update(&bytes);
    }
    let digest: String = hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    println!("{digest}  ({frames} 帧)");
    Ok(())
}

fn play(path: &Path, config: OutputConfig, start: Option<u64>) -> Result<()> {
    let (tx, rx) = std::sync::mpsc::channel();
    let sink: EventSink = Arc::new(move |e| {
        let _ = tx.send(e);
    });
    let engine = Engine::new(sink);

    engine.send(Command::SetOutput { config });
    engine.send(Command::Play {
        path: path.display().to_string(),
        start_ms: start,
    });

    let mut last_print = Instant::now() - Duration::from_secs(1);
    for event in rx {
        match event {
            Event::State { state } => println!("状态: {state:?}"),
            Event::TrackChanged { track } => println!(
                "曲目: {} - {} [{}]",
                track.artist.as_deref().unwrap_or("?"),
                track.title.as_deref().unwrap_or(&track.path),
                track.codec
            ),
            Event::SignalPath { path } => print_signal_path(&path),
            Event::Position {
                position_ms,
                duration_ms,
            } => {
                if last_print.elapsed() >= Duration::from_secs(1) {
                    last_print = Instant::now();
                    println!(
                        "  {} / {}",
                        fmt_ms(position_ms),
                        duration_ms.map_or("--:--".into(), fmt_ms)
                    );
                }
            }
            Event::QueueEnded => {
                println!("播放结束");
                break;
            }
            Event::Error { message } => bail!(message),
            Event::DspChanged { .. }
            | Event::Quality { .. }
            | Event::QualityError { .. }
            | Event::Volume { .. }
            | Event::BufferReset { .. } => {}
        }
    }
    drop(engine);
    Ok(())
}

fn print_signal_path(path: &SignalPath) {
    println!("信号链:");
    for node in &path.nodes {
        println!("  [{:?}] {} - {}", node.fidelity, node.title, node.detail);
    }
    let verdict = match path.verdict {
        Verdict::BitPerfect => "Bit-Perfect (软件侧已验证)",
        Verdict::Processed => "无损源，但被处理过",
        Verdict::Lossy => "有损源",
        Verdict::SystemMixed => "由系统混音器处理",
    };
    println!("  结论: {verdict}");
}

fn fmt_ms(ms: u64) -> String {
    format!("{:02}:{:02}", ms / 60_000, ms / 1000 % 60)
}

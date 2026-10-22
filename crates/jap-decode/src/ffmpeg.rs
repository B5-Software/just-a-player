//! Streaming fallback for codecs outside Symphonia. No intermediate PCM file.
use crate::{AudioSource, DecodeError, Result};
use jap_core::{AudioFormat, TrackInfo};
use std::{
    io::Read,
    path::Path,
    process::{Child, ChildStdout, Command, Stdio},
};

pub(crate) fn command(program: &str) -> Command {
    let variable = match program {
        "ffmpeg" => "JAP_FFMPEG_PATH",
        "ffprobe" => "JAP_FFPROBE_PATH",
        _ => unreachable!(),
    };
    // Electron provides absolute bundled paths; the standalone CLI can use PATH.
    let executable = std::env::var_os(variable).filter(|p| !p.is_empty());
    let c = Command::new(executable.as_deref().unwrap_or_else(|| program.as_ref()));
    #[cfg(windows)]
    let c = {
        use std::os::windows::process::CommandExt;
        let mut c = c;
        c.creation_flags(0x08000000);
        c
    };
    c
}
pub struct FfmpegSource {
    info: TrackInfo,
    child: Option<Child>,
    pipe: Option<ChildStdout>,
    position: u64,
}
impl FfmpegSource {
    pub fn open(path: &Path) -> Result<Self> {
        let output = command("ffprobe")
            .args([
                "-v",
                "error",
                "-select_streams",
                "a:0",
                "-show_streams",
                "-show_format",
                "-of",
                "json",
            ])
            .arg(path)
            .output()
            .map_err(|e| {
                DecodeError::Unsupported(format!(
                    "无法启动 FFprobe，请修复安装或检查命令行工具路径：{e}"
                ))
            })?;
        let value: serde_json::Value = serde_json::from_slice(&output.stdout)
            .map_err(|_| DecodeError::Unsupported("FFprobe 无法识别音轨".into()))?;
        let s = &value["streams"][0];
        let f = &value["format"];
        let codec = s["codec_name"]
            .as_str()
            .ok_or_else(|| DecodeError::Unsupported("没有可解码的音轨".into()))?;
        let rate: u32 = s["sample_rate"]
            .as_str()
            .and_then(|v| v.parse().ok())
            .unwrap_or(0);
        let channels = s["channels"].as_u64().unwrap_or(0) as u16;
        if rate == 0 || channels == 0 || channels > 32 {
            return Err(DecodeError::Unsupported("无效音轨参数".into()));
        }
        let profile = s["profile"].as_str();
        let lossless = matches!(codec, "ape" | "flac" | "wavpack" | "alac")
            || codec.starts_with("pcm_")
            || codec == "dts"
                && profile.is_some_and(|p| p.contains("DTS-HD MA") || p.contains("Master Audio"));
        let bits = s["bits_per_raw_sample"]
            .as_str()
            .and_then(|v| v.parse::<u32>().ok())
            .filter(|&v| v > 0)
            .or_else(|| {
                s["bits_per_sample"]
                    .as_u64()
                    .filter(|&v| v > 0)
                    .map(|v| v as u32)
            });
        let duration_ms = s["duration"]
            .as_str()
            .or_else(|| f["duration"].as_str())
            .and_then(|v| v.parse::<f64>().ok())
            .map(|v| (v * 1000.) as u64);
        let tags = &f["tags"];
        let tag = |name: &str| {
            tags[name]
                .as_str()
                .or_else(|| tags[name.to_uppercase()].as_str())
                .map(str::to_owned)
        };
        let info = TrackInfo {
            path: path.display().to_string(),
            codec: format!(
                "{}{} / FFmpeg",
                codec.to_uppercase(),
                profile.map(|p| format!(" ({p})")).unwrap_or_default()
            ),
            format: AudioFormat {
                sample_rate: rate,
                channels,
                bits: if lossless { bits } else { None },
                float: codec.starts_with("pcm_f"),
            },
            duration_ms,
            lossless,
            bitrate_kbps: f["bit_rate"]
                .as_str()
                .and_then(|v| v.parse::<u32>().ok())
                .map(|v| v / 1000),
            title: tag("title"),
            artist: tag("artist"),
            album: tag("album"),
        };
        let mut source = Self {
            info,
            child: None,
            pipe: None,
            position: 0,
        };
        source.restart(0)?;
        Ok(source)
    }
    fn restart(&mut self, ms: u64) -> Result<()> {
        self.stop();
        let mut c = command("ffmpeg");
        c.args(["-v", "error", "-nostdin"]);
        // Decode a short preroll, then trim at the exact output sample. Input
        // seeking alone can return EOF for a short FLAC without a seek table.
        let coarse = ms.saturating_sub(2000);
        if coarse > 0 {
            c.args(["-ss", &format!("{:.6}", coarse as f64 / 1000.)]);
        }
        c.arg("-i").arg(&self.info.path);
        if ms > 0 {
            c.args(["-ss", &format!("{:.6}", (ms - coarse) as f64 / 1000.)]);
        }
        c.args([
            "-map",
            "0:a:0",
            "-vn",
            "-sn",
            "-dn",
            "-f",
            "f64le",
            "-acodec",
            "pcm_f64le",
            "pipe:1",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .stdin(Stdio::null());
        let mut child = c
            .spawn()
            .map_err(|e| DecodeError::Unsupported(format!("无法启动 FFmpeg：{e}")))?;
        self.pipe = child.stdout.take();
        self.child = Some(child);
        self.position = ms * u64::from(self.info.format.sample_rate) / 1000;
        Ok(())
    }
    fn stop(&mut self) {
        self.pipe.take();
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}
impl AudioSource for FfmpegSource {
    fn info(&self) -> &TrackInfo {
        &self.info
    }
    fn read(&mut self, out: &mut Vec<f64>) -> Result<usize> {
        let frame_bytes = usize::from(self.info.format.channels) * 8;
        let mut bytes = vec![0; 2048 * frame_bytes];
        let mut used = 0;
        let pipe = self
            .pipe
            .as_mut()
            .ok_or_else(|| DecodeError::Unsupported("FFmpeg 已关闭".into()))?;
        while used < bytes.len() {
            let n = pipe.read(&mut bytes[used..])?;
            if n == 0 {
                break;
            }
            used += n;
        }
        if !used.is_multiple_of(frame_bytes) {
            return Err(DecodeError::Unsupported("截断的 FFmpeg 音频帧".into()));
        }
        if used == 0
            && let Some(child) = self.child.as_mut()
            && !child.wait()?.success()
        {
            return Err(DecodeError::Decode("FFmpeg 音轨解码失败".into()));
        }
        for b in bytes[..used].as_chunks::<8>().0 {
            out.push(f64::from_le_bytes(*b));
        }
        let frames = used / frame_bytes;
        self.position += frames as u64;
        Ok(frames)
    }
    fn seek(&mut self, position_ms: u64) -> Result<u64> {
        self.restart(position_ms)?;
        Ok(position_ms)
    }
    fn position_frames(&self) -> u64 {
        self.position
    }
}
impl Drop for FfmpegSource {
    fn drop(&mut self) {
        self.stop();
    }
}

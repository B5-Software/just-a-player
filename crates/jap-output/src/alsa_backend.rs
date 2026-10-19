//! ALSA `hw:` output: exact hardware parameters, no plughw/dmix resampling.
use crate::{
    OpenRequest, OpenedStream, OutputError, RenderSource, Result, StreamEvent, StreamHandle,
};
use alsa::{
    Direction, ValueOr,
    pcm::{Access, Format, HwParams, PCM},
};
use cpal::traits::DeviceTrait;
use jap_core::SampleFormat;
use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    thread,
    time::Duration,
};

fn err(e: impl std::fmt::Display) -> OutputError {
    OutputError::Backend(e.to_string())
}
struct Handle {
    stop: Arc<AtomicBool>,
    started: Arc<AtomicBool>,
    thread: Option<thread::JoinHandle<()>>,
}
impl StreamHandle for Handle {
    fn start(&self) {
        self.started.store(true, Ordering::Release)
    }
}
impl Drop for Handle {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}
pub(crate) fn open(
    request: &OpenRequest,
    mut source: Box<dyn RenderSource>,
) -> Result<OpenedStream> {
    let device = crate::portable_backend::choose(request.api, request.device_id.as_deref())?;
    let id = device.id().map_err(err)?;
    if !id.id().starts_with("hw:") {
        return Err(OutputError::UnsupportedFormat(
            "独占输出只能使用 ALSA hw: 设备；plughw/default 会引入转换".into(),
        ));
    }
    let mut selected = None;
    for &candidate in &request.candidates {
        let format = match candidate.format {
            SampleFormat::I16 => Format::s16(),
            SampleFormat::I24Packed | SampleFormat::Dop24 => Format::s24_3(),
            SampleFormat::I24In32 | SampleFormat::I32 | SampleFormat::Dop32 => Format::s32(),
            SampleFormat::F32 => Format::float(),
            _ => continue,
        };
        let pcm = match PCM::new(id.id(), Direction::Playback, true) {
            Ok(p) => p,
            Err(_) => continue,
        };
        let configured = (|| -> std::result::Result<_, alsa::Error> {
            let hw = HwParams::any(&pcm)?;
            hw.set_access(Access::RWInterleaved)?;
            hw.set_format(format)?;
            hw.set_channels(candidate.channels as u32)?;
            // The exact setter rejects unsupported rates; no nearest-rate fallback.
            hw.set_rate(candidate.sample_rate, ValueOr::Nearest)?;
            if hw.get_rate()? != candidate.sample_rate {
                return Err(alsa::Error::unsupported("exact sample rate"));
            }
            let desired =
                (candidate.sample_rate as u64 * request.buffer_ms.max(5) as u64 / 1000).max(64);
            hw.set_buffer_size_near(desired as _)?;
            hw.set_period_size_near((desired / 4).max(16) as _, ValueOr::Nearest)?;
            pcm.hw_params(&hw)?;
            let actual = pcm.hw_params_current()?;
            if actual.get_rate()? != candidate.sample_rate
                || actual.get_channels()? != candidate.channels as u32
                || actual.get_format()? != format
            {
                return Err(alsa::Error::unsupported("hardware format changed"));
            }
            let frames = actual.get_buffer_size()? as u32;
            let period = actual.get_period_size()? as usize;
            drop(actual);
            drop(hw);
            let sw = pcm.sw_params_current()?;
            sw.set_start_threshold(1)?;
            sw.set_avail_min(period as _)?;
            pcm.sw_params(&sw)?;
            drop(sw);
            pcm.prepare()?;
            Ok((frames, period))
        })();
        if let Ok((frames, period)) = configured {
            selected = Some((pcm, candidate, frames, period));
            break;
        }
    }
    let (pcm, config, frames, period) = selected.ok_or_else(|| {
        OutputError::UnsupportedFormat(
            "ALSA 硬件不接受候选格式，或已被 PipeWire/PulseAudio 占用；可切换系统共享输出".into(),
        )
    })?;
    let stop = Arc::new(AtomicBool::new(false));
    let started = Arc::new(AtomicBool::new(false));
    let worker_stop = Arc::clone(&stop);
    let worker_started = Arc::clone(&started);
    let (tx, rx) = mpsc::channel();
    let thread = thread::Builder::new()
        .name("jap-alsa-hw".into())
        .spawn(move || {
            let bytes_per_frame = config.bytes_per_frame();
            let mut buffer = vec![0u8; period * bytes_per_frame];
            let io = pcm.io_bytes();
            'stream: while !worker_stop.load(Ordering::Acquire) {
                if !worker_started.load(Ordering::Acquire) {
                    thread::sleep(Duration::from_millis(2));
                    continue;
                }
                source.render(&mut buffer);
                let mut written = 0;
                while written < period && !worker_stop.load(Ordering::Acquire) {
                    match io.writei(&buffer[written * bytes_per_frame..]) {
                        Ok(n) if n > 0 => written += n,
                        Ok(_) => {
                            let _ = pcm.wait(Some(20));
                        }
                        Err(e) if e.errno() == 11 => {
                            let _ = pcm.wait(Some(20));
                        }
                        Err(e) => {
                            if pcm.try_recover(e, true).is_ok() {
                                let _ = tx.send(StreamEvent::ResetRequired(
                                    "ALSA xrun：重建音频缓冲".into(),
                                ));
                            } else {
                                let _ =
                                    tx.send(StreamEvent::Failed("ALSA 设备已断开或流失败".into()));
                            }
                            break 'stream;
                        }
                    }
                }
            }
            let _ = pcm.drop();
        })
        .map_err(err)?;
    Ok(OpenedStream {
        config,
        buffer_frames: frames,
        exclusive: true,
        device_name: device.to_string(),
        api_label: "ALSA hw · 原始格式独占（无软件重采样）".into(),
        events: rx,
        handle: Box::new(Handle {
            stop,
            started,
            thread: Some(thread),
        }),
    })
}

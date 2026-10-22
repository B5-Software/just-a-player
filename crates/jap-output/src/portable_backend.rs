//! Native CoreAudio / ALSA shared streams. Callbacks consume the existing ring directly.
use crate::{
    OpenRequest, OpenedStream, OutputError, RenderSource, Result, StreamEvent, StreamHandle,
};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use jap_core::{DeviceInfo, OutputApi, SampleFormat, StreamConfig};
use std::{
    sync::mpsc::{self, Sender},
    time::Duration,
};

fn err(e: impl std::fmt::Display) -> OutputError {
    OutputError::Backend(e.to_string())
}
fn validate(api: OutputApi) -> Result<()> {
    if (cfg!(target_os = "macos")
        && matches!(api, OutputApi::CoreAudio | OutputApi::CoreAudioExclusive))
        || (cfg!(target_os = "linux")
            && matches!(api, OutputApi::AlsaShared | OutputApi::AlsaExclusive))
    {
        Ok(())
    } else {
        Err(OutputError::UnsupportedApi(api))
    }
}
pub(crate) fn choose(api: OutputApi, id: Option<&str>) -> Result<cpal::Device> {
    validate(api)?;
    let host = cpal::default_host();
    if let Some(id) = id {
        return host
            .device_by_id(&id.parse().map_err(err)?)
            .ok_or(OutputError::DeviceNotFound);
    }
    if api == OutputApi::AlsaExclusive {
        return host
            .devices()
            .map_err(err)?
            .find(|d| d.id().is_ok_and(|id| id.id().starts_with("hw:")) && d.supports_output())
            .ok_or(OutputError::DeviceNotFound);
    }
    let default = host
        .default_output_device()
        .ok_or(OutputError::DeviceNotFound)?;
    if api == OutputApi::CoreAudioExclusive {
        return host
            .device_by_id(&default.id().map_err(err)?)
            .ok_or(OutputError::DeviceNotFound);
    }
    Ok(default)
}
pub(crate) fn list_devices(api: OutputApi) -> Result<Vec<DeviceInfo>> {
    validate(api)?;
    let host = cpal::default_host();
    let default = host.default_output_device().and_then(|d| d.id().ok());
    host.devices()
        .map_err(err)?
        .filter_map(|d| {
            let id = d.id().ok()?;
            if api == OutputApi::AlsaExclusive && !id.id().starts_with("hw:") {
                return None;
            }
            if !d.supports_output() {
                return None;
            }
            Some(Ok(DeviceInfo {
                name: format!("{d}"),
                is_default: default.as_ref() == Some(&id),
                id: id.to_string(),
            }))
        })
        .collect()
}
pub(crate) fn probe_exclusive(id: Option<&str>) -> Result<Vec<StreamConfig>> {
    let api = OutputApi::platform_exclusive();
    let device = choose(api, id)?;
    let mut formats = Vec::new();
    for range in device.supported_output_configs().map_err(err)? {
        let format = match range.sample_format() {
            cpal::SampleFormat::I16 => SampleFormat::I16,
            cpal::SampleFormat::I32 => SampleFormat::I32,
            cpal::SampleFormat::F32 => SampleFormat::F32,
            cpal::SampleFormat::F64 => SampleFormat::F64,
            _ => continue,
        };
        for rate in [
            44100, 48000, 88200, 96000, 176400, 192000, 352800, 384000, 705600, 768000,
        ] {
            if rate >= range.min_sample_rate() && rate <= range.max_sample_rate() {
                let config = StreamConfig {
                    sample_rate: rate,
                    channels: range.channels(),
                    format,
                };
                if !formats.contains(&config) {
                    formats.push(config)
                }
            }
        }
    }
    Ok(formats)
}
fn raw_format(format: SampleFormat) -> Option<cpal::SampleFormat> {
    match format {
        SampleFormat::I16 => Some(cpal::SampleFormat::I16),
        SampleFormat::I24In32 | SampleFormat::I32 | SampleFormat::Dop32 => {
            Some(cpal::SampleFormat::I32)
        }
        SampleFormat::F32 => Some(cpal::SampleFormat::F32),
        SampleFormat::F64 => Some(cpal::SampleFormat::F64),
        _ => None,
    }
}
struct Handle {
    stream: cpal::Stream,
    errors: Sender<StreamEvent>,
    #[cfg(target_os = "macos")]
    _hog: Option<crate::coreaudio_guard::HogGuard>,
}
impl StreamHandle for Handle {
    fn start(&self) {
        if let Err(e) = self.stream.play() {
            let _ = self.errors.send(StreamEvent::Failed(e.to_string()));
        }
    }
}
pub(crate) fn open(
    request: &OpenRequest,
    mut source: Box<dyn RenderSource>,
) -> Result<OpenedStream> {
    let device = choose(request.api, request.device_id.as_deref())?;
    #[cfg(target_os = "macos")]
    let hog = if request.api.is_exclusive() {
        Some(crate::coreaudio_guard::HogGuard::acquire(
            device.id().map_err(err)?.id(),
        )?)
    } else {
        None
    };
    let ranges: Vec<_> = device.supported_output_configs().map_err(err)?.collect();
    let mut selected = None;
    let mut candidates = request.candidates.clone();
    if !request.api.is_exclusive()
        && let Ok(default) = device.default_output_config()
    {
        let format = match default.sample_format() {
            cpal::SampleFormat::I16 => Some(SampleFormat::I16),
            cpal::SampleFormat::I32 => Some(SampleFormat::I32),
            cpal::SampleFormat::F32 => Some(SampleFormat::F32),
            cpal::SampleFormat::F64 => Some(SampleFormat::F64),
            _ => None,
        };
        if let Some(format) = format {
            candidates.push(StreamConfig {
                channels: default.channels(),
                sample_rate: default.sample_rate(),
                format,
            });
        }
    }
    for &candidate in &candidates {
        let Some(format) = raw_format(candidate.format) else {
            continue;
        };
        if !ranges.iter().any(|r| {
            r.channels() == candidate.channels
                && r.sample_format() == format
                && r.min_sample_rate() <= candidate.sample_rate
                && r.max_sample_rate() >= candidate.sample_rate
        }) {
            continue;
        }
        let config = cpal::StreamConfig {
            channels: candidate.channels,
            sample_rate: candidate.sample_rate,
            buffer_size: cpal::BufferSize::Default,
        };
        // Negotiate with a paused silence callback, then give the sole real callback
        // ownership of the source. No mutex or allocation is needed on the RT path.
        if let Ok(probe) = device.build_output_stream_raw(
            config,
            format,
            |d, _| d.bytes_mut().fill(0),
            |_| {},
            Some(Duration::from_secs(2)),
        ) {
            #[cfg(target_os = "macos")]
            if hog.as_ref().is_some_and(|guard| !guard.accepts(candidate)) {
                drop(probe);
                continue;
            }
            drop(probe);
            selected = Some((candidate, config, format));
            break;
        }
    }
    let (candidate, config, format) = selected.ok_or_else(|| {
        OutputError::UnsupportedFormat("没有与原始采样率/声道/位深兼容的设备格式".into())
    })?;
    let (tx, rx) = mpsc::channel();
    let errors = tx.clone();
    let stream = device
        .build_output_stream_raw(
            config,
            format,
            move |d, _| source.render(d.bytes_mut()),
            move |e| {
                let event = if matches!(
                    e.kind(),
                    cpal::ErrorKind::Xrun | cpal::ErrorKind::DeviceChanged
                ) {
                    StreamEvent::ResetRequired(e.to_string())
                } else {
                    StreamEvent::Failed(e.to_string())
                };
                let _ = errors.send(event);
            },
            Some(Duration::from_secs(2)),
        )
        .map_err(err)?;
    #[cfg(target_os = "macos")]
    if hog.as_ref().is_some_and(|guard| !guard.accepts(candidate)) {
        return Err(OutputError::UnsupportedFormat(
            "硬件物理格式未保持请求的位深/采样率".into(),
        ));
    }
    Ok(OpenedStream {
        config: candidate,
        buffer_frames: (candidate.sample_rate * request.buffer_ms / 1000).max(1),
        exclusive: request.api.is_exclusive(),
        device_name: device.to_string(),
        api_label: match request.api {
            OutputApi::CoreAudioExclusive => "CoreAudio Hog · 原始采样率",
            OutputApi::CoreAudio => "CoreAudio · 原始采样率 / 系统共享",
            _ => "ALSA 系统共享（PipeWire / PulseAudio 插件）",
        }
        .into(),
        events: rx,
        handle: Box::new(Handle {
            stream,
            errors: tx,
            #[cfg(target_os = "macos")]
            _hog: hog,
        }),
    })
}

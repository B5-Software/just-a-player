use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use jap_core::{DeviceInfo, OutputApi, SampleFormat, StreamConfig};
use wasapi::{
    AudioClient, CapabilityProbe, Device, DeviceEnumerator, Direction, SampleType, StreamMode,
    WasapiError, WaveFormat, calculate_period_100ns, deinitialize, initialize_mta,
};
use windows::Win32::Foundation::HANDLE;
use windows::Win32::Media::Audio::{
    AUDCLNT_E_BUFFER_SIZE_NOT_ALIGNED, AUDCLNT_E_DEVICE_IN_USE,
    AUDCLNT_E_EXCLUSIVE_MODE_NOT_ALLOWED, AUDCLNT_E_UNSUPPORTED_FORMAT,
};
use windows::Win32::System::Threading::{
    AvRevertMmThreadCharacteristics, AvSetMmThreadCharacteristicsW,
};
use windows::core::w;

use crate::backend::{OpenRequest, OpenedStream, RenderSource, StreamEvent, StreamHandle};
use crate::error::{OutputError, Result};

fn map_err(err: WasapiError) -> OutputError {
    match &err {
        WasapiError::UnsupportedFormat => OutputError::UnsupportedFormat("设备拒绝了该格式".into()),
        WasapiError::Windows(e) => {
            let code = e.code();
            if code == AUDCLNT_E_DEVICE_IN_USE {
                OutputError::DeviceBusy
            } else if code == AUDCLNT_E_UNSUPPORTED_FORMAT {
                OutputError::UnsupportedFormat("设备拒绝了该格式".into())
            } else if code == AUDCLNT_E_EXCLUSIVE_MODE_NOT_ALLOWED {
                OutputError::Backend("系统设置不允许应用独占该设备".into())
            } else {
                OutputError::Backend(err.to_string())
            }
        }
        _ => OutputError::Backend(err.to_string()),
    }
}

fn wave_format(cfg: &StreamConfig) -> WaveFormat {
    let (store, valid, kind) = match cfg.format {
        SampleFormat::I16 => (16, 16, SampleType::Int),
        SampleFormat::I24Packed | SampleFormat::Dop24 => (24, 24, SampleType::Int),
        SampleFormat::I24In32 | SampleFormat::Dop32 => (32, 24, SampleType::Int),
        SampleFormat::I32 => (32, 32, SampleType::Int),
        SampleFormat::F32 => (32, 32, SampleType::Float),
        SampleFormat::F64 => (64, 64, SampleType::Float),
        SampleFormat::DsdU8Lsb | SampleFormat::DsdU8Msb => unreachable!("WASAPI 不接受原生 DSD"),
    };
    WaveFormat::new(
        store,
        valid,
        &kind,
        cfg.sample_rate as usize,
        cfg.channels as usize,
        None,
    )
}

fn sample_format_of(wave: &WaveFormat) -> Option<SampleFormat> {
    let kind = wave.get_subformat().ok()?;
    match (
        wave.get_bitspersample(),
        wave.get_validbitspersample(),
        kind,
    ) {
        (16, 16, SampleType::Int) => Some(SampleFormat::I16),
        (24, 24, SampleType::Int) => Some(SampleFormat::I24Packed),
        (32, 24, SampleType::Int) => Some(SampleFormat::I24In32),
        (32, 32, SampleType::Int) => Some(SampleFormat::I32),
        (32, 32, SampleType::Float) => Some(SampleFormat::F32),
        (64, 64, SampleType::Float) => Some(SampleFormat::F64),
        _ => None,
    }
}

/// COM 对象必须在初始化过 COM 的线程里创建和销毁，查询类调用统一丢到短命线程里做。
fn in_com_thread<T: Send + 'static>(f: impl FnOnce() -> Result<T> + Send + 'static) -> Result<T> {
    thread::Builder::new()
        .name("jap-wasapi-query".into())
        .spawn(move || {
            let _ = initialize_mta();
            let result = f();
            deinitialize();
            result
        })
        .map_err(|e| OutputError::Backend(e.to_string()))?
        .join()
        .map_err(|_| OutputError::Backend("设备查询线程崩溃".into()))?
}

pub fn list_devices() -> Result<Vec<DeviceInfo>> {
    in_com_thread(|| {
        let enumerator = DeviceEnumerator::new().map_err(map_err)?;
        let default_id = enumerator
            .get_default_device(&Direction::Render)
            .and_then(|d| d.get_id())
            .ok();
        let collection = enumerator
            .get_device_collection(&Direction::Render)
            .map_err(map_err)?;
        let count = collection.get_nbr_devices().map_err(map_err)?;

        let mut devices = Vec::with_capacity(count as usize);
        for i in 0..count {
            let Ok(device) = collection.get_device_at_index(i) else {
                continue;
            };
            let (Ok(id), Ok(name)) = (device.get_id(), device.get_friendlyname()) else {
                continue;
            };
            devices.push(DeviceInfo {
                is_default: default_id.as_deref() == Some(id.as_str()),
                id,
                name,
            });
        }
        Ok(devices)
    })
}

pub fn set_hardware_volume(device_id: Option<&str>, gain: f32) -> Result<bool> {
    let device_id = device_id.map(str::to_owned);
    in_com_thread(move || {
        use windows::Win32::{
            Media::Audio::Endpoints::IAudioEndpointVolume, System::Com::CLSCTX_ALL,
        };
        let enumerator = DeviceEnumerator::new().map_err(map_err)?;
        let device = find_device(&enumerator, device_id.as_deref())?;
        let endpoint: IAudioEndpointVolume =
            unsafe { device.as_immdevice().Activate(CLSCTX_ALL, None) }
                .map_err(|e| OutputError::Backend(e.to_string()))?;
        let capabilities = unsafe { endpoint.QueryHardwareSupport() }
            .map_err(|e| OutputError::Backend(e.to_string()))?;
        if capabilities & 1 == 0 {
            return Ok(false);
        }
        unsafe { endpoint.SetMasterVolumeLevelScalar(gain.clamp(0., 1.), std::ptr::null()) }
            .map_err(|e| OutputError::Backend(e.to_string()))?;
        Ok(true)
    })
}

pub fn probe_shared(device_id: Option<&str>) -> Result<Vec<StreamConfig>> {
    let id = device_id.map(str::to_owned);
    in_com_thread(move || {
        let enumerator = DeviceEnumerator::new().map_err(map_err)?;
        let device = find_device(&enumerator, id.as_deref())?;
        let wave = device
            .get_iaudioclient()
            .map_err(map_err)?
            .get_mixformat()
            .map_err(map_err)?;
        Ok(vec![StreamConfig {
            sample_rate: wave.get_samplespersec(),
            channels: wave.get_nchannels(),
            format: sample_format_of(&wave).unwrap_or(SampleFormat::F32),
        }])
    })
}
pub fn probe_exclusive(device_id: Option<&str>) -> Result<Vec<StreamConfig>> {
    let device_id = device_id.map(str::to_owned);
    in_com_thread(move || {
        let enumerator = DeviceEnumerator::new().map_err(map_err)?;
        let device = find_device(&enumerator, device_id.as_deref())?;
        let mut probe = CapabilityProbe::new(&device).map_err(map_err)?;
        let formats = probe
            .supported_formats_all_rates()
            .iter()
            .filter_map(|w| {
                Some(StreamConfig {
                    sample_rate: w.get_samplespersec(),
                    channels: w.get_nchannels(),
                    format: sample_format_of(w)?,
                })
            })
            .collect();
        Ok(formats)
    })
}

fn find_device(enumerator: &DeviceEnumerator, id: Option<&str>) -> Result<Device> {
    match id {
        Some(id) => enumerator.get_device(id),
        None => enumerator.get_default_device(&Direction::Render),
    }
    .map_err(|_| OutputError::DeviceNotFound)
}

struct Ready {
    config: StreamConfig,
    buffer_frames: u32,
    exclusive: bool,
    device_name: String,
}

struct WasapiHandle {
    go: Sender<()>,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl StreamHandle for WasapiHandle {
    fn start(&self) {
        let _ = self.go.send(());
    }
}

impl Drop for WasapiHandle {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

pub fn open(request: &OpenRequest, source: Box<dyn RenderSource>) -> Result<OpenedStream> {
    let exclusive = match request.api {
        OutputApi::WasapiExclusive => true,
        OutputApi::WasapiShared => false,
        other => return Err(OutputError::UnsupportedApi(other)),
    };

    let (ready_tx, ready_rx) = mpsc::channel();
    let (event_tx, event_rx) = mpsc::channel();
    let (go_tx, go_rx) = mpsc::channel();
    let stop = Arc::new(AtomicBool::new(false));

    let req = request.clone();
    let thread_stop = Arc::clone(&stop);
    let thread = thread::Builder::new()
        .name("jap-wasapi-render".into())
        .spawn(move || {
            let _ = initialize_mta();
            run(
                &req,
                exclusive,
                source,
                &go_rx,
                &thread_stop,
                &ready_tx,
                &event_tx,
            );
            deinitialize();
        })
        .map_err(|e| OutputError::Backend(e.to_string()))?;

    let handle = WasapiHandle {
        go: go_tx,
        stop,
        thread: Some(thread),
    };
    let ready: Ready = ready_rx
        .recv()
        .map_err(|_| OutputError::Backend("渲染线程意外退出".into()))??;

    Ok(OpenedStream {
        config: ready.config,
        buffer_frames: ready.buffer_frames,
        exclusive: ready.exclusive,
        device_name: ready.device_name,
        api_label: if exclusive {
            "WASAPI 独占 · 事件驱动"
        } else {
            "WASAPI 共享 · 系统混音"
        }
        .into(),
        events: event_rx,
        handle: Box::new(handle),
    })
}

fn run(
    req: &OpenRequest,
    exclusive: bool,
    mut source: Box<dyn RenderSource>,
    go_rx: &Receiver<()>,
    stop: &AtomicBool,
    ready_tx: &Sender<Result<Ready>>,
    event_tx: &Sender<StreamEvent>,
) {
    let fail_early = |e: OutputError| {
        let _ = ready_tx.send(Err(e));
    };

    let enumerator = match DeviceEnumerator::new() {
        Ok(e) => e,
        Err(e) => return fail_early(map_err(e)),
    };
    let device = match find_device(&enumerator, req.device_id.as_deref()) {
        Ok(d) => d,
        Err(e) => return fail_early(e),
    };
    let device_name = device
        .get_friendlyname()
        .unwrap_or_else(|_| "未知设备".into());

    let (client, config) = match open_client(&device, req, exclusive) {
        Ok(v) => v,
        Err(e) => return fail_early(e),
    };

    let setup = (|| -> Result<_> {
        let h_event = client.set_get_eventhandle().map_err(map_err)?;
        let render = client.get_audiorenderclient().map_err(map_err)?;
        let buffer_frames = client.get_buffer_size().map_err(map_err)?;
        Ok((h_event, render, buffer_frames))
    })();
    let (h_event, render, buffer_frames) = match setup {
        Ok(v) => v,
        Err(e) => return fail_early(e),
    };

    let _ = ready_tx.send(Ok(Ready {
        config,
        buffer_frames,
        exclusive,
        device_name,
    }));

    // 等引擎把环形缓冲预热好再出声
    loop {
        match go_rx.recv_timeout(Duration::from_millis(20)) {
            Ok(()) => break,
            Err(mpsc::RecvTimeoutError::Timeout) if !stop.load(Ordering::Acquire) => {}
            Err(_) => return,
        }
    }

    let _mmcss = Mmcss::enter();
    let bytes_per_frame = config.bytes_per_frame();
    let mut scratch = vec![0u8; buffer_frames as usize * bytes_per_frame];
    let report = |msg: String| {
        let _ = event_tx.send(StreamEvent::Failed(msg));
    };

    // 起播前先把设备缓冲灌满真实数据，免得开头吃进一段静音
    if let Ok(frames) = client.get_available_space_in_frames() {
        let n = (frames as usize).min(buffer_frames as usize) * bytes_per_frame;
        source.render(&mut scratch[..n]);
        if let Err(e) = render.write_to_device(n / bytes_per_frame, &scratch[..n], None) {
            return report(format!("写入设备失败: {e}"));
        }
    }
    if let Err(e) = client.start_stream() {
        return report(format!("启动设备流失败: {e}"));
    }

    let mut last_event = Instant::now();
    while !stop.load(Ordering::Acquire) {
        if h_event.wait_for_event(50).is_err() {
            if last_event.elapsed() > Duration::from_secs(2) {
                report("设备长时间没有响应".into());
                break;
            }
            continue;
        }
        let deadline =
            Duration::from_secs_f64(f64::from(buffer_frames) / f64::from(config.sample_rate) * 4.)
                .max(Duration::from_millis(50));
        if last_event.elapsed() > deadline {
            let _ = event_tx.send(StreamEvent::ResetRequired(
                "音频回调超时，丢弃过期缓冲并重新预热".into(),
            ));
        }
        last_event = Instant::now();

        let frames = match client.get_available_space_in_frames() {
            Ok(f) => (f as usize).min(buffer_frames as usize),
            Err(e) => {
                report(format!("设备已失效: {e}"));
                break;
            }
        };
        if frames == 0 {
            continue;
        }
        let n = frames * bytes_per_frame;
        source.render(&mut scratch[..n]);
        if let Err(e) = render.write_to_device(frames, &scratch[..n], None) {
            report(format!("写入设备失败: {e}"));
            break;
        }
    }
    let _ = client.stop_stream();
}

fn open_client(
    device: &Device,
    req: &OpenRequest,
    exclusive: bool,
) -> Result<(AudioClient, StreamConfig)> {
    if !exclusive {
        let wave = device
            .get_iaudioclient()
            .map_err(map_err)?
            .get_mixformat()
            .map_err(map_err)?;
        let config = StreamConfig {
            sample_rate: wave.get_samplespersec(),
            channels: wave.get_nchannels(),
            format: sample_format_of(&wave).unwrap_or(SampleFormat::F32),
        };
        return Ok((
            try_candidate(device, &config, req.buffer_ms, false)?,
            config,
        ));
    }
    let mut last = OutputError::UnsupportedFormat("没有候选格式".into());
    for cand in &req.candidates {
        for attempt in 0..3 {
            match try_candidate(device, cand, req.buffer_ms, exclusive) {
                Ok(client) => return Ok((client, *cand)),
                // 如果设备刚从另一个会话释放，Windows 驱动可能需要数十毫秒解除底层独占占用，重试可无缝接管
                Err(OutputError::DeviceBusy) if exclusive && attempt < 2 => {
                    tracing::debug!("设备暂忙（释放过渡中），等待 60ms 重试...");
                    thread::sleep(Duration::from_millis(60));
                    continue;
                }
                Err(e @ OutputError::DeviceBusy) => return Err(e),
                Err(e) => {
                    tracing::debug!(?cand, "候选格式被拒绝: {e}");
                    last = e;
                    break;
                }
            }
        }
    }
    Err(last)
}

fn try_candidate(
    device: &Device,
    cand: &StreamConfig,
    buffer_ms: u32,
    exclusive: bool,
) -> Result<AudioClient> {
    if matches!(cand.format, SampleFormat::DsdU8Lsb | SampleFormat::DsdU8Msb)
        || (cand.format.is_dsd() && !exclusive)
    {
        return Err(OutputError::UnsupportedFormat(
            "DSD 需要独占 DoP 或原生 ASIO".into(),
        ));
    }
    let wave = wave_format(cand);
    let mut client = device.get_iaudioclient().map_err(map_err)?;
    let want_hns = i64::from(buffer_ms) * 10_000;

    if !exclusive {
        let (default_period, _) = client.get_device_period().map_err(map_err)?;
        let mode = StreamMode::EventsShared {
            autoconvert: true,
            buffer_duration_hns: want_hns.max(default_period),
        };
        client
            .initialize_client(&wave, &Direction::Render, &mode)
            .map_err(map_err)?;
        return Ok(client);
    }

    let wave = client
        .is_supported_exclusive_with_quirks(&wave)
        .map_err(map_err)?;
    let (_, min_period) = client.get_device_period().map_err(map_err)?;
    // Intel HDA 等设备要求缓冲按 128 字节对齐
    let mut period = client
        .calculate_aligned_period_near(want_hns.max(min_period), Some(128), &wave)
        .map_err(map_err)?;

    for attempt in 0..2 {
        let mode = StreamMode::EventsExclusive { period_hns: period };
        match client.initialize_client(&wave, &Direction::Render, &mode) {
            Ok(()) => return Ok(client),
            Err(WasapiError::Windows(e))
                if attempt == 0 && e.code() == AUDCLNT_E_BUFFER_SIZE_NOT_ALIGNED =>
            {
                // 按微软文档的做法：取驱动建议的对齐缓冲，换新 client 重试
                let frames = client.get_buffer_size().map_err(map_err)?;
                period =
                    calculate_period_100ns(i64::from(frames), i64::from(wave.get_samplespersec()));
                client = device.get_iaudioclient().map_err(map_err)?;
            }
            Err(e) => return Err(map_err(e)),
        }
    }
    Err(OutputError::Backend("缓冲对齐重试失败".into()))
}

/// 让渲染线程以 MMCSS "Pro Audio" 特征运行。
struct Mmcss(HANDLE);

impl Mmcss {
    fn enter() -> Option<Self> {
        let mut task_index = 0u32;
        // SAFETY: 参数均为有效指针，句柄在 Drop 中归还
        unsafe { AvSetMmThreadCharacteristicsW(w!("Pro Audio"), &mut task_index) }
            .ok()
            .map(Self)
    }
}

impl Drop for Mmcss {
    fn drop(&mut self) {
        // SAFETY: 句柄由 `enter` 取得且仅归还一次
        unsafe {
            let _ = AvRevertMmThreadCharacteristics(self.0);
        }
    }
}

//! Windows 64-bit ASIO COM host. The driver owns planar double buffers; this adapter only
//! deinterleaves already-finished audio. No DSP or allocation in the callback.
use crate::error::Result;
use crate::{OpenRequest, OpenedStream, OutputError, RenderSource, StreamEvent, StreamHandle};
use jap_core::{DeviceInfo, SampleFormat, StreamConfig};
use std::{
    cell::{Cell, UnsafeCell},
    ffi::c_void,
    ptr,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicPtr, AtomicU32, Ordering},
        mpsc::{self, Sender},
    },
    thread::{self, JoinHandle},
    time::Duration,
};
use windows::{
    Win32::System::Com::{COINIT_APARTMENTTHREADED, CoInitializeEx, CoUninitialize},
    core::GUID,
};
use winreg::{
    RegKey,
    enums::{HKEY_LOCAL_MACHINE, KEY_READ, KEY_WOW64_64KEY},
};

static DRIVER_LOCK: Mutex<()> = Mutex::new(());
static CALLBACK: AtomicPtr<CallbackState> = AtomicPtr::new(ptr::null_mut());
const SUCCESS: i32 = 0x3f4847a0;

#[link(name = "ole32")]
unsafe extern "system" {
    fn CoCreateInstance(
        class: *const GUID,
        outer: *mut c_void,
        context: u32,
        iid: *const GUID,
        result: *mut *mut c_void,
    ) -> i32;
}

pub fn list_devices() -> Result<Vec<DeviceInfo>> {
    let Ok(root) = RegKey::predef(HKEY_LOCAL_MACHINE)
        .open_subkey_with_flags("SOFTWARE\\ASIO", KEY_READ | KEY_WOW64_64KEY)
    else {
        return Ok(Vec::new());
    };
    let mut devices = Vec::new();
    for name in root.enum_keys().flatten() {
        let Ok(key) = root.open_subkey(&name) else {
            continue;
        };
        let Ok(clsid) = key.get_value::<String, _>("CLSID") else {
            continue;
        };
        let desc = key.get_value::<String, _>("Description").unwrap_or(name);
        devices.push(DeviceInfo {
            id: clsid,
            name: desc,
            is_default: false,
        });
    }
    Ok(devices)
}

// ASIO longs are 32-bit; SDK structures use four-byte packing on 64-bit Windows.
#[repr(C, packed(4))]
#[derive(Clone, Copy)]
struct BufferInfo {
    input: i32,
    channel: i32,
    buffers: [*mut u8; 2],
}
#[repr(C, packed(4))]
struct ChannelInfo {
    channel: i32,
    input: i32,
    active: i32,
    group: i32,
    kind: i32,
    name: [u8; 32],
}
#[repr(C, packed(4))]
struct Callbacks {
    switch: extern "C" fn(i32, i32),
    rate: extern "C" fn(f64),
    message: extern "C" fn(i32, i32, *mut c_void, *mut f64) -> i32,
    time: extern "C" fn(*mut c_void, i32, i32) -> *mut c_void,
}

struct Driver {
    ptr: *mut c_void,
    buffers: Cell<bool>,
    dsd: Cell<bool>,
}
impl Driver {
    unsafe fn method<T: Copy>(&self, index: usize) -> T {
        // SAFETY: this pointer comes from CoCreateInstance for the ASIO class IID;
        // method indices and signatures follow IASIO and the native Windows ABI.
        unsafe {
            let table = *(self.ptr as *const *const *const c_void);
            std::mem::transmute_copy(&*table.add(index))
        }
    }
    fn call(&self, index: usize) -> i32 {
        unsafe { self.method::<unsafe extern "system" fn(*mut c_void) -> i32>(index)(self.ptr) }
    }
    fn rate(&self, hz: f64) -> Result<()> {
        let code = unsafe {
            self.method::<unsafe extern "system" fn(*mut c_void, f64) -> i32>(14)(self.ptr, hz)
        };
        check(code, "设置 ASIO 采样率")
    }
    fn channel(&self, channel: i32) -> Result<i32> {
        let mut info = ChannelInfo {
            channel,
            input: 0,
            active: 0,
            group: 0,
            kind: -1,
            name: [0; 32],
        };
        let code = unsafe {
            self.method::<unsafe extern "system" fn(*mut c_void, *mut ChannelInfo) -> i32>(18)(
                self.ptr, &mut info,
            )
        };
        check(code, "查询 ASIO 声道格式")?;
        Ok(info.kind)
    }
    fn set_dsd(&self, dsd: bool) -> Result<()> {
        let mut format = [0u8; 512];
        format[..4].copy_from_slice(&(i32::from(dsd)).to_le_bytes());
        let code = unsafe {
            self.method::<unsafe extern "system" fn(*mut c_void, i32, *mut c_void) -> i32>(22)(
                self.ptr,
                0x23111961,
                format.as_mut_ptr().cast(),
            )
        };
        if dsd && code != SUCCESS {
            return Err(OutputError::UnsupportedFormat(
                "该 ASIO 驱动不支持 kAsioSetIoFormat(DSD)；ASIO4ALL 不能提供厂商原生 DSD".into(),
            ));
        }
        if code == SUCCESS {
            self.dsd.set(dsd);
        }
        Ok(())
    }
}
impl Drop for Driver {
    fn drop(&mut self) {
        if self.buffers.get() {
            self.call(8);
            self.call(20);
        }
        if self.dsd.get() {
            let _ = self.set_dsd(false);
        }
        self.call(2);
    }
}
fn check(code: i32, action: &str) -> Result<()> {
    if code == 0 || code == SUCCESS {
        Ok(())
    } else {
        Err(OutputError::Backend(format!("{action}失败（ASIO {code}）")))
    }
}

struct CallbackData {
    source: Box<dyn RenderSource>,
    buffers: Vec<BufferInfo>,
    scratch: Vec<u8>,
    config: StreamConfig,
    frames: usize,
    right_aligned: bool,
}
struct CallbackState {
    entered: AtomicBool,
    failed: AtomicU32,
    rate: f64,
    driver: *mut c_void,
    output_ready: Option<unsafe extern "system" fn(*mut c_void) -> i32>,
    data: UnsafeCell<CallbackData>,
}

extern "C" fn buffer_switch(index: i32, _: i32) {
    if !(0..=1).contains(&index) {
        return;
    }
    let state = CALLBACK.load(Ordering::Acquire);
    if state.is_null() {
        return;
    }
    // SAFETY: state stays alive until stop() has joined all callbacks. The CAS
    // serializes any reentrant callback before accessing its UnsafeCell.
    let state = unsafe { &*state };
    if state
        .entered
        .compare_exchange(false, true, Ordering::Acquire, Ordering::Relaxed)
        .is_err()
    {
        state.failed.store(1, Ordering::Release);
        return;
    }
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let data = unsafe { &mut *state.data.get() };
        data.source.render(&mut data.scratch);
        let width = data.config.format.container_bytes();
        let channels = data.config.channels as usize;
        for (ch, info) in data.buffers.iter().enumerate() {
            let buffers = info.buffers;
            let dst = unsafe {
                std::slice::from_raw_parts_mut(buffers[index as usize], data.frames * width)
            };
            for (frame, sample) in dst.chunks_exact_mut(width).enumerate() {
                let start = (frame * channels + ch) * width;
                let source = &data.scratch[start..start + width];
                if data.right_aligned {
                    let value = i32::from_le_bytes(source.try_into().unwrap()) >> 8;
                    sample.copy_from_slice(&value.to_le_bytes());
                } else {
                    sample.copy_from_slice(source);
                }
            }
        }
    }));
    if result.is_err() {
        state.failed.store(2, Ordering::Release);
    }
    state.entered.store(false, Ordering::Release);
    if let Some(output_ready) = state.output_ready {
        unsafe {
            output_ready(state.driver);
        }
    }
}
extern "C" fn rate_changed(rate: f64) {
    let state = CALLBACK.load(Ordering::Acquire);
    if !state.is_null() {
        let state = unsafe { &*state };
        if (state.rate - rate).abs() > 0.5 {
            state.failed.store(3, Ordering::Release);
        }
    }
}
extern "C" fn message(selector: i32, value: i32, _: *mut c_void, _: *mut f64) -> i32 {
    match selector {
        1 => i32::from(matches!(value, 2 | 3 | 5 | 6 | 7)),
        2 => 2,
        7 => 1,
        3 | 5 | 6 => {
            let state = CALLBACK.load(Ordering::Acquire);
            if !state.is_null() {
                unsafe { &*state }.failed.store(4, Ordering::Release);
            }
            1
        }
        _ => 0,
    }
}
extern "C" fn time_switch(time: *mut c_void, index: i32, direct: i32) -> *mut c_void {
    buffer_switch(index, direct);
    time
}

struct Handle {
    go: Sender<()>,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}
impl StreamHandle for Handle {
    fn start(&self) {
        let _ = self.go.send(());
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

pub fn open(req: &OpenRequest, source: Box<dyn RenderSource>) -> Result<OpenedStream> {
    let selected = list_devices()?
        .into_iter()
        .find(|d| req.device_id.as_ref().is_none_or(|id| id == &d.id))
        .ok_or(OutputError::DeviceNotFound)?;
    let request = req.clone();
    let name = selected.name.clone();
    let (ready_tx, ready_rx) = mpsc::sync_channel(1);
    let (event_tx, events) = mpsc::channel();
    let (go, go_rx) = mpsc::channel();
    let stop = Arc::new(AtomicBool::new(false));
    let thread_stop = Arc::clone(&stop);
    let thread = thread::Builder::new()
        .name("jap-asio".into())
        .spawn(move || {
            let Ok(_guard) = DRIVER_LOCK.try_lock() else {
                let _ = ready_tx.send(Err(OutputError::DeviceBusy));
                return;
            };
            // The driver and every COM call stay on this apartment's thread.
            let initialized = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) }.is_ok();
            if !initialized {
                let _ = ready_tx.send(Err(OutputError::Backend("ASIO COM 初始化失败".into())));
                return;
            }
            let opened = prepare(&selected.id, &request, source);
            match opened {
                Err(e) => {
                    let _ = ready_tx.send(Err(e));
                }
                Ok((driver, state, config, latency, _callbacks)) => {
                    let raw = Box::into_raw(state);
                    CALLBACK.store(raw, Ordering::Release);
                    let _ = ready_tx.send(Ok((config, latency)));
                    while !thread_stop.load(Ordering::Acquire) {
                        if go_rx.recv_timeout(Duration::from_millis(10)).is_ok() {
                            // Half 1 sounds first; half 0 is filled by the first callback.
                            buffer_switch(1, 0);
                            if let Err(e) = check(driver.call(7), "启动 ASIO") {
                                let _ = event_tx.send(StreamEvent::Failed(e.to_string()));
                            }
                            break;
                        }
                    }
                    while !thread_stop.load(Ordering::Acquire) {
                        let failed = unsafe { &*raw }.failed.load(Ordering::Acquire);
                        if failed != 0 {
                            let _ = event_tx.send(StreamEvent::ResetRequired(format!(
                                "ASIO 流需要重新打开（事件 {failed}）"
                            )));
                            break;
                        }
                        thread::sleep(Duration::from_millis(10));
                    }
                    driver.call(8); // stop guarantees no further callbacks
                    CALLBACK.store(ptr::null_mut(), Ordering::Release);
                    driver.call(20);
                    driver.buffers.set(false);
                    unsafe {
                        drop(Box::from_raw(raw));
                    }
                    if matches!(
                        config.format,
                        SampleFormat::DsdU8Lsb | SampleFormat::DsdU8Msb
                    ) {
                        let _ = driver.set_dsd(false);
                    }
                    drop(driver);
                }
            }
            unsafe {
                CoUninitialize();
            }
        })
        .map_err(|e| OutputError::Backend(e.to_string()))?;
    let handle = Handle {
        go,
        stop,
        thread: Some(thread),
    };
    let (config, buffer_frames) = ready_rx
        .recv()
        .map_err(|_| OutputError::Backend("ASIO 初始化线程退出".into()))??;
    Ok(OpenedStream {
        config,
        buffer_frames,
        exclusive: true,
        device_name: name,
        api_label: "ASIO · 原生驱动".into(),
        events,
        handle: Box::new(handle),
    })
}

fn load_driver(id: &str) -> Result<Driver> {
    let clsid = GUID::try_from(id.trim_matches(['{', '}']))
        .map_err(|e| OutputError::Backend(e.to_string()))?;
    let mut ptr = ptr::null_mut();
    let hr = unsafe { CoCreateInstance(&clsid, ptr::null_mut(), 1, &clsid, &mut ptr) };
    if hr < 0 || ptr.is_null() {
        return Err(OutputError::Backend(format!(
            "无法加载 64 位 ASIO 驱动：0x{hr:08x}"
        )));
    }
    let driver = Driver {
        ptr,
        buffers: Cell::new(false),
        dsd: Cell::new(false),
    };
    let initialized = unsafe {
        driver.method::<unsafe extern "system" fn(*mut c_void, *mut c_void) -> i32>(3)(
            ptr,
            ptr::null_mut(),
        )
    };
    if initialized == 0 {
        return Err(OutputError::Backend(
            "ASIO 驱动初始化失败；请确认设备已连接".into(),
        ));
    }
    Ok(driver)
}
static FORMAT_CACHE: std::sync::OnceLock<
    Mutex<std::collections::HashMap<String, Vec<StreamConfig>>>,
> = std::sync::OnceLock::new();
fn format_cache() -> &'static Mutex<std::collections::HashMap<String, Vec<StreamConfig>>> {
    FORMAT_CACHE.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
}
fn cache_pcm_formats(id: &str, driver: &Driver) {
    if format_cache().lock().unwrap().contains_key(id) {
        return;
    }
    let Some(format) = driver.channel(0).ok().and_then(|kind| match kind {
        16 => Some(SampleFormat::I16),
        17 => Some(SampleFormat::I24Packed),
        18 => Some(SampleFormat::I32),
        19 => Some(SampleFormat::F32),
        20 => Some(SampleFormat::F64),
        27 => Some(SampleFormat::I24In32),
        _ => None,
    }) else {
        return;
    };
    let channels = if driver.channel(1).ok() == driver.channel(0).ok() {
        2
    } else {
        1
    };
    let mut formats = Vec::new();
    for rate in [
        8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000, 88200, 96000, 176400, 192000,
        352800, 384000, 705600, 768000, 1411200, 1536000, 2822400, 3072000, 5644800, 6144000,
    ] {
        let code = unsafe {
            driver.method::<unsafe extern "system" fn(*mut c_void, f64) -> i32>(12)(
                driver.ptr,
                f64::from(rate),
            )
        };
        if check(code, "查询 ASIO 采样率").is_ok() {
            formats.push(StreamConfig {
                sample_rate: rate,
                channels,
                format,
            });
        }
    }
    format_cache()
        .lock()
        .unwrap()
        .insert(id.to_owned(), formats);
}
pub fn probe_formats(id: Option<&str>) -> Result<Vec<StreamConfig>> {
    let selected = list_devices()?
        .into_iter()
        .find(|d| id.is_none_or(|id| d.id == id))
        .ok_or(OutputError::DeviceNotFound)?;
    if let Some(formats) = format_cache().lock().unwrap().get(&selected.id).cloned() {
        return Ok(formats);
    }
    thread::spawn(move || {
        let _guard = DRIVER_LOCK
            .try_lock()
            .map_err(|_| OutputError::Backend("ASIO 正在播放；停止播放后可检测此驱动".into()))?;
        unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) }
            .ok()
            .map_err(|e| OutputError::Backend(e.to_string()))?;
        let result = (|| {
            let driver = load_driver(&selected.id)?;
            cache_pcm_formats(&selected.id, &driver);
            Ok(format_cache()
                .lock()
                .unwrap()
                .get(&selected.id)
                .cloned()
                .unwrap_or_default())
        })();
        unsafe { CoUninitialize() };
        result
    })
    .join()
    .map_err(|_| OutputError::Backend("ASIO 格式查询线程退出".into()))?
}
type Prepared = (
    Driver,
    Box<CallbackState>,
    StreamConfig,
    u32,
    Box<Callbacks>,
);
fn prepare(id: &str, req: &OpenRequest, source: Box<dyn RenderSource>) -> Result<Prepared> {
    let driver = load_driver(id)?;
    cache_pcm_formats(id, &driver);
    let ptr = driver.ptr;
    let dsd = req
        .candidates
        .first()
        .is_some_and(|c| matches!(c.format, SampleFormat::DsdU8Lsb | SampleFormat::DsdU8Msb));
    driver.set_dsd(dsd)?;
    let mut selected = None;
    for &config in &req.candidates {
        let rate = f64::from(config.sample_rate) * if dsd { 8. } else { 1. };
        if driver.rate(rate).is_err() {
            continue;
        }
        let kind = driver.channel(0)?;
        let matches = match config.format {
            SampleFormat::I16 => kind == 16,
            SampleFormat::I24Packed | SampleFormat::Dop24 => kind == 17,
            SampleFormat::I24In32 | SampleFormat::Dop32 => matches!(kind, 18 | 27),
            SampleFormat::I32 => kind == 18,
            SampleFormat::F32 => kind == 19,
            SampleFormat::F64 => kind == 20,
            SampleFormat::DsdU8Lsb => kind == 32,
            SampleFormat::DsdU8Msb => kind == 33,
        };
        if matches && (0..config.channels).all(|ch| driver.channel(ch as i32).ok() == Some(kind)) {
            selected = Some((config, kind));
            break;
        }
    }
    let (config, kind) = selected.ok_or_else(|| {
        OutputError::UnsupportedFormat("ASIO 驱动没有接受音源格式或原生 DSD 位序".into())
    })?;
    let (mut min, mut max, mut preferred, mut granularity) = (0, 0, 0, 0);
    let code = unsafe {
        driver.method::<unsafe extern "system" fn(*mut c_void, *mut i32, *mut i32, *mut i32, *mut i32) -> i32>(11)(ptr, &mut min, &mut max, &mut preferred, &mut granularity)
    };
    check(code, "查询 ASIO 缓冲")?;
    if preferred <= 0 || preferred > 8_388_608 || min <= 0 || max < min {
        return Err(OutputError::Backend("ASIO 驱动返回无效缓冲大小".into()));
    }
    let frames = if dsd {
        preferred as usize / 8
    } else {
        preferred as usize
    };
    if frames == 0 || (dsd && preferred % 8 != 0) {
        return Err(OutputError::UnsupportedFormat(
            "ASIO DSD 缓冲未按 8 个 bit 对齐".into(),
        ));
    }
    let mut buffers: Vec<_> = (0..config.channels)
        .map(|channel| BufferInfo {
            input: 0,
            channel: channel as i32,
            buffers: [ptr::null_mut(); 2],
        })
        .collect();
    let mut callbacks = Box::new(Callbacks {
        switch: buffer_switch,
        rate: rate_changed,
        message,
        time: time_switch,
    });
    let code = unsafe {
        driver.method::<unsafe extern "system" fn(
            *mut c_void,
            *mut BufferInfo,
            i32,
            i32,
            *mut Callbacks,
        ) -> i32>(19)(
            ptr,
            buffers.as_mut_ptr(),
            config.channels as i32,
            preferred,
            &mut *callbacks,
        )
    };
    check(code, "创建 ASIO 缓冲")?;
    driver.buffers.set(true);
    if buffers.iter().any(|info| {
        let b = info.buffers;
        b.iter().any(|p| p.is_null())
    }) {
        driver.call(20);
        driver.buffers.set(false);
        return Err(OutputError::Backend("ASIO 返回空缓冲".into()));
    }
    let (mut input, mut output) = (0, preferred);
    unsafe {
        driver.method::<unsafe extern "system" fn(*mut c_void, *mut i32, *mut i32) -> i32>(10)(
            ptr,
            &mut input,
            &mut output,
        );
    }
    let latency = (output.max(preferred) as u32) / if dsd { 8 } else { 1 };
    let data = CallbackData {
        source,
        buffers,
        scratch: vec![0; frames * config.bytes_per_frame()],
        config,
        frames,
        right_aligned: kind == 27,
    };
    let output_ready = if driver.call(23) == 0 {
        Some(unsafe { driver.method::<unsafe extern "system" fn(*mut c_void) -> i32>(23) })
    } else {
        None
    };
    Ok((
        driver,
        Box::new(CallbackState {
            entered: AtomicBool::new(false),
            failed: AtomicU32::new(0),
            rate: f64::from(config.sample_rate) * if dsd { 8. } else { 1. },
            driver: ptr,
            output_ready,
            data: UnsafeCell::new(data),
        }),
        config,
        latency,
        callbacks,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Pattern(Vec<u8>);
    impl RenderSource for Pattern {
        fn render(&mut self, out: &mut [u8]) {
            out.copy_from_slice(&self.0);
        }
    }
    #[test]
    fn callback_preserves_native_bytes_and_dop_alignment_in_planar_driver_buffers() {
        let _guard = DRIVER_LOCK.lock().unwrap();
        assert_eq!(std::mem::size_of::<BufferInfo>(), 24);
        assert_eq!(std::mem::size_of::<ChannelInfo>(), 52);
        assert_eq!(std::mem::size_of::<Callbacks>(), 32);
        for (format, right_aligned) in [
            (SampleFormat::F64, false),
            (SampleFormat::DsdU8Msb, false),
            (SampleFormat::DsdU8Lsb, false),
            (SampleFormat::Dop24, false),
            (SampleFormat::Dop32, false),
            (SampleFormat::Dop32, true),
        ] {
            let width = format.container_bytes();
            let frames = 16;
            let raw: Vec<u8> = (0..frames * 2 * width).map(|i| (i * 31) as u8).collect();
            let mut left = vec![0; frames * width];
            let mut right = vec![0; frames * width];
            let buffers = vec![
                BufferInfo {
                    input: 0,
                    channel: 0,
                    buffers: [left.as_mut_ptr(); 2],
                },
                BufferInfo {
                    input: 0,
                    channel: 1,
                    buffers: [right.as_mut_ptr(); 2],
                },
            ];
            let state = Box::new(CallbackState {
                entered: AtomicBool::new(false),
                failed: AtomicU32::new(0),
                rate: 2822400.,
                driver: ptr::null_mut(),
                output_ready: None,
                data: UnsafeCell::new(CallbackData {
                    source: Box::new(Pattern(raw.clone())),
                    buffers,
                    scratch: vec![0; raw.len()],
                    config: StreamConfig {
                        sample_rate: 352800,
                        channels: 2,
                        format,
                    },
                    frames,
                    right_aligned,
                }),
            });
            let state = Box::into_raw(state);
            CALLBACK.store(state, Ordering::Release);
            buffer_switch(0, 0);
            CALLBACK.store(ptr::null_mut(), Ordering::Release);
            assert_eq!(unsafe { &*state }.failed.load(Ordering::Acquire), 0);
            for frame in 0..frames {
                for (ch, channel) in [&left, &right].iter().enumerate() {
                    let start = (frame * 2 + ch) * width;
                    let mut expected = raw[start..start + width].to_vec();
                    if right_aligned {
                        expected = (i32::from_le_bytes(expected.try_into().unwrap()) >> 8)
                            .to_le_bytes()
                            .to_vec();
                    }
                    assert_eq!(&channel[frame * width..(frame + 1) * width], &expected);
                }
            }
            unsafe {
                drop(Box::from_raw(state));
            }
        }
    }
}

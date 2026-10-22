//! Android AAudio and USB Host outputs. USB never passes through AudioFlinger.
mod usb;

use crate::{
    OpenRequest, OpenedStream, OutputError, RenderSource, Result, StreamEvent, StreamHandle,
};
use jap_core::{DeviceInfo, OutputApi, SampleFormat, StreamConfig};
use std::sync::mpsc;
use std::{cell::UnsafeCell, ffi::c_void};

pub use usb::{register_usb, unregister_usb};
pub(crate) fn set_hardware_volume(id: Option<&str>, gain: f32) -> Result<bool> {
    usb::set_gain(id, gain)
}

#[link(name = "aaudio")]
unsafe extern "C" {
    fn AAudio_createStreamBuilder(builder: *mut *mut c_void) -> i32;
    fn AAudioStreamBuilder_delete(builder: *mut c_void) -> i32;
    fn AAudioStreamBuilder_setDirection(builder: *mut c_void, direction: i32);
    fn AAudioStreamBuilder_setFormat(builder: *mut c_void, format: i32);
    fn AAudioStreamBuilder_setSharingMode(builder: *mut c_void, mode: i32);
    fn AAudioStreamBuilder_setPerformanceMode(builder: *mut c_void, mode: i32);
    fn AAudioStreamBuilder_setSampleRate(builder: *mut c_void, rate: i32);
    fn AAudioStreamBuilder_setChannelCount(builder: *mut c_void, channels: i32);
    fn AAudioStreamBuilder_setDataCallback(
        builder: *mut c_void,
        callback: unsafe extern "C" fn(*mut c_void, *mut c_void, *mut c_void, i32) -> i32,
        user: *mut c_void,
    );
    fn AAudioStreamBuilder_setErrorCallback(
        builder: *mut c_void,
        callback: unsafe extern "C" fn(*mut c_void, *mut c_void, i32),
        user: *mut c_void,
    );
    fn AAudioStreamBuilder_openStream(builder: *mut c_void, stream: *mut *mut c_void) -> i32;
    fn AAudioStream_getSampleRate(stream: *mut c_void) -> i32;
    fn AAudioStream_getChannelCount(stream: *mut c_void) -> i32;
    fn AAudioStream_setBufferSizeInFrames(stream: *mut c_void, frames: i32) -> i32;
    fn AAudioStream_requestStart(stream: *mut c_void) -> i32;
    fn AAudioStream_requestStop(stream: *mut c_void) -> i32;
    fn AAudioStream_close(stream: *mut c_void) -> i32;
}
struct Callback {
    source: UnsafeCell<Box<dyn RenderSource>>,
    channels: usize,
    events: mpsc::Sender<StreamEvent>,
}
// Only AAudio's serialized data callback accesses source. Error callbacks only
// access the independent, thread-safe event sender.
unsafe impl Sync for Callback {}
unsafe extern "C" fn render(
    _: *mut c_void,
    user: *mut c_void,
    data: *mut c_void,
    frames: i32,
) -> i32 {
    // AAudio serializes data callbacks and close waits for them to finish.
    let cb = unsafe { &*user.cast::<Callback>() };
    if frames > 0 {
        unsafe { &mut *cb.source.get() }.render(unsafe {
            std::slice::from_raw_parts_mut(data.cast::<u8>(), frames as usize * cb.channels * 4)
        });
    }
    0
}
unsafe extern "C" fn failed(_: *mut c_void, user: *mut c_void, error: i32) {
    let cb = unsafe { &*user.cast::<Callback>() };
    let _ = cb.events.send(StreamEvent::Failed(format!(
        "AAudio disconnected ({error})"
    )));
}
struct Shared {
    stream: *mut c_void,
    callback: *mut Callback,
    events: mpsc::Sender<StreamEvent>,
}
// Stream ownership moves to the engine; AAudio owns the callback thread.
unsafe impl Send for Shared {}
impl StreamHandle for Shared {
    fn start(&self) {
        let code = unsafe { AAudioStream_requestStart(self.stream) };
        if code < 0 {
            let _ = self
                .events
                .send(StreamEvent::Failed(format!("AAudio start: {code}")));
        }
    }
}
impl Drop for Shared {
    fn drop(&mut self) {
        unsafe {
            AAudioStream_requestStop(self.stream);
            AAudioStream_close(self.stream);
            drop(Box::from_raw(self.callback));
        }
    }
}
pub(crate) fn list_devices(api: OutputApi) -> Result<Vec<DeviceInfo>> {
    if api == OutputApi::UsbExclusive {
        usb::devices()
    } else {
        Ok(vec![DeviceInfo {
            id: "android-default".into(),
            name: "Android 系统音频 · AAudio".into(),
            is_default: true,
        }])
    }
}
pub(crate) fn probe(id: Option<&str>) -> Result<Vec<StreamConfig>> {
    usb::probe(id)
}
pub(crate) fn probe_shared() -> Result<Vec<StreamConfig>> {
    // No start/write call: query the negotiated default system stream, then close.
    let mut builder = std::ptr::null_mut();
    let mut stream = std::ptr::null_mut();
    unsafe {
        if AAudio_createStreamBuilder(&mut builder) < 0 {
            return Err(OutputError::Backend("AAudio 格式查询失败".into()));
        }
        AAudioStreamBuilder_setDirection(builder, 0);
        AAudioStreamBuilder_setFormat(builder, 2);
        AAudioStreamBuilder_setSharingMode(builder, 1);
        let code = AAudioStreamBuilder_openStream(builder, &mut stream);
        AAudioStreamBuilder_delete(builder);
        if code < 0 {
            return Err(OutputError::Backend(format!("AAudio 格式查询: {code}")));
        }
        let config = StreamConfig {
            sample_rate: AAudioStream_getSampleRate(stream) as u32,
            channels: AAudioStream_getChannelCount(stream) as u16,
            format: SampleFormat::F32,
        };
        AAudioStream_close(stream);
        Ok(vec![config])
    }
}
pub(crate) fn open(req: &OpenRequest, source: Box<dyn RenderSource>) -> Result<OpenedStream> {
    if req.api == OutputApi::UsbExclusive {
        return usb::open(req, source);
    }
    let candidate = req
        .candidates
        .iter()
        .find(|c| c.format == SampleFormat::F32)
        .ok_or_else(|| OutputError::UnsupportedFormat("AAudio PCM float32".into()))?;
    let (tx, rx) = mpsc::channel();
    let callback = Box::into_raw(Box::new(Callback {
        source: UnsafeCell::new(source),
        channels: usize::from(candidate.channels),
        events: tx.clone(),
    }));
    let mut builder = std::ptr::null_mut();
    let mut stream = std::ptr::null_mut();
    let status = unsafe {
        let code = AAudio_createStreamBuilder(&mut builder);
        if code < 0 {
            code
        } else {
            AAudioStreamBuilder_setDirection(builder, 0);
            AAudioStreamBuilder_setFormat(builder, 2); // AAUDIO_FORMAT_PCM_FLOAT
            AAudioStreamBuilder_setSharingMode(builder, 1); // SHARED, USB is a separate backend
            AAudioStreamBuilder_setPerformanceMode(builder, 12); // LOW_LATENCY
            // Shared output runs at the system's native rate. The producer's
            // anti-aliased converter adapts the source before the callback.
            AAudioStreamBuilder_setSampleRate(builder, 0);
            AAudioStreamBuilder_setChannelCount(builder, i32::from(candidate.channels));
            AAudioStreamBuilder_setDataCallback(builder, render, callback.cast());
            AAudioStreamBuilder_setErrorCallback(builder, failed, callback.cast());
            let code = AAudioStreamBuilder_openStream(builder, &mut stream);
            AAudioStreamBuilder_delete(builder);
            code
        }
    };
    if status < 0 {
        unsafe {
            drop(Box::from_raw(callback));
        }
        return Err(OutputError::Backend(format!("AAudio open: {status}")));
    }
    let config = StreamConfig {
        sample_rate: unsafe { AAudioStream_getSampleRate(stream) } as u32,
        channels: unsafe { AAudioStream_getChannelCount(stream) } as u16,
        format: SampleFormat::F32,
    };
    unsafe {
        (*callback).channels = usize::from(config.channels);
    }
    let frames = unsafe {
        AAudioStream_setBufferSizeInFrames(
            stream,
            (config.sample_rate * req.buffer_ms / 1000).max(192) as i32,
        )
    };
    Ok(OpenedStream {
        config,
        buffer_frames: frames.max(192) as u32,
        exclusive: false,
        device_name: "Android 系统默认设备".into(),
        api_label: "AAudio · 系统共享".into(),
        events: rx,
        handle: Box::new(Shared {
            stream,
            callback,
            events: tx,
        }),
    })
}

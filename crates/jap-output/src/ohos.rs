//! HarmonyOS native OHAudio and the same descriptor-verified USB transport as Android.
use crate::{
    OpenRequest, OpenedStream, OutputError, RenderSource, Result, StreamEvent, StreamHandle,
};
use jap_core::{DeviceInfo, OutputApi, SampleFormat, StreamConfig};
use std::{cell::UnsafeCell, ffi::c_void, sync::mpsc};
#[path = "android/usb.rs"]
pub mod usb;
pub(crate) fn set_hardware_volume(id: Option<&str>, gain: f32) -> Result<bool> {
    usb::set_gain(id, gain)
}

#[link(name = "ohaudio")]
unsafe extern "C" {
    fn OH_AudioStreamBuilder_Create(builder: *mut *mut c_void, kind: i32) -> i32;
    fn OH_AudioStreamBuilder_Destroy(builder: *mut c_void) -> i32;
    fn OH_AudioStreamBuilder_SetSamplingRate(builder: *mut c_void, rate: i32) -> i32;
    fn OH_AudioStreamBuilder_SetChannelCount(builder: *mut c_void, channels: i32) -> i32;
    fn OH_AudioStreamBuilder_SetSampleFormat(builder: *mut c_void, format: i32) -> i32;
    fn OH_AudioStreamBuilder_SetRendererInfo(builder: *mut c_void, usage: i32) -> i32;
    fn OH_AudioStreamBuilder_SetRendererWriteDataCallback(
        builder: *mut c_void,
        callback: unsafe extern "C" fn(*mut c_void, *mut c_void, *mut c_void, i32) -> i32,
        user: *mut c_void,
    ) -> i32;
    fn OH_AudioStreamBuilder_GenerateRenderer(
        builder: *mut c_void,
        renderer: *mut *mut c_void,
    ) -> i32;
    fn OH_AudioRenderer_GetSamplingRate(renderer: *mut c_void, rate: *mut i32) -> i32;
    fn OH_AudioRenderer_GetChannelCount(renderer: *mut c_void, channels: *mut i32) -> i32;
    fn OH_AudioRenderer_GetFrameSizeInCallback(renderer: *mut c_void, frames: *mut i32) -> i32;
    fn OH_AudioRenderer_Start(renderer: *mut c_void) -> i32;
    fn OH_AudioRenderer_Stop(renderer: *mut c_void) -> i32;
    fn OH_AudioRenderer_Release(renderer: *mut c_void) -> i32;
}
struct Callback {
    source: UnsafeCell<Box<dyn RenderSource>>,
}
unsafe extern "C" fn render(
    _: *mut c_void,
    user: *mut c_void,
    buffer: *mut c_void,
    length: i32,
) -> i32 {
    if user.is_null() || buffer.is_null() || length <= 0 {
        return 1;
    }
    // OHAudio serializes this stream's callbacks; the owner releases after Stop.
    unsafe {
        (&mut *(*user.cast::<Callback>()).source.get()).render(std::slice::from_raw_parts_mut(
            buffer.cast::<u8>(),
            length as usize,
        ));
    }
    0
}
struct Handle {
    renderer: *mut c_void,
    callback: *mut Callback,
    events: mpsc::Sender<StreamEvent>,
}
unsafe impl Send for Handle {}
impl StreamHandle for Handle {
    fn start(&self) {
        if unsafe { OH_AudioRenderer_Start(self.renderer) } != 0 {
            let _ = self
                .events
                .send(StreamEvent::Failed("OHAudio 启动失败".into()));
        }
    }
}
impl Drop for Handle {
    fn drop(&mut self) {
        unsafe {
            OH_AudioRenderer_Stop(self.renderer);
            OH_AudioRenderer_Release(self.renderer);
            drop(Box::from_raw(self.callback));
        }
    }
}
pub(crate) fn list_devices(api: OutputApi) -> Result<Vec<DeviceInfo>> {
    if api == OutputApi::UsbExclusive {
        return usb::devices();
    }
    Ok(vec![DeviceInfo {
        id: "ohos-default".into(),
        name: "HarmonyOS 系统默认音频设备".into(),
        is_default: true,
    }])
}
pub(crate) fn probe_formats(api: OutputApi, id: Option<&str>) -> Result<Vec<StreamConfig>> {
    if api == OutputApi::UsbExclusive {
        return usb::probe(id);
    }
    // This describes the application stream. The system may mix it downstream.
    Ok(vec![StreamConfig {
        sample_rate: 48000,
        channels: 2,
        format: SampleFormat::F32,
    }])
}
pub(crate) fn open(req: &OpenRequest, source: Box<dyn RenderSource>) -> Result<OpenedStream> {
    if req.api == OutputApi::UsbExclusive {
        return usb::open(req, source);
    }
    let mut builder = std::ptr::null_mut();
    let mut renderer = std::ptr::null_mut();
    let callback = Box::into_raw(Box::new(Callback {
        source: UnsafeCell::new(source),
    }));
    let code = unsafe {
        let init = OH_AudioStreamBuilder_Create(&mut builder, 1);
        if init != 0 {
            init
        } else {
            OH_AudioStreamBuilder_SetSamplingRate(builder, 48000);
            OH_AudioStreamBuilder_SetChannelCount(builder, 2);
            OH_AudioStreamBuilder_SetSampleFormat(builder, 4);
            OH_AudioStreamBuilder_SetRendererInfo(builder, 1);
            OH_AudioStreamBuilder_SetRendererWriteDataCallback(builder, render, callback.cast());
            let result = OH_AudioStreamBuilder_GenerateRenderer(builder, &mut renderer);
            OH_AudioStreamBuilder_Destroy(builder);
            result
        }
    };
    if code != 0 {
        unsafe {
            drop(Box::from_raw(callback));
        }
        return Err(OutputError::Backend(format!("OHAudio 打开失败: {code}")));
    }
    let (mut rate, mut channels, mut frames) = (48000, 2, 960);
    unsafe {
        OH_AudioRenderer_GetSamplingRate(renderer, &mut rate);
        OH_AudioRenderer_GetChannelCount(renderer, &mut channels);
        OH_AudioRenderer_GetFrameSizeInCallback(renderer, &mut frames);
    }
    let (events, rx) = mpsc::channel();
    Ok(OpenedStream {
        config: StreamConfig {
            sample_rate: rate as u32,
            channels: channels as u16,
            format: SampleFormat::F32,
        },
        buffer_frames: frames.max(1) as u32,
        exclusive: false,
        device_name: "HarmonyOS 系统音频".into(),
        api_label: "OHAudio · 系统共享".into(),
        events: rx,
        handle: Box::new(Handle {
            renderer,
            callback,
            events,
        }),
    })
}

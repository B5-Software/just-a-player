//! N-API 绑定：把 `jap-engine` 暴露给 Node（在 Electron 的 utilityProcess 里加载）。
//!
//! 命令、事件、查询全部以 JSON 字符串传递，类型定义由 `jap-core` 通过 ts-rs 导出，保证两端一致。

use std::path::Path;
mod desktop;
mod gpu;
mod original_audio;
pub use gpu::gpu_adapters;
pub use original_audio::unwrap_original_audio;
mod system_media;
pub use desktop::{refresh_desktop_wallpaper, set_desktop_wallpaper};
pub use system_media::{
    close_system_media, init_system_media, poll_system_media, update_system_media,
};
mod offline;
pub use offline::OfflineRender;
use std::sync::{Arc, Once};

use jap_core::{Command, Event, Query, QueryResponse};
use jap_engine::EventSink;
use napi::Status;
use napi::bindgen_prelude::{Buffer, Float32Array};
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;

type EventCallback = ThreadsafeFunction<String, (), String, Status, false>;

fn init_logging() {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        let filter = tracing_subscriber::EnvFilter::try_from_env("JAP_LOG")
            .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info"));
        let _ = tracing_subscriber::fmt()
            .with_env_filter(filter)
            .with_writer(std::io::stderr)
            .with_ansi(false)
            .try_init();

        // 工作线程里的 panic 默认只打到 stderr 且线程悄悄消失，这里统一记录下来
        std::panic::set_hook(Box::new(|info| tracing::error!("引擎线程 panic: {info}")));
    });
}

#[napi(js_name = "Engine")]
pub struct JapEngine {
    inner: jap_engine::Engine,
    live: parking_lot::Mutex<Option<jap_decode::live::LiveInput>>,
}

/// 可视化帧的布局常量，前端启动时校验与自己的假设一致。
#[napi(object)]
pub struct VizLayout {
    pub header_len: u32,
    pub bands: u32,
    pub wave_len: u32,
    pub gonio_points: u32,
    pub frame_len: u32,
}

#[napi]
pub fn viz_layout() -> VizLayout {
    VizLayout {
        header_len: jap_analysis::HEADER_LEN as u32,
        bands: jap_analysis::BANDS as u32,
        wave_len: jap_analysis::WAVE_LEN as u32,
        gonio_points: jap_analysis::GONIO_POINTS as u32,
        frame_len: jap_analysis::FRAME_LEN as u32,
    }
}

#[napi]
pub fn logical_drives() -> Vec<String> {
    #[cfg(windows)]
    {
        use windows::Win32::Storage::FileSystem::GetLogicalDrives;
        let drives = unsafe { GetLogicalDrives() };
        (0..26)
            .filter(|index| drives & (1 << index) != 0)
            .map(|index| format!("{}:\\", char::from(b'A' + index)))
            .collect()
    }
    #[cfg(not(windows))]
    Vec::new()
}

/// Finish only the UI process after its quit handlers and audio handoff have
/// completed. Windows can otherwise wait for a detached Electron Node host in
/// its process teardown. The host and native window have independent lifetimes.
#[napi]
pub fn finish_ui_handoff() {
    #[cfg(windows)]
    unsafe {
        use windows::Win32::System::Threading::{GetCurrentProcess, TerminateProcess};
        let _ = TerminateProcess(GetCurrentProcess(), 0);
    }
}

/// 文件内嵌的封面图；没有封面或无法解析时返回 `null`。
#[napi(object)]
pub struct CoverImage {
    pub mime: String,
    pub data: Buffer,
}

#[napi(js_name = "readCover")]
pub fn read_cover_image(path: String) -> Option<CoverImage> {
    jap_engine::read_cover(Path::new(&path)).map(|cover| CoverImage {
        mime: cover.mime,
        data: Buffer::from(cover.data),
    })
}

#[napi]
impl JapEngine {
    #[napi]
    pub fn set_visualization_enabled(&self, enabled: bool) {
        self.inner.set_visualization_enabled(enabled);
    }
    /// `on_event` 会在 Node 主线程收到 JSON 序列化后的引擎事件。
    #[napi(constructor)]
    pub fn new(
        #[napi(ts_arg_type = "(eventJson: string) => void")] on_event: EventCallback,
    ) -> Self {
        init_logging();
        let callback = Arc::new(on_event);
        let sink: EventSink = Arc::new(move |event: Event| match serde_json::to_string(&event) {
            Ok(json) => {
                callback.call(json, ThreadsafeFunctionCallMode::NonBlocking);
            }
            Err(e) => tracing::error!("事件序列化失败: {e}"),
        });
        Self {
            inner: jap_engine::Engine::new(sink),
            live: parking_lot::Mutex::new(None),
        }
    }

    /// 投递命令（`Command` 的 JSON），异步执行。
    #[napi]
    pub fn send(&self, command_json: String) -> napi::Result<()> {
        let command: Command = serde_json::from_str(&command_json)
            .map_err(|e| napi::Error::from_reason(format!("无法解析命令: {e}")))?;
        self.inner.send(command);
        Ok(())
    }

    #[napi]
    pub fn open_live(&self, config_json: String) -> napi::Result<()> {
        let config = serde_json::from_str(&config_json)
            .map_err(|e| napi::Error::from_reason(format!("实时流参数: {e}")))?;
        let input = jap_decode::live::LiveInput::new(config)
            .map_err(|e| napi::Error::from_reason(e.to_string()))?;
        let mut live = self.live.lock();
        if let Some(previous) = live.replace(input.clone()) {
            previous.close();
        }
        self.inner.play_live(input);
        Ok(())
    }

    #[napi]
    pub fn push_live(&self, pts: f64, frames: u32, data: Buffer) -> napi::Result<()> {
        if !pts.is_finite() || pts < 0. || pts.fract() != 0. || pts > 9_007_199_254_740_991. {
            return Err(napi::Error::from_reason("无效实时流时间戳"));
        }
        let live = self.live.lock();
        let input = live
            .as_ref()
            .ok_or_else(|| napi::Error::from_reason("没有连接实时音源"))?;
        input
            .push(pts as u64, frames, data.to_vec())
            .map_err(|e| napi::Error::from_reason(e.to_string()))
    }

    #[napi]
    pub fn close_live(&self) {
        if let Some(input) = self.live.lock().take() {
            input.close();
        }
    }

    /// 同步查询（`Query` 的 JSON），返回 `QueryResponse` 的 JSON。
    #[napi]
    pub fn query(&self, query_json: String) -> napi::Result<String> {
        let query: Query = serde_json::from_str(&query_json)
            .map_err(|e| napi::Error::from_reason(format!("无法解析查询: {e}")))?;
        let response: QueryResponse = self.inner.query(query);
        serde_json::to_string(&response).map_err(|e| napi::Error::from_reason(e.to_string()))
    }

    /// 取一帧可视化分析数据；没有在播或画面没变时返回 `null`。
    #[napi]
    pub fn viz_frame(&self) -> Option<Float32Array> {
        let mut frame = Vec::with_capacity(jap_analysis::FRAME_LEN);
        self.inner
            .viz_frame(&mut frame)
            .then(|| Float32Array::new(frame))
    }
}

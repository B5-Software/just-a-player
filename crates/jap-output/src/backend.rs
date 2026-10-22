use std::sync::mpsc::Receiver;

use jap_core::{DeviceInfo, OutputApi, StreamConfig};

use crate::error::Result;

/// 由设备线程反复调用，从环形缓冲取走成品数据。
pub trait RenderSource: Send + 'static {
    /// `out` 恰为整数个帧。必须写满，且不得阻塞或分配内存。
    fn render(&mut self, out: &mut [u8]);
}

/// 设备流的句柄，丢弃即停止并释放设备。
pub trait StreamHandle: Send {
    /// 开始拉取数据。打开设备后先不出声，等引擎把缓冲预热好再调用。
    fn start(&self);
}

#[derive(Debug, Clone)]
pub enum StreamEvent {
    ResetRequired(String),
    /// 设备被拔出、被抢占或驱动出错，流已不可用。
    Failed(String),
}

#[derive(Debug, Clone)]
pub struct OpenRequest {
    pub api: OutputApi,
    /// `None` 表示系统默认设备。
    pub device_id: Option<String>,
    pub buffer_ms: u32,
    /// 按偏好排序的候选格式，依次尝试直到设备接受。
    pub candidates: Vec<StreamConfig>,
}

pub struct OpenedStream {
    pub config: StreamConfig,
    pub buffer_frames: u32,
    pub exclusive: bool,
    pub device_name: String,
    /// 给信号链展示用，例如 "WASAPI 独占 (事件驱动)"。
    pub api_label: String,
    pub events: Receiver<StreamEvent>,
    pub handle: Box<dyn StreamHandle>,
}

pub trait OutputBackend: Send + Sync {
    fn set_hardware_volume(
        &self,
        _api: OutputApi,
        _device_id: Option<&str>,
        _gain: f32,
    ) -> Result<bool> {
        Ok(false)
    }
    fn list_devices(&self, api: OutputApi) -> Result<Vec<DeviceInfo>>;

    /// 列出设备在独占模式下接受的格式。
    fn probe_exclusive(&self, device_id: Option<&str>) -> Result<Vec<StreamConfig>>;
    fn probe_formats(&self, _api: OutputApi, device_id: Option<&str>) -> Result<Vec<StreamConfig>> {
        self.probe_exclusive(device_id)
    }

    fn open(&self, request: &OpenRequest, source: Box<dyn RenderSource>) -> Result<OpenedStream>;
}

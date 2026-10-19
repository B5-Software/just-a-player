//! 不接触真实设备的后端：把渲染出的字节收集起来，用于 CI 里的比特完美校验。

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::thread::{self, JoinHandle};
use std::time::Duration;

use jap_core::{DeviceInfo, OutputApi, StreamConfig};
use parking_lot::Mutex;

use crate::backend::{OpenRequest, OpenedStream, OutputBackend, RenderSource, StreamHandle};
use crate::error::{OutputError, Result};

/// 每次渲染的帧数，相当于一个假设备的周期。
const PERIOD_FRAMES: usize = 480;

pub struct CaptureBackend {
    captured: Arc<Mutex<Vec<u8>>>,
    /// 为 `true` 时按真实时间节奏渲染，否则全速。
    realtime: bool,
    /// 假设备接受的格式；为空表示接受第一个候选。
    accepted: Vec<StreamConfig>,
    /// 为 `true` 时渲染完直接丢弃，不在内存里累积。
    discard: bool,
}

impl CaptureBackend {
    pub fn new(realtime: bool) -> Self {
        Self {
            captured: Arc::new(Mutex::new(Vec::new())),
            realtime,
            accepted: Vec::new(),
            discard: false,
        }
    }

    /// 只消费不留存：用作“无输出”接口，长时间播放也不会涨内存。
    pub fn discarding(mut self) -> Self {
        self.discard = true;
        self
    }

    /// 限定假设备支持的格式，用来测试格式协商。
    pub fn with_accepted(mut self, accepted: Vec<StreamConfig>) -> Self {
        self.accepted = accepted;
        self
    }

    pub fn captured(&self) -> Arc<Mutex<Vec<u8>>> {
        Arc::clone(&self.captured)
    }
}

struct CaptureHandle {
    go: Arc<AtomicBool>,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl StreamHandle for CaptureHandle {
    fn start(&self) {
        self.go.store(true, Ordering::Release);
    }
}

impl Drop for CaptureHandle {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

impl OutputBackend for CaptureBackend {
    fn list_devices(&self, _api: OutputApi) -> Result<Vec<DeviceInfo>> {
        Ok(vec![DeviceInfo {
            id: "capture".into(),
            name: "Capture (test)".into(),
            is_default: true,
        }])
    }

    fn probe_exclusive(&self, _device_id: Option<&str>) -> Result<Vec<StreamConfig>> {
        Ok(self.accepted.clone())
    }

    fn open(
        &self,
        request: &OpenRequest,
        mut source: Box<dyn RenderSource>,
    ) -> Result<OpenedStream> {
        let config = request
            .candidates
            .iter()
            .copied()
            .find(|c| self.accepted.is_empty() || self.accepted.contains(c))
            .ok_or_else(|| OutputError::UnsupportedFormat("capture backend".into()))?;

        let go = Arc::new(AtomicBool::new(false));
        let stop = Arc::new(AtomicBool::new(false));
        let (_tx, rx) = mpsc::channel();
        let captured = Arc::clone(&self.captured);
        let realtime = self.realtime;
        let discard = self.discard;
        let bytes_per_frame = config.bytes_per_frame();
        let period = Duration::from_secs_f64(PERIOD_FRAMES as f64 / f64::from(config.sample_rate));

        let (go_t, stop_t) = (Arc::clone(&go), Arc::clone(&stop));
        let thread = thread::Builder::new()
            .name("jap-capture".into())
            .spawn(move || {
                let mut buf = vec![0u8; PERIOD_FRAMES * bytes_per_frame];
                while !stop_t.load(Ordering::Acquire) {
                    if !go_t.load(Ordering::Acquire) {
                        thread::sleep(Duration::from_millis(1));
                        continue;
                    }
                    source.render(&mut buf);
                    if !discard {
                        captured.lock().extend_from_slice(&buf);
                    }
                    if realtime {
                        thread::sleep(period);
                    } else {
                        // 全速模式下让出 CPU，避免和生产者线程抢占
                        thread::yield_now();
                    }
                }
            })
            .map_err(|e| OutputError::Backend(e.to_string()))?;

        Ok(OpenedStream {
            config,
            buffer_frames: PERIOD_FRAMES as u32,
            exclusive: true,
            device_name: if discard {
                "空设备（无声）"
            } else {
                "Capture (test)"
            }
            .into(),
            api_label: if discard {
                "无输出 · 静默消费"
            } else {
                "Capture"
            }
            .into(),
            events: rx,
            handle: Box::new(CaptureHandle {
                go,
                stop,
                thread: Some(thread),
            }),
        })
    }
}

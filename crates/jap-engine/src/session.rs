use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::sync::mpsc::Receiver as StdReceiver;
use std::thread::JoinHandle;

use crossbeam_channel::{Receiver, Sender, unbounded};
use jap_core::{DspConfig, OutputConfig, StreamConfig};
use jap_output::{
    OpenRequest, OpenedStream, OutputBackend, OutputError, StreamEvent, StreamHandle,
};
use parking_lot::Mutex;

use crate::producer::{ProducerCmd, ProducerCtx, spawn};
use crate::ring::{RingShared, new_ring};
use crate::signal::OutputDetails;
use crate::timeline::Timeline;
use crate::viz::VizTap;

/// 环形缓冲的时长。越短，调 EQ 等参数时听感越跟手；越长，抗卡顿越强。
const RING_MS: u32 = 500;
/// 积累到这么多毫秒的数据才开始出声。
const PRIME_MS: u32 = 150;

/// 一次“设备流 + 环形缓冲 + 生产者线程”的组合；格式变化时整体重建。
pub(crate) struct Session {
    pub config: StreamConfig,
    pub shared: Arc<RingShared>,
    pub timeline: Arc<Mutex<Timeline>>,
    pub details: OutputDetails,
    pub errors: Receiver<String>,
    pub emitted_serial: u64,
    cmd_tx: Sender<ProducerCmd>,
    stream_events: StdReceiver<StreamEvent>,
    handle: Box<dyn StreamHandle>,
    producer: Option<JoinHandle<()>>,
    prime_frames: u64,
    tap: Arc<VizTap>,
}

impl Session {
    /// 依次尝试候选格式，第一个被设备接受的胜出。
    pub fn open(
        backend: &dyn OutputBackend,
        output: &OutputConfig,
        candidates: &[StreamConfig],
        tap: &Arc<VizTap>,
        dsp: &Arc<Mutex<DspConfig>>,
        volume: f32,
    ) -> Result<Self, OutputError> {
        let mut last = OutputError::UnsupportedFormat("没有候选格式".into());
        for &cand in candidates {
            let mut selected = cand;
            // Shared backends can negotiate a native rate/format. Recreate the
            // ring before starting, so its byte layout matches the actual stream.
            for attempt in 0..2 {
                let mut parts = new_ring(selected, RING_MS);
                parts.render.initial_volume(volume);
                let request = OpenRequest {
                    api: output.api,
                    device_id: output.device_id.clone(),
                    buffer_ms: output.buffer_ms,
                    candidates: vec![selected],
                };
                match backend.open(&request, Box::new(parts.render)) {
                    Ok(opened) => {
                        if opened.config.sample_rate != cand.sample_rate {
                            last = OutputError::UnsupportedFormat(
                                "设备改变了请求采样率；此路径没有应用内重采样器".into(),
                            );
                            break;
                        }
                        if opened.config != selected {
                            selected = opened.config;
                            drop(opened);
                            last =
                                OutputError::UnsupportedFormat("设备未保持已协商的输出格式".into());
                            if attempt == 0 {
                                continue;
                            }
                            break;
                        }
                        return Self::assemble(
                            opened,
                            parts.producer,
                            parts.shared,
                            parts.capacity_frames,
                            tap,
                            dsp,
                        );
                    }
                    Err(e @ (OutputError::DeviceBusy | OutputError::DeviceNotFound)) => {
                        return Err(e);
                    }
                    Err(e) => {
                        tracing::debug!(?selected, "候选格式被拒绝: {e}");
                        last = e;
                        break;
                    }
                }
            }
        }
        Err(last)
    }

    fn assemble(
        opened: OpenedStream,
        ring_producer: rtrb::Producer<u8>,
        shared: Arc<RingShared>,
        capacity_frames: usize,
        tap: &Arc<VizTap>,
        dsp: &Arc<Mutex<DspConfig>>,
    ) -> Result<Self, OutputError> {
        let OpenedStream {
            config,
            buffer_frames,
            exclusive,
            device_name,
            api_label,
            events,
            handle,
        } = opened;

        let timeline = Arc::new(Mutex::new(Timeline::default()));
        let (cmd_tx, cmd_rx) = unbounded();
        let (err_tx, err_rx) = unbounded();
        let ctx = ProducerCtx {
            config,
            shared: Arc::clone(&shared),
            timeline: Arc::clone(&timeline),
            errors: err_tx,
            tap: Arc::clone(tap),
            dsp: Arc::clone(dsp),
        };
        let producer =
            spawn(ctx, ring_producer, cmd_rx).map_err(|e| OutputError::Backend(e.to_string()))?;

        let prime_frames = (u64::from(config.sample_rate) * u64::from(PRIME_MS) / 1000)
            .min(capacity_frames as u64 / 2);
        let divisor = match config.format {
            jap_core::SampleFormat::Dop24 | jap_core::SampleFormat::Dop32 => 4,
            jap_core::SampleFormat::DsdU8Lsb | jap_core::SampleFormat::DsdU8Msb => 8,
            _ => 1,
        };
        tap.bind(
            Arc::clone(&shared),
            u64::from(buffer_frames),
            config.sample_rate,
            divisor,
        );

        Ok(Self {
            config,
            shared,
            timeline,
            details: OutputDetails {
                device_name,
                api_label,
                exclusive,
                buffer_frames,
            },
            errors: err_rx,
            emitted_serial: 0,
            cmd_tx,
            stream_events: events,
            handle,
            producer: Some(producer),
            prime_frames,
            tap: Arc::clone(tap),
        })
    }

    pub fn send(&self, cmd: ProducerCmd) {
        let _ = self.cmd_tx.send(cmd);
    }

    pub fn compatible(&self, candidates: &[StreamConfig], exclusive: bool) -> bool {
        self.details.exclusive == exclusive && candidates.contains(&self.config)
    }

    pub fn started(&self) -> bool {
        self.shared.started.load(Ordering::Acquire)
    }

    /// 缓冲预热完成（或曲目很短已写完）后启动设备。
    pub fn start_if_primed(&self) {
        if self.started() || self.shared.paused.load(Ordering::Acquire) {
            return;
        }
        let written = self.shared.written_frames.load(Ordering::Acquire);
        if written >= self.prime_frames || self.shared.finished.load(Ordering::Acquire) {
            self.shared.started.store(true, Ordering::Release);
            self.handle.start();
        }
    }

    pub fn poll_stream_event(&self) -> Option<StreamEvent> {
        self.stream_events.try_recv().ok()
    }

    /// 播放头在环中的位置，扣除设备尚未放出的缓冲后才是“正在听到”的位置。
    pub fn audible_playhead(&self) -> u64 {
        if !self.started() {
            return 0;
        }
        self.shared
            .read_frames
            .load(Ordering::Acquire)
            .saturating_sub(u64::from(self.details.buffer_frames))
    }
}

impl Drop for Session {
    /// 先让生产者退出；随后字段按声明顺序销毁，`handle` 释放设备流，因此设备一定晚于生产者停止。
    fn drop(&mut self) {
        self.tap.unbind(&self.shared);
        let _ = self.cmd_tx.send(ProducerCmd::Shutdown);
        if let Some(t) = self.producer.take() {
            let _ = t.join();
        }
    }
}

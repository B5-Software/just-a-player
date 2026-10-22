//! 生产者线程：解码 -> 声道映射 -> 量化 -> 写入环形缓冲。

use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use crossbeam_channel::{Receiver, RecvTimeoutError, Sender, TryRecvError};
use jap_core::{DspConfig, StreamConfig, TrackInfo};
use jap_decode::AudioSource;
use parking_lot::Mutex;
use rtrb::Producer;

use crate::convert::{ChannelMap, quantize_into};
use crate::ring::RingShared;
use crate::timeline::{Segment, Timeline};
use crate::viz::VizTap;

/// 等待设备确认清空环的最长时间。
const FLUSH_TIMEOUT: Duration = Duration::from_millis(500);

pub(crate) struct TrackHandoff {
    pub source: Box<dyn AudioSource>,
    pub info: Arc<TrackInfo>,
}

pub(crate) enum ProducerCmd {
    /// 打断当前曲目并播放新曲目；`resume` 为真时在清空后解除暂停。
    Load {
        track: TrackHandoff,
        resume: bool,
        request: u64,
    },
    QueueNext(Option<TrackHandoff>),
    Seek {
        ms: u64,
        request: u64,
    },
    Shutdown,
}

pub(crate) struct ProducerCtx {
    pub config: StreamConfig,
    pub shared: Arc<RingShared>,
    pub timeline: Arc<Mutex<Timeline>>,
    pub errors: Sender<String>,
    pub tap: Arc<VizTap>,
    pub dsp: Arc<Mutex<DspConfig>>,
}

struct Active {
    source: Box<dyn AudioSource>,
    info: Arc<TrackInfo>,
    map: ChannelMap,
    in_channels: usize,
}

pub(crate) fn spawn(
    ctx: ProducerCtx,
    ring: Producer<u8>,
    rx: Receiver<ProducerCmd>,
) -> std::io::Result<JoinHandle<()>> {
    thread::Builder::new()
        .name("jap-producer".into())
        .spawn(move || {
            let dsp = crate::dsp::Dsp::new(ctx.config.sample_rate, ctx.config.channels as usize);
            let mut worker = Worker {
                ctx,
                ring,
                rx,
                current: None,
                next: None,
                serial: 0,
                pending: Vec::new(),
                pending_off: 0,
                decoded: Vec::new(),
                mapped: Vec::new(),
                dsp,
            };
            worker.run();
        })
}

struct Worker {
    ctx: ProducerCtx,
    ring: Producer<u8>,
    rx: Receiver<ProducerCmd>,
    current: Option<Active>,
    next: Option<TrackHandoff>,
    serial: u64,
    /// 已量化、等待写入环的字节，`pending_off` 之前的部分已经写过。
    pending: Vec<u8>,
    pending_off: usize,
    decoded: Vec<f64>,
    mapped: Vec<f64>,
    dsp: crate::dsp::Dsp,
}

impl Worker {
    fn run(&mut self) {
        let bpf = self.ctx.config.bytes_per_frame();
        loop {
            loop {
                match self.rx.try_recv() {
                    Ok(cmd) => {
                        if !self.handle(cmd) {
                            return;
                        }
                    }
                    Err(TryRecvError::Empty) => break,
                    Err(TryRecvError::Disconnected) => return,
                }
            }

            if self.current.is_none() {
                match self.rx.recv_timeout(Duration::from_millis(20)) {
                    Ok(cmd) => {
                        if !self.handle(cmd) {
                            return;
                        }
                    }
                    Err(RecvTimeoutError::Timeout) => {}
                    Err(RecvTimeoutError::Disconnected) => return,
                }
                continue;
            }

            // 如果还有量化好的数据待写入环，先尽力写入
            if self.pending_off < self.pending.len() {
                let free = self.ring.slots();
                let n = free.min(self.pending.len() - self.pending_off) / bpf * bpf;
                if n > 0 {
                    self.write(self.pending_off, n);
                    self.pending_off += n;
                }
            }

            // 如果当前数据已全部写入环：
            // 只要环里还有足够空间，就继续解码下一包；
            // 环彻底满了才休眠让出 CPU，保证环始终处于饱和状态。
            if self.pending_off >= self.pending.len() {
                let free = self.ring.slots();
                if free >= bpf * 64 {
                    self.refill();
                } else {
                    thread::sleep(Duration::from_millis(2));
                }
            }
        }
    }

    /// 返回 `false` 表示应当退出线程。
    fn handle(&mut self, cmd: ProducerCmd) -> bool {
        match cmd {
            ProducerCmd::Shutdown => return false,
            ProducerCmd::Load {
                track,
                resume,
                request,
            } => {
                if self.ctx.shared.started.load(Ordering::Acquire) {
                    self.flush();
                }
                self.pending.clear();
                self.pending_off = 0;
                self.next = None;
                self.ctx.timeline.lock().clear();
                self.activate(track);
                if resume {
                    self.ctx.shared.paused.store(false, Ordering::Release);
                }
                self.ctx
                    .shared
                    .control_ack
                    .store(request, Ordering::Release);
            }
            ProducerCmd::QueueNext(track) => match track {
                // 当前曲目早已写完（短曲目）时，新预载的曲目直接接上
                Some(track) if self.current.is_none() => self.activate(track),
                other => self.next = other,
            },
            ProducerCmd::Seek { ms, request } => {
                self.seek(ms);
                self.ctx
                    .shared
                    .control_ack
                    .store(request, Ordering::Release);
            }
        }
        true
    }

    fn activate(&mut self, mut track: TrackHandoff) {
        if !self.ctx.config.format.is_dsd() {
            match crate::resample::adapt(track.source, self.ctx.config.sample_rate) {
                Ok(source) => track.source = source,
                Err(e) => {
                    let _ = self.ctx.errors.send(e.to_string());
                    self.on_track_end();
                    return;
                }
            }
        }
        let in_channels = track.info.format.channels as usize;
        let out_channels = self.ctx.config.channels as usize;
        let Some(map) = ChannelMap::new(in_channels, out_channels) else {
            let _ = self.ctx.errors.send(format!(
                "无法把 {in_channels} 声道映射到 {out_channels} 声道输出: {}",
                track.info.path
            ));
            self.on_track_end();
            return;
        };

        self.serial += 1;
        self.ctx
            .shared
            .current_serial
            .store(self.serial, Ordering::Release);
        self.push_segment(&track.info, track.source.position_frames());
        self.ctx.shared.finished.store(false, Ordering::Release);
        self.current = Some(Active {
            source: track.source,
            info: track.info,
            map,
            in_channels,
        });
    }

    fn push_segment(&self, info: &Arc<TrackInfo>, source_offset: u64) {
        self.ctx.timeline.lock().push(Segment {
            start_frame: self.ctx.shared.written_frames.load(Ordering::Acquire),
            serial: self.serial,
            info: Arc::clone(info),
            source_offset,
        });
    }

    fn seek(&mut self, ms: u64) {
        if self.current.is_none() {
            return;
        }
        self.flush();
        self.pending.clear();
        self.pending_off = 0;
        let Some(active) = self.current.as_mut() else {
            return;
        };
        match active.source.seek(ms) {
            Ok(_) => {
                let (info, pos) = (Arc::clone(&active.info), active.source.position_frames());
                self.ctx.timeline.lock().clear();
                self.push_segment(&info, pos);
            }
            Err(e) => {
                let _ = self.ctx.errors.send(format!("跳转失败: {e}"));
            }
        }
    }

    /// 请求设备线程渐出并清空环，等它确认。
    fn flush(&self) {
        let shared = &self.ctx.shared;
        let generation = shared
            .flush_gen
            .fetch_add(1, Ordering::AcqRel)
            .wrapping_add(1);
        let deadline = Instant::now() + FLUSH_TIMEOUT;
        while shared.flush_ack.load(Ordering::Acquire) != generation {
            if Instant::now() > deadline {
                tracing::warn!("等待设备清空缓冲超时");
                break;
            }
            thread::sleep(Duration::from_micros(500));
        }
    }

    fn refill(&mut self) {
        let Some(active) = self.current.as_mut() else {
            return;
        };
        self.pending.clear();
        self.pending_off = 0;
        self.decoded.clear();

        let encoded = self.ctx.config.format.is_dsd();
        let result = if encoded {
            active
                .source
                .read_encoded(self.ctx.config.format, &mut self.pending, &mut self.decoded)
        } else {
            active.source.read(&mut self.decoded)
        };
        match result {
            Ok(0) => self.on_track_end(),
            Ok(_) => {
                if encoded {
                    let divisor = if matches!(
                        self.ctx.config.format,
                        jap_core::SampleFormat::Dop24 | jap_core::SampleFormat::Dop32
                    ) {
                        4
                    } else {
                        8
                    };
                    self.ctx.tap.push(
                        self.ctx.shared.written_frames.load(Ordering::Acquire) / divisor,
                        &self.decoded,
                        active.in_channels,
                    );
                    return;
                }
                self.mapped.clear();
                active
                    .map
                    .apply(&self.decoded, active.in_channels, &mut self.mapped);
                self.dsp.process(&mut self.mapped, &self.ctx.dsp.lock());
                self.ctx.tap.push(
                    self.ctx.shared.written_frames.load(Ordering::Acquire),
                    &self.mapped,
                    self.ctx.config.channels as usize,
                );
                quantize_into(&self.mapped, self.ctx.config.format, &mut self.pending);
            }
            Err(e) => {
                let _ = self.ctx.errors.send(format!("解码出错: {e}"));
                self.on_track_end();
            }
        }
    }

    fn on_track_end(&mut self) {
        self.current = None;
        match self.next.take() {
            Some(next) => self.activate(next),
            None => self.ctx.shared.finished.store(true, Ordering::Release),
        }
    }

    fn write(&mut self, offset: usize, len: usize) {
        let bpf = self.ctx.config.bytes_per_frame();
        let data = &self.pending[offset..offset + len];
        if let Ok(mut chunk) = self.ring.write_chunk(len) {
            let (a, b) = chunk.as_mut_slices();
            a.copy_from_slice(&data[..a.len()]);
            b.copy_from_slice(&data[a.len()..]);
            chunk.commit_all();
            self.ctx
                .shared
                .written_frames
                .fetch_add((len / bpf) as u64, Ordering::Release);
        }
    }
}

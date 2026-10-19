//! 生产者线程与设备线程之间的环形缓冲，以及设备侧的渐变处理。

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};

use jap_core::{SampleFormat, StreamConfig};
use jap_output::RenderSource;
use rtrb::{Consumer, Producer, RingBuffer};

/// 暂停、恢复与跳转时使用的渐变时长。
const RAMP_SECONDS: f64 = 0.010;

/// 两侧共享的计数器与控制标志。
#[derive(Default)]
pub struct RingShared {
    /// 设备线程已从环中取走的帧数（播放出去的与被丢弃的都算）。
    pub read_frames: AtomicU64,
    /// 生产者已写入环中的帧数。
    pub written_frames: AtomicU64,
    /// 生产者请求清空环时递增；设备线程处理后把同样的值写进 `flush_ack`。
    pub flush_gen: AtomicU32,
    pub flush_ack: AtomicU32,
    pub paused: AtomicBool,
    /// 设备线程已开始拉取数据。
    pub started: AtomicBool,
    /// 生产者再无数据可写（队列播完）。
    pub finished: AtomicBool,
    pub underruns: AtomicU32,
    /// 生产者当前正在写入的曲目序号。
    pub current_serial: AtomicU64,
    /// Completed manual load/seek request, published after its timeline is installed.
    pub control_ack: AtomicU64,
    pub volume: AtomicU32,
}

pub struct RingParts {
    pub producer: Producer<u8>,
    pub render: RingRender,
    pub shared: Arc<RingShared>,
    pub capacity_frames: usize,
}

pub fn new_ring(config: StreamConfig, ring_ms: u32) -> RingParts {
    let bpf = config.bytes_per_frame();
    let capacity_frames = (u64::from(config.sample_rate) * u64::from(ring_ms) / 1000) as usize;
    let (producer, consumer) = RingBuffer::new(capacity_frames * bpf);
    let shared = Arc::new(RingShared::default());
    shared.volume.store(1f32.to_bits(), Ordering::Relaxed);
    let render = RingRender {
        consumer,
        shared: Arc::clone(&shared),
        config,
        gain: 1.0,
        step: (1.0 / (f64::from(config.sample_rate) * RAMP_SECONDS)) as f32,
        flush_gen: 0,
        wire_frame: 0,
        master_gain: 1.,
    };
    RingParts {
        producer,
        render,
        shared,
        capacity_frames,
    }
}

/// 设备线程一侧：从环中取数据，并在暂停/跳转时做短渐变以免爆音。
pub struct RingRender {
    consumer: Consumer<u8>,
    shared: Arc<RingShared>,
    config: StreamConfig,
    /// 当前增益；正常播放时恒为 1，即逐位透传。
    gain: f32,
    step: f32,
    flush_gen: u32,
    wire_frame: u64,
    master_gain: f32,
}

impl RenderSource for RingRender {
    fn render(&mut self, out: &mut [u8]) {
        if self.config.format.is_dsd() {
            self.render_dsd(out);
            return;
        }
        let bpf = self.config.bytes_per_frame();
        let want_frames = out.len() / bpf;
        let avail_frames = self.consumer.slots() / bpf;

        let flush_requested = self.shared.flush_gen.load(Ordering::Acquire) != self.flush_gen;
        let target = if flush_requested || self.shared.paused.load(Ordering::Acquire) {
            0.0
        } else {
            1.0
        };

        let consume = if target == 0.0 {
            if self.gain == 0.0 {
                0
            } else {
                // 只消耗渐变到 0 所需的帧数，剩下的留在环里等恢复
                let ramp = (self.gain / self.step).ceil() as usize;
                want_frames.min(avail_frames).min(ramp)
            }
        } else {
            want_frames.min(avail_frames)
        };

        if consume > 0 {
            let bytes = consume * bpf;
            copy_from_ring(&mut self.consumer, &mut out[..bytes]);
            if self.gain != target || target != 1.0 {
                self.gain =
                    ramp_scale(&mut out[..bytes], self.config, self.gain, target, self.step);
            }
            self.apply_volume(&mut out[..bytes]);
            self.shared
                .read_frames
                .fetch_add(consume as u64, Ordering::Release);
        } else if self.gain != target && target == 0.0 {
            self.gain = 0.0;
        }
        out[consume * bpf..].fill(0);

        // 环里的数据不够时，渐变状态按目标收敛，避免后续突变
        if consume < want_frames && target == 0.0 {
            self.gain = 0.0;
        }

        if flush_requested && self.gain == 0.0 {
            let rest = self.consumer.slots() / bpf;
            if rest > 0 {
                if let Ok(chunk) = self.consumer.read_chunk(rest * bpf) {
                    chunk.commit_all();
                }
                self.shared
                    .read_frames
                    .fetch_add(rest as u64, Ordering::Release);
            }
            self.flush_gen = self.shared.flush_gen.load(Ordering::Acquire);
            self.shared
                .flush_ack
                .store(self.flush_gen, Ordering::Release);
        } else if target == 1.0
            && consume < want_frames
            && !self.shared.finished.load(Ordering::Acquire)
        {
            self.shared.underruns.fetch_add(1, Ordering::Relaxed);
        }
    }
}

fn copy_from_ring(consumer: &mut Consumer<u8>, dst: &mut [u8]) {
    if let Ok(chunk) = consumer.read_chunk(dst.len()) {
        let (a, b) = chunk.as_slices();
        dst[..a.len()].copy_from_slice(a);
        dst[a.len()..].copy_from_slice(b);
        chunk.commit_all();
    }
}

/// 对一段设备字节做线性增益渐变，返回渐变结束时的增益。
fn ramp_scale(buf: &mut [u8], config: StreamConfig, start: f32, target: f32, step: f32) -> f32 {
    let channels = config.channels as usize;
    let width = config.format.container_bytes();
    let frame_bytes = width * channels;
    let mut gain = start;

    for frame in buf.chunks_exact_mut(frame_bytes) {
        gain = if gain < target {
            (gain + step).min(target)
        } else {
            (gain - step).max(target)
        };
        for sample in frame.chunks_exact_mut(width) {
            scale_sample(sample, config.format, f64::from(gain));
        }
    }
    gain
}

fn scale_sample(bytes: &mut [u8], format: SampleFormat, gain: f64) {
    match format {
        SampleFormat::I16 => {
            let v = i16::from_le_bytes([bytes[0], bytes[1]]);
            let s = (f64::from(v) * gain).round().clamp(-32_768.0, 32_767.0) as i16;
            bytes.copy_from_slice(&s.to_le_bytes());
        }
        SampleFormat::I24Packed => {
            let v = i32::from_le_bytes([
                bytes[0],
                bytes[1],
                bytes[2],
                if bytes[2] & 0x80 != 0 { 0xFF } else { 0 },
            ]);
            let s = (f64::from(v) * gain)
                .round()
                .clamp(-8_388_608.0, 8_388_607.0) as i32;
            bytes.copy_from_slice(&s.to_le_bytes()[..3]);
        }
        SampleFormat::I24In32 | SampleFormat::I32 => {
            let v = i32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]);
            let s = (f64::from(v) * gain)
                .round()
                .clamp(-2_147_483_648.0, 2_147_483_647.0) as i32;
            bytes.copy_from_slice(&s.to_le_bytes());
        }
        SampleFormat::F32 => {
            let v = f32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]);
            bytes.copy_from_slice(&((f64::from(v) * gain) as f32).to_le_bytes());
        }
        SampleFormat::Dop24
        | SampleFormat::Dop32
        | SampleFormat::DsdU8Lsb
        | SampleFormat::DsdU8Msb => {}
    }
}

impl RingRender {
    pub(crate) fn initial_volume(&mut self, gain: f32) {
        self.master_gain = gain;
        self.shared.volume.store(gain.to_bits(), Ordering::Release);
    }
    fn apply_volume(&mut self, out: &mut [u8]) {
        let target = f32::from_bits(self.shared.volume.load(Ordering::Acquire)).clamp(0., 1.);
        if target == 1. && self.master_gain == 1. {
            return;
        }
        let width = self.config.format.container_bytes();
        for frame in out.chunks_exact_mut(self.config.bytes_per_frame()) {
            self.master_gain += (target - self.master_gain).clamp(-self.step, self.step);
            for sample in frame.chunks_exact_mut(width) {
                scale_sample(sample, self.config.format, f64::from(self.master_gain));
            }
        }
    }
    fn render_dsd(&mut self, out: &mut [u8]) {
        let bpf = self.config.bytes_per_frame();
        let generation = self.shared.flush_gen.load(Ordering::Acquire);
        if generation != self.flush_gen {
            let n = self.consumer.slots() / bpf * bpf;
            if let Ok(chunk) = self.consumer.read_chunk(n) {
                chunk.commit_all();
            }
            self.shared
                .read_frames
                .fetch_add((n / bpf) as u64, Ordering::Release);
            self.flush_gen = generation;
            self.shared.flush_ack.store(generation, Ordering::Release);
        }
        // DSD must never pass through PCM gain ramps or zero-fill. 0x69 is
        // balanced DSD silence; DoP markers continue across pause and underrun.
        out.fill(0x69);
        let paused = self.shared.paused.load(Ordering::Acquire);
        let n = if paused {
            0
        } else {
            out.len().min(self.consumer.slots()) / bpf * bpf
        };
        if n > 0 {
            copy_from_ring(&mut self.consumer, &mut out[..n]);
        }
        if f32::from_bits(self.shared.volume.load(Ordering::Acquire)) == 0. {
            out.fill(0x69);
        }
        self.shared
            .read_frames
            .fetch_add((n / bpf) as u64, Ordering::Release);
        let width = self.config.format.container_bytes();
        if matches!(
            self.config.format,
            SampleFormat::Dop24 | SampleFormat::Dop32
        ) {
            for frame in out.chunks_exact_mut(bpf) {
                let marker = if self.wire_frame.is_multiple_of(2) {
                    0x05
                } else {
                    0xfa
                };
                for sample in frame.chunks_exact_mut(width) {
                    sample[width - 1] = marker;
                    if width == 4 {
                        sample[0] = 0;
                    }
                }
                self.wire_frame += 1;
            }
        }
        if n < out.len() && !paused && !self.shared.finished.load(Ordering::Acquire) {
            self.shared.underruns.fetch_add(1, Ordering::Relaxed);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn initial_volume_attenuates_first_device_sample_and_mute_is_smooth() {
        let RingParts {
            mut producer,
            mut render,
            shared,
            ..
        } = new_ring(cfg(SampleFormat::I16), 100);
        render.initial_volume(0.2);
        let data: Vec<_> = (0..2000).flat_map(|_| 10000i16.to_le_bytes()).collect();
        let mut w = producer.write_chunk(data.len()).unwrap();
        let (a, b) = w.as_mut_slices();
        a.copy_from_slice(&data[..a.len()]);
        b.copy_from_slice(&data[a.len()..]);
        w.commit_all();
        let mut out = vec![0; 4 * 20];
        render.render(&mut out);
        assert_eq!(i16::from_le_bytes([out[0], out[1]]), 2000);
        shared.volume.store(0f32.to_bits(), Ordering::Release);
        let mut out = vec![0; 4 * 600];
        render.render(&mut out);
        assert!(out[out.len() - 4..].iter().all(|&b| b == 0));
    }

    #[test]
    fn dop_markers_continue_across_pauses_underruns_and_flush() {
        for format in [SampleFormat::Dop24, SampleFormat::Dop32] {
            let config = cfg(format);
            let width = format.container_bytes();
            let bpf = config.bytes_per_frame();
            let RingParts {
                mut producer,
                mut render,
                shared,
                ..
            } = new_ring(config, 100);
            let data = vec![0x27; bpf * 3];
            let mut chunk = producer.write_chunk(data.len()).unwrap();
            let (a, b) = chunk.as_mut_slices();
            a.copy_from_slice(&data[..a.len()]);
            b.copy_from_slice(&data[a.len()..]);
            chunk.commit_all();
            let mut wire = 0;
            for paused in [false, true, false, false] {
                shared.paused.store(paused, Ordering::Release);
                let mut out = vec![0; bpf * 5];
                render.render(&mut out);
                for frame in out.chunks_exact(bpf) {
                    for channel in frame.chunks_exact(width) {
                        assert_eq!(channel[width - 1], if wire % 2 == 0 { 0x05 } else { 0xfa });
                        if width == 4 {
                            assert_eq!(channel[0], 0);
                        }
                    }
                    wire += 1;
                }
                if paused {
                    assert!(
                        out.chunks_exact(width)
                            .all(|sample| sample[width - 2] == 0x69)
                    );
                }
            }
            shared.flush_gen.store(1, Ordering::Release);
            render.render(&mut vec![0; bpf]);
            assert_eq!(shared.flush_ack.load(Ordering::Acquire), 1);
            assert_eq!(shared.read_frames.load(Ordering::Acquire), 3);
        }
    }

    #[test]
    fn native_dsd_pause_emits_balanced_silence_without_pcm_ramps() {
        let RingParts {
            mut render, shared, ..
        } = new_ring(cfg(SampleFormat::DsdU8Msb), 100);
        shared.paused.store(true, Ordering::Release);
        let mut out = [0; 34];
        render.render(&mut out);
        assert!(out.iter().all(|&v| v == 0x69));
        assert_eq!(shared.read_frames.load(Ordering::Acquire), 0);
    }

    fn cfg(format: SampleFormat) -> StreamConfig {
        StreamConfig {
            sample_rate: 48_000,
            channels: 2,
            format,
        }
    }

    #[test]
    fn unity_playback_is_a_plain_copy() {
        let parts = new_ring(cfg(SampleFormat::I16), 100);
        let RingParts {
            mut producer,
            mut render,
            shared,
            ..
        } = parts;
        let data: Vec<u8> = (0..4 * 100).map(|i| (i % 251) as u8).collect();
        let mut w = producer.write_chunk(data.len()).unwrap();
        let (a, b) = w.as_mut_slices();
        a.copy_from_slice(&data[..a.len()]);
        b.copy_from_slice(&data[a.len()..]);
        w.commit_all();

        let mut out = vec![0u8; data.len()];
        render.render(&mut out);
        assert_eq!(out, data);
        assert_eq!(shared.read_frames.load(Ordering::Relaxed), 100);
    }

    #[test]
    fn flush_discards_the_ring_and_acks() {
        let RingParts {
            mut producer,
            mut render,
            shared,
            ..
        } = new_ring(cfg(SampleFormat::I16), 100);
        let mut w = producer.write_chunk(4 * 2000).unwrap();
        let (a, _) = w.as_mut_slices();
        a.fill(0x10);
        w.commit_all();

        shared.flush_gen.fetch_add(1, Ordering::AcqRel);
        let mut out = vec![0u8; 4 * 480];
        // 渐变约 10ms（480 帧），之后应清空并确认
        for _ in 0..4 {
            render.render(&mut out);
        }
        assert_eq!(shared.flush_ack.load(Ordering::Acquire), 1);
        assert_eq!(shared.read_frames.load(Ordering::Relaxed), 2000);
        assert!(out.iter().all(|&b| b == 0), "flush 之后必须输出静音");
    }

    #[test]
    fn pause_ramps_down_then_goes_silent_without_consuming() {
        let RingParts {
            mut producer,
            mut render,
            shared,
            ..
        } = new_ring(cfg(SampleFormat::I16), 200);
        let mut w = producer.write_chunk(4 * 9000).unwrap();
        let (a, b) = w.as_mut_slices();
        for chunk in a
            .as_chunks_mut::<2>()
            .0
            .iter_mut()
            .chain(b.as_chunks_mut::<2>().0.iter_mut())
        {
            chunk.copy_from_slice(&10_000i16.to_le_bytes());
        }
        w.commit_all();

        shared.paused.store(true, Ordering::Release);
        let mut out = vec![0u8; 4 * 1000];
        render.render(&mut out);
        let consumed = shared.read_frames.load(Ordering::Relaxed);
        assert!(
            consumed > 0 && consumed <= 481,
            "只应消耗渐变所需的帧数，实际 {consumed}"
        );

        render.render(&mut out);
        assert_eq!(
            shared.read_frames.load(Ordering::Relaxed),
            consumed,
            "暂停后不再消耗"
        );
        assert!(out.iter().all(|&b| b == 0));
    }
}

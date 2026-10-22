//! 可视化取样点：生产者把解码后的样本推进来，前端按需拉取“此刻正在听到的那一帧”的分析结果。

use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Instant;

use jap_analysis::Analyzer;
use parking_lot::Mutex;
use rubato::{FftFixedInOut, Resampler};

use crate::ring::RingShared;

struct Binding {
    shared: Arc<RingShared>,
    latency_frames: u64,
    rate: u32,
    divisor: u64,
}

struct State {
    analyzer: Analyzer,
    analysis_rate: u32,
    downsample: Option<AnalysisResampler>,
    binding: Option<Binding>,
    last_read: u64,
    last_change: Instant,
    last_emitted: Option<u64>,
}

pub struct VizTap {
    state: Mutex<State>,
}

impl VizTap {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(State {
                analyzer: Analyzer::new(),
                analysis_rate: 44_100,
                downsample: None,
                binding: None,
                last_read: 0,
                last_change: Instant::now(),
                last_emitted: None,
            }),
        })
    }

    pub(crate) fn bind(
        &self,
        shared: Arc<RingShared>,
        latency_frames: u64,
        rate: u32,
        divisor: u64,
    ) {
        let rate = rate / divisor as u32;
        let mut st = self.state.lock();
        st.analyzer.reset();
        // Keep only the visual analysis at <= 96 kHz. The samples sent to the
        // DAC never pass through this filter; native high-rate PCM stays exact.
        st.downsample = AnalysisResampler::new(rate);
        st.analysis_rate = if st.downsample.is_some() {
            96_000
        } else {
            rate
        };
        let analysis_rate = st.analysis_rate;
        st.analyzer.set_rate(analysis_rate);
        st.last_read = 0;
        st.last_change = Instant::now();
        st.last_emitted = None;
        st.binding = Some(Binding {
            shared,
            latency_frames: latency_frames / divisor,
            rate,
            divisor,
        });
    }

    /// 只解除属于 `shared` 的绑定，避免旧会话销毁时误伤刚建立的新会话。
    pub(crate) fn unbind(&self, shared: &Arc<RingShared>) {
        let mut st = self.state.lock();
        if st
            .binding
            .as_ref()
            .is_some_and(|b| Arc::ptr_eq(&b.shared, shared))
        {
            st.binding = None;
        }
    }

    pub(crate) fn push(&self, start_frame: u64, samples: &[f64], channels: usize) {
        let mut guard = self.state.lock();
        let st = &mut *guard;
        if let Some(filter) = &mut st.downsample {
            filter.push(start_frame, samples, channels, &mut st.analyzer);
        } else {
            st.analyzer.push(start_frame, samples, channels);
        }
    }

    /// 取一帧分析结果。没有在播、或暂停且画面没变时返回 `false`。
    pub fn frame(&self, out: &mut Vec<f32>) -> bool {
        let mut guard = self.state.lock();
        let st = &mut *guard;
        let Some(binding) = &st.binding else {
            return false;
        };
        if !binding.shared.started.load(Ordering::Acquire) {
            return false;
        }

        let read = binding.shared.read_frames.load(Ordering::Acquire) / binding.divisor;
        let now = Instant::now();
        if read != st.last_read {
            st.last_read = read;
            st.last_change = now;
        }
        let paused = binding.shared.paused.load(Ordering::Acquire);
        // 设备按周期取数据，两次取数之间按墙钟外推，画面才不会一顿一顿
        let extra = if paused {
            0
        } else {
            let elapsed = now.duration_since(st.last_change).as_secs_f64();
            ((elapsed * f64::from(binding.rate)) as u64).min(binding.latency_frames)
        };
        let written = binding.shared.written_frames.load(Ordering::Acquire) / binding.divisor;
        let playhead = (read + extra)
            .min(written)
            .saturating_sub(binding.latency_frames);

        if paused && st.last_emitted == Some(playhead) {
            return false;
        }
        st.last_emitted = Some(playhead);
        let analysis_head =
            (u128::from(playhead) * u128::from(st.analysis_rate) / u128::from(binding.rate)) as u64;
        st.analyzer.compute(analysis_head, out);
        true
    }
}

/// Bounded stereo copy for the FFT/history, independent of the audio producer's
/// quantization. Filtering avoids ultrasonic aliases in meters and visualizers.
struct AnalysisResampler {
    fft: FftFixedInOut<f64>,
    input: Vec<Vec<f64>>,
    output: Vec<Vec<f64>>,
    interleaved: Vec<f64>,
    used: usize,
    delay: usize,
    expected: Option<u64>,
    emitted: u64,
    rate: u32,
}
impl AnalysisResampler {
    fn new(rate: u32) -> Option<Self> {
        if rate <= 96_000 {
            return None;
        }
        let chunk = ((u64::from(rate) * 1024 / 96_000) as usize).clamp(2048, 65536);
        let fft = crate::resample::fft_for_rates(rate, 96_000, chunk, 2).ok()?;
        Some(Self {
            input: fft.input_buffer_allocate(true),
            output: fft.output_buffer_allocate(true),
            delay: fft.output_delay(),
            fft,
            interleaved: Vec::new(),
            used: 0,
            expected: None,
            emitted: 0,
            rate,
        })
    }
    fn push(&mut self, start: u64, samples: &[f64], channels: usize, analyzer: &mut Analyzer) {
        if channels == 0 {
            return;
        }
        if self.expected != Some(start) {
            self.fft.reset();
            self.used = 0;
            self.delay = self.fft.output_delay();
            self.emitted = (u128::from(start) * 96_000 / u128::from(self.rate)) as u64;
            analyzer.reset();
        }
        self.expected = Some(start + (samples.len() / channels) as u64);
        for frame in samples.chunks_exact(channels) {
            for c in 0..2 {
                let value = frame[c.min(channels - 1)];
                self.input[c][self.used] = if value.is_finite() { value } else { 0. };
            }
            self.used += 1;
            if self.used == self.fft.input_frames_next() {
                let produced =
                    match self
                        .fft
                        .process_into_buffer(&self.input, &mut self.output, None)
                    {
                        Ok((_, n)) => n,
                        Err(e) => {
                            tracing::warn!("可视化抽样失败: {e}");
                            self.used = 0;
                            continue;
                        }
                    };
                let skip = self.delay.min(produced);
                self.delay -= skip;
                self.interleaved.clear();
                for i in skip..produced {
                    self.interleaved
                        .extend([self.output[0][i], self.output[1][i]]);
                }
                analyzer.push(self.emitted, &self.interleaved, 2);
                self.emitted += (produced - skip) as u64;
                self.used = 0;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_megahertz_audio_keeps_audible_history_and_correct_meter_time() {
        let rate = 6_144_000u32;
        let shared = Arc::new(RingShared::default());
        shared.started.store(true, Ordering::Release);
        shared.paused.store(true, Ordering::Release);
        let tap = VizTap::new();
        tap.bind(shared.clone(), 0, rate, 1);
        let original: Vec<f64> = (0..16_384)
            .flat_map(|i| {
                let phase = std::f64::consts::TAU * i as f64 / f64::from(rate);
                [
                    (phase * 1500.).sin() * 0.5 + (phase * 768000.).sin() * 0.25,
                    (phase * 1500.).sin() * 0.25,
                ]
            })
            .collect();
        // Exactly periodic chunks, almost 0.8 seconds of prebuffered data.
        for i in 0..300 {
            tap.push(i * 16_384, &original, 2);
        }
        shared.written_frames.store(300 * 16_384, Ordering::Release);
        shared.read_frames.store(100 * 16_384, Ordering::Release);
        let mut out = Vec::new();
        assert!(tap.frame(&mut out));
        assert_eq!(out[4], 96_000.);
        assert!(
            (out[0] - 0.5).abs() < 0.01,
            "ultrasonic alias or stale history: {}",
            out[0]
        );
        assert!((out[2] - 0.5 / 2f32.sqrt()).abs() < 0.01);
        assert!((out[3] - 0.25 / 2f32.sqrt()).abs() < 0.01);
        // A discontinuous seek discards old analysis, even at a large absolute offset.
        tap.push(u64::from(rate) * 60, &vec![0.; 16_384 * 2], 2);
        shared
            .read_frames
            .store(u64::from(rate) * 60, Ordering::Release);
        shared
            .written_frames
            .store(u64::from(rate) * 60 + 16_384, Ordering::Release);
        assert!(tap.frame(&mut out));
        assert_eq!(out[0], 0.);
    }
}

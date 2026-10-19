//! 可视化取样点：生产者把解码后的样本推进来，前端按需拉取“此刻正在听到的那一帧”的分析结果。

use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Instant;

use jap_analysis::Analyzer;
use parking_lot::Mutex;

use crate::ring::RingShared;

struct Binding {
    shared: Arc<RingShared>,
    latency_frames: u64,
    rate: u32,
    divisor: u64,
}

struct State {
    analyzer: Analyzer,
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
        st.analyzer.set_rate(rate);
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
        self.state
            .lock()
            .analyzer
            .push(start_frame, samples, channels);
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
        st.analyzer.compute(playhead, out);
        true
    }
}

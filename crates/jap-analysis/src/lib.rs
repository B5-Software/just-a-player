//! 实时音频分析：把播放头附近的一小段音频变成频谱、电平、波形与立体声相位点。
//!
//! 输出是一块定长的 `f32` 帧，布局与前端 `src/shared/viz.ts` 一一对应：
//!
//! | 区段 | 长度 | 内容 |
//! |------|------|------|
//! | 头部 | `HEADER_LEN` | peakL, peakR, rmsL, rmsR, sampleRate, 预留 x3 |
//! | 频谱 | `BANDS` | 对数频率分带，0..1（已按 3 dB/oct 倾斜补偿） |
//! | 波形 | `WAVE_LEN` | 最近一小段单声道波形，-1..1 |
//! | 相位 | `GONIO_POINTS * 2` | 立体声 (L, R) 点对，-1..1 |

use std::sync::Arc;
pub mod quality;

use realfft::num_complex::Complex;
use realfft::{RealFftPlanner, RealToComplex};

pub const BANDS: usize = 128;
pub const WAVE_LEN: usize = 256;
pub const GONIO_POINTS: usize = 128;
pub const HEADER_LEN: usize = 8;
pub const FRAME_LEN: usize = HEADER_LEN + BANDS + WAVE_LEN + GONIO_POINTS * 2;

pub const FFT_SIZE: usize = 4096;
/// 约 3 秒（44.1 kHz）的历史，远大于环形缓冲里“尚未播出”的那一段。
const HISTORY: usize = 1 << 17;
const FREQ_MIN: f32 = 25.0;
const FREQ_MAX: f32 = 20_000.0;
const DB_FLOOR: f32 = -90.0;
const DB_CEIL: f32 = -6.0;
/// 以 1 kHz 为轴的倾斜补偿，避免高频总是“空”的。
const TILT_DB_PER_OCTAVE: f32 = 3.0;
const LEVEL_WINDOW: usize = 1024;

pub struct Analyzer {
    history: Vec<[f32; 2]>,
    /// 最新一帧的下一个序号。
    end: u64,
    rate: u32,
    fft: Arc<dyn RealToComplex<f32>>,
    window: Vec<f32>,
    window_sum: f32,
    input: Vec<f32>,
    spectrum: Vec<Complex<f32>>,
    scratch: Vec<Complex<f32>>,
    bands: Vec<BandSpan>,
}

#[derive(Clone, Copy, Default)]
struct BandSpan {
    center_bin: f32,
    lo: usize,
    hi: usize,
    tilt_db: f32,
    valid: bool,
}

impl Default for Analyzer {
    fn default() -> Self {
        Self::new()
    }
}

impl Analyzer {
    pub fn new() -> Self {
        let fft = RealFftPlanner::<f32>::new().plan_fft_forward(FFT_SIZE);
        let window: Vec<f32> = (0..FFT_SIZE)
            .map(|i| 0.5 - 0.5 * (2.0 * std::f32::consts::PI * i as f32 / FFT_SIZE as f32).cos())
            .collect();
        let window_sum = window.iter().sum();
        let mut analyzer = Self {
            history: vec![[0.0; 2]; HISTORY],
            end: 0,
            rate: 44_100,
            input: fft.make_input_vec(),
            spectrum: fft.make_output_vec(),
            scratch: fft.make_scratch_vec(),
            fft,
            window,
            window_sum,
            bands: Vec::new(),
        };
        analyzer.set_rate(44_100);
        analyzer
    }

    /// 采样率改变时重算每个频带对应的 FFT 区间。
    pub fn set_rate(&mut self, rate: u32) {
        self.rate = rate.max(8_000);
        let nyquist = self.rate as f32 / 2.0;
        let bin_hz = self.rate as f32 / FFT_SIZE as f32;
        let ratio = FREQ_MAX / FREQ_MIN;

        self.bands = (0..BANDS)
            .map(|i| {
                let f_lo = FREQ_MIN * ratio.powf(i as f32 / BANDS as f32);
                let f_hi = FREQ_MIN * ratio.powf((i + 1) as f32 / BANDS as f32);
                let center = (f_lo * f_hi).sqrt();
                let lo = (f_lo / bin_hz).floor() as usize;
                let hi = ((f_hi.min(nyquist) / bin_hz).ceil() as usize).max(lo + 1);
                BandSpan {
                    center_bin: center / bin_hz,
                    lo,
                    hi: hi.min(FFT_SIZE / 2 + 1),
                    tilt_db: TILT_DB_PER_OCTAVE * (center / 1000.0).log2(),
                    valid: f_lo < nyquist,
                }
            })
            .collect();
    }

    /// 重置分析器状态（清空历史样本与帧指针），在会话重建或重新播放时调用。
    pub fn reset(&mut self) {
        self.history.fill([0.0; 2]);
        self.end = 0;
    }

    /// 记录一块刚解码好的音频。`start_frame` 是它在整条播放时间线上的帧序号，
    /// `interleaved` 的前两个声道视为左右，单声道则左右相同。
    pub fn push(&mut self, start_frame: u64, interleaved: &[f64], channels: usize) {
        if channels == 0 {
            return;
        }
        let frames = interleaved.len() / channels;
        // 如果新到达的数据帧序号大幅落后于当前 end（比如重新起播或倒回跳转），
        // 必须重置 end，否则旧的 end 会导致新数据被当作过期样本而丢弃。
        if start_frame < self.end.saturating_sub(HISTORY as u64) {
            self.history.fill([0.0; 2]);
            self.end = start_frame + frames as u64;
        } else {
            self.end = self.end.max(start_frame + frames as u64);
        }
        for i in 0..frames {
            let l = interleaved[i * channels] as f32;
            let r = if channels > 1 {
                interleaved[i * channels + 1] as f32
            } else {
                l
            };
            self.history[((start_frame + i as u64) as usize) & (HISTORY - 1)] = [l, r];
        }
    }

    fn frame_at(&self, frame: i64) -> [f32; 2] {
        let oldest = self.end.saturating_sub(HISTORY as u64) as i64;
        if frame < 0 || frame < oldest || frame as u64 >= self.end {
            return [0.0; 2];
        }
        self.history[(frame as usize) & (HISTORY - 1)]
    }

    /// 以 `playhead`（正在被听到的那一帧）为窗口末端，填满一整块 `FRAME_LEN` 的输出。
    pub fn compute(&mut self, playhead: u64, out: &mut Vec<f32>) {
        out.clear();
        out.resize(FRAME_LEN, 0.0);
        let p = playhead.min(self.end) as i64;

        let (mut peak, mut sum_sq) = ([0.0f32; 2], [0.0f32; 2]);
        for k in 1..=LEVEL_WINDOW as i64 {
            let s = self.frame_at(p - k);
            for c in 0..2 {
                peak[c] = peak[c].max(s[c].abs());
                sum_sq[c] += s[c] * s[c];
            }
        }
        out[0] = peak[0];
        out[1] = peak[1];
        out[2] = (sum_sq[0] / LEVEL_WINDOW as f32).sqrt();
        out[3] = (sum_sq[1] / LEVEL_WINDOW as f32).sqrt();
        out[4] = self.rate as f32;

        for i in 0..FFT_SIZE {
            let s = self.frame_at(p - FFT_SIZE as i64 + i as i64);
            self.input[i] = (s[0] + s[1]) * 0.5 * self.window[i];
        }
        let _ =
            self.fft
                .process_with_scratch(&mut self.input, &mut self.spectrum, &mut self.scratch);

        let norm = 2.0 / self.window_sum;
        let mag = |k: usize| self.spectrum.get(k).map_or(0.0, |c| c.norm() * norm);
        let spectrum_out = &mut out[HEADER_LEN..HEADER_LEN + BANDS];
        for (band, slot) in self.bands.iter().zip(spectrum_out.iter_mut()) {
            if !band.valid {
                continue;
            }
            let m = if band.hi - band.lo <= 1 {
                // 比一个 bin 还窄的低频带：在相邻 bin 之间插值，避免低频出现一格一格的台阶
                let base = band.center_bin.floor();
                let frac = band.center_bin - base;
                let k = base as usize;
                mag(k) * (1.0 - frac) + mag(k + 1) * frac
            } else {
                let power: f32 = (band.lo..band.hi).map(|k| mag(k).powi(2)).sum();
                (power / (band.hi - band.lo) as f32).sqrt()
            };
            let db = 20.0 * m.max(1e-9).log10() + band.tilt_db;
            *slot = ((db - DB_FLOOR) / (DB_CEIL - DB_FLOOR)).clamp(0.0, 1.0);
        }

        let wave_start = HEADER_LEN + BANDS;
        let stride = 4i64;
        for i in 0..WAVE_LEN {
            let base = p - (WAVE_LEN as i64 - i as i64) * stride;
            let mut acc = 0.0;
            for j in 0..stride {
                let s = self.frame_at(base + j);
                acc += (s[0] + s[1]) * 0.5;
            }
            out[wave_start + i] = acc / stride as f32;
        }

        let gonio_start = wave_start + WAVE_LEN;
        for i in 0..GONIO_POINTS {
            let s = self.frame_at(p - (GONIO_POINTS as i64 - i as i64) * 3);
            out[gonio_start + i * 2] = s[0];
            out[gonio_start + i * 2 + 1] = s[1];
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine(rate: u32, hz: f64, amp: f64, frames: usize) -> Vec<f64> {
        (0..frames)
            .flat_map(|i| {
                let v = amp * (2.0 * std::f64::consts::PI * hz * i as f64 / f64::from(rate)).sin();
                [v, v]
            })
            .collect()
    }

    fn band_center(i: usize) -> f32 {
        let ratio = FREQ_MAX / FREQ_MIN;
        let lo = FREQ_MIN * ratio.powf(i as f32 / BANDS as f32);
        let hi = FREQ_MIN * ratio.powf((i + 1) as f32 / BANDS as f32);
        (lo * hi).sqrt()
    }

    #[test]
    fn frame_has_the_documented_length() {
        let mut a = Analyzer::new();
        let mut out = Vec::new();
        a.compute(0, &mut out);
        assert_eq!(out.len(), FRAME_LEN);
    }

    #[test]
    fn silence_is_flat_zero() {
        let mut a = Analyzer::new();
        a.push(0, &vec![0.0; 2 * 8192], 2);
        let mut out = Vec::new();
        a.compute(8192, &mut out);
        assert_eq!(out[4], 44_100.);
        assert!(out.iter().enumerate().all(|(i, &v)| i == 4 || v == 0.0));
    }

    #[test]
    fn a_1khz_tone_lights_up_the_1khz_band_and_reports_its_level() {
        let mut a = Analyzer::new();
        a.push(0, &sine(44_100, 1000.0, 0.5, 16_384), 2);
        let mut out = Vec::new();
        a.compute(16_384, &mut out);

        let bands = &out[HEADER_LEN..HEADER_LEN + BANDS];
        let loudest = bands
            .iter()
            .enumerate()
            .max_by(|a, b| a.1.total_cmp(b.1))
            .map(|(i, _)| i)
            .unwrap();
        let hz = band_center(loudest);
        assert!((hz - 1000.0).abs() < 90.0, "最响的频带中心是 {hz} Hz");
        assert!(
            (out[0] - 0.5).abs() < 0.01,
            "峰值应约为 0.5，实际 {}",
            out[0]
        );
        assert!((out[2] - 0.5 / 2f32.sqrt()).abs() < 0.01);
    }

    #[test]
    fn playhead_before_the_first_window_does_not_panic() {
        let mut a = Analyzer::new();
        a.push(0, &sine(48_000, 440.0, 0.3, 1000), 2);
        let mut out = Vec::new();
        a.compute(500, &mut out);
        assert_eq!(out.len(), FRAME_LEN);
    }

    #[test]
    fn mono_input_is_duplicated_to_both_channels() {
        let mut a = Analyzer::new();
        a.push(0, &vec![0.25; 4096], 1);
        let mut out = Vec::new();
        a.compute(4096, &mut out);
        assert!((out[0] - 0.25).abs() < 1e-6 && (out[1] - 0.25).abs() < 1e-6);
    }
}

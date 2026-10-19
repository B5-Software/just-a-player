use jap_core::{QualityFinding, QualityReport};
use realfft::{RealFftPlanner, RealToComplex};
use std::sync::Arc;

const N: usize = 8192;
fn db(v: f64) -> f64 {
    20. * v.max(1e-12).log10()
}

pub struct QualityAnalyzer {
    rate: u32,
    channels: usize,
    bits: Option<u32>,
    count: u64,
    frames: u64,
    dc_sums: Vec<f64>,
    sum_sq: f64,
    peak: f64,
    clipped: u32,
    runs: u32,
    run: Vec<u32>,
    used: u32,
    nonzero: u64,
    quiet: Vec<f64>,
    block_sq: f64,
    block_n: usize,
    ll: f64,
    rr: f64,
    lr: f64,
    fft: Arc<dyn RealToComplex<f64>>,
    pending: Vec<Vec<f64>>,
    power: Vec<f64>,
    windows: u32,
}

impl QualityAnalyzer {
    pub fn new(rate: u32, channels: usize, bits: Option<u32>) -> Self {
        Self {
            rate,
            channels,
            bits,
            count: 0,
            frames: 0,
            dc_sums: vec![0.; channels],
            sum_sq: 0.,
            peak: 0.,
            clipped: 0,
            runs: 0,
            run: vec![0; channels],
            used: 0,
            nonzero: 0,
            quiet: Vec::new(),
            block_sq: 0.,
            block_n: 0,
            ll: 0.,
            rr: 0.,
            lr: 0.,
            fft: RealFftPlanner::new().plan_fft_forward(N),
            pending: vec![Vec::with_capacity(N); channels.min(2)],
            power: vec![0.; N / 2 + 1],
            windows: 0,
        }
    }
    pub fn begin_segment(&mut self) {
        for p in &mut self.pending {
            p.clear();
        }
        self.run.fill(0);
        self.block_sq = 0.;
        self.block_n = 0;
    }
    pub fn push(&mut self, samples: &[f64]) {
        let threshold = 1. - 1.5 * 2f64.powi(1 - self.bits.unwrap_or(24).min(32) as i32);
        for frame in samples.chunks_exact(self.channels) {
            self.frames += 1;
            for (ch, &sample) in frame.iter().enumerate() {
                let x = if sample.is_finite() { sample } else { 0. };
                self.count += 1;
                self.dc_sums[ch] += x;
                self.sum_sq += x * x;
                self.peak = self.peak.max(x.abs());
                self.block_sq += x * x;
                self.block_n += 1;
                if x.abs() >= threshold {
                    self.clipped = self.clipped.saturating_add(1);
                    self.run[ch] += 1;
                    if self.run[ch] == 3 {
                        self.runs += 1;
                    }
                } else {
                    self.run[ch] = 0;
                }
                if self.bits.is_some() && x != 0. {
                    let value = (x * 2147483648.)
                        .round()
                        .clamp(i32::MIN as f64, i32::MAX as f64)
                        as i32;
                    self.used |= value as u32;
                    self.nonzero += 1;
                }
                if ch < self.pending.len() {
                    self.pending[ch].push(x);
                }
            }
            let finite = |v: f64| if v.is_finite() { v } else { 0. };
            let l = finite(frame[0]);
            let r = finite(*frame.get(1).unwrap_or(&l));
            self.ll += l * l;
            self.rr += r * r;
            self.lr += l * r;
            if self.block_n >= (self.rate as usize / 10).max(1) * self.channels {
                self.quiet
                    .push((self.block_sq / self.block_n as f64).sqrt());
                self.block_sq = 0.;
                self.block_n = 0;
            }
            if self.pending[0].len() == N {
                // Separate channel FFTs avoid falsely declaring anti-phase audio silent.
                for p in &mut self.pending {
                    for (i, x) in p.iter_mut().enumerate() {
                        *x *= 0.5 - 0.5 * (2. * std::f64::consts::PI * i as f64 / N as f64).cos();
                    }
                    let mut spectrum = self.fft.make_output_vec();
                    if self.fft.process(p, &mut spectrum).is_ok() {
                        for (sum, v) in self.power.iter_mut().zip(spectrum) {
                            *sum += v.norm_sqr();
                        }
                        self.windows += 1;
                    }
                    p.clear();
                }
            }
        }
    }
    pub fn finish(mut self, path: String) -> QualityReport {
        let count = self.count.max(1) as f64;
        let rms = (self.sum_sq / count).sqrt();
        let dc_offset = self
            .dc_sums
            .iter()
            .map(|sum| sum / self.frames.max(1) as f64)
            .max_by(|a, b| a.abs().total_cmp(&b.abs()))
            .unwrap_or(0.);
        self.quiet.sort_by(f64::total_cmp);
        let quiet = self
            .quiet
            .get(self.quiet.len() / 10)
            .copied()
            .unwrap_or(rms);
        let effective = if self.nonzero >= 1024 && self.used != 0 {
            Some(32 - self.used.trailing_zeros())
        } else {
            None
        };
        let total: f64 = self.power.iter().skip(1).sum();
        let mut cumulative = 0.;
        let mut bandwidth = 0.;
        for (i, &p) in self.power.iter().enumerate().skip(1) {
            cumulative += p;
            if total > 1e-20 && cumulative >= total * 0.9999 {
                bandwidth = i as f64 * f64::from(self.rate) / N as f64;
                break;
            }
        }
        let boundary = (20000. * N as f64 / f64::from(self.rate)) as usize;
        let high: f64 = self.power.iter().skip(boundary).sum();
        let high_db = 10. * (high / total.max(1e-30)).max(1e-24).log10();
        let low_bin = (80. * N as f64 / f64::from(self.rate)).ceil() as usize;
        let high_bin = (18000. * N as f64 / f64::from(self.rate)).floor() as usize;
        let bins = &self.power[low_bin.min(self.power.len())
            ..high_bin
                .min(self.power.len())
                .max(low_bin.min(self.power.len()))];
        let flatness = if !bins.is_empty() && total > 1e-12 {
            (bins.iter().map(|v| v.max(1e-30).ln()).sum::<f64>() / bins.len() as f64).exp()
                / (bins.iter().sum::<f64>() / bins.len() as f64).max(1e-30)
        } else {
            0.
        };
        let line_db = |hz: f64| {
            let k = (hz * N as f64 / f64::from(self.rate)).round() as usize;
            if k < 6 || k + 7 >= self.power.len() {
                return -240.;
            }
            let peak: f64 = self.power[k - 1..=k + 1].iter().sum::<f64>() / 3.;
            let local = self.power[k - 6..k - 3]
                .iter()
                .chain(self.power[k + 4..k + 7].iter())
                .sum::<f64>()
                / 6.;
            10. * (peak / local.max(total * 1e-12)).max(1e-24).log10()
        };
        let hum = [50., 60.]
            .into_iter()
            .find(|&hz| line_db(hz) > 18. && line_db(hz * 2.) > 12.);
        let mut findings = Vec::new();
        let mut add = |title: &str, detail: String, severity: &str, confidence: &str| {
            findings.push(QualityFinding {
                title: title.into(),
                detail,
                severity: severity.into(),
                confidence: confidence.into(),
            })
        };
        if self.frames < u64::from(self.rate) {
            add(
                "样本不足",
                "少于 1 秒，无法稳定评估音源。".into(),
                "info",
                "low",
            );
        }
        if self.runs > 0 {
            add(
                "疑似硬削波",
                format!(
                    "发现 {} 段连续至少 3 个满幅样本；需结合波形区分刻意失真和制作削波。",
                    self.runs
                ),
                "warning",
                "medium",
            );
        } else if self.clipped > 0 {
            add(
                "触及满幅",
                format!(
                    "{} 个样本接近 0 dBFS；单独的峰值不能证明削波。",
                    self.clipped
                ),
                "info",
                "medium",
            );
        }
        if dc_offset.abs() > 0.001 {
            add(
                "直流偏移",
                format!("平均偏移 {:.4}% FS，可能压缩有效余量。", dc_offset * 100.),
                "warning",
                "high",
            );
        }
        if let (Some(declared), Some(actual)) = (self.bits, effective)
            && actual < declared
        {
            add(
                "位深填充迹象",
                format!(
                    "标称 {declared} 位，抽样中只有 {actual} 个有效整数位；低位恒零说明填充，不代表录音动态范围。"
                ),
                "warning",
                "high",
            );
        }
        if self.rate > 48000 && total > 1e-12 && high_db < -70. {
            add(
                "疑似低带宽或升频来源",
                format!(
                    "标称 {} Hz，但 20 kHz 以上能量比为 {:.1} dB，99.99% 能量位于 {:.0} Hz 以下。自然乐器、母带低通也会产生这种结果。",
                    self.rate, high_db, bandwidth
                ),
                "info",
                "low",
            );
        }
        if db(quiet) > -55. && db(quiet) < db(rms) - 18. {
            add(
                "安静片段存在底噪候选",
                format!(
                    "最安静 10% 的 100 ms 窗口约 {:.1} dBFS；可能含混响或乐器尾音，不能当作设备噪声测量。",
                    db(quiet)
                ),
                "info",
                "low",
            );
        }
        if flatness > 0.55 && db(rms) > -85. {
            add(
                "宽带噪声特征",
                format!(
                    "80 Hz–18 kHz 平均频谱平坦度 {:.2}，接近宽带噪声；打击乐、雨声等内容也会符合，需结合安静片段试听。",
                    flatness
                ),
                "info",
                "low",
            );
        }
        if let Some(hz) = hum {
            add(
                "工频嗡声候选",
                format!(
                    "{hz:.0} Hz 与其二次谐波相对附近频带有突出窄峰。低音乐器也可能产生这些频率，不能单独据此认定电气噪声。"
                ),
                "info",
                "low",
            );
        }
        if rms > 1e-9 && db(self.peak) - db(rms) < 6. {
            add(
                "动态余量较小",
                "峰均比低于 6 dB，可能经过较强压限；此值不是 LUFS 或 EBU 动态范围。".into(),
                "info",
                "medium",
            );
        }
        add("来源鉴别范围", "频谱和有效位能发现部分填充、低通和升频迹象；加抖、重采样或 AI 重建可掩盖这些痕迹，无法仅凭成品音频证明真实录制采样率或是否经过 AI。".into(), "info", "high");
        // Integrity score v1: bounded, transparent penalties for measured defects.
        // Low-confidence bandwidth/AI/noise hypotheses do not reduce this score.
        let clipping = if self.runs > 0 {
            (10. + 5. * f64::from(self.runs).log10() + 500. * f64::from(self.clipped) / count)
                .min(40.)
        } else {
            0.
        };
        let dc = ((dc_offset.abs() - 0.001).max(0.) * 1000.).min(20.);
        let padding = match (self.bits, effective) {
            (Some(d), Some(a)) if a < d => (f64::from(d - a) * 1.25).min(10.),
            _ => 0.,
        };
        let overflow = if self.peak > 1. { 20. } else { 0. };
        let score = if self.frames >= u64::from(self.rate) && rms > 1e-9 {
            Some(
                (100. - clipping - dc - padding - overflow)
                    .clamp(0., 100.)
                    .round() as u32,
            )
        } else {
            None
        };
        let score_explanation = format!(
            "技术完整性 v1 · 100 − 削波 {clipping:.1} − DC {dc:.1} − 位深填充 {padding:.1} − 超幅 {overflow:.1}。低置信噪声、低通或 AI 猜测不扣分；静音/不足 1 秒不评分。"
        );
        QualityReport {
            path,
            score,
            score_explanation,
            analyzed_seconds: self.frames as f64 / f64::from(self.rate),
            coverage: String::new(),
            peak_dbfs: db(self.peak),
            rms_dbfs: db(rms),
            crest_db: db(self.peak) - db(rms),
            clipped_samples: self.clipped,
            clipped_runs: self.runs,
            dc_offset,
            quiet_rms_dbfs: db(quiet),
            effective_bits: effective,
            occupied_bandwidth_hz: bandwidth,
            high_band_db: high_db,
            stereo_correlation: (self.lr / (self.ll * self.rr).sqrt().max(1e-30)).clamp(-1., 1.),
            findings,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn opposite_channel_dc_offsets_do_not_cancel_and_nonfinite_is_ignored() {
        let mut a = QualityAnalyzer::new(48000, 2, None);
        a.push(&[f64::NAN, f64::INFINITY]);
        a.push(&[0.01, -0.01].repeat(48000));
        let r = a.finish("test".into());
        assert!(r.dc_offset.abs() > 0.009);
        assert!(r.stereo_correlation.is_finite());
        assert!(r.findings.iter().any(|f| f.title == "直流偏移"));
    }
    #[test]
    fn broadband_noise_is_identified_as_a_candidate() {
        let mut a = QualityAnalyzer::new(48000, 2, None);
        let mut seed = 0x12345678u32;
        let data: Vec<_> = (0..96000)
            .map(|_| {
                seed ^= seed << 13;
                seed ^= seed >> 17;
                seed ^= seed << 5;
                (seed as f64 / u32::MAX as f64 - 0.5) * 0.02
            })
            .collect();
        a.push(&data);
        let r = a.finish("test".into());
        assert!(r.findings.iter().any(|f| f.title == "宽带噪声特征"));
    }
    #[test]
    fn detects_padded_depth_and_clipping() {
        let mut a = QualityAnalyzer::new(48000, 2, Some(24));
        let samples: Vec<f64> = (0..48000)
            .flat_map(|i| {
                let v = if i % 100 < 4 {
                    -1.
                } else {
                    ((i as f64 * 0.1).sin() * 10000.).round() / 32768.
                };
                [v, v]
            })
            .collect();
        a.push(&samples);
        let report = a.finish("test".into());
        assert_eq!(report.effective_bits, Some(16));
        assert!(report.clipped_runs > 0);
    }
    #[test]
    fn antiphase_is_not_mistaken_for_silence() {
        let mut a = QualityAnalyzer::new(96000, 2, Some(24));
        let samples: Vec<f64> = (0..96000)
            .flat_map(|i| {
                let x = (i as f64 * 2. * std::f64::consts::PI * 24000. / 96000.).sin() * 0.5;
                [x, -x]
            })
            .collect();
        a.push(&samples);
        let r = a.finish("test".into());
        assert!(r.occupied_bandwidth_hz > 23000.);
        assert!(r.stereo_correlation < -0.99);
    }
}

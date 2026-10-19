//! 64-bit RBJ peaking EQ, channel controls and stereo-linked peak limiter.
use jap_core::DspConfig;

pub const EQ_HZ: [f64; 10] = [
    31.25, 62.5, 125., 250., 500., 1000., 2000., 4000., 8000., 16000.,
];

#[derive(Clone)]
struct Biquad {
    b: [f64; 3],
    a: [f64; 2],
    z: Vec<[f64; 2]>,
}

impl Biquad {
    fn peak(hz: f64, db: f64, rate: u32, channels: usize) -> Self {
        let a = 10f64.powf(db / 40.);
        let w = 2. * std::f64::consts::PI * hz.min(f64::from(rate) * 0.45) / f64::from(rate);
        let alpha = w.sin() / (2. * 1.4);
        let a0 = 1. + alpha / a;
        Self {
            b: [
                (1. + alpha * a) / a0,
                -2. * w.cos() / a0,
                (1. - alpha * a) / a0,
            ],
            a: [-2. * w.cos() / a0, (1. - alpha / a) / a0],
            z: vec![[0.; 2]; channels],
        }
    }
    fn tick(&mut self, x: f64, ch: usize) -> f64 {
        let z = &mut self.z[ch];
        let y = self.b[0] * x + z[0];
        z[0] = self.b[1] * x - self.a[0] * y + z[1];
        z[1] = self.b[2] * x - self.a[1] * y;
        y
    }
}

#[derive(Clone)]
struct Chain {
    config: DspConfig,
    filters: Vec<Biquad>,
    low: [f64; 2],
    low_k: f64,
    limiter_gain: f64,
    release: f64,
}
impl Chain {
    fn new(config: DspConfig, rate: u32, channels: usize) -> Self {
        let filters = EQ_HZ
            .iter()
            .zip(config.eq_db)
            .filter(|(_, db)| db.abs() > 1e-9)
            .map(|(&hz, db)| Biquad::peak(hz, db, rate, channels))
            .collect();
        Self {
            config,
            filters,
            low: [0.; 2],
            low_k: 1. - (-2. * std::f64::consts::PI * 700. / f64::from(rate)).exp(),
            limiter_gain: 1.,
            release: 1. - (-1. / (0.08 * f64::from(rate))).exp(),
        }
    }
    fn frame(&mut self, frame: &mut [f64]) {
        let c = &self.config;
        if !c.enabled {
            return;
        }
        let gain = 10f64.powf(c.preamp_db / 20.);
        for (ch, x) in frame.iter_mut().enumerate() {
            *x = if x.is_finite() { *x * gain } else { 0. };
            for filter in &mut self.filters {
                *x = filter.tick(*x, ch);
            }
        }
        if frame.len() == 2 {
            let (l, r) = (frame[0], frame[1]);
            self.low[0] += self.low_k * (l - self.low[0]);
            self.low[1] += self.low_k * (r - self.low[1]);
            let mid = (l + r) * 0.5;
            let side = (l - r) * 0.5 * c.stereo_width;
            frame[0] = (mid + side + c.crossfeed * self.low[1] * 0.35) / (1. + c.crossfeed * 0.35)
                * (1. - c.balance.max(0.));
            frame[1] = (mid - side + c.crossfeed * self.low[0] * 0.35) / (1. + c.crossfeed * 0.35)
                * (1. + c.balance.min(0.));
        }
        if c.limiter {
            let peak = frame.iter().fold(0f64, |p, x| p.max(x.abs()));
            let target = (0.98 / peak.max(0.98)).min(1.);
            self.limiter_gain = if target < self.limiter_gain {
                target
            } else {
                self.limiter_gain + (target - self.limiter_gain) * self.release
            };
            for x in frame {
                *x *= self.limiter_gain;
            }
        }
    }
}

pub struct Dsp {
    chain: Chain,
    previous: Option<Chain>,
    fade: usize,
    fade_len: usize,
    rate: u32,
    channels: usize,
    scratch: Vec<f64>,
}
impl Dsp {
    pub fn new(rate: u32, channels: usize) -> Self {
        Self {
            chain: Chain::new(DspConfig::default(), rate, channels),
            previous: None,
            fade: 0,
            fade_len: (rate as usize / 50).max(1),
            rate,
            channels,
            scratch: vec![0.; channels],
        }
    }
    pub fn process(&mut self, samples: &mut [f64], config: &DspConfig) {
        if self.chain.config != *config {
            self.previous = Some(self.chain.clone());
            self.chain = Chain::new(config.clone(), self.rate, self.channels);
            self.fade = self.fade_len;
        }
        for frame in samples.chunks_exact_mut(self.channels) {
            if self.fade > 0 {
                self.scratch.copy_from_slice(frame);
                self.previous.as_mut().unwrap().frame(&mut self.scratch);
            }
            self.chain.frame(frame);
            if self.fade > 0 {
                let mix = 1. - self.fade as f64 / self.fade_len as f64;
                for (x, old) in frame.iter_mut().zip(&self.scratch) {
                    *x = *old + (*x - *old) * mix;
                }
                self.fade -= 1;
                if self.fade == 0 {
                    self.previous = None;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bypass_is_bit_exact() {
        let mut dsp = Dsp::new(48000, 2);
        let mut data = vec![0.125, -0.75, 0., 0.999];
        let original = data.clone();
        dsp.process(&mut data, &DspConfig::default());
        assert_eq!(data, original);
    }
    #[test]
    fn preamp_and_limiter_actually_change_audio() {
        let mut dsp = Dsp::new(48000, 2);
        let c = DspConfig {
            enabled: true,
            preamp_db: -6.,
            ..Default::default()
        };
        let mut data = vec![0.5; 4800];
        dsp.process(&mut data, &c);
        assert!((data[4799] - 0.2505936).abs() < 1e-6);
        let c = DspConfig {
            preamp_db: 12.,
            ..c
        };
        let mut data = vec![0.9; 4800];
        dsp.process(&mut data, &c);
        assert!(data[2000..].iter().all(|v| v.abs() <= 0.98000001));
    }
    #[test]
    fn eq_boosts_its_center_frequency() {
        let mut dsp = Dsp::new(48000, 2);
        let mut c = DspConfig {
            enabled: true,
            preamp_db: 0.,
            limiter: false,
            ..Default::default()
        };
        c.eq_db[5] = 6.;
        let mut data: Vec<f64> = (0..48000)
            .flat_map(|i| {
                let x = 0.1 * (i as f64 * 2. * std::f64::consts::PI * 1000. / 48000.).sin();
                [x, x]
            })
            .collect();
        dsp.process(&mut data, &c);
        let rms = (data[48000..].iter().map(|x| x * x).sum::<f64>() / 48000.).sqrt();
        assert!((rms - 0.1 * 10f64.powf(6. / 20.) / 2f64.sqrt()).abs() < 0.001);
    }
}

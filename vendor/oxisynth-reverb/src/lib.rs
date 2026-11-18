// Based on oxisynth-reverb 0.1.0 (LGPL-2.1), with sample-rate-aware timing.
const DC_OFFSET: f32 = 1e-8;
const STEREO_SPREAD: usize = 23;

// Delay lengths from the upstream Freeverb tuning at 44.1 kHz.
const TUNING_RATE: f32 = 44_100.0;
const COMB_DELAYS: [usize; 8] = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
const ALLPASS_DELAYS: [usize; 4] = [556, 441, 341, 225];

#[derive(Clone)]
struct Comb {
    feedback: f32,
    filterstore: f32,
    damp1: f32,
    damp2: f32,
    buffer: Vec<f32>,
    bufidx: usize,
}

impl Comb {
    fn new(size: usize) -> Self {
        Self {
            feedback: 0f32,
            filterstore: 0f32,
            damp1: 0f32,
            damp2: 0f32,
            buffer: vec![DC_OFFSET; size],
            bufidx: 0,
        }
    }

    fn set_damp(&mut self, val: f32) {
        self.damp1 = val;
        self.damp2 = 1f32 - val;
    }

    fn set_feedback(&mut self, val: f32) {
        self.feedback = val;
    }

    fn process(&mut self, input: f32) -> f32 {
        let mut _tmp = self.buffer[self.bufidx];
        self.filterstore = _tmp * self.damp2 + self.filterstore * self.damp1;
        self.buffer[self.bufidx] = input + self.filterstore * self.feedback;
        self.bufidx += 1;
        if self.bufidx >= self.buffer.len() {
            self.bufidx = 0
        }
        _tmp
    }
}

#[derive(Clone)]
struct AllPass {
    feedback: f32,
    buffer: Vec<f32>,
    bufidx: usize,
}

impl AllPass {
    fn new(size: usize, feedback: f32) -> Self {
        Self {
            feedback,
            buffer: vec![DC_OFFSET; size],
            bufidx: 0,
        }
    }

    fn process(&mut self, input: f32) -> f32 {
        let bufout: f32 = self.buffer[self.bufidx];
        let output: f32 = bufout - input;
        self.buffer[self.bufidx] = input + bufout * self.feedback;
        self.bufidx += 1;
        if self.bufidx >= self.buffer.len() {
            self.bufidx = 0
        }
        output
    }
}

#[derive(Clone)]
struct LRPair<T> {
    l: T,
    r: T,
}

#[derive(Clone)]
pub struct Reverb {
    roomsize: f32,
    damp: f32,
    wet: f32,
    wet1: f32,
    wet2: f32,
    width: f32,
    gain: f32,
    rate_ratio: f32,
    comb: [LRPair<Comb>; 8],
    allpass: [LRPair<AllPass>; 4],
}

impl Default for Reverb {
    fn default() -> Self {
        Self::new()
    }
}

impl Reverb {
    pub fn new() -> Self {
        Self::with_sample_rate(TUNING_RATE)
    }

    pub fn with_sample_rate(sample_rate: f32) -> Self {
        let rate_ratio = sample_rate / TUNING_RATE;
        let delay = |samples| ((samples as f32 * rate_ratio).round() as usize).max(1);
        let mut rev = Self {
            roomsize: 0.5 * 0.28 + 0.7,
            damp: 0.2 * 1.0,
            wet: 1.0 * 3.0,
            wet1: 0.0,
            wet2: 0.0,
            width: 1.0,
            gain: 0.015,
            rate_ratio,
            comb: COMB_DELAYS.map(|n| LRPair {
                l: Comb::new(delay(n)),
                r: Comb::new(delay(n + STEREO_SPREAD)),
            }),
            allpass: ALLPASS_DELAYS.map(|n| LRPair {
                l: AllPass::new(delay(n), 0.5),
                r: AllPass::new(delay(n + STEREO_SPREAD), 0.5),
            }),
        };
        rev.set_params(&Default::default());
        rev
    }

    pub fn reset(&mut self) {
        for pair in &mut self.comb {
            for comb in [&mut pair.l, &mut pair.r] {
                comb.buffer.fill(DC_OFFSET);
                comb.bufidx = 0;
                comb.filterstore = 0.0;
            }
        }
        for pair in &mut self.allpass {
            for allpass in [&mut pair.l, &mut pair.r] {
                allpass.buffer.fill(DC_OFFSET);
                allpass.bufidx = 0;
            }
        }
    }

    pub fn process_replace(&mut self, left_out: &mut [f32; 64], right_out: &mut [f32; 64]) {
        for k in 0..64 {
            let mut out_r = 0f32;
            let mut out_l = 0f32;

            // Don't ask me why only left buf is considered an input...
            let input = (2.0 * left_out[k] + DC_OFFSET) * self.gain;

            for comb in self.comb.iter_mut() {
                out_l += comb.l.process(input);
                out_r += comb.r.process(input);
            }

            for allpass in self.allpass.iter_mut() {
                out_l = allpass.l.process(out_l);
                out_r = allpass.r.process(out_r);
            }

            out_l -= DC_OFFSET;
            out_r -= DC_OFFSET;

            left_out[k] = out_l * self.wet1 + out_r * self.wet2;
            right_out[k] = out_r * self.wet1 + out_l * self.wet2;
        }
    }

    pub fn process_mix(
        &mut self,
        in_0: &mut [f32; 64],
        left_out: &mut [f32; 64],
        right_out: &mut [f32; 64],
    ) {
        for k in 0..64 {
            let mut out_r = 0f32;
            let mut out_l = out_r;
            let input = (2.0 * in_0[k] + DC_OFFSET) * self.gain;

            for comb in self.comb.iter_mut() {
                out_l += comb.l.process(input);
                out_r += comb.r.process(input);
            }

            for allpass in self.allpass.iter_mut() {
                out_l = allpass.l.process(out_l);
                out_r = allpass.r.process(out_r);
            }

            out_l -= DC_OFFSET;
            out_r -= DC_OFFSET;

            left_out[k] += out_l * self.wet1 + out_r * self.wet2;
            right_out[k] += out_r * self.wet1 + out_l * self.wet2;
        }
    }

    fn update(&mut self) {
        self.wet1 = self.wet * (self.width / 2f32 + 0.5f32);
        self.wet2 = self.wet * ((1f32 - self.width) / 2f32);
        // Preserve the damping pole's time constant as the sample period changes.
        let damp = self.damp.powf(1.0 / self.rate_ratio);
        for comb in self.comb.iter_mut() {
            comb.l.set_feedback(self.roomsize);
            comb.r.set_feedback(self.roomsize);
            comb.l.set_damp(damp);
            comb.r.set_damp(damp);
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ReverbParams {
    /// Reverb room size
    pub roomsize: f32,
    /// Reverb dumping
    pub damp: f32,
    /// Reverb width
    pub width: f32,
    /// Reverb level
    pub level: f32,
}

impl Default for ReverbParams {
    fn default() -> Self {
        Self {
            roomsize: 0.2,
            damp: 0.0,
            width: 0.5,
            level: 0.9,
        }
    }
}

impl Reverb {
    /// Set the current reverb room size
    fn set_room_size(&mut self, value: f32) {
        self.roomsize = value * 0.28 + 0.7;
    }

    /// Query the current reverb room size
    fn room_size(&self) -> f32 {
        (self.roomsize - 0.7) / 0.28
    }

    /// Set the current reverb dumping
    fn set_damp(&mut self, value: f32) {
        self.damp = value * 1.0;
    }

    /// Query the current reverb dumping
    fn damp(&self) -> f32 {
        self.damp / 1.0
    }

    /// Set the current reverb level
    fn set_level(&mut self, value: f32) {
        let value = value.clamp(0.0, 1.0);
        self.wet = value * 3.0;
    }

    /// Query the current reverb level
    fn level(&self) -> f32 {
        self.wet / 3.0
    }

    /// Set the current reverb width
    fn set_width(&mut self, value: f32) {
        self.width = value;
    }

    /// Query the current reverb width
    fn width(&self) -> f32 {
        self.width
    }
}

impl Reverb {
    /// Set the parameters for the built-in reverb unit
    pub fn set_params(&mut self, params: &ReverbParams) {
        self.set_room_size(params.roomsize);
        self.set_damp(params.damp);
        self.set_width(params.width);
        self.set_level(params.level);
        self.update();
    }

    /// Query the current reverb params
    pub fn params(&self) -> ReverbParams {
        ReverbParams {
            roomsize: self.room_size(),
            damp: self.damp(),
            level: self.level(),
            width: self.width(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_reflection_keeps_its_time_across_sample_rates() {
        for sample_rate in [44_100.0, 48_000.0, 96_000.0] {
            let mut reverb = Reverb::with_sample_rate(sample_rate);
            let mut silence = reverb.clone();
            let mut first_reflection = None;
            for block in 0..64 {
                let mut impulse = [0.0; 64];
                if block == 0 {
                    impulse[0] = 1.0;
                }
                let mut silent_input = [0.0; 64];
                let mut left = [0.0; 64];
                let mut silent_left = [0.0; 64];
                reverb.process_mix(&mut impulse, &mut left, &mut [0.0; 64]);
                silence.process_mix(&mut silent_input, &mut silent_left, &mut [0.0; 64]);
                if let Some(index) = left.iter().zip(silent_left).position(|(a, b)| *a != b) {
                    first_reflection = Some(64 * block + index);
                    break;
                }
            }
            let seconds = first_reflection.unwrap() as f32 / sample_rate;
            assert!((seconds - COMB_DELAYS[0] as f32 / TUNING_RATE).abs() <= 0.5 / sample_rate);
        }
    }
}

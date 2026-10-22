//! Streaming FFT sample-rate conversion, performed only on the producer thread.
use jap_core::{AudioFormat, TrackInfo};
use jap_decode::{AudioSource, DecodeError, Result};
use rubato::{FftFixedInOut, Resampler};

pub(crate) fn adapt(source: Box<dyn AudioSource>, rate: u32) -> Result<Box<dyn AudioSource>> {
    if source.playback_format().sample_rate == rate {
        return Ok(source);
    }
    Ok(Box::new(RateSource::new(source, rate)?))
}
struct RateSource {
    source: Box<dyn AudioSource>,
    format: AudioFormat,
    fft: FftFixedInOut<f64>,
    input: Vec<Vec<f64>>,
    output: Vec<Vec<f64>>,
    decoded: Vec<f64>,
    offset: usize,
    eof: bool,
    input_frames: u64,
    emitted: u64,
    position: u64,
    delay: usize,
    source_rate: u32,
}
fn error(e: impl std::fmt::Display) -> DecodeError {
    DecodeError::Decode(format!("重采样: {e}"))
}
pub(crate) fn fft_for_rates(
    input: u32,
    output: u32,
    chunk: usize,
    channels: usize,
) -> Result<FftFixedInOut<f64>> {
    if input == 0 || output == 0 || channels == 0 {
        return Err(error("无效采样率/声道数"));
    }
    let (mut a, mut b) = (input, output);
    while b != 0 {
        (a, b) = (b, a % b);
    }
    let unit = u64::from(input / a);
    let blocks = (chunk as u64).div_ceil(unit);
    let input_size = unit * blocks;
    let output_size = u64::from(output / a) * blocks;
    // Co-prime, unusually large rates can cause an FFT implementation to round
    // a small requested chunk up to millions of frames. Reject before allocation.
    if input_size.max(output_size) > 262_144
        || (input_size + output_size) * channels as u64 > 2_097_152
    {
        return Err(error(
            "非常规采样率的转换块超出内存预算；原始格式直通仍可使用",
        ));
    }
    FftFixedInOut::new(input as usize, output as usize, chunk, channels).map_err(error)
}
impl RateSource {
    fn new(source: Box<dyn AudioSource>, rate: u32) -> Result<Self> {
        let mut format = source.playback_format();
        let source_rate = format.sample_rate;
        let channels = usize::from(format.channels);
        let chunk = ((u64::from(source_rate) * 1024 / u64::from(rate)) as usize).clamp(2048, 65536);
        let fft = fft_for_rates(source_rate, rate, chunk, channels)?;
        let input = fft.input_buffer_allocate(true);
        let output = fft.output_buffer_allocate(true);
        let delay = fft.output_delay();
        format.sample_rate = rate;
        format.bits = Some(64);
        format.float = true;
        let position = source.position_frames() * u64::from(rate) / u64::from(source_rate);
        Ok(Self {
            source,
            format,
            fft,
            input,
            output,
            decoded: Vec::new(),
            offset: 0,
            eof: false,
            input_frames: 0,
            emitted: 0,
            position,
            delay,
            source_rate,
        })
    }
}
impl AudioSource for RateSource {
    fn info(&self) -> &TrackInfo {
        self.source.info()
    }
    fn playback_format(&self) -> AudioFormat {
        self.format
    }
    fn read(&mut self, out: &mut Vec<f64>) -> Result<usize> {
        let channels = usize::from(self.format.channels);
        loop {
            let expected = self.input_frames * u64::from(self.format.sample_rate)
                / u64::from(self.source_rate);
            if self.eof && self.emitted >= expected {
                return Ok(0);
            }
            let wanted = self.fft.input_frames_next();
            let mut used = 0;
            while used < wanted {
                if self.offset >= self.decoded.len() {
                    if self.eof {
                        break;
                    }
                    self.decoded.clear();
                    self.offset = 0;
                    if self.source.read(&mut self.decoded)? == 0 {
                        self.eof = true;
                        break;
                    }
                }
                let take = (wanted - used).min((self.decoded.len() - self.offset) / channels);
                for i in 0..take {
                    for ch in 0..channels {
                        let value = self.decoded[self.offset + i * channels + ch];
                        self.input[ch][used + i] = if value.is_finite() { value } else { 0. };
                    }
                }
                self.offset += take * channels;
                used += take;
            }
            self.input_frames += used as u64;
            for channel in &mut self.input {
                channel[used..].fill(0.);
            }
            let (_, produced) = self
                .fft
                .process_into_buffer(&self.input, &mut self.output, None)
                .map_err(error)?;
            let skip = self.delay.min(produced);
            self.delay -= skip;
            let mut take = produced - skip;
            if self.eof {
                let total = self.input_frames * u64::from(self.format.sample_rate)
                    / u64::from(self.source_rate);
                take = take.min(total.saturating_sub(self.emitted) as usize);
            }
            for i in skip..skip + take {
                for channel in &self.output {
                    out.push(channel[i]);
                }
            }
            self.emitted += take as u64;
            self.position += take as u64;
            if take > 0 {
                return Ok(take);
            }
        }
    }
    fn seek(&mut self, ms: u64) -> Result<u64> {
        let actual = self.source.seek(ms)?;
        self.fft.reset();
        self.delay = self.fft.output_delay();
        self.decoded.clear();
        self.offset = 0;
        self.eof = false;
        self.input_frames = 0;
        self.emitted = 0;
        self.position = actual * u64::from(self.format.sample_rate) / 1000;
        Ok(actual)
    }
    fn position_frames(&self) -> u64 {
        self.position
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn pathological_coprime_rates_cannot_allocate_unbounded_fft_blocks() {
        assert!(fft_for_rates(12_287_999, 48_000, 65_536, 32).is_err());
        assert!(fft_for_rates(6_144_000, 48_000, 65_536, 2).is_ok());
    }
    struct Tone {
        info: TrackInfo,
        pos: u64,
        frames: u64,
        chunk: usize,
    }
    impl AudioSource for Tone {
        fn info(&self) -> &TrackInfo {
            &self.info
        }
        fn read(&mut self, out: &mut Vec<f64>) -> Result<usize> {
            let n = (self.frames - self.pos).min(self.chunk as u64) as usize;
            for i in 0..n {
                let time = (self.pos + i as u64) as f64 / f64::from(self.info.format.sample_rate);
                let pass = (time * 1000. * std::f64::consts::TAU).sin() * 0.25;
                let stop = (time * 80000. * std::f64::consts::TAU).sin() * 0.25;
                out.extend([pass + stop, pass - stop]);
            }
            self.pos += n as u64;
            Ok(n)
        }
        fn seek(&mut self, ms: u64) -> Result<u64> {
            self.pos = (ms * u64::from(self.info.format.sample_rate) / 1000).min(self.frames);
            Ok(ms)
        }
        fn position_frames(&self) -> u64 {
            self.pos
        }
    }
    fn tone(rate: u32, chunk: usize) -> Box<dyn AudioSource> {
        Box::new(Tone {
            info: TrackInfo {
                path: "test".into(),
                codec: "PCM".into(),
                format: AudioFormat {
                    sample_rate: rate,
                    channels: 2,
                    bits: Some(64),
                    float: true,
                },
                duration_ms: Some(200),
                lossless: true,
                bitrate_kbps: None,
                title: None,
                artist: None,
                album: None,
            },
            pos: 0,
            frames: u64::from(rate) / 5,
            chunk,
        })
    }
    fn all(source: &mut dyn AudioSource) -> Vec<f64> {
        let mut out = Vec::new();
        while source.read(&mut out).unwrap() > 0 {}
        out
    }
    #[test]
    fn extreme_downsampling_keeps_duration_channels_and_removes_aliases() {
        let mut a = adapt(tone(6_144_000, 16384), 48000).unwrap();
        let out = all(a.as_mut());
        assert_eq!(out.len(), 9600 * 2);
        let mut error = 0f64;
        for i in 2048..8000 {
            let expected = (i as f64 / 48000. * 1000. * std::f64::consts::TAU).sin() * 0.25;
            error = error
                .max((out[i * 2] - expected).abs())
                .max((out[i * 2 + 1] - expected).abs());
        }
        assert!(error < 1e-5, "passband or alias error {error}");
        a.seek(0).unwrap();
        assert_eq!(all(a.as_mut()), out);
        let mut b = adapt(tone(6_144_000, 777), 48000).unwrap();
        assert_eq!(all(b.as_mut()), out);
    }
    #[test]
    fn rational_rate_and_short_tail_are_not_truncated() {
        for rate in [44100, 96000, 768000] {
            let mut source = adapt(tone(rate, 523), 48000).unwrap();
            assert_eq!(all(source.as_mut()).len(), 19200);
            source.seek(75).unwrap();
            assert_eq!(source.position_frames(), 3600);
            assert_eq!(all(source.as_mut()).len(), 12000);
        }
    }
    #[test]
    #[ignore = "Read-only local high-rate source benchmark; set JAP_HIGH_RATE_QA_PATH"]
    fn local_high_rate_streaming_throughput() {
        let path = std::env::var("JAP_HIGH_RATE_QA_PATH").expect("JAP_HIGH_RATE_QA_PATH");
        for output in [None, Some(192000), Some(48000)] {
            let raw = jap_decode::open(std::path::Path::new(&path)).unwrap();
            let source_rate = raw.playback_format().sample_rate;
            let mut source = if let Some(rate) = output {
                adapt(raw, rate).unwrap()
            } else {
                raw
            };
            let rate = source.playback_format().sample_rate;
            let now = std::time::Instant::now();
            let mut frames = 0;
            let mut bytes = Vec::new();
            let mut peak = 0;
            while frames < u64::from(rate) * 5 {
                bytes.clear();
                frames += source.read(&mut bytes).unwrap() as u64;
                peak = peak.max(bytes.capacity() * 8);
            }
            let elapsed = now.elapsed().as_secs_f64();
            println!(
                "source {source_rate} Hz -> {rate} Hz: 5 s audio / {elapsed:.4} s = {:.2}x realtime; largest PCM block {peak} bytes",
                5. / elapsed
            );
            assert!(elapsed < 5., "cannot sustain real time");
            source.seek(200_000).unwrap();
            bytes.clear();
            assert!(source.read(&mut bytes).unwrap() > 0);
            assert!(bytes.iter().all(|v| v.is_finite()));
        }
    }
}

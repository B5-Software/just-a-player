use jap_analysis::Analyzer;
use jap_decode::AudioSource;
use std::{fs::File, io::BufWriter, path::Path};
type Result<T> = std::result::Result<T, String>;
fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}
pub struct OfflineRender {
    source: Box<dyn AudioSource>,
    analyzer: Analyzer,
    cursor: u64,
    rate: u32,
    channels: usize,
    samples: Vec<f64>,
    writer: Option<hound::WavWriter<BufWriter<File>>>,
}
impl OfflineRender {
    pub fn new(path: String, audio_path: String, start_ms: u32) -> Result<Self> {
        let source = jap_decode::open(Path::new(&path)).map_err(err)?;
        Self::from_source(source, audio_path, start_ms)
    }
    pub fn new_with_midi(
        path: String,
        audio_path: String,
        start_ms: u32,
        soundfont: Option<String>,
        rate: u32,
    ) -> Result<Self> {
        let source: Box<dyn AudioSource> = if jap_decode::midi::is_midi(Path::new(&path)) {
            Box::new(
                jap_decode::midi::MidiSource::open_with(Path::new(&path), soundfont, rate)
                    .map_err(err)?,
            )
        } else {
            jap_decode::open(Path::new(&path)).map_err(err)?
        };
        Self::from_source(source, audio_path, start_ms)
    }
    fn from_source(
        mut source: Box<dyn AudioSource>,
        audio_path: String,
        start_ms: u32,
    ) -> Result<Self> {
        if start_ms > 0 {
            source.seek(u64::from(start_ms)).map_err(err)?;
        }
        let format = source.playback_format();
        let mut analyzer = Analyzer::new();
        analyzer.set_rate(format.sample_rate);
        let writer = if audio_path.is_empty() {
            None
        } else {
            Some(
                hound::WavWriter::create(
                    audio_path,
                    hound::WavSpec {
                        channels: format.channels,
                        sample_rate: format.sample_rate,
                        bits_per_sample: 32,
                        sample_format: hound::SampleFormat::Int,
                    },
                )
                .map_err(err)?,
            )
        };
        Ok(Self {
            source,
            analyzer,
            cursor: 0,
            rate: format.sample_rate,
            channels: usize::from(format.channels),
            samples: Vec::new(),
            writer,
        })
    }
    pub fn frame_at(&mut self, relative_ms: f64) -> Result<Vec<f32>> {
        if !relative_ms.is_finite() || relative_ms < 0. {
            return Err(err("Invalid export time"));
        }
        let target = (relative_ms * f64::from(self.rate) / 1000.) as u64;
        while self.cursor <= target {
            self.samples.clear();
            let n = self.source.read(&mut self.samples).map_err(err)?;
            if n == 0 {
                break;
            }
            self.analyzer
                .push(self.cursor, &self.samples, self.channels);
            self.cursor += n as u64;
            if let Some(writer) = self.writer.as_mut() {
                for &s in &self.samples {
                    writer
                        .write_sample(
                            (s * 2147483648.)
                                .round()
                                .clamp(i32::MIN as f64, i32::MAX as f64)
                                as i32,
                        )
                        .map_err(err)?;
                }
            }
        }
        let mut frame = Vec::new();
        self.analyzer.compute(target, &mut frame);
        Ok(frame)
    }
    pub fn close(&mut self) -> Result<()> {
        if let Some(writer) = self.writer.take() {
            writer.finalize().map_err(err)?
        }
        Ok(())
    }
}

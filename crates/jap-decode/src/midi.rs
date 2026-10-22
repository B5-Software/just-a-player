//! Sample-based, platform-independent MIDI playback. No OS synthesizer or temp WAV.
use crate::{AudioSource, DecodeError, Result};
use jap_core::{AudioFormat, TrackInfo};
use midly::{Format, MetaMessage, MidiMessage, Smf, Timing, TrackEventKind};
use oxisynth::{InterpolationMethod, MidiEvent, SoundFont, Synth, SynthDescriptor};
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock, RwLock},
};

const BLOCK: usize = 1024;
const TAIL_SECONDS: u64 = 3;
#[derive(Clone)]
struct Config {
    path: Option<String>,
    rate: u32,
}
fn config() -> &'static RwLock<Config> {
    static CONFIG: OnceLock<RwLock<Config>> = OnceLock::new();
    CONFIG.get_or_init(|| {
        RwLock::new(Config {
            path: None,
            rate: 96000,
        })
    })
}
pub fn configure(path: Option<String>, rate: u32) {
    *config().write().unwrap_or_else(|e| e.into_inner()) = Config {
        path: path.filter(|p| !p.is_empty()),
        rate: if [44100, 48000, 96000].contains(&rate) {
            rate
        } else {
            96000
        },
    };
}
pub fn is_midi(path: &Path) -> bool {
    path.extension().is_some_and(|ext| {
        ["mid", "midi", "kar", "rmi"]
            .iter()
            .any(|e| ext.eq_ignore_ascii_case(e))
    })
}
fn default_font() -> PathBuf {
    std::env::var_os("JAP_SOUNDFONT_PATH")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../assets/soundfonts/MuseScore_General_HQ.sf2")
        })
}
struct CachedFont {
    path: PathBuf,
    modified: Option<std::time::SystemTime>,
    len: u64,
    font: SoundFont,
}
fn load_font(path: &Path) -> Result<SoundFont> {
    static CACHE: OnceLock<Mutex<Option<CachedFont>>> = OnceLock::new();
    let meta = fs::metadata(path).map_err(|e| {
        DecodeError::Decode(format!(
            "无法读取 MIDI 音色库，请在设置中导入 SF2：{}: {e}",
            path.display()
        ))
    })?;
    if meta.len() > 1024 * 1024 * 1024 {
        return Err(invalid("SF2 音色库超过 1 GiB"));
    }
    let mut cache = CACHE
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    if let Some(c) = cache
        .as_ref()
        .filter(|c| c.path == path && c.modified == meta.modified().ok() && c.len == meta.len())
    {
        return Ok(c.font.clone());
    }
    let mut file = fs::File::open(path)?;
    let font =
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| SoundFont::load(&mut file)))
            .map_err(|_| invalid("SF2 音色库结构损坏"))?
            .map_err(|e| invalid(format!("SF2 音色库: {e:?}")))?;
    *cache = Some(CachedFont {
        path: path.to_owned(),
        modified: meta.modified().ok(),
        len: meta.len(),
        font: font.clone(),
    });
    Ok(font)
}
fn invalid(message: impl Into<String>) -> DecodeError {
    DecodeError::Decode(message.into())
}
#[derive(Clone, Copy)]
enum Action {
    Midi(MidiEvent),
    Gain(f32),
}
#[derive(Clone, Copy)]
struct Scheduled {
    frame: u64,
    action: Action,
}
struct Sequence {
    events: Vec<Scheduled>,
    end: u64,
    title: Option<String>,
}
fn midi_data(data: &[u8]) -> Result<&[u8]> {
    if data.starts_with(b"MThd") {
        return Ok(data);
    }
    if !data.starts_with(b"RIFF") || data.get(8..12) != Some(b"RMID") {
        return Err(invalid("无效 MIDI 文件头"));
    }
    let mut offset = 12usize;
    while offset + 8 <= data.len() {
        let size = u32::from_le_bytes(data[offset + 4..offset + 8].try_into().unwrap()) as usize;
        let start = offset + 8;
        let end = start
            .checked_add(size)
            .filter(|&v| v <= data.len())
            .ok_or_else(|| invalid("损坏的 RIFF MIDI 数据"))?;
        if &data[offset..offset + 4] == b"data" {
            return Ok(&data[start..end]);
        }
        offset = end + (size & 1);
    }
    Err(invalid("RIFF MIDI 缺少演奏数据"))
}
fn convert(channel: u8, m: MidiMessage) -> MidiEvent {
    match m {
        MidiMessage::NoteOff { key, .. } => MidiEvent::NoteOff {
            channel,
            key: key.as_int(),
        },
        MidiMessage::NoteOn { key, vel } if vel.as_int() == 0 => MidiEvent::NoteOff {
            channel,
            key: key.as_int(),
        },
        MidiMessage::NoteOn { key, vel } => MidiEvent::NoteOn {
            channel,
            key: key.as_int(),
            vel: vel.as_int(),
        },
        MidiMessage::Aftertouch { key, vel } => MidiEvent::PolyphonicKeyPressure {
            channel,
            key: key.as_int(),
            value: vel.as_int(),
        },
        MidiMessage::Controller { controller, value } => MidiEvent::ControlChange {
            channel,
            ctrl: controller.as_int(),
            value: value.as_int(),
        },
        MidiMessage::ProgramChange { program } => MidiEvent::ProgramChange {
            channel,
            program_id: program.as_int(),
        },
        MidiMessage::ChannelAftertouch { vel } => MidiEvent::ChannelPressure {
            channel,
            value: vel.as_int(),
        },
        MidiMessage::PitchBend { bend } => MidiEvent::PitchBend {
            channel,
            value: bend.0.as_int(),
        },
    }
}
fn parse(data: &[u8], rate: u32) -> Result<Sequence> {
    let smf = Smf::parse(midi_data(data)?).map_err(|e| invalid(e.to_string()))?;
    let mut title = None;
    let mut events = Vec::new();
    let mut base = 0;
    let mut end = 0;
    let groups: Vec<_> = if smf.header.format == Format::Sequential {
        smf.tracks.iter().map(std::slice::from_ref).collect()
    } else {
        vec![smf.tracks.as_slice()]
    };
    for tracks in groups {
        let mut timeline = Vec::new();
        for track in tracks {
            let mut tick = 0u64;
            for event in track {
                tick = tick
                    .checked_add(u64::from(event.delta.as_int()))
                    .ok_or_else(|| invalid("MIDI 时间溢出"))?;
                timeline.push((tick, event.kind));
                if timeline.len() > 1_000_000 {
                    return Err(invalid("MIDI 事件超过一百万条"));
                }
            }
        }
        timeline.sort_by_key(|v| v.0); // stable: preserve same-tick bank/program/note order
        let (denominator, mut step) = match smf.header.timing {
            Timing::Metrical(ticks) if ticks.as_int() > 0 => (
                u128::from(ticks.as_int()) * 1_000_000,
                u128::from(rate) * 500_000,
            ),
            Timing::Timecode(fps, ticks) if ticks > 0 => {
                if fps == midly::Fps::Fps29 {
                    (30_000 * u128::from(ticks), u128::from(rate) * 1001)
                } else {
                    (
                        u128::from(fps.as_int()) * u128::from(ticks),
                        u128::from(rate),
                    )
                }
            }
            _ => return Err(invalid("MIDI 时间分辨率为零")),
        };
        let mut elapsed = 0u128;
        let mut previous = 0;
        let mut frame = base;
        for (tick, kind) in timeline {
            elapsed += u128::from(tick - previous) * step;
            previous = tick;
            frame = base
                + u64::try_from(elapsed / denominator).map_err(|_| invalid("MIDI 时长溢出"))?;
            if frame > u64::from(rate) * 86400 {
                return Err(invalid("MIDI 时长超过 24 小时"));
            }
            let action = match kind {
                TrackEventKind::Midi { channel, message } => {
                    Some(Action::Midi(convert(channel.as_int(), message)))
                }
                TrackEventKind::Meta(MetaMessage::Tempo(tempo)) => {
                    if matches!(smf.header.timing, Timing::Metrical(_)) {
                        step = u128::from(rate) * u128::from(tempo.as_int().max(1));
                    }
                    None
                }
                TrackEventKind::Meta(MetaMessage::TrackName(text)) => {
                    if title.is_none() && !text.is_empty() {
                        title = Some(
                            String::from_utf8_lossy(text)
                                .trim_matches(char::from(0))
                                .to_owned(),
                        );
                    }
                    None
                }
                TrackEventKind::SysEx(d) if d.len() >= 4 && d[0] == 0x7e && d[2] == 9 => {
                    Some(Action::Midi(MidiEvent::SystemReset))
                }
                TrackEventKind::SysEx(d) if d.len() >= 6 && d[0] == 0x7f && d[2..4] == [4, 1] => {
                    Some(Action::Gain(
                        f32::from(u16::from(d[4]) | u16::from(d[5]) << 7) / 16383.,
                    ))
                }
                _ => None,
            };
            if let Some(action) = action {
                events.push(Scheduled { frame, action });
            }
        }
        // Release held pedal/voices at the end of each type-2 pattern.
        for channel in 0..16 {
            events.push(Scheduled {
                frame,
                action: Action::Midi(MidiEvent::ControlChange {
                    channel,
                    ctrl: 64,
                    value: 0,
                }),
            });
            events.push(Scheduled {
                frame,
                action: Action::Midi(MidiEvent::AllNotesOff { channel }),
            });
        }
        end = frame;
        base = end;
    }
    if !events
        .iter()
        .any(|e| matches!(e.action, Action::Midi(MidiEvent::NoteOn { vel: 1.., .. })))
    {
        return Err(invalid("MIDI 没有可播放的音符"));
    }
    Ok(Sequence {
        events,
        end: end + u64::from(rate) * TAIL_SECONDS,
        title,
    })
}

pub struct MidiSource {
    info: TrackInfo,
    sequence: Sequence,
    synth: Synth,
    font: SoundFont,
    cursor: u64,
    index: usize,
    warned_missing_preset: bool,
}
impl MidiSource {
    pub fn open(path: &Path) -> Result<Self> {
        let cfg = config().read().unwrap_or_else(|e| e.into_inner()).clone();
        Self::open_config(path, cfg)
    }
    pub fn open_with(path: &Path, soundfont: Option<String>, rate: u32) -> Result<Self> {
        Self::open_config(
            path,
            Config {
                path: soundfont.filter(|p| !p.is_empty()),
                rate: if [44100, 48000, 96000].contains(&rate) {
                    rate
                } else {
                    96000
                },
            },
        )
    }
    fn open_config(path: &Path, cfg: Config) -> Result<Self> {
        let mut data = Vec::new();
        fs::File::open(path)?
            .take(32 * 1024 * 1024 + 1)
            .read_to_end(&mut data)?;
        if data.len() > 32 * 1024 * 1024 {
            return Err(invalid("MIDI 文件超过 32 MiB"));
        }
        let sequence = parse(&data, cfg.rate)?;
        let font_path = cfg.path.map(PathBuf::from).unwrap_or_else(default_font);
        let font = load_font(&font_path)?;
        let synth = Self::synth(&font, cfg.rate)?;
        let info = TrackInfo {
            path: path.display().to_string(),
            codec: format!(
                "MIDI / SF2 合成 · {} · 7 阶插值",
                font_path.file_stem().unwrap_or_default().to_string_lossy()
            ),
            format: AudioFormat {
                sample_rate: cfg.rate,
                channels: 2,
                bits: Some(32),
                float: true,
            },
            duration_ms: Some(sequence.end * 1000 / u64::from(cfg.rate)),
            lossless: false,
            bitrate_kbps: None,
            title: sequence.title.clone(),
            artist: None,
            album: None,
        };
        Ok(Self {
            info,
            sequence,
            synth,
            font,
            cursor: 0,
            index: 0,
            warned_missing_preset: false,
        })
    }
    fn synth(font: &SoundFont, rate: u32) -> Result<Synth> {
        let mut synth = Synth::new(SynthDescriptor {
            sample_rate: rate as f32,
            polyphony: 512,
            interpolation: InterpolationMethod::SeventhOrder,
            ..Default::default()
        })
        .map_err(|e| invalid(e.to_string()))?;
        synth.add_font(font.clone(), true);
        Ok(synth)
    }
    fn render(&mut self, count: usize, out: &mut Vec<f64>) -> Result<()> {
        let target = self.cursor + count as u64;
        while self.cursor < target {
            while self.index < self.sequence.events.len()
                && self.sequence.events[self.index].frame <= self.cursor
            {
                match self.sequence.events[self.index].action {
                    Action::Midi(e) => match self.synth.send_event(e) {
                        Ok(()) => {}
                        Err(
                            oxisynth::OxiError::ChannelHasNoPreset
                            | oxisynth::OxiError::PresetNotFound { .. },
                        ) => {
                            if !self.warned_missing_preset {
                                tracing::warn!(
                                    "导入的 SF2 缺少部分乐器/鼓组；这些音符静音，保留其余声部"
                                );
                                self.warned_missing_preset = true;
                            }
                        }
                        Err(e) => return Err(invalid(e.to_string())),
                    },
                    Action::Gain(gain) => self.synth.set_gain(gain * 0.2),
                }
                self.index += 1;
            }
            let end = self
                .sequence
                .events
                .get(self.index)
                .map_or(target, |e| e.frame.min(target));
            let start = out.len();
            out.resize(start + (end - self.cursor) as usize * 2, 0.);
            self.synth.write(&mut out[start..]);
            self.cursor = end;
        }
        Ok(())
    }
}
impl AudioSource for MidiSource {
    fn info(&self) -> &TrackInfo {
        &self.info
    }
    fn read(&mut self, out: &mut Vec<f64>) -> Result<usize> {
        let count = (self.sequence.end - self.cursor).min(BLOCK as u64) as usize;
        self.render(count, out)?;
        Ok(count)
    }
    fn seek(&mut self, ms: u64) -> Result<u64> {
        let target = (ms.saturating_mul(u64::from(self.info.format.sample_rate)) / 1000)
            .min(self.sequence.end);
        if target < self.cursor {
            self.synth = Self::synth(&self.font, self.info.format.sample_rate)?;
            self.cursor = 0;
            self.index = 0;
        }
        let mut scratch = Vec::with_capacity(BLOCK * 2);
        while self.cursor < target {
            scratch.clear();
            self.render(
                (target - self.cursor).min(BLOCK as u64) as usize,
                &mut scratch,
            )?;
        }
        Ok(self.cursor * 1000 / u64::from(self.info.format.sample_rate))
    }
    fn position_frames(&self) -> u64 {
        self.cursor
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn smf(format: u16, division: u16, tracks: &[&[u8]]) -> Vec<u8> {
        let mut data = b"MThd\0\0\0\x06".to_vec();
        data.extend(format.to_be_bytes());
        data.extend((tracks.len() as u16).to_be_bytes());
        data.extend(division.to_be_bytes());
        for track in tracks {
            data.extend(b"MTrk");
            data.extend((track.len() as u32).to_be_bytes());
            data.extend(*track);
        }
        data
    }
    #[test]
    fn tempo_running_status_and_tail() {
        let data = smf(
            0,
            480,
            &[&[
                0, 0x90, 60, 100, 0x83, 0x60, 0xff, 0x51, 3, 0x0f, 0x42, 0x40, 0x83, 0x60, 0x90,
                60, 0, 0, 0xff, 0x2f, 0,
            ]],
        );
        let seq = parse(&data, 48000).unwrap();
        assert_eq!(seq.end, 216000); // .5 s at 120 BPM + 1 s at 60 BPM + 3 s release
        assert!(seq.events.iter().any(
            |e| e.frame == 72000 && matches!(e.action, Action::Midi(MidiEvent::NoteOff { .. }))
        ));
    }
    #[test]
    fn merge_type_one_tempo_track() {
        let data = smf(
            1,
            480,
            &[
                &[
                    0, 0xff, 0x51, 3, 0x0f, 0x42, 0x40, 0x83, 0x60, 0xff, 0x2f, 0,
                ],
                &[0, 0x90, 60, 100, 0x83, 0x60, 0x80, 60, 0, 0, 0xff, 0x2f, 0],
            ],
        );
        assert_eq!(parse(&data, 48000).unwrap().end, 192000);
    }
    #[test]
    fn smpte_and_sequential_patterns() {
        let track = [0, 0x90, 60, 100, 0x83, 0x60, 0x80, 60, 0, 0, 0xff, 0x2f, 0];
        assert_eq!(
            parse(&smf(2, 480, &[&track, &track]), 48000).unwrap().end,
            192000
        );
        assert_eq!(
            parse(&smf(0, 0xe728, &[&track]), 48000).unwrap().end,
            167040
        );
    }
    #[test]
    fn riff_midi_and_bad_headers() {
        let data = smf(
            0,
            480,
            &[&[0, 0x90, 60, 100, 0x83, 0x60, 0x80, 60, 0, 0, 0xff, 0x2f, 0]],
        );
        let mut r = b"RIFF".to_vec();
        r.extend((data.len() as u32 + 12).to_le_bytes());
        r.extend(b"RMIDdata");
        r.extend((data.len() as u32).to_le_bytes());
        r.extend(&data);
        assert!(parse(&r, 48000).is_ok());
        assert!(parse(b"not midi", 48000).is_err());
        assert!(parse(&smf(0, 0, &[&[0, 0xff, 0x2f, 0]]), 48000).is_err());
    }
    #[test]
    fn imported_soundfont_works_without_a_bundled_bank() {
        let data = smf(
            0,
            480,
            &[&[0, 0x90, 69, 100, 0x83, 0x60, 0x80, 69, 0, 0, 0xff, 0x2f, 0]],
        );
        let path = std::env::temp_dir().join(format!("jap-import-midi-{}.mid", std::process::id()));
        fs::write(&path, data).unwrap();
        let font = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../scripts/fixtures/sine.sf2");
        let mut source =
            MidiSource::open_with(&path, Some(font.to_string_lossy().into_owned()), 96000).unwrap();
        let mut audio = Vec::new();
        source.read(&mut audio).unwrap();
        assert!(audio.iter().any(|v| v.abs() > 1e-4));
        fs::remove_file(path).unwrap();
    }
    #[test]
    fn a_partial_imported_bank_does_not_abort_other_channels() {
        // The original sine bank has only melodic program zero, no drum bank.
        let data = smf(
            0,
            480,
            &[&[
                0, 0x90, 69, 100, 0, 0x99, 42, 100, 0x83, 0x60, 0x80, 69, 0, 0, 0xff, 0x2f, 0,
            ]],
        );
        let path =
            std::env::temp_dir().join(format!("jap-partial-bank-{}.mid", std::process::id()));
        fs::write(&path, data).unwrap();
        let font = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../scripts/fixtures/sine.sf2");
        let mut source =
            MidiSource::open_with(&path, Some(font.to_string_lossy().into_owned()), 48000).unwrap();
        let mut audio = Vec::new();
        while source.read(&mut audio).unwrap() > 0 {}
        assert!(source.warned_missing_preset);
        assert!(audio.iter().any(|v| v.abs() > 1e-4));
        assert!(audio.iter().all(|v| v.is_finite()));
        fs::remove_file(path).unwrap();
    }
    #[test]
    fn hq_soundfont_produces_audio_and_seek_restores_voices() {
        if !default_font().exists() {
            return;
        } // Source-only cargo test can run before asset preparation.
        let data = smf(
            0,
            480,
            &[&[0, 0x90, 60, 100, 0x87, 0x40, 0x80, 60, 0, 0, 0xff, 0x2f, 0]],
        );
        let path = std::env::temp_dir().join(format!("jap-midi-{}.mid", std::process::id()));
        fs::write(&path, data).unwrap();
        let mut source = MidiSource::open(&path).unwrap();
        let mut linear = Vec::new();
        for _ in 0..24 {
            source.read(&mut linear).unwrap();
        }
        assert!(linear.iter().all(|v| v.is_finite()));
        assert!(linear.iter().any(|v| v.abs() > 1e-4));
        source.seek(0).unwrap();
        let mut again = Vec::new();
        for _ in 0..24 {
            source.read(&mut again).unwrap();
        }
        assert_eq!(linear, again);
        fs::remove_file(path).unwrap();
    }
}

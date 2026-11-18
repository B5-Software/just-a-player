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
    MasterVolume(f64),
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
fn sysex(data: &[u8]) -> Option<Action> {
    let payload = data.strip_suffix(&[0xf7]).unwrap_or(data);
    match payload {
        [0x7e, 0..=127, 9, 1 | 3] | [0x41, 0..=127, 0x42, 0x12, 0x40, 0, 0x7f, 0, 0x41] => {
            Some(Action::Midi(MidiEvent::SystemReset))
        }
        [0x7f, 0..=127, 4, 1, lsb @ 0..=127, msb @ 0..=127] => {
            let value = u16::from(*lsb) | (u16::from(*msb) << 7);
            Some(Action::MasterVolume(f64::from(value) / 16383.0))
        }
        [
            0x41,
            0..=127,
            0x42,
            0x12,
            0x40,
            0,
            4,
            volume @ 0..=127,
            checksum @ 0..=127,
        ] if (0x44 + u16::from(*volume) + u16::from(*checksum)) % 128 == 0 => {
            Some(Action::MasterVolume(f64::from(*volume) / 127.0))
        }
        _ => None,
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
                TrackEventKind::SysEx(data) => sysex(data),
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
    master_volume: f64,
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
            master_volume: 1.0,
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
                    Action::Midi(MidiEvent::SystemReset) => {
                        self.synth
                            .send_event(MidiEvent::SystemReset)
                            .map_err(|e| invalid(e.to_string()))?;
                        self.master_volume = 1.0;
                    }
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
                    Action::MasterVolume(volume) => self.master_volume = volume,
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
            let samples = &mut out[start..];
            self.synth.write(&mut *samples);
            // Apply MIDI master volume after mixing voices and effects, including their tails.
            if self.master_volume != 1.0 {
                for sample in samples {
                    *sample *= self.master_volume;
                }
            }
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
            self.master_volume = 1.0;
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
    fn hq_bank_selection_and_reset_preserve_the_intended_instruments() {
        if !default_font().exists() {
            return;
        }
        let mut synth = MidiSource::synth(&load_font(&default_font()).unwrap(), 48000).unwrap();
        assert_eq!(synth.channel_preset(9).unwrap().banknum(), 128);
        synth.send_event(MidiEvent::SystemReset).unwrap();
        assert_eq!(synth.channel_preset(9).unwrap().banknum(), 128);
        for lsb in [0, 1] {
            for (ctrl, value) in [(0, 20), (32, lsb)] {
                synth
                    .send_event(MidiEvent::ControlChange {
                        channel: 0,
                        ctrl,
                        value,
                    })
                    .unwrap();
            }
            synth
                .send_event(MidiEvent::ProgramChange {
                    channel: 0,
                    program_id: 48,
                })
                .unwrap();
            assert_eq!(synth.channel_preset(0).unwrap().banknum(), 20);
        }
        synth.send_event(MidiEvent::SystemReset).unwrap();
        synth
            .send_event(MidiEvent::ControlChange {
                channel: 0,
                ctrl: 32,
                value: 0,
            })
            .unwrap();
        synth
            .send_event(MidiEvent::ProgramChange {
                channel: 0,
                program_id: 48,
            })
            .unwrap();
        assert_eq!(synth.channel_preset(0).unwrap().banknum(), 0);
    }

    fn render_fixture(name: &str, track: &[u8], rate: u32) -> Vec<f64> {
        let path = std::env::temp_dir().join(format!("jap-{name}-{}.mid", std::process::id()));
        fs::write(&path, smf(0, 480, &[track])).unwrap();
        let font = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../scripts/fixtures/sine.sf2");
        let mut source =
            MidiSource::open_with(&path, Some(font.to_string_lossy().into_owned()), rate).unwrap();
        let mut audio = Vec::new();
        while source.read(&mut audio).unwrap() > 0 {}
        fs::remove_file(path).unwrap();
        audio
    }

    #[test]
    fn master_volume_mutes_the_mix_without_losing_sustained_notes() {
        #[rustfmt::skip]
        let track = [
            0, 0xb0, 91, 127, // send to reverb so the master volume also covers effects
            0, 0x90, 69, 100,
            0x83, 0x60, 0xf0, 7, 0x7f, 0x7f, 4, 1, 0, 0, 0xf7,
            0x83, 0x60, 0xf0, 7, 0x7f, 0x7f, 4, 1, 0x7f, 0x7f, 0xf7,
            0x83, 0x60, 0x80, 69, 0,
            0, 0xff, 0x2f, 0,
        ];
        let audio = render_fixture("midi-master-volume", &track, 48000);
        assert!(audio[48_000..96_000].iter().all(|sample| *sample == 0.));
        assert!(
            audio[100_000..120_000]
                .iter()
                .any(|sample| sample.abs() > 0.001)
        );
    }

    #[test]
    fn effects_returns_are_restored_after_reset() {
        let render = |rate, controller, send, reset| {
            let mut track = Vec::new();
            if reset {
                track.extend([0, 0xf0, 5, 0x7e, 0x7f, 9, 1, 0xf7]);
            }
            track.extend([
                0, 0xb0, controller, send, 0, 0x90, 69, 100, 0x87, 0x40, 0x80, 69, 0, 0, 0xff,
                0x2f, 0,
            ]);
            render_fixture("midi-effects", &track, rate)
        };
        for rate in [48000, 96000] {
            for controller in [91, 93] {
                let dry = render(rate, controller, 0, false);
                let wet = render(rate, controller, 127, false);
                let after_reset = render(rate, controller, 127, true);
                assert!(wet != dry, "CC{controller} has no effect at {rate} Hz");
                assert!(
                    wet == after_reset,
                    "CC{controller} changed after reset at {rate} Hz"
                );
            }
        }
    }

    #[test]
    fn soundfont_effect_controllers_add_to_the_send_without_changing_dry_audio() {
        use oxisynth::GeneratorType;

        let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../scripts/fixtures/sine.sf2");
        let font = load_font(&fixture).unwrap();
        for (ctrl, generator) in [
            (91, GeneratorType::ReverbSend),
            (93, GeneratorType::ChorusSend),
        ] {
            let render = |send, value, fx| {
                let mut synth = Synth::new(SynthDescriptor {
                    reverb_active: fx,
                    chorus_active: fx,
                    ..Default::default()
                })
                .unwrap();
                synth.add_font(font.clone(), true);
                synth.set_gen(0, generator, send).unwrap();
                synth
                    .send_event(MidiEvent::ControlChange {
                        channel: 0,
                        ctrl,
                        value,
                    })
                    .unwrap();
                synth
                    .send_event(MidiEvent::NoteOn {
                        channel: 0,
                        key: 69,
                        vel: 100,
                    })
                    .unwrap();
                let mut pcm = vec![0.0_f32; 16384];
                synth.write(pcm.as_mut_slice());
                pcm
            };
            // SF2 2.04 §8.4.8–9: add 200 × 64/128 to the existing send of 250.
            // Compare real rendered samples, including the effect return.
            assert!(render(250.0, 64, true) == render(350.0, 0, true));
            assert!(render(250.0, 127, true) == render(448.4375, 0, true));
            assert!(render(250.0, 127, false) == render(250.0, 0, false));
        }
    }

    #[test]
    fn channel_volume_expression_and_velocity_preserve_stereo_mix_ratios() {
        let audio = render_fixture(
            "midi-channel-balance",
            &[
                0, 0xb0, 10, 0, 0, 0xb1, 10, 127, // hard-pan two identical parts
                0, 0xb0, 7, 127, 0, 0xb1, 7, 127, 0, 0x90, 69, 100, 0, 0x91, 69, 100, 0x83, 0x60,
                0xb1, 7, 64, // reduce right channel volume
                0x83, 0x60, 0xb1, 7, 127, 0, 0xb1, 11, 64, // reduce expression instead
                0x83, 0x60, 0xb1, 11, 127, 0, 0x81, 69, 0, 0, 0x91, 69, 50, 0x83, 0x60, 0x80, 69,
                0, 0, 0x81, 69, 0, 0, 0xff, 0x2f, 0,
            ],
            48000,
        );
        for (window, expected_db) in [
            (0, 0.0),
            (1, 40.0 * (64.0_f64 / 127.0).log10()),
            (2, 40.0 * (64.0_f64 / 127.0).log10()),
            (3, 40.0 * (50.0_f64 / 100.0).log10()),
        ] {
            let start = window * 48_000 + 20_000;
            let (frames, _) = audio[start..start + 20_000].as_chunks::<2>();
            let (left, right) =
                frames
                    .iter()
                    .fold((0.0, 0.0), |(left_power, right_power), &[left, right]| {
                        (left_power + left * left, right_power + right * right)
                    });
            let actual_db = 10.0 * (right / left).log10();
            assert!(
                (actual_db - expected_db).abs() < 0.2,
                "window {window}: {actual_db:.2} dB vs {expected_db:.2} dB"
            );
        }
    }

    #[test]
    fn soundfont_pan_controller_centers_at_sixty_four() {
        let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../scripts/fixtures/sine.sf2");
        let mut synth = Synth::new(SynthDescriptor {
            reverb_active: false,
            chorus_active: false,
            ..Default::default()
        })
        .unwrap();
        synth.add_font(load_font(&fixture).unwrap(), true);
        synth
            .send_event(MidiEvent::ControlChange {
                channel: 0,
                ctrl: 10,
                value: 64,
            })
            .unwrap();
        synth
            .send_event(MidiEvent::NoteOn {
                channel: 0,
                key: 69,
                vel: 100,
            })
            .unwrap();
        let mut audio = [0.0_f64; 4096];
        synth.write(audio.as_mut_slice());
        assert!(audio.iter().any(|sample| sample.abs() > 1e-4));
        assert!(
            audio
                .as_chunks::<2>()
                .0
                .iter()
                .all(|[left, right]| left == right)
        );
    }

    #[test]
    fn reset_and_master_volume_sysex_match_supported_messages() {
        for data in [
            &[0x7e, 0x7f, 9, 1, 0xf7][..],
            &[0x41, 0x10, 0x42, 0x12, 0x40, 0, 0x7f, 0, 0x41, 0xf7],
        ] {
            assert!(matches!(
                sysex(data),
                Some(Action::Midi(MidiEvent::SystemReset))
            ));
        }
        assert!(matches!(
            sysex(&[0x7f, 0x7f, 4, 1, 0x7f, 0x7f, 0xf7]),
            Some(Action::MasterVolume(1.0))
        ));
        assert!(
            matches!(sysex(&[0x41, 0x10, 0x42, 0x12, 0x40, 0, 4, 63, 125, 0xf7]), Some(Action::MasterVolume(v)) if v == 63.0 / 127.0)
        );
        assert!(sysex(&[0x7e, 0x7f, 9, 2, 0xf7]).is_none());
        assert!(sysex(&[0x41, 0x10, 0x42, 0x12, 0x40, 0, 4, 63, 126, 0xf7]).is_none());
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

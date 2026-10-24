//! 端到端比特完美校验：文件 -> 解码 -> 环形缓冲 -> “假设备”，字节必须与原始样本逐位一致。

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use crossbeam_channel::{Receiver, unbounded};
use jap_core::{
    Command, Event, OutputApi, OutputConfig, SampleFormat, SignalPath, StreamConfig, Verdict,
};
use jap_engine::{Engine, EventSink};
use jap_output::CaptureBackend;

/// 带极值的确定性伪随机样本，覆盖满量程两端。
fn gen_samples(count: usize, bits: u32, seed: u64) -> Vec<i32> {
    let (min, max) = (-(1i64 << (bits - 1)), (1i64 << (bits - 1)) - 1);
    let mut state = seed | 1;
    let mut out = Vec::with_capacity(count);
    for i in 0..count {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        let span = (max - min + 1) as u64;
        let v = match i % 997 {
            0 => min,
            1 => max,
            _ => min + (state % span) as i64,
        };
        out.push(v as i32);
    }
    out
}

fn write_wav(
    dir: &Path,
    name: &str,
    rate: u32,
    channels: u16,
    bits: u32,
    samples: &[i32],
) -> PathBuf {
    let path = dir.join(name);
    let spec = hound::WavSpec {
        channels,
        sample_rate: rate,
        bits_per_sample: bits as u16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut w = hound::WavWriter::create(&path, spec).unwrap();
    for &s in samples {
        w.write_sample(s).unwrap();
    }
    w.finalize().unwrap();
    path
}

/// 把整数样本按给定设备格式编码，作为期望字节。
fn expected_bytes(samples: &[i32], src_bits: u32, format: SampleFormat) -> Vec<u8> {
    let mut out = Vec::new();
    for &x in samples {
        match format {
            SampleFormat::I16 => out.extend_from_slice(&(x as i16).to_le_bytes()),
            SampleFormat::I24Packed => {
                out.extend_from_slice(&(x << (24 - src_bits)).to_le_bytes()[..3])
            }
            SampleFormat::I24In32 => out.extend_from_slice(&(x << (32 - src_bits)).to_le_bytes()),
            SampleFormat::I32 => out.extend_from_slice(&x.to_le_bytes()),
            _ => unreachable!("整数源不会走浮点或 DSD 输出"),
        }
    }
    out
}

struct Harness {
    engine: Engine,
    events: Receiver<Event>,
    captured: Arc<parking_lot::Mutex<Vec<u8>>>,
    _dir: tempfile_dir::TempDir,
}

mod tempfile_dir {
    use std::path::{Path, PathBuf};

    pub struct TempDir(PathBuf);

    impl TempDir {
        pub fn new(tag: &str) -> Self {
            let p = std::env::temp_dir().join(format!("jap-test-{tag}-{}", std::process::id()));
            std::fs::create_dir_all(&p).unwrap();
            Self(p)
        }
        pub fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
}

fn harness(tag: &str, accepted: Vec<StreamConfig>) -> Harness {
    let backend = CaptureBackend::new(true).with_accepted(accepted);
    let captured = backend.captured();
    let (tx, events) = unbounded();
    let sink: EventSink = Arc::new(move |e| {
        let _ = tx.send(e);
    });
    let engine = Engine::with_backend(Arc::new(backend), sink);
    engine.send(Command::SetVolume { gain: 1. });
    engine.send(Command::SetOutput {
        config: OutputConfig {
            api: OutputApi::Null,
            device_id: None,
            buffer_ms: 10,
            ..Default::default()
        },
    });
    Harness {
        engine,
        events,
        captured,
        _dir: tempfile_dir::TempDir::new(tag),
    }
}

impl Harness {
    fn dir(&self) -> &Path {
        self._dir.path()
    }

    fn wait_for<T>(&self, timeout: Duration, mut pick: impl FnMut(&Event) -> Option<T>) -> T {
        let deadline = Instant::now() + timeout;
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            match self.events.recv_timeout(left) {
                Ok(e) => {
                    if let Event::Error { message } = &e {
                        panic!("引擎报告错误: {message}");
                    }
                    if let Some(v) = pick(&e) {
                        return v;
                    }
                }
                Err(_) => panic!("等待事件超时"),
            }
        }
    }

    fn play_to_end(&self, path: &Path) -> Vec<Event> {
        self.engine.send(Command::Play {
            path: path.display().to_string(),
            start_ms: None,
        });
        let mut seen = Vec::new();
        self.wait_for(Duration::from_secs(20), |e| {
            seen.push(e.clone());
            matches!(e, Event::QueueEnded).then_some(())
        });
        seen
    }

    fn captured_prefix(&self, len: usize) -> Vec<u8> {
        let c = self.captured.lock();
        assert!(c.len() >= len, "捕获到的数据不足: {} < {len}", c.len());
        c[..len].to_vec()
    }
}

fn cfg(rate: u32, channels: u16, format: SampleFormat) -> StreamConfig {
    StreamConfig {
        sample_rate: rate,
        channels,
        format,
    }
}

#[test]
fn lightweight_without_visual_analysis_preserves_audio_bytes() {
    let h = harness(
        "light-without-fft",
        vec![cfg(192000, 2, SampleFormat::I24In32)],
    );
    h.engine.set_visualization_enabled(false);
    let samples = gen_samples(192000 / 5 * 2, 24, 0xb5);
    let path = write_wav(h.dir(), "light.wav", 192000, 2, 24, &samples);
    h.play_to_end(&path);
    let expected = expected_bytes(&samples, 24, SampleFormat::I24In32);
    assert_eq!(h.captured_prefix(expected.len()), expected);
    assert!(!h.engine.viz_frame(&mut Vec::new()));
}

#[test]
fn seek_then_immediate_pause_retains_the_acknowledged_position() {
    let h = harness("seek-pause-order", vec![cfg(48000, 2, SampleFormat::I16)]);
    let samples = vec![1000; 48000 * 20 * 2];
    let path = write_wav(h.dir(), "seek-pause.wav", 48000, 2, 16, &samples);
    h.engine.send(Command::Play {
        path: path.display().to_string(),
        start_ms: None,
    });
    h.wait_for(Duration::from_secs(5), |event| {
        matches!(event, Event::Position {position_ms,..} if *position_ms > 0).then_some(())
    });
    for target in [7000, 12000, 3000] {
        h.engine.send(Command::Seek {
            position_ms: target,
        });
        h.engine.send(Command::Pause);
        h.wait_for(Duration::from_secs(5), |event| {
            matches!(
                event,
                Event::State {
                    state: jap_core::PlaybackState::Paused
                }
            )
            .then_some(())
        });
        let paused = h.wait_for(Duration::from_secs(5), |event| match event {
            Event::Position { position_ms, .. } => Some(*position_ms),
            _ => None,
        });
        assert!(
            paused >= target.saturating_sub(20) && paused < target + 200,
            "stale paused position {paused}, expected {target}"
        );
        std::thread::sleep(Duration::from_millis(60));
        h.engine.send(Command::Resume);
        let resumed = h.wait_for(Duration::from_secs(5), |event| match event {
            Event::Position { position_ms, .. } => Some(*position_ms),
            _ => None,
        });
        assert!(
            resumed >= target.saturating_sub(20) && resumed < target + 500,
            "seek timeline regressed to {resumed}, expected {target}"
        );
    }
}

#[test]
fn negotiated_shared_format_rebuilds_the_ring_before_applying_volume() {
    use jap_output::{OpenRequest, OpenedStream, OutputBackend, RenderSource};
    struct NativeShared(CaptureBackend);
    impl OutputBackend for NativeShared {
        fn list_devices(&self, api: OutputApi) -> jap_output::Result<Vec<jap_core::DeviceInfo>> {
            self.0.list_devices(api)
        }
        fn probe_exclusive(&self, id: Option<&str>) -> jap_output::Result<Vec<StreamConfig>> {
            self.0.probe_exclusive(id)
        }
        fn open(
            &self,
            request: &OpenRequest,
            source: Box<dyn RenderSource>,
        ) -> jap_output::Result<OpenedStream> {
            let mut native = request.clone();
            native.candidates = vec![cfg(48000, 2, SampleFormat::I16)];
            let mut stream = self.0.open(&native, source)?;
            stream.exclusive = false;
            Ok(stream)
        }
    }
    let backend = CaptureBackend::new(true);
    let captured = backend.captured();
    let (tx, events) = unbounded();
    let engine = Engine::with_backend(
        Arc::new(NativeShared(backend)),
        Arc::new(move |event| {
            let _ = tx.send(event);
        }),
    );
    engine.send(Command::SetOutput {
        config: OutputConfig {
            api: OutputApi::CoreAudio,
            ..Default::default()
        },
    });
    engine.send(Command::SetVolume { gain: 0.5 });
    let h = Harness {
        engine,
        events,
        captured,
        _dir: tempfile_dir::TempDir::new("native-format-layout"),
    };
    let samples = vec![10000; 48000 / 2];
    let path = write_wav(h.dir(), "shared.wav", 48000, 2, 16, &samples);
    h.play_to_end(&path);
    let expected = expected_bytes(&vec![5000; samples.len()], 16, SampleFormat::I16);
    assert_eq!(
        h.captured_prefix(expected.len()),
        expected,
        "gain used the requested format instead of the negotiated device format"
    );
}

#[test]
fn enabling_dsp_changes_captured_samples_and_removes_bit_perfect_verdict() {
    let h = harness("dsp-capture", vec![cfg(44100, 2, SampleFormat::I16)]);
    let samples = vec![10000; 44100];
    let path = write_wav(h.dir(), "dsp.wav", 44100, 2, 16, &samples);
    h.engine.send(Command::SetDsp {
        config: jap_core::DspConfig {
            enabled: true,
            preamp_db: -6.,
            ..Default::default()
        },
    });
    let events = h.play_to_end(&path);
    assert!(
        events
            .iter()
            .any(|e| matches!(e, Event::SignalPath { path } if path.verdict == Verdict::Processed))
    );
    let captured = h.captured_prefix(samples.len() * 2);
    let steady = i16::from_le_bytes(captured[10000..10002].try_into().unwrap());
    assert!(
        (steady - 5012).abs() <= 1,
        "Expected -6 dB gain in actual engine output, got {steady}"
    );
}

fn check_bit_perfect(bits: u32, device_format: SampleFormat, tag: &str) {
    let h = harness(tag, vec![cfg(44_100, 2, device_format)]);
    let samples = gen_samples(44_100 / 2 * 2, bits, 0xC0FFEE ^ u64::from(bits));
    let wav = write_wav(h.dir(), "a.wav", 44_100, 2, bits, &samples);

    let events = h.play_to_end(&wav);

    let expected = expected_bytes(&samples, bits, device_format);
    assert_eq!(
        h.captured_prefix(expected.len()),
        expected,
        "{bits}-bit -> {device_format:?} 不是逐位一致"
    );

    let path = events.iter().find_map(|e| match e {
        Event::SignalPath { path } => Some(path.clone()),
        _ => None,
    });
    let path: SignalPath = path.expect("应当收到信号链");
    assert_eq!(path.verdict, Verdict::BitPerfect);
}

#[test]
fn sixteen_bit_is_bit_perfect_into_16_bit_device() {
    check_bit_perfect(16, SampleFormat::I16, "b16");
}

#[test]
fn sixteen_bit_widens_losslessly_into_24_in_32() {
    let h = harness("w16", vec![cfg(44_100, 2, SampleFormat::I24In32)]);
    let samples = gen_samples(44_100, 16, 7);
    let wav = write_wav(h.dir(), "a.wav", 44_100, 2, 16, &samples);
    h.play_to_end(&wav);

    let expected = expected_bytes(&samples, 16, SampleFormat::I24In32);
    assert_eq!(h.captured_prefix(expected.len()), expected);
}

#[test]
fn twenty_four_bit_is_bit_perfect_in_both_24_bit_layouts() {
    check_bit_perfect(24, SampleFormat::I24In32, "b24a");
    check_bit_perfect(24, SampleFormat::I24Packed, "b24b");
}

#[test]
fn thirty_two_bit_is_bit_perfect() {
    check_bit_perfect(32, SampleFormat::I32, "b32");
}

#[test]
fn float64_keeps_every_mantissa_bit_into_a_float64_device() {
    let h = harness("float64", vec![cfg(48000, 2, SampleFormat::F64)]);
    let samples: Vec<f64> = (0..9600)
        .map(|i| {
            if i % 2 == 0 {
                f64::from_bits(0x3fd0000000000001 + i as u64)
            } else {
                -0.12345678901234567
            }
        })
        .collect();
    let expected: Vec<u8> = samples.iter().flat_map(|v| v.to_le_bytes()).collect();
    let mut file = Vec::new();
    file.extend(b"RIFF");
    file.extend((36u32 + expected.len() as u32).to_le_bytes());
    file.extend(b"WAVEfmt ");
    file.extend(16u32.to_le_bytes());
    file.extend(3u16.to_le_bytes());
    file.extend(2u16.to_le_bytes());
    file.extend(48000u32.to_le_bytes());
    file.extend((48000u32 * 16).to_le_bytes());
    file.extend(16u16.to_le_bytes());
    file.extend(64u16.to_le_bytes());
    file.extend(b"data");
    file.extend((expected.len() as u32).to_le_bytes());
    file.extend(&expected);
    let path = h.dir().join("64.wav");
    std::fs::write(&path, file).unwrap();
    h.engine.send(Command::Play {
        path: path.display().to_string(),
        start_ms: None,
    });
    let mut verdict = None;
    h.wait_for(Duration::from_secs(10), |e| {
        if let Event::SignalPath { path } = e {
            verdict = Some(path.verdict);
        }
        matches!(e, Event::QueueEnded).then_some(())
    });
    assert_eq!(verdict, Some(Verdict::BitPerfect));
    assert_eq!(h.captured_prefix(expected.len()), expected);
}

#[test]
fn gapless_queue_has_no_samples_inserted_between_tracks() {
    let h = harness("gap", vec![cfg(44_100, 2, SampleFormat::I16)]);
    let a = gen_samples(44_100, 16, 11);
    let b = gen_samples(44_100, 16, 13);
    let wa = write_wav(h.dir(), "a.wav", 44_100, 2, 16, &a);
    let wb = write_wav(h.dir(), "b.wav", 44_100, 2, 16, &b);

    h.engine.send(Command::Play {
        path: wa.display().to_string(),
        start_ms: None,
    });
    h.engine.send(Command::QueueNext {
        path: Some(wb.display().to_string()),
    });

    let mut changed = 0;
    h.wait_for(Duration::from_secs(20), |e| {
        if matches!(e, Event::TrackChanged { .. }) {
            changed += 1;
        }
        matches!(e, Event::QueueEnded).then_some(())
    });
    assert_eq!(changed, 2, "两首都应触发 TrackChanged");

    let mut expected = expected_bytes(&a, 16, SampleFormat::I16);
    expected.extend(expected_bytes(&b, 16, SampleFormat::I16));
    assert_eq!(
        h.captured_prefix(expected.len()),
        expected,
        "两首之间必须零间隙"
    );
}

#[test]
fn seek_lands_on_the_requested_frame() {
    let h = harness("seek", vec![cfg(44_100, 2, SampleFormat::I16)]);
    let frames = 44_100 * 3;
    let samples = gen_samples(frames * 2, 16, 21);
    let wav = write_wav(h.dir(), "a.wav", 44_100, 2, 16, &samples);

    h.engine.send(Command::Play {
        path: wav.display().to_string(),
        start_ms: None,
    });
    h.wait_for(Duration::from_secs(10), |e| match e {
        Event::Position { position_ms, .. } if *position_ms >= 100 => Some(()),
        _ => None,
    });

    let target_ms = 2_000u64;
    h.engine.send(Command::Seek {
        position_ms: target_ms,
    });
    h.wait_for(Duration::from_secs(20), |e| {
        matches!(e, Event::QueueEnded).then_some(())
    });

    // 渐入段之后的数据必须正好是源文件从目标帧起的内容
    let target_frame = (target_ms * 44_100 / 1000) as usize;
    let probe_frame = target_frame + 2_000;
    let expected = expected_bytes(&samples, 16, SampleFormat::I16);
    let bpf = 4;
    let needle = &expected[probe_frame * bpf..probe_frame * bpf + 256];
    let tail = &expected[probe_frame * bpf..];

    let c = h.captured.lock();
    let at = c
        .windows(needle.len())
        .rposition(|w| w == needle)
        .expect("捕获数据里找不到跳转之后的内容");
    assert_eq!(
        &c[at..at + tail.len()],
        tail,
        "跳转后的数据应与源文件从该帧起逐位一致"
    );
}

#[test]
fn incompatible_next_track_rebuilds_the_device_and_still_plays_both() {
    let h = harness("rebuild", Vec::new());
    let a = gen_samples(44_100 / 2 * 2, 16, 31);
    let b = gen_samples(48_000 / 2 * 2, 16, 37);
    let wa = write_wav(h.dir(), "a.wav", 44_100, 2, 16, &a);
    let wb = write_wav(h.dir(), "b.wav", 48_000, 2, 16, &b);

    h.engine.send(Command::Play {
        path: wa.display().to_string(),
        start_ms: None,
    });
    h.engine.send(Command::QueueNext {
        path: Some(wb.display().to_string()),
    });

    let mut changed = 0;
    h.wait_for(Duration::from_secs(20), |e| {
        if matches!(e, Event::TrackChanged { .. }) {
            changed += 1;
        }
        matches!(e, Event::QueueEnded).then_some(())
    });
    assert_eq!(changed, 2);

    let ea = expected_bytes(&a, 16, SampleFormat::I16);
    let eb = expected_bytes(&b, 16, SampleFormat::I16);
    let c = h.captured.lock();
    assert_eq!(&c[..ea.len()], &ea[..]);
    let at = c
        .windows(64)
        .position(|w| w == &eb[..64])
        .expect("第二首的数据缺失");
    assert!(at >= ea.len());
    assert_eq!(&c[at..at + eb.len()], &eb[..]);
}

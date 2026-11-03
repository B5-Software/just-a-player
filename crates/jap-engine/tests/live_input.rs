use std::sync::Arc;
use std::time::{Duration, Instant};

use jap_core::{
    AudioFormat, Command, Event, OutputApi, OutputConfig, SampleFormat, StreamConfig, TrackInfo,
};
use jap_decode::live::{LiveConfig, LiveEncoding, LiveInput};
use jap_engine::Engine;
use jap_output::CaptureBackend;

fn config(start_frame: u64) -> LiveConfig {
    LiveConfig {
        track: TrackInfo {
            path: "external://test/1".into(),
            codec: "外部 PCM · 解码器前级".into(),
            format: AudioFormat {
                sample_rate: 48000,
                channels: 2,
                bits: Some(24),
                float: false,
            },
            duration_ms: Some(3000),
            lossless: true,
            bitrate_kbps: None,
            title: Some("Live test".into()),
            artist: None,
            album: None,
        },
        encoding: LiveEncoding::Pcm {
            format: SampleFormat::I24In32,
            planar: false,
        },
        start_frame,
        trim_start_frames: 0,
    }
}

#[test]
fn bounded_ingress_preserves_samples_waits_for_data_and_uses_source_time() {
    let input = LiveInput::new(config(96000)).unwrap();
    let backend = CaptureBackend::new(true).with_accepted(vec![StreamConfig {
        sample_rate: 48000,
        channels: 2,
        format: SampleFormat::I24In32,
    }]);
    let captured = backend.captured();
    let (tx, rx) = crossbeam_channel::unbounded();
    let engine = Engine::with_backend(
        Arc::new(backend),
        Arc::new(move |e| {
            let _ = tx.send(e);
        }),
    );
    engine.send(Command::SetVolume { gain: 1. });
    engine.send(Command::SetOutput {
        config: OutputConfig {
            api: OutputApi::Null,
            buffer_ms: 10,
            ..Default::default()
        },
    });
    engine.play_live(input.clone());
    // A live source must not turn an empty queue into EOF or a decoder error.
    std::thread::sleep(Duration::from_millis(60));
    assert!(
        !rx.try_iter()
            .any(|e| matches!(e, Event::QueueEnded | Event::Error { .. }))
    );
    let mut expected = Vec::new();
    for block in 0..8u64 {
        let mut bytes = Vec::new();
        for i in 0..4096i32 {
            bytes.extend_from_slice(
                &((i.wrapping_mul(8713).wrapping_add(block as i32)) << 8).to_le_bytes(),
            );
        }
        expected.extend_from_slice(&bytes);
        input.push(96000 + block * 2048, 2048, bytes).unwrap();
    }
    input.close();
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut position = false;
    loop {
        match rx
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .unwrap()
        {
            Event::Position { position_ms, .. } if position_ms >= 2000 => position = true,
            Event::QueueEnded => break,
            Event::Error { message } => panic!("{message}"),
            _ => {}
        }
    }
    assert!(position);
    assert_eq!(&captured.lock()[..expected.len()], &expected);
}

#[test]
fn stream_discontinuity_malformed_pcm_and_queue_overflow_are_not_silent() {
    let input = LiveInput::new(config(100)).unwrap();
    assert!(input.push(0, 1, vec![0; 8]).is_err());
    assert!(input.push(100, 1, vec![0; 7]).is_err());
    let packet = vec![0; 2 * 1024 * 1024];
    for i in 0..8 {
        input
            .push(100 + i * 262144, 262144, packet.clone())
            .unwrap();
    }
    assert!(input.push(100 + 8 * 262144, 262144, packet).is_err());
    input.close();
    assert!(input.push(100 + 8 * 262144, 1, vec![0; 8]).is_err());
}

#[test]
fn small_packets_do_not_exhaust_the_queue_before_its_byte_budget() {
    let input = LiveInput::new(config(0)).unwrap();
    for frame in 0..2048 {
        input.push(frame, 1, vec![0; 8]).unwrap();
    }
    let mut source = input.source().unwrap();
    let mut samples = Vec::new();
    for _ in 0..2048 {
        assert_eq!(source.read(&mut samples).unwrap(), 1);
    }
    assert_eq!(samples.len(), 4096);
}

#[test]
fn planar_samples_and_packet_seek_trimming_keep_channels_and_exact_source_position() {
    let mut c = config(48000);
    c.track.format.bits = Some(32);
    c.track.format.float = true;
    c.encoding = LiveEncoding::Pcm {
        format: SampleFormat::F32,
        planar: true,
    };
    c.trim_start_frames = 5;
    let input = LiveInput::new(c).unwrap();
    let mut source = input.source().unwrap();
    assert_eq!(source.position_frames(), 48005);
    for block in 0..2u64 {
        let mut bytes = Vec::new();
        for channel in 0..2 {
            for i in 0..4 {
                let value = (block * 4 + i) as f32 / 16. * if channel == 0 { 1. } else { -1. };
                bytes.extend_from_slice(&value.to_le_bytes());
            }
        }
        input.push(48000 + block * 4, 4, bytes).unwrap();
    }
    let mut out = vec![42.];
    assert!(matches!(
        source.read(&mut out),
        Err(jap_decode::DecodeError::Pending)
    ));
    assert_eq!(out, vec![42.]);
    assert_eq!(source.read(&mut out).unwrap(), 3);
    assert_eq!(
        &out[1..],
        &[
            5. / 16.,
            -5. / 16.,
            6. / 16.,
            -6. / 16.,
            7. / 16.,
            -7. / 16.
        ]
    );
    assert_eq!(source.position_frames(), 48008);
    input.close();
    assert_eq!(source.read(&mut out).unwrap(), 0);
}

#[test]
fn original_flac_packets_are_decoded_in_rust_without_a_temporary_file() {
    use symphonia::core::{
        formats::probe::Hint,
        formats::{FormatOptions, TrackType},
        io::MediaSourceStream,
        meta::MetadataOptions,
    };
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../scripts/fixtures/pcm24-768.flac");
    let mut reference = jap_decode::open(&path).unwrap();
    let mut samples = Vec::new();
    while reference.read(&mut samples).unwrap() > 0 {}
    let expected: Vec<u8> = samples
        .iter()
        .flat_map(|x| ((*x * 8388608.).round() as i32).to_le_bytes()[..3].to_vec())
        .collect();
    let mut format = symphonia::default::get_probe()
        .probe(
            &Hint::new(),
            MediaSourceStream::new(
                Box::new(std::fs::File::open(path).unwrap()),
                Default::default(),
            ),
            FormatOptions::default(),
            MetadataOptions::default(),
        )
        .unwrap();
    let params = format
        .default_track(TrackType::Audio)
        .unwrap()
        .codec_params
        .as_ref()
        .unwrap()
        .audio()
        .unwrap();
    let mut config = config(0);
    config.track = reference.info().clone();
    config.track.path = "external://flac-test".into();
    config.encoding = LiveEncoding::Flac {
        streaminfo: params.extra_data.as_ref().unwrap().to_vec(),
    };
    let input = LiveInput::new(config).unwrap();
    let backend = CaptureBackend::new(true).with_accepted(vec![StreamConfig {
        sample_rate: 768000,
        channels: 2,
        format: SampleFormat::I24Packed,
    }]);
    let captured = backend.captured();
    let (tx, rx) = crossbeam_channel::unbounded();
    let engine = Engine::with_backend(
        Arc::new(backend),
        Arc::new(move |e| {
            let _ = tx.send(e);
        }),
    );
    engine.send(Command::SetVolume { gain: 1. });
    engine.send(Command::SetOutput {
        config: OutputConfig {
            api: OutputApi::Null,
            buffer_ms: 10,
            ..Default::default()
        },
    });
    engine.play_live(input.clone());
    while let Some(p) = format.next_packet().unwrap() {
        input
            .push(p.pts.get() as u64, p.dur.get() as u32, p.data.into_vec())
            .unwrap();
    }
    input.close();
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match rx
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .unwrap()
        {
            Event::QueueEnded => break,
            Event::Error { message } => panic!("{message}"),
            _ => {}
        }
    }
    assert_eq!(&captured.lock()[..expected.len()], &expected);
}

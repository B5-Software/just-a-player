use jap_core::{
    Command, Event, OutputApi, OutputConfig, SampleFormat, StreamConfig, Verdict, device::DsdMode,
};
use jap_engine::Engine;
use jap_output::CaptureBackend;
use std::{sync::Arc, time::Duration};

fn dsf(path: &std::path::Path, rate: u32) -> Vec<u8> {
    let frames = 16384usize;
    let block = 4096usize;
    let raw: Vec<u8> = (0..frames)
        .flat_map(|i| [(i * 31) as u8, (i * 17 + 1) as u8])
        .collect();
    let mut bytes = b"DSD ".to_vec();
    bytes.extend(28u64.to_le_bytes());
    bytes.extend((92u64 + raw.len() as u64).to_le_bytes());
    bytes.extend(0u64.to_le_bytes());
    bytes.extend(b"fmt ");
    bytes.extend(52u64.to_le_bytes());
    for v in [1u32, 0, 2, 2, rate, 1] {
        bytes.extend(v.to_le_bytes());
    }
    bytes.extend((frames as u64 * 8).to_le_bytes());
    bytes.extend((block as u32).to_le_bytes());
    bytes.extend(0u32.to_le_bytes());
    bytes.extend(b"data");
    bytes.extend((12u64 + raw.len() as u64).to_le_bytes());
    for group in 0..frames / block {
        for ch in 0..2 {
            for i in 0..block {
                bytes.push(raw[(group * block + i) * 2 + ch].reverse_bits());
            }
        }
    }
    std::fs::write(path, bytes).unwrap();
    raw
}

#[test]
fn dsd64_128_256_are_bit_exact_through_the_complete_engine_for_dop_and_native() {
    for rate in [2_822_400u32, 5_644_800, 11_289_600] {
        for format in [
            SampleFormat::Dop24,
            SampleFormat::Dop32,
            SampleFormat::DsdU8Lsb,
            SampleFormat::DsdU8Msb,
        ] {
            let path = std::env::temp_dir().join(format!(
                "jap-dsd-e2e-{}-{rate}-{format:?}.dsf",
                std::process::id()
            ));
            let raw = dsf(&path, rate);
            let dop = matches!(format, SampleFormat::Dop24 | SampleFormat::Dop32);
            let config = StreamConfig {
                sample_rate: rate / if dop { 16 } else { 8 },
                channels: 2,
                format,
            };
            let backend = CaptureBackend::new(true).with_accepted(vec![config]);
            let capture = backend.captured();
            let (tx, rx) = std::sync::mpsc::channel();
            let engine = Engine::with_backend(
                Arc::new(backend),
                Arc::new(move |event| {
                    let _ = tx.send(event);
                }),
            );
            engine.send(Command::SetVolume { gain: 1. });
            engine.send(Command::SetOutput {
                config: OutputConfig {
                    api: OutputApi::Null,
                    dsd_mode: if dop { DsdMode::Dop } else { DsdMode::Native },
                    ..Default::default()
                },
            });
            engine.send(Command::Play {
                path: path.to_string_lossy().into_owned(),
                start_ms: None,
            });
            let mut perfect = false;
            loop {
                match rx
                    .recv_timeout(Duration::from_secs(10))
                    .expect("DSD playback timed out")
                {
                    Event::Error { message } => panic!("{message}"),
                    Event::SignalPath { path } => {
                        assert_eq!(path.verdict, Verdict::BitPerfect);
                        perfect = true;
                    }
                    Event::QueueEnded => break,
                    _ => {}
                }
            }
            let mut expected = Vec::new();
            if dop {
                for (frame, pair) in raw.as_chunks::<4>().0.iter().enumerate() {
                    for ch in 0..2 {
                        if format == SampleFormat::Dop32 {
                            expected.push(0);
                        }
                        expected.extend_from_slice(&[
                            pair[ch + 2],
                            pair[ch],
                            if frame % 2 == 0 { 0x05 } else { 0xfa },
                        ]);
                    }
                }
            } else if format == SampleFormat::DsdU8Lsb {
                expected.extend(raw.iter().map(|v| v.reverse_bits()));
            } else {
                expected.extend(&raw);
            }
            let recorded = capture.lock();
            assert!(perfect);
            assert!(recorded.len() >= expected.len());
            assert_eq!(
                &recorded[..expected.len()],
                &expected,
                "DSD bit mismatch at {rate} Hz, {format:?}"
            );
            drop(recorded);
            drop(engine);
            std::fs::remove_file(&path).unwrap();
        }
    }
}

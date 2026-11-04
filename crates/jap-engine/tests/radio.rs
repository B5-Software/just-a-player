use std::io::{BufRead, BufReader, Cursor, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::thread;
use std::time::{Duration, Instant};

use crossbeam_channel::Receiver;
use jap_core::{Command, Event, OutputApi, OutputConfig, PlaybackState};
use jap_engine::Engine;
use jap_output::CaptureBackend;

fn send_wave(mut stream: TcpStream, bytes: &[u8]) {
    let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: audio/wav\r\nIcy-Name: Test Radio\r\nConnection: close\r\n\r\n");
    let _ = stream.write_all(bytes);
}

fn request_path(stream: &TcpStream) -> Option<String> {
    let mut reader = BufReader::new(stream).take(8192);
    let mut first = String::new();
    if reader.read_line(&mut first).ok()? == 0 {
        return None;
    }
    let path = first.split_whitespace().nth(1)?.to_owned();
    loop {
        let mut header = String::new();
        if reader.read_line(&mut header).ok()? == 0 {
            return None;
        }
        if header == "\r\n" || header == "\n" {
            return Some(path);
        }
    }
}

#[track_caller]
fn await_event(events: &Receiver<Event>, pred: impl Fn(&Event) -> bool) {
    let deadline = Instant::now() + Duration::from_secs(6);
    loop {
        let event = events
            .recv_deadline(deadline)
            .expect("missing playback event");
        assert!(
            !matches!(event, Event::Error { .. } | Event::QueueEnded),
            "{event:?}"
        );
        if pred(&event) {
            return;
        }
    }
}

#[test]
fn radio_resolves_playlist_reconnects_and_cancels_without_blocking_controls() {
    let mut bytes = Cursor::new(Vec::new());
    let mut wav = hound::WavWriter::new(
        &mut bytes,
        hound::WavSpec {
            channels: 2,
            sample_rate: 48000,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        },
    )
    .unwrap();
    for i in 0..48000 {
        wav.write_sample(if i % 24 < 12 { 16_000i16 } else { -16_000 })
            .unwrap();
    }
    wav.finalize().unwrap();
    let audio = Arc::new(bytes.into_inner());
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let address = listener.local_addr().unwrap();
    let connects = Arc::new(AtomicUsize::new(0));
    let stopped = Arc::new(AtomicBool::new(false));
    let stalled = Arc::new(AtomicBool::new(false));
    let server = thread::spawn({
        let (connects, stopped, stalled) = (connects.clone(), stopped.clone(), stalled.clone());
        move || {
            let mut workers = Vec::new();
            while !stopped.load(Ordering::Relaxed) {
                let Ok((mut stream, _)) = listener.accept() else {
                    thread::sleep(Duration::from_millis(5));
                    continue;
                };
                stream
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let (audio, connects, stopped, stalled) = (
                    audio.clone(),
                    connects.clone(),
                    stopped.clone(),
                    stalled.clone(),
                );
                // An idle or cancelled connection must not block acceptance of
                // the next real request. Each reader has a bounded timeout.
                workers.push(thread::spawn(move || {
                    let Some(request) = request_path(&stream) else {
                        return;
                    };
                    match request.as_str() {
                        "/station.pls" => {
                            let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: audio/x-scpls\r\nConnection: close\r\n\r\n[playlist]\nFile1=./redirect\n");
                        }
                        "/redirect" => {
                            let _ = stream.write_all(b"HTTP/1.1 302 Found\r\nLocation: /Stream?Case=Yes\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                        }
                        "/Stream?Case=Yes" => {
                            connects.fetch_add(1, Ordering::Relaxed);
                            send_wave(stream, &audio);
                        }
                        "/stall" => {
                            stalled.store(true, Ordering::Release);
                            while !stopped.load(Ordering::Relaxed) {
                                thread::sleep(Duration::from_millis(5));
                            }
                        }
                        _ => panic!("unexpected request: {request}"),
                    }
                }));
            }
            for worker in workers {
                worker.join().unwrap();
            }
        }
    });
    // Reproduce a speculative or cancelled connection before the real HTTP
    // request. It must not consume a stream request or terminate the fixture.
    drop(TcpStream::connect(address).unwrap());
    let backend = CaptureBackend::new(true);
    let capture = backend.captured();
    let (tx, rx) = crossbeam_channel::unbounded();
    let engine = Engine::with_backend(
        Arc::new(backend),
        Arc::new(move |event| {
            let _ = tx.send(event);
        }),
    );
    engine.send(Command::SetOutput {
        config: OutputConfig {
            api: OutputApi::Null,
            ..Default::default()
        },
    });
    let station = format!("http://{address}/station.pls");
    let play = |path: &str| {
        engine.send(Command::Play {
            path: path.into(),
            start_ms: Some(15000),
        })
    };
    play(&station);
    await_event(&rx, |event| {
        matches!(event, Event::TrackChanged { track }
        if track.path == station && track.duration_ms.is_none() && track.title.as_deref() == Some("Test Radio"))
    });
    await_event(
        &rx,
        |event| matches!(event, Event::Position { position_ms, .. } if *position_ms > 550),
    );
    assert!(
        connects.load(Ordering::Relaxed) >= 2,
        "stream did not reconnect"
    );
    assert!(
        capture.lock().iter().any(|byte| *byte != 0),
        "expected decoded PCM output"
    );
    engine.send(Command::Pause);
    await_event(&rx, |e| {
        matches!(
            e,
            Event::State {
                state: PlaybackState::Paused
            }
        )
    });
    engine.send(Command::Resume);
    await_event(&rx, |e| matches!(e, Event::TrackChanged { .. }));
    // Keep another connection idle while a real request starts. One idle
    // reader must not serialize or delay the stalled-stream control test.
    let idle = TcpStream::connect(address).unwrap();
    play(&format!("http://{address}/stall"));
    let deadline = Instant::now() + Duration::from_secs(2);
    while !stalled.load(Ordering::Acquire) && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(10));
    }
    assert!(stalled.load(Ordering::Acquire));
    let start = Instant::now();
    engine.send(Command::Stop);
    await_event(&rx, |e| {
        matches!(
            e,
            Event::State {
                state: PlaybackState::Stopped
            }
        )
    });
    assert!(start.elapsed() < Duration::from_secs(1));
    drop(idle);
    play(&station);
    await_event(
        &rx,
        |e| matches!(e, Event::TrackChanged { track } if track.path == station),
    );
    engine.send(Command::Stop);
    stopped.store(true, Ordering::Relaxed);
    server.join().unwrap();
}

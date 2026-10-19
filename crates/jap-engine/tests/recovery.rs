//! Exercise the real engine/session rebuild after a driver resync notification.
use jap_core::{Command, Event, OutputApi, OutputConfig};
use jap_engine::{Engine, EventSink};
use jap_output::{
    CaptureBackend, OpenRequest, OpenedStream, OutputBackend, RenderSource, StreamEvent,
};
use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
        mpsc,
    },
    time::{Duration, Instant},
};
struct ResyncBackend {
    inner: CaptureBackend,
    sender: Mutex<Option<mpsc::Sender<StreamEvent>>>,
    opens: AtomicUsize,
    starts: Arc<AtomicUsize>,
}
struct CountedStream {
    inner: Box<dyn jap_output::StreamHandle>,
    starts: Arc<AtomicUsize>,
}
impl jap_output::StreamHandle for CountedStream {
    fn start(&self) {
        self.starts.fetch_add(1, Ordering::Relaxed);
        self.inner.start()
    }
}
impl OutputBackend for ResyncBackend {
    fn list_devices(&self, api: OutputApi) -> jap_output::Result<Vec<jap_core::DeviceInfo>> {
        self.inner.list_devices(api)
    }
    fn probe_exclusive(&self, id: Option<&str>) -> jap_output::Result<Vec<jap_core::StreamConfig>> {
        self.inner.probe_exclusive(id)
    }
    fn open(
        &self,
        request: &OpenRequest,
        source: Box<dyn RenderSource>,
    ) -> jap_output::Result<OpenedStream> {
        let mut opened = self.inner.open(request, source)?;
        let (tx, rx) = mpsc::channel();
        *self.sender.lock().unwrap() = Some(tx);
        opened.events = rx;
        opened.handle = Box::new(CountedStream {
            inner: opened.handle,
            starts: self.starts.clone(),
        });
        self.opens.fetch_add(1, Ordering::Relaxed);
        Ok(opened)
    }
}
#[test]
fn driver_resync_rebuilds_buffer_and_keeps_playing_at_current_position() {
    let path = std::env::temp_dir().join(format!("jap-recovery-{}.wav", std::process::id()));
    let mut wav = hound::WavWriter::create(
        &path,
        hound::WavSpec {
            channels: 2,
            sample_rate: 48000,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        },
    )
    .unwrap();
    for i in 0..48000 * 2 * 3 {
        wav.write_sample(((i % 1000) - 500) as i16).unwrap()
    }
    wav.finalize().unwrap();
    let backend = Arc::new(ResyncBackend {
        inner: CaptureBackend::new(true).discarding(),
        sender: Mutex::new(None),
        opens: AtomicUsize::new(0),
        starts: Arc::new(AtomicUsize::new(0)),
    });
    let (tx, rx) = mpsc::channel();
    let sink: EventSink = Arc::new(move |e| {
        let _ = tx.send(e);
    });
    let engine = Engine::with_backend(backend.clone(), sink);
    engine.send(Command::SetOutput {
        config: OutputConfig {
            api: OutputApi::Null,
            ..Default::default()
        },
    });
    engine.send(Command::Play {
        path: path.display().to_string(),
        start_ms: None,
    });
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut before = 0;
    while Instant::now() < deadline {
        if let Event::Position { position_ms, .. } =
            rx.recv_timeout(Duration::from_secs(2)).unwrap()
            && position_ms >= 200
        {
            before = position_ms;
            break;
        }
    }
    assert!(before >= 200);
    backend
        .sender
        .lock()
        .unwrap()
        .as_ref()
        .unwrap()
        .send(StreamEvent::ResetRequired("test resync".into()))
        .unwrap();
    let mut reset = false;
    let mut after = None;
    while Instant::now() < deadline {
        match rx.recv_timeout(Duration::from_secs(2)).unwrap() {
            Event::BufferReset { automatic: true } => reset = true,
            Event::Position { position_ms, .. } if reset && position_ms >= before => {
                after = Some(position_ms);
                break;
            }
            Event::Error { message } => panic!("{message}"),
            _ => {}
        }
    }
    assert!(reset);
    assert!(after.is_some());
    assert!(backend.opens.load(Ordering::Relaxed) >= 2);
    engine.send(Command::Pause);
    while !matches!(
        rx.recv_timeout(Duration::from_secs(2)).unwrap(),
        Event::State {
            state: jap_core::PlaybackState::Paused
        }
    ) {}
    engine.send(Command::ResetBuffer);
    while !matches!(
        rx.recv_timeout(Duration::from_secs(2)).unwrap(),
        Event::BufferReset { automatic: false }
    ) {}
    std::thread::sleep(Duration::from_millis(100));
    assert_eq!(
        backend.starts.load(Ordering::Relaxed),
        2,
        "Rebuilding a paused session must not start audio or produce a burst"
    );
    engine.send(Command::Resume);
    while backend.starts.load(Ordering::Relaxed) < 3 {
        let _ = rx.recv_timeout(Duration::from_secs(2)).unwrap();
    }
    drop(engine);
    std::fs::remove_file(path).unwrap();
}

use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use crossbeam_channel::{RecvTimeoutError, Sender, unbounded};
use jap_core::device::DsdMode;
use jap_core::{
    AudioFormat, Command, DspConfig, Event, OutputApi, OutputConfig, PlaybackState, Query,
    QueryResponse, SampleFormat, StreamConfig, TrackInfo,
};
use jap_decode::AudioSource;
use jap_output::{OutputBackend, SystemBackend, candidate_formats};
use parking_lot::Mutex;

use crate::producer::{ProducerCmd, TrackHandoff};
use crate::session::Session;
use crate::signal;
use crate::viz::VizTap;

pub type EventSink = Arc<dyn Fn(Event) + Send + Sync + 'static>;

const TICK: Duration = Duration::from_millis(10);
const POSITION_INTERVAL: Duration = Duration::from_millis(33);

enum Msg {
    Command(Command),
    Shutdown,
}

/// 播放引擎句柄。命令投递到引擎线程异步执行，事件通过 `EventSink` 回调。
pub struct Engine {
    tx: Sender<Msg>,
    thread: Option<JoinHandle<()>>,
    backend: Arc<dyn OutputBackend>,
    tap: Arc<VizTap>,
}

impl Engine {
    pub fn new(sink: EventSink) -> Self {
        Self::with_backend(Arc::new(SystemBackend), sink)
    }

    pub fn with_backend(backend: Arc<dyn OutputBackend>, sink: EventSink) -> Self {
        let (tx, rx) = unbounded();
        let core_backend = Arc::clone(&backend);
        let tap = VizTap::new();
        let core_tap = Arc::clone(&tap);
        let thread = thread::Builder::new()
            .name("jap-engine".into())
            .spawn(move || Core::new(core_backend, sink, core_tap).run(&rx))
            .expect("无法启动引擎线程");
        Self {
            tx,
            thread: Some(thread),
            backend,
            tap,
        }
    }

    /// 取一帧可视化分析数据（布局见 `jap-analysis`），没在播或画面未变时返回 `false`。
    pub fn viz_frame(&self, out: &mut Vec<f32>) -> bool {
        self.tap.frame(out)
    }
    /// Suspend visual-only resampling, history copies and FFT. Audio is unchanged.
    pub fn set_visualization_enabled(&self, enabled: bool) {
        self.tap.set_enabled(enabled);
    }

    pub fn send(&self, command: Command) {
        if let Command::SetMidi {
            soundfont,
            sample_rate,
        } = command
        {
            jap_decode::midi::configure(soundfont, sample_rate);
            return;
        }
        let _ = self.tx.send(Msg::Command(command));
    }

    pub fn query(&self, query: Query) -> QueryResponse {
        match query {
            Query::ListOutputDevices { api } => self
                .backend
                .list_devices(api)
                .map_or_else(error_response, |devices| QueryResponse::Devices { devices }),
            Query::ListDevices => self
                .backend
                .list_devices(OutputApi::platform_default())
                .map_or_else(error_response, |devices| QueryResponse::Devices { devices }),
            Query::ListAsioDevices => self
                .backend
                .list_devices(OutputApi::Asio)
                .map_or_else(error_response, |devices| QueryResponse::Devices { devices }),
            Query::ProbeExclusive { device_id } => self
                .backend
                .probe_exclusive(device_id.as_deref())
                .map_or_else(error_response, |formats| QueryResponse::ExclusiveFormats {
                    formats,
                }),
            Query::ProbeTrack { path } => match jap_decode::open(Path::new(&path)) {
                Ok(source) => QueryResponse::Track {
                    track: source.info().clone(),
                },
                Err(e) => QueryResponse::Error {
                    message: format!("{path}: {e}"),
                },
            },
            Query::DiscTracks { path } => jap_decode::disc::tracks(Path::new(&path))
                .map_or_else(error_response, |tracks| QueryResponse::Tracks { tracks }),
            Query::EmbeddedLyrics { path } => QueryResponse::Lyrics {
                text: jap_decode::read_lyrics(Path::new(&path)),
            },
            Query::DeviceFormats { api, device_id } => self
                .backend
                .probe_formats(api, device_id.as_deref())
                .map_or_else(error_response, |formats| QueryResponse::ExclusiveFormats {
                    formats,
                }),
        }
    }
}

fn error_response(error: impl std::fmt::Display) -> QueryResponse {
    QueryResponse::Error {
        message: error.to_string(),
    }
}

impl Drop for Engine {
    fn drop(&mut self) {
        let _ = self.tx.send(Msg::Shutdown);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

struct Loaded {
    source: Box<dyn AudioSource>,
    info: Arc<TrackInfo>,
}

struct Core {
    backend: Arc<dyn OutputBackend>,
    sink: EventSink,
    tap: Arc<VizTap>,
    output: OutputConfig,
    session: Option<Session>,
    state: PlaybackState,
    /// 当前正在听到的曲目路径。
    current_path: Option<String>,
    /// 与当前设备格式不兼容、需要重建设备才能播放的下一首。
    pending_next: Option<Loaded>,
    queued_next_path: Option<String>,
    last_position_ms: u64,
    last_position_emit: Instant,
    drain_started: Option<Instant>,
    seen_underruns: u32,
    dsp: Arc<Mutex<DspConfig>>,
    quality_cancel: Arc<AtomicBool>,
    volume: f32,
    last_recovery: Instant,
    underrun_window: Instant,
    underrun_count: u32,
    pending_recovery: bool,
    control_request: u64,
    pending_control: Option<u64>,
}

impl Core {
    fn new(backend: Arc<dyn OutputBackend>, sink: EventSink, tap: Arc<VizTap>) -> Self {
        Self {
            backend,
            sink,
            tap,
            output: OutputConfig::default(),
            session: None,
            state: PlaybackState::Stopped,
            current_path: None,
            pending_next: None,
            queued_next_path: None,
            last_position_ms: 0,
            last_position_emit: Instant::now(),
            drain_started: None,
            seen_underruns: 0,
            dsp: Arc::new(Mutex::new(DspConfig::default())),
            quality_cancel: Arc::new(AtomicBool::new(false)),
            volume: 0.2,
            last_recovery: Instant::now() - Duration::from_secs(10),
            underrun_window: Instant::now(),
            underrun_count: 0,
            pending_recovery: false,
            control_request: 0,
            pending_control: None,
        }
    }

    fn run(mut self, rx: &crossbeam_channel::Receiver<Msg>) {
        loop {
            match rx.recv_timeout(TICK) {
                Ok(Msg::Command(command)) => self.handle(command),
                Ok(Msg::Shutdown) | Err(RecvTimeoutError::Disconnected) => break,
                Err(RecvTimeoutError::Timeout) => {}
            }
            self.tick();
        }
        self.session = None;
        self.quality_cancel.store(true, Ordering::Relaxed);
    }

    fn emit(&self, event: Event) {
        (self.sink)(event);
    }

    fn error(&self, message: impl Into<String>) {
        let message = message.into();
        tracing::warn!("{message}");
        self.emit(Event::Error { message });
    }

    fn set_state(&mut self, state: PlaybackState) {
        if self.state != state {
            self.state = state;
            self.emit(Event::State { state });
        }
    }

    fn handle(&mut self, command: Command) {
        match command {
            Command::Play { path, start_ms } => self.play(&path, start_ms.unwrap_or(0)),
            Command::QueueNext { path } => self.queue_next(path),
            Command::Pause => self.pause(),
            Command::Resume => self.resume(),
            Command::Stop => self.stop(),
            Command::Seek { position_ms } => self.seek(position_ms),
            Command::SetOutput { config } => self.set_output(config),
            Command::SetDsp { config } => self.set_dsp(config),
            Command::SetMidi {
                soundfont,
                sample_rate,
            } => {
                jap_decode::midi::configure(soundfont, sample_rate);
            }
            Command::SetVolume { gain } => self.set_volume(gain),
            Command::ResetBuffer => self.reset_buffer(false),
            Command::AnalyzeQuality { path } => {
                self.quality_cancel.store(true, Ordering::Relaxed);
                self.quality_cancel = Arc::new(AtomicBool::new(false));
                crate::quality::start(
                    path,
                    Arc::clone(&self.sink),
                    Arc::clone(&self.quality_cancel),
                );
            }
        }
    }

    fn out_channels(&self, format: &AudioFormat) -> u16 {
        // 共享模式让系统去处理多声道；独占模式要么原样输出要么至少立体声
        if self.output.api.is_exclusive() {
            format.channels.max(2)
        } else {
            2
        }
    }

    fn open_track(path: &str) -> Result<Loaded, String> {
        let source = jap_decode::open(Path::new(path)).map_err(|e| format!("{path}: {e}"))?;
        let info = Arc::new(source.info().clone());
        Ok(Loaded { source, info })
    }

    fn play(&mut self, path: &str, start_ms: u64) {
        let mut loaded = match Self::open_track(path) {
            Ok(l) => l,
            Err(e) => return self.error(e),
        };
        if start_ms > 0
            && let Err(e) = loaded.source.seek(start_ms)
        {
            tracing::warn!("起播位置跳转失败，从头播放: {e}");
        }

        self.pending_next = None;
        self.queued_next_path = None;
        self.last_position_ms = start_ms;
        if let Err(e) = self.start_track(loaded) {
            self.error(e);
            self.stop();
            return;
        }
        self.current_path = Some(path.to_owned());
        self.drain_started = None;
        self.set_state(PlaybackState::Playing);
    }

    /// 能复用现有设备流就复用（无缝衔接），否则重建。
    fn start_track(&mut self, mut loaded: Loaded) -> Result<(), String> {
        self.control_request = self.control_request.wrapping_add(1);
        let request = self.control_request;
        self.pending_control = Some(request);
        let candidates = self.candidates(&loaded)?;
        if candidates.first().is_some_and(|c| c.format.is_dsd())
            && self.output.api != OutputApi::Null
            && self.volume < 1.
            && !self
                .backend
                .set_hardware_volume(
                    self.output.api,
                    self.output.device_id.as_deref(),
                    self.volume,
                )
                .map_err(|e| e.to_string())?
        {
            return Err("此 DSD 直通设备没有可验证的硬件音量控制，已阻止满幅输出。请选择 DSD → PCM 使用应用内音量。".into());
        }

        if let Some(session) = &self.session
            && session.started()
            && session.compatible(&candidates, self.output.api.is_exclusive())
        {
            loaded
                .source
                .set_transport(if session.config.format.is_dsd() {
                    Some(session.config.format)
                } else {
                    None
                });
            let track = TrackHandoff {
                source: loaded.source,
                info: loaded.info,
            };
            session.send(ProducerCmd::Load {
                track,
                resume: true,
                request,
            });
            return Ok(());
        }

        self.session = None;
        let session = Session::open(
            &*self.backend,
            &self.output,
            &candidates,
            &self.tap,
            &self.dsp,
            self.volume,
        )
        .map_err(|e| e.to_string())?;
        loaded
            .source
            .set_transport(if session.config.format.is_dsd() {
                Some(session.config.format)
            } else {
                None
            });
        let track = TrackHandoff {
            source: loaded.source,
            info: loaded.info,
        };
        session.send(ProducerCmd::Load {
            track,
            resume: false,
            request,
        });
        self.session = Some(session);
        self.seen_underruns = 0;
        self.pending_recovery = false;
        self.underrun_count = 0;
        self.underrun_window = Instant::now();
        Ok(())
    }

    fn reset_buffer(&mut self, automatic: bool) {
        if self.state == PlaybackState::Stopped {
            return;
        }
        let Some(path) = self.current_path.clone() else {
            return;
        };
        self.last_recovery = Instant::now();
        self.underrun_count = 0;
        self.pending_recovery = false;
        self.session = None;
        self.replay(&path, self.last_position_ms);
        self.emit(Event::BufferReset { automatic });
    }

    fn set_volume(&mut self, gain: f32) {
        if !gain.is_finite() || !(0. ..=1.).contains(&gain) {
            self.error("音量必须在 0–100% 之间");
            return;
        }
        if self
            .session
            .as_ref()
            .is_some_and(|s| s.config.format.is_dsd())
            && self.output.api != OutputApi::Null
        {
            match self.backend.set_hardware_volume(
                self.output.api,
                self.output.device_id.as_deref(),
                gain,
            ) {
                Ok(true) => {}
                _ if gain == 0. => {}
                _ => {
                    self.error("DSD 直通不支持软件衰减；已保留当前音量，请切换到 PCM 模式");
                    return;
                }
            }
        }
        self.volume = gain;
        if let Some(s) = &self.session {
            s.shared.volume.store(gain.to_bits(), Ordering::Release);
        }
        self.emit(Event::Volume { gain });
        if let Some(s) = &self.session
            && let Some(loc) = s.timeline.lock().locate(s.audible_playhead())
        {
            self.emit(Event::SignalPath {
                path: signal::build_with_controls(
                    &loc.info,
                    s.config,
                    &s.details,
                    &self.dsp.lock(),
                    self.volume,
                ),
            });
        }
    }

    fn candidates(&self, loaded: &Loaded) -> Result<Vec<StreamConfig>, String> {
        let src = loaded.info.format;
        if !src.is_dsd() || self.output.dsd_mode == DsdMode::Pcm {
            let pcm = loaded.source.playback_format();
            return Ok(candidate_formats(
                &pcm,
                self.output.api,
                self.out_channels(&pcm),
            ));
        }
        if self.dsp.lock().enabled {
            return Err("DSD 直通需要关闭 DSP；使用 DSD → PCM 模式可启用音效".into());
        }
        let formats = match self.output.dsd_mode {
            DsdMode::Dop if self.output.api.is_exclusive() => {
                vec![SampleFormat::Dop24, SampleFormat::Dop32]
            }
            DsdMode::Native
                if matches!(
                    self.output.api,
                    OutputApi::Asio | OutputApi::UsbExclusive | OutputApi::Null
                ) =>
            {
                vec![SampleFormat::DsdU8Msb, SampleFormat::DsdU8Lsb]
            }
            _ => {
                return Err(
                    "DoP 需要独占输出；原生 DSD 需要支持 DSD 的 ASIO 驱动或 Android USB RAW_DATA 接口".into(),
                );
            }
        };
        Ok(formats
            .into_iter()
            .map(|format| StreamConfig {
                sample_rate: src.sample_rate
                    / if matches!(format, SampleFormat::Dop24 | SampleFormat::Dop32) {
                        16
                    } else {
                        8
                    },
                channels: src.channels,
                format,
            })
            .collect())
    }

    fn set_dsp(&mut self, config: DspConfig) {
        if let Err(e) = config.validate() {
            self.error(e);
            return;
        }
        if config.enabled
            && self
                .session
                .as_ref()
                .is_some_and(|s| s.config.format.is_dsd())
        {
            self.error("DSD 直通时无法启用 DSP，请先切换到 DSD → PCM");
            return;
        }
        *self.dsp.lock() = config.clone();
        self.emit(Event::DspChanged { config });
        if let Some(s) = &self.session
            && let Some(loc) = s.timeline.lock().locate(s.audible_playhead())
        {
            self.emit(Event::SignalPath {
                path: signal::build_with_controls(
                    &loc.info,
                    s.config,
                    &s.details,
                    &self.dsp.lock(),
                    self.volume,
                ),
            });
        }
    }

    fn queue_next(&mut self, path: Option<String>) {
        self.pending_next = None;
        self.queued_next_path = None;
        let Some(session) = &self.session else { return };
        session.send(ProducerCmd::QueueNext(None));
        let Some(path) = path else { return };

        let mut loaded = match Self::open_track(&path) {
            Ok(l) => l,
            Err(e) => return self.error(e),
        };
        let candidates = match self.candidates(&loaded) {
            Ok(v) => v,
            Err(e) => {
                self.error(e);
                return;
            }
        };
        self.queued_next_path = Some(path);
        if session.compatible(&candidates, self.output.api.is_exclusive()) {
            loaded
                .source
                .set_transport(if session.config.format.is_dsd() {
                    Some(session.config.format)
                } else {
                    None
                });
            session.send(ProducerCmd::QueueNext(Some(TrackHandoff {
                source: loaded.source,
                info: loaded.info,
            })));
        } else {
            self.pending_next = Some(loaded);
        }
    }

    fn pause(&mut self) {
        if self.state != PlaybackState::Playing {
            return;
        }
        if let Some(session) = &self.session {
            session.shared.paused.store(true, Ordering::Release);
        }
        self.set_state(PlaybackState::Paused);
        self.emit_position();
    }

    fn resume(&mut self) {
        if self.state != PlaybackState::Paused {
            return;
        }
        if let Some(session) = &self.session {
            session.shared.paused.store(false, Ordering::Release);
        }
        self.set_state(PlaybackState::Playing);
    }

    fn stop(&mut self) {
        self.pending_control = None;
        self.session = None;
        self.pending_next = None;
        self.queued_next_path = None;
        self.drain_started = None;
        self.set_state(PlaybackState::Stopped);
    }

    fn seek(&mut self, position_ms: u64) {
        let Some(session) = &self.session else { return };
        let in_place = session.started()
            && !session.shared.finished.load(Ordering::Acquire)
            && session.shared.current_serial.load(Ordering::Acquire) == session.emitted_serial;

        if in_place {
            self.control_request = self.control_request.wrapping_add(1);
            self.pending_control = Some(self.control_request);
            session.send(ProducerCmd::Seek {
                ms: position_ms,
                request: self.control_request,
            });
            self.last_position_ms = position_ms;
            self.emit_position();
        } else if let Some(path) = self.current_path.clone() {
            // 设备尚未起播、曲目已写完或生产者已跑到下一首：直接从目标位置重开
            self.replay(&path, position_ms);
        }
    }

    fn replay(&mut self, path: &str, position_ms: u64) {
        let was_paused = self.state == PlaybackState::Paused;
        let queued = self.queued_next_path.clone();
        self.play(path, position_ms);
        if queued.is_some() {
            self.queue_next(queued);
        }
        if was_paused {
            self.pause();
        }
    }

    fn set_output(&mut self, config: OutputConfig) {
        if config == self.output {
            return;
        }
        let api_changed = config.api != self.output.api;
        self.output = config;

        // 仅在正在播放或已暂停时才热切换输出并保持原播放位置；
        // 如果当前是停止状态，只记录新配置，下次起播即自动生效。
        if (self.state == PlaybackState::Playing || self.state == PlaybackState::Paused)
            && let Some(path) = self.current_path.clone()
        {
            let position = self.last_position_ms;
            // 切换 API（共享↔独占）或设备时显式销毁旧会话，确保 Windows WASAPI 驱动释放硬件独占锁
            if api_changed || self.session.is_some() {
                self.session = None;
                std::thread::sleep(Duration::from_millis(80));
            }
            self.replay(&path, position);
        }
    }

    fn emit_position(&mut self) {
        let duration_ms = self
            .session
            .as_ref()
            .and_then(|s| s.timeline.lock().locate(s.audible_playhead()))
            .and_then(|loc| loc.info.duration_ms);
        self.last_position_emit = Instant::now();
        self.emit(Event::Position {
            position_ms: self.last_position_ms,
            duration_ms,
        });
    }

    fn tick(&mut self) {
        let Some(session) = self.session.as_mut() else {
            return;
        };

        if let Some(event) = session.poll_stream_event() {
            match event {
                jap_output::StreamEvent::Failed(msg) => {
                    self.error(format!("输出设备中断: {msg}"));
                    self.stop();
                    return;
                }
                jap_output::StreamEvent::ResetRequired(msg) => {
                    tracing::warn!("{msg}");
                    self.pending_recovery = true;
                }
            }
        }
        let producer_errors: Vec<String> = session.errors.try_iter().collect();

        session.start_if_primed();
        // Never re-publish the old timeline while a manual load/seek is in flight.
        // In particular, an immediate Pause must retain the requested seek position.
        if self
            .pending_control
            .is_some_and(|request| session.shared.control_ack.load(Ordering::Acquire) != request)
        {
            for message in producer_errors {
                self.error(message);
            }
            return;
        }
        self.pending_control = None;

        let underruns = session.shared.underruns.load(Ordering::Relaxed);
        let new_underruns = underruns.wrapping_sub(self.seen_underruns);
        self.seen_underruns = underruns;
        if self.underrun_window.elapsed() > Duration::from_secs(2) {
            self.underrun_window = Instant::now();
            self.underrun_count = 0;
        }
        self.underrun_count = self.underrun_count.saturating_add(new_underruns);

        let shared = Arc::clone(&session.shared);
        let rate = u64::from(session.config.sample_rate);
        let located = session.timeline.lock().locate(session.audible_playhead());

        let mut changed = None;
        if let Some(loc) = &located
            && loc.serial != session.emitted_serial
        {
            session.emitted_serial = loc.serial;
            changed = Some((
                Arc::clone(&loc.info),
                signal::build_with_controls(
                    &loc.info,
                    session.config,
                    &session.details,
                    &self.dsp.lock(),
                    self.volume,
                ),
            ));
        }
        let latency =
            Duration::from_secs_f64(f64::from(session.details.buffer_frames) / rate as f64)
                + Duration::from_millis(30);

        for msg in producer_errors {
            self.error(msg);
        }
        if new_underruns > 0 {
            tracing::warn!("设备缓冲欠载 {new_underruns} 次");
        }
        if self.pending_recovery && self.last_recovery.elapsed() > Duration::from_secs(2)
            || self.underrun_count >= 3 && self.last_recovery.elapsed() > Duration::from_secs(8)
        {
            self.reset_buffer(true);
            return;
        }

        if let Some((info, path)) = changed {
            self.current_path = Some(info.path.clone());
            if self.queued_next_path.as_deref() == Some(info.path.as_str()) {
                self.queued_next_path = None;
            }
            self.emit(Event::TrackChanged {
                track: (*info).clone(),
            });
            self.emit(Event::SignalPath { path });
        }

        if let Some(loc) = &located {
            self.last_position_ms = loc.position_frames * 1000 / rate;
            if self.state == PlaybackState::Playing
                && self.last_position_emit.elapsed() >= POSITION_INTERVAL
            {
                self.emit_position();
            }
        }

        let drained = shared.finished.load(Ordering::Acquire)
            && shared.read_frames.load(Ordering::Acquire)
                >= shared.written_frames.load(Ordering::Acquire);
        if !drained {
            self.drain_started = None;
            return;
        }
        let started = *self.drain_started.get_or_insert_with(Instant::now);
        if started.elapsed() < latency {
            return;
        }

        self.drain_started = None;
        if let Some(next) = self.pending_next.take() {
            self.queued_next_path = None;
            match self.start_track(next) {
                Ok(()) => return,
                Err(e) => self.error(e),
            }
        }
        if let Some(loc) = &located
            && let Some(duration_ms) = loc.info.duration_ms
        {
            self.last_position_ms = duration_ms;
            self.emit_position();
        }
        self.emit(Event::QueueEnded);
        self.stop();
    }
}

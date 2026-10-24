use crate::lyrics::{self, Line};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use egui::{ColorImage, TextureHandle};
use jap_core::{
    Command, DspConfig, Event, OutputApi, OutputConfig, PlaybackState, Query, QueryResponse,
    TrackInfo,
};
use jap_engine::Engine;
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    sync::{Arc, mpsc},
    time::{Duration, Instant},
};

pub const METERS: [&str; 5] = ["spectrum", "scope", "vu", "spectrogram", "vectorscope"];
pub const METER_NAMES: [&str; 5] = ["频谱", "示波器", "VU 电平表", "频谱图", "相位示波器"];
pub fn read(path: &Path) -> Value {
    std::fs::read(path)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or(Value::Null)
}
pub fn save(path: &Path, value: &Value) -> Result<(), String> {
    std::fs::create_dir_all(path.parent().ok_or("缺少数据目录")?).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("pending");
    std::fs::write(&tmp, value.to_string())
        .and_then(|_| std::fs::rename(tmp, path))
        .map_err(|e| e.to_string())
}
pub fn title(item: &Value) -> String {
    item["title"]
        .as_str()
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| {
            Path::new(item["path"].as_str().unwrap_or(""))
                .file_stem()
                .unwrap_or_default()
                .to_string_lossy()
                .into()
        })
}
pub fn now_id() -> String {
    format!(
        "native-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    )
}
enum Task {
    Import(Vec<String>, String),
    Resources(String),
    Preview(String, u64),
    Query(Query),
    Persist(PathBuf, Value),
    Stop,
}
enum Update {
    Imported(Vec<Value>, String),
    Resources(String, Option<ColorImage>, Vec<Line>, Option<String>),
    Query(QueryResponse),
    Preview(TrackInfo, u64),
    Error(String),
}
pub struct Player {
    pub root: PathBuf,
    pub platform: String,
    pub settings: Value,
    pub prefs: Value,
    pub library: Value,
    pub current: Option<TrackInfo>,
    pub state: PlaybackState,
    pub position: u64,
    pub volume: f32,
    pub output: OutputConfig,
    pub dsp: DspConfig,
    pub signal: Option<jap_core::SignalPath>,
    pub engine: Arc<Engine>,
    pub frame: Vec<f32>,
    pub lyrics: Vec<Line>,
    pub cover: Option<TextureHandle>,
    pub cover_image: Option<ColorImage>,
    pub cover_data: Option<String>,
    pub error: Option<String>,
    pub actions: Vec<Value>,
    pub devices: Vec<jap_core::DeviceInfo>,
    pub formats: Vec<jap_core::StreamConfig>,
    pub search: String,
    pub focused_text: String,
    pub viewport: [f32; 2],
    pub dialog: String,
    pub import_path: String,
    pub new_name: String,
    pub controls: serde_json::Map<String, Value>,
    pub visible: bool,
    pub mini: bool,
    pub can_return: bool,
    pub dirty: bool,
    pub meter_levels: [f32; 2],
    pub meter_peaks: [f32; 2],
    pub history: Vec<Vec<f32>>,
    pub renders: u64,
    pub analysis_frames: u64,
    pub quality: Option<jap_core::QualityReport>,
    tx: mpsc::Sender<Task>,
    rx: mpsc::Receiver<Update>,
    worker: Option<std::thread::JoinHandle<()>>,
    last_save: Instant,
    last_meter: Instant,
    visuals: bool,
}
impl Player {
    pub fn new(
        engine: Arc<Engine>,
        root: PathBuf,
        platform: String,
        settings: Value,
        handoff: Value,
        can_return: bool,
    ) -> Self {
        let saved = read(&root.join("lightweight.json"));
        let mut prefs = saved["prefs"]
            .as_object()
            .cloned()
            .map(Value::Object)
            .unwrap_or(json!({}));
        if !prefs["meters"].is_array() {
            prefs["meters"] = json!([]);
        }
        let output = serde_json::from_value(handoff["output"].clone())
            .or_else(|_| serde_json::from_value(prefs["output"].clone()))
            .unwrap_or(OutputConfig {
                api: OutputApi::platform_default(),
                device_id: None,
                buffer_ms: 40,
                dsd_mode: Default::default(),
            });
        let dsp = serde_json::from_value(handoff["dsp"].clone())
            .or_else(|_| serde_json::from_value(prefs["dsp"].clone()))
            .unwrap_or_default();
        let volume = handoff["volume"]
            .as_f64()
            .or_else(|| prefs["volume"].as_f64())
            .unwrap_or(0.2)
            .clamp(0., 1.) as f32;
        let file = if platform == "android" || platform == "ohos" {
            "library.json"
        } else {
            "playlists.json"
        };
        let mut library = handoff["libraryJson"]
            .as_str()
            .and_then(|s| serde_json::from_str(s).ok())
            .unwrap_or_else(|| read(&root.join(file)));
        if library["lists"].as_array().is_none_or(|l| l.is_empty()) {
            library = json!({"version":2,"activeListId":"native-default","repeat":"all","shuffle":false,"lists":[{"id":"native-default","name":"默认列表","items":[]}],"memories":{}});
        }
        if settings["rememberPlaylist"] == false && handoff.is_null() {
            library = json!({"version":2,"activeListId":"native-default","repeat":"all","shuffle":false,"lists":[{"id":"native-default","name":"默认列表","items":[]}],"memories":{}});
        }
        let (tx, tasks) = mpsc::channel();
        let (updates, rx) = mpsc::channel();
        let backend = engine.clone();
        let worker = std::thread::Builder::new()
            .name("jap-native-io".into())
            .spawn(move || {
                while let Ok(task) = tasks.recv() {
                    match task {
                        Task::Stop => break,
                        Task::Preview(path, position) => {
                            if let QueryResponse::Track { track } =
                                backend.query(Query::ProbeTrack { path })
                            {
                                let _ = updates.send(Update::Preview(track, position));
                            }
                        }
                        Task::Query(q) => {
                            let _ = updates.send(Update::Query(backend.query(q)));
                        }
                        Task::Persist(path, v) => {
                            if let Err(e) = save(&path, &v) {
                                let _ = updates.send(Update::Error(e));
                            }
                        }
                        Task::Import(paths, list) => {
                            let mut items = Vec::new();
                            for path in paths {
                                let mut found = Vec::new();
                                scan(Path::new(&path), 0, &mut found);
                                for path in found {
                                    let tracks = jap_decode::disc::tracks(Path::new(&path))
                                        .unwrap_or_default();
                                    let tracks = if tracks.is_empty() {
                                        match backend
                                            .query(Query::ProbeTrack { path: path.clone() })
                                        {
                                            QueryResponse::Track { track } => vec![track],
                                            QueryResponse::Error { message } => {
                                                let _ = updates.send(Update::Error(message));
                                                vec![]
                                            }
                                            _ => vec![],
                                        }
                                    } else {
                                        tracks
                                    };
                                    for track in tracks {
                                        let mut item =
                                            serde_json::to_value(&track).unwrap_or_default();
                                        item["id"] = json!(now_id());
                                        item["metaLoaded"] = json!(true);
                                        item["addedAt"] = json!(0);
                                        item["sampleRate"] = json!(track.format.sample_rate);
                                        item["bits"] = json!(track.format.bits);
                                        items.push(item);
                                    }
                                }
                            }
                            let _ = updates.send(Update::Imported(items, list));
                        }
                        Task::Resources(path) => {
                            let source = jap_decode::disc::source_path(Path::new(&path))
                                .unwrap_or_else(|_| PathBuf::from(&path));
                            let embedded = jap_decode::read_lyrics(Path::new(&path));
                            let lrc = ["lrc", "LRC"]
                                .iter()
                                .find_map(|ext| {
                                    std::fs::read_to_string(source.with_extension(ext)).ok()
                                })
                                .or(embedded);
                            let mut cover =
                                jap_engine::read_cover(Path::new(&path)).map(|c| c.data);
                            if cover.is_none() {
                                for p in [
                                    source.with_extension("jpg"),
                                    source.with_extension("png"),
                                    source.with_file_name("cover.jpg"),
                                    source.with_file_name("cover.png"),
                                ] {
                                    if std::fs::metadata(&p)
                                        .is_ok_and(|m| m.len() < 16 * 1024 * 1024)
                                    {
                                        cover = std::fs::read(p).ok();
                                        if cover.is_some() {
                                            break;
                                        }
                                    }
                                }
                            }
                            let image = cover
                                .as_ref()
                                .and_then(|b| image::load_from_memory(b).ok())
                                .map(|im| {
                                    let im = im.thumbnail(768, 768).to_rgba8();
                                    ColorImage::from_rgba_unmultiplied(
                                        [im.width() as usize, im.height() as usize],
                                        im.as_raw(),
                                    )
                                });
                            let _ = updates.send(Update::Resources(
                                path,
                                image,
                                lrc.as_deref().map(lyrics::parse).unwrap_or_default(),
                                cover
                                    .as_ref()
                                    .and_then(|b| image::load_from_memory(b).ok())
                                    .and_then(|im| {
                                        let mut bytes = std::io::Cursor::new(Vec::new());
                                        image::DynamicImage::ImageRgb8(
                                            im.thumbnail(512, 512).to_rgb8(),
                                        )
                                        .write_to(&mut bytes, image::ImageFormat::Jpeg)
                                        .ok()?;
                                        Some(STANDARD.encode(bytes.into_inner()))
                                    }),
                            ));
                        }
                    }
                }
            })
            .expect("native IO worker");
        let current = serde_json::from_value::<TrackInfo>(handoff["track"].clone()).ok();
        let state =
            serde_json::from_value(handoff["state"].clone()).unwrap_or(PlaybackState::Stopped);
        let p = Self {
            root,
            platform,
            settings,
            prefs,
            library,
            current,
            state,
            position: handoff["positionMs"].as_u64().unwrap_or(0),
            volume,
            output,
            dsp,
            signal: None,
            engine,
            frame: vec![0.; 648],
            lyrics: vec![],
            cover: None,
            cover_image: None,
            cover_data: None,
            error: None,
            actions: vec![],
            devices: vec![],
            formats: vec![],
            search: String::new(),
            focused_text: String::new(),
            viewport: [0.; 2],
            dialog: String::new(),
            import_path: String::new(),
            new_name: String::new(),
            controls: Default::default(),
            visible: true,
            mini: false,
            can_return,
            dirty: true,
            meter_levels: [0.; 2],
            meter_peaks: [0.; 2],
            history: vec![],
            renders: 0,
            analysis_frames: 0,
            quality: None,
            tx,
            rx,
            worker: Some(worker),
            last_save: Instant::now(),
            last_meter: Instant::now(),
            visuals: false,
        };
        p.command(Command::SetVolume { gain: volume });
        let soundfont = p.prefs["soundfont"]
            .as_str()
            .or_else(|| p.settings["midiSoundfont"].as_str())
            .filter(|s| !s.is_empty())
            .map(str::to_owned);
        let sample_rate = p.settings["midiSampleRate"].as_u64().unwrap_or(96000) as u32;
        p.command(Command::SetMidi {
            soundfont,
            sample_rate,
        });
        if !p.mobile() {
            p.command(Command::SetOutput {
                config: p.output.clone(),
            });
            p.command(Command::SetDsp {
                config: p.dsp.clone(),
            });
        }
        if let Some(track) = &p.current {
            let _ = p.tx.send(Task::Resources(track.path.clone()));
        }
        p.command(Command::QueueNext { path: None });
        if p.current.is_none() {
            let list = &p.library["lists"][p.active()];
            let id = list["id"].as_str().unwrap_or("");
            let memory = &p.library["memories"][id];
            if let Some(item) = list["items"].as_array().and_then(|a| {
                a.iter()
                    .find(|i| i["id"] == memory["itemId"])
                    .or_else(|| a.first())
            }) && let Some(path) = item["path"].as_str()
            {
                let _ = p.tx.send(Task::Preview(
                    path.into(),
                    memory["positionMs"].as_u64().unwrap_or(0),
                ));
            }
        }

        if !p.mobile()
            && p.state == PlaybackState::Playing
            && let Some(t) = p.current.clone()
        {
            p.command(Command::Play {
                path: t.path,
                start_ms: Some(p.position),
            });
        }
        p
    }
    pub fn mobile(&self) -> bool {
        self.platform == "android" || self.platform == "ohos"
    }
    pub fn command(&self, c: Command) {
        // Engine dispatch is non-blocking; file imports must never delay mute or pause.
        self.engine.send(c);
    }
    pub fn query(&self, q: Query) {
        let _ = self.tx.send(Task::Query(q));
    }
    pub fn active(&self) -> usize {
        self.library["lists"]
            .as_array()
            .and_then(|a| {
                a.iter()
                    .position(|l| l["id"] == self.library["activeListId"])
            })
            .unwrap_or(0)
    }
    pub fn items(&self) -> Vec<Value> {
        self.library["lists"][self.active()]["items"]
            .as_array()
            .cloned()
            .unwrap_or_default()
    }
    pub fn enabled(&self, id: &str) -> bool {
        self.prefs["meters"]
            .as_array()
            .is_some_and(|a| a.iter().any(|v| v == id))
    }
    pub fn set_meter(&mut self, id: &str, on: bool) {
        let mut ids = self.prefs["meters"].as_array().cloned().unwrap_or_default();
        ids.retain(|v| v != id);
        if on {
            ids.push(json!(id));
        }
        self.prefs["meters"] = json!(ids);
        self.persist();
    }
    pub fn receive(&mut self, value: Value) {
        if value["kind"] == "event" {
            self.receive(value["event"].clone());
            return;
        }
        let Ok(event) = serde_json::from_value::<Event>(value) else {
            return;
        };
        self.dirty = true;
        match event {
            Event::State { state } => {
                self.state = state;
                self.actions
                    .push(json!({"type":"media","value":self.media()}));
            }
            Event::TrackChanged { track } => {
                self.cover = None;
                self.cover_data = None;
                self.position = 0;
                let _ = self.tx.send(Task::Resources(track.path.clone()));
                self.current = Some(track);
                self.queue_next();
            }
            Event::Position { position_ms, .. } => {
                self.position = position_ms;
            }
            Event::Volume { gain } => self.volume = gain,
            Event::DspChanged { config } => self.dsp = config,
            Event::SignalPath { path } => self.signal = Some(path),
            Event::QueueEnded => self.neighbour(1, true),
            Event::Error { message } | Event::QualityError { message, .. } => {
                self.error = Some(message)
            }
            Event::Quality { report } => self.quality = Some(report),
            Event::BufferReset { .. } => {}
        }
    }
    pub fn tick(&mut self, ctx: &egui::Context) {
        while let Ok(update) = self.rx.try_recv() {
            self.dirty = true;
            match update {
                Update::Error(e) => self.error = Some(e),
                Update::Preview(track, position) if self.current.is_none() => {
                    self.position = position;
                    let _ = self.tx.send(Task::Resources(track.path.clone()));
                    self.current = Some(track);
                }
                Update::Imported(items, id) => {
                    let first = if id == "jap-external-files" {
                        items
                            .first()
                            .and_then(|i| i["path"].as_str())
                            .map(str::to_owned)
                    } else {
                        None
                    };
                    if let Some(list) = self.library["lists"]
                        .as_array_mut()
                        .and_then(|a| a.iter_mut().find(|l| l["id"] == id))
                        && let Some(existing) = list["items"].as_array_mut()
                    {
                        for item in items {
                            if !existing.iter().any(|i| i["path"] == item["path"]) {
                                existing.push(item);
                            }
                        }
                    }
                    self.persist();
                    if let Some(path) = first {
                        self.play(path, 0);
                    }
                }
                Update::Resources(path, image, lyrics, data) => {
                    if self.current.as_ref().is_some_and(|t| t.path == path) {
                        self.cover = image.as_ref().map(|im| {
                            ctx.load_texture(
                                "current-cover",
                                im.clone(),
                                egui::TextureOptions::LINEAR,
                            )
                        });
                        self.cover_image = image;
                        self.lyrics = lyrics;
                        self.cover_data = data;
                        self.actions
                            .push(json!({"type":"media","value":self.media()}));
                    }
                }
                Update::Query(QueryResponse::Devices { devices }) => self.devices = devices,
                Update::Query(QueryResponse::ExclusiveFormats { formats }) => {
                    self.formats = formats
                }
                Update::Query(QueryResponse::Error { message }) => self.error = Some(message),
                _ => {}
            }
        }
        let visual = self.visible
            && !self.mini
            && self.state == PlaybackState::Playing
            && METERS.iter().any(|id| self.enabled(id));
        self.engine.set_visualization_enabled(visual);
        if visual != self.visuals {
            self.visuals = visual;
            self.last_meter = Instant::now();
            self.actions
                .push(json!({"type":"visuals","enabled":visual}));
        }
        if visual && self.engine.viz_frame(&mut self.frame) {
            let dt = self.last_meter.elapsed().as_secs_f32().min(1.);
            self.last_meter = Instant::now();
            for c in 0..2 {
                self.meter_levels[c] += (self.frame[c + 2] - self.meter_levels[c])
                    * (1. - (-dt / (0.3 / 100f32.ln())).exp());
                self.meter_peaks[c] = self.frame[c].max(self.meter_peaks[c] * (-dt / 1.5).exp());
            }
            if self.enabled("spectrogram") {
                self.history.push(self.frame[8..136].to_vec());
                if self.history.len() > 96 {
                    self.history.remove(0);
                }
            }
            self.analysis_frames += 1;
        }
        if self.last_save.elapsed() > Duration::from_secs(5) {
            self.persist();
        }
    }
    pub fn visuals(&self) -> bool {
        self.visuals
    }
    pub fn import(&mut self, paths: Vec<String>) {
        let id = self.library["lists"][self.active()]["id"]
            .as_str()
            .unwrap_or("native-default")
            .to_owned();
        let _ = self.tx.send(Task::Import(paths, id));
    }
    pub fn external(&mut self, paths: Vec<String>) {
        if !self.library["lists"]
            .as_array()
            .is_some_and(|a| a.iter().any(|l| l["id"] == "jap-external-files"))
        {
            self.library["lists"]
                .as_array_mut()
                .unwrap()
                .push(json!({"id":"jap-external-files","name":"外部打开","items":[]}));
        }
        self.library["activeListId"] = json!("jap-external-files");
        self.import(paths);
    }
    pub fn play(&mut self, path: String, start: u64) {
        self.command(Command::Play {
            path,
            start_ms: Some(start),
        });
    }
    pub fn toggle(&mut self) {
        match self.state {
            PlaybackState::Playing => self.command(Command::Pause),
            PlaybackState::Paused => self.command(Command::Resume),
            PlaybackState::Stopped => {
                let at = self.active();
                let id = self.library["lists"][at]["id"].as_str().unwrap_or("");
                let memory = &self.library["memories"][id];
                let items = self.items();
                let item = items
                    .iter()
                    .find(|i| i["id"] == memory["itemId"])
                    .or_else(|| items.first());
                if let Some(i) = item {
                    if let Some(path) = i["path"].as_str() {
                        self.play(path.into(), memory["positionMs"].as_u64().unwrap_or(0));
                    }
                } else {
                    self.dialog = "import".into();
                }
            }
        }
    }
    fn ordered(&self) -> Vec<Value> {
        let items = self.items();
        if self.library["shuffle"] != true {
            return items;
        }
        let list = &self.library["lists"][self.active()];
        let id = list["id"].as_str().unwrap_or("");
        let order = self.library["memories"][id]["order"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        let mut result = Vec::new();
        for id in &order {
            if let Some(i) = items.iter().find(|i| &i["id"] == id) {
                result.push(i.clone());
            }
        }
        for item in items {
            if !result.iter().any(|i| i["id"] == item["id"]) {
                result.push(item);
            }
        }
        result
    }
    pub fn neighbour(&mut self, delta: i32, automatic: bool) {
        let items = self.ordered();
        if items.is_empty() {
            return;
        }
        let i = items
            .iter()
            .position(|i| self.current.as_ref().is_some_and(|t| i["path"] == t.path))
            .unwrap_or(0) as i32;
        let n = items.len() as i32;
        let next = if automatic && self.library["repeat"] == "one" {
            i
        } else {
            i + delta
        };
        if automatic && self.library["repeat"] == "off" && next >= n {
            return;
        }
        if let Some(path) = items[next.rem_euclid(n) as usize]["path"].as_str() {
            self.play(path.into(), 0);
        }
    }
    pub fn queue_next(&self) {
        let items = self.ordered();
        let path = self
            .current
            .as_ref()
            .and_then(|t| items.iter().position(|i| i["path"] == t.path))
            .and_then(|i| {
                if self.library["repeat"] == "one" {
                    return self.current.as_ref().map(|t| t.path.clone());
                }
                if i + 1 >= items.len() && self.library["repeat"] == "off" {
                    None
                } else {
                    items
                        .get((i + 1) % items.len())
                        .and_then(|i| i["path"].as_str())
                        .map(str::to_owned)
                }
            });
        self.command(Command::QueueNext { path });
    }
    pub fn persist(&mut self) {
        if let Some(track) = &self.current {
            let items = self.ordered();
            if let Some(item) = items.iter().find(|i| i["path"] == track.path) {
                let id = self.library["lists"][self.active()]["id"]
                    .as_str()
                    .unwrap_or("")
                    .to_owned();
                self.library["memories"][id] = json!({"itemId":item["id"],"positionMs":self.position,"order":items.iter().map(|i|i["id"].clone()).collect::<Vec<_>>()});
            }
        }
        self.prefs["volume"] = json!(self.volume);
        self.prefs["output"] = json!(self.output);
        self.prefs["dsp"] = json!(self.dsp);
        let memory = self.settings["rememberPlaylist"] != false;
        let saved = if memory {
            self.library.clone()
        } else {
            json!({"version":2,"activeListId":"native-default","repeat":self.library["repeat"],"shuffle":self.library["shuffle"],"lists":[{"id":"native-default","name":"默认列表","items":[]}],"memories":{}})
        };
        let file = if self.mobile() {
            "library.json"
        } else {
            "playlists.json"
        };
        let _ = self.tx.send(Task::Persist(self.root.join(file), saved));
        let _=self.tx.send(Task::Persist(self.root.join("lightweight.json"),json!({"prefs":self.prefs,"last":if memory {self.current.as_ref().map(|t|json!({"path":t.path,"positionMs":self.position}))}else{None}})));
        self.last_save = Instant::now();
    }
    pub fn handoff(&mut self) -> Value {
        self.persist();
        json!({"libraryJson":self.library.to_string(),"track":self.current,"state":self.state,"positionMs":self.position,"volume":self.volume,"output":self.output,"dsp":self.dsp})
    }
    pub fn media(&self) -> Value {
        let mut value = json!({"title":self.current.as_ref().and_then(|t|t.title.clone()).unwrap_or_else(||self.current.as_ref().map(|t|title(&json!(t))).unwrap_or_default()),"artist":self.current.as_ref().and_then(|t|t.artist.clone()),"album":self.current.as_ref().and_then(|t|t.album.clone()),"positionMs":self.position,"durationMs":self.current.as_ref().and_then(|t|t.duration_ms),"state":self.state});
        value[if self.mobile() {
            "coverBase64"
        } else {
            "cover"
        }] = json!(self.cover_data);
        value
    }
    pub fn debug(&self) -> Value {
        json!({"hasCover":self.cover.is_some(),"hasMediaCover":self.cover_data.is_some(),"lyricLines":self.lyrics.len(),"viewport":self.viewport,"renderer":"egui-native","webview":false,"state":self.state,"current":self.current,"position":self.position,"volume":self.volume,"library":self.library,"visual":self.visuals,"draws":self.renders,"analysisFrames":self.analysis_frames,"meters":self.prefs["meters"],"rms":self.meter_levels,"controls":self.controls,"error":self.error})
    }
}
impl Drop for Player {
    fn drop(&mut self) {
        self.engine.set_visualization_enabled(false);
        self.persist();
        let _ = self.tx.send(Task::Stop);
        if let Some(t) = self.worker.take() {
            let _ = t.join();
        }
    }
}
fn scan(path: &Path, depth: usize, out: &mut Vec<String>) {
    if depth > 32 || out.len() >= 100_000 {
        return;
    }
    if path.is_file() {
        if path.extension().and_then(|e| e.to_str()).is_some_and(|e| {
            [
                "flac", "wav", "wave", "aif", "aiff", "mp3", "m4a", "aac", "ogg", "oga", "opus",
                "caf", "alac", "mka", "dsf", "dff", "dsd", "ncm", "ape", "dts", "dtshd", "iso",
                "cue", "bin", "img", "mid", "midi", "kar", "rmi",
            ]
            .contains(&e.to_ascii_lowercase().as_str())
        }) {
            out.push(path.to_string_lossy().into());
        }
    } else if let Ok(entries) = std::fs::read_dir(path) {
        for e in entries.flatten() {
            if e.file_type().is_ok_and(|t| !t.is_symlink()) {
                scan(&e.path(), depth + 1, out);
            }
        }
    }
}

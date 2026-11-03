use jap_core::{Command, Event};
use jap_decode::live::{LiveConfig, LiveInput};
use jap_light::external::Connection;
use serde_json::{Value, json};
use std::{
    io::{BufReader, Read, Write},
    path::PathBuf,
    process::{Child, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};

type Updates = Arc<Mutex<Vec<(Value, Vec<u8>)>>>;
pub struct Client {
    executable: PathBuf,
    service: PathBuf,
    dll: PathBuf,
    log: PathBuf,
    engine: Arc<jap_engine::Engine>,
    process: Mutex<Option<Child>>,
    writer: Mutex<Option<crossbeam_channel::Sender<Value>>>,
    updates: Updates,
    connected: Arc<AtomicBool>,
    routing: Arc<AtomicBool>,
    position: AtomicU64,
}
impl Client {
    pub fn new(
        executable: PathBuf,
        service: PathBuf,
        dll: PathBuf,
        engine: Arc<jap_engine::Engine>,
        log: PathBuf,
    ) -> Self {
        Self {
            executable,
            service,
            dll,
            log,
            engine,
            process: Mutex::new(None),
            writer: Mutex::new(None),
            updates: Arc::new(Mutex::new(Vec::new())),
            connected: Arc::new(AtomicBool::new(false)),
            routing: Arc::new(AtomicBool::new(false)),
            position: AtomicU64::new(0),
        }
    }
    fn start(&self) -> Result<(), String> {
        let mut process = self.process.lock().unwrap();
        if process
            .as_mut()
            .is_some_and(|p| p.try_wait().ok().flatten().is_none())
        {
            return Ok(());
        }
        let mut command = std::process::Command::new(&self.executable);
        command
            .arg(&self.service)
            .env("ELECTRON_RUN_AS_NODE", "1")
            .env("JAP_VIRTUAL_OUTPUT_PATH", &self.dll)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(
                std::fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(&self.log)
                    .map(Stdio::from)
                    .unwrap_or_else(|_| Stdio::null()),
            );
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let mut child = command
            .spawn()
            .map_err(|e| format!("无法启动无界面连接适配器: {e}"))?;
        let mut stdin = child.stdin.take().ok_or("缺少控制通路")?;
        let stdout = child.stdout.take().ok_or("缺少音频通路")?;
        let (sender, receiver) = crossbeam_channel::bounded::<Value>(256);
        *self.writer.lock().unwrap() = Some(sender.clone());
        std::thread::Builder::new()
            .name("jap-client-control".into())
            .spawn(move || {
                while let Ok(value) = receiver.recv() {
                    let Ok(mut bytes) = serde_json::to_vec(&value) else {
                        break;
                    };
                    bytes.push(b'\n');
                    if stdin.write_all(&bytes).is_err() || stdin.flush().is_err() {
                        break;
                    }
                }
            })
            .map_err(|e| e.to_string())?;
        let engine = self.engine.clone();
        let updates = self.updates.clone();
        let routing = self.routing.clone();
        let connected = self.connected.clone();
        std::thread::Builder::new().name("jap-client-audio".into()).spawn(move || {
            let mut reader = BufReader::new(stdout);
            let mut live: Option<LiveInput> = None;
            let mut stopped = false;
            let result = (|| -> Result<(), String> {
                loop {
                    let mut header = [0; 8];
                    if reader.read_exact(&mut header).is_err() { break }
                    let json_len = u32::from_le_bytes(header[..4].try_into().unwrap()) as usize;
                    let data_len = u32::from_le_bytes(header[4..].try_into().unwrap()) as usize;
                    if json_len > 1024 * 1024 || data_len > 8 * 1024 * 1024 { return Err("连接数据超过内存预算".into()) }
                    let mut json_bytes = vec![0; json_len];
                    reader.read_exact(&mut json_bytes).map_err(|e| e.to_string())?;
                    let value: Value = serde_json::from_slice(&json_bytes).map_err(|e| e.to_string())?;
                    let mut data = vec![0; data_len];
                    reader.read_exact(&mut data).map_err(|e| e.to_string())?;
                    let result = match value["kind"].as_str().unwrap_or("") {
                        "openLive" => (|| {
                            let config: LiveConfig = serde_json::from_value(value["config"].clone()).map_err(|e| e.to_string())?;
                            let input = LiveInput::new(config).map_err(|e| e.to_string())?;
                            if let Some(old) = live.replace(input.clone()) { old.close() }
                            engine.play_live(input);
                            Ok(())
                        })(),
                        "audio" => live.as_ref().ok_or_else(|| "没有连接实时音源".to_string()).and_then(|input| {
                            let pts = value["pts"].as_u64().ok_or("无效时间戳")?;
                            let frames = value["frames"].as_u64().and_then(|n| u32::try_from(n).ok()).ok_or("无效帧数")?;
                            input.push(pts, frames, data).map_err(|e| e.to_string())
                        }),
                        "closeLive" => { if let Some(input) = live.take() { input.close() } Ok(()) },
                        "command" => { if let Ok(c) = serde_json::from_value::<Command>(value["command"].clone()) { engine.send(c) } Ok(()) },
                        "externalState" => {
                            let phase = value["state"]["phase"].as_str().unwrap_or("");
                            routing.store(phase == "routing" || (phase == "ready" && value["state"]["snapshot"]["devices"]["currentDevice"]["name"] == "Just A Player HiFi Bridge (Black Hole)"), Ordering::Release);
                            connected.store(matches!(phase, "ready" | "routing" | "connecting"), Ordering::Release);
                            let mut queue = updates.lock().unwrap();
                            // Coalesce position/device snapshots, but retain image deltas.
                            if data.is_empty() { queue.retain(|(v, d)| !d.is_empty() || v["kind"] != "externalState") }
                            queue.push((value, data));
                            if queue.len() > 16 { queue.remove(0); }
                            Ok(())
                        }
                        "shutdownDone" => { stopped = true; break }
                        "requestError" => { updates.lock().unwrap().push((value, data)); Ok(()) }
                        _ => Ok(()),
                    };
                    if let Err(message) = result {
                        let _ = sender.send_timeout(json!({"kind":"event","event":Event::Error { message }}), Duration::from_millis(100));
                    }
                }
                Ok(())
            })();
            if let Some(input) = live { input.close() }
            if routing.swap(false, Ordering::AcqRel) { engine.send(Command::Stop) }
            connected.store(false, Ordering::Release);
            if !stopped {
                updates.lock().unwrap().push((json!({"kind":"externalState","state":{"phase":"error","message":result.err().unwrap_or_else(||"网易云连接适配器已退出，请检查客户端输出设备".into())}}), vec![]));
            }
        }).map_err(|e| e.to_string())?;
        *process = Some(child);
        Ok(())
    }
    fn send(&self, value: Value) -> Result<(), String> {
        self.writer
            .lock()
            .unwrap()
            .as_ref()
            .ok_or("网易云尚未连接")?
            .send_timeout(value, Duration::from_millis(100))
            .map_err(|_| "客户端控制通路繁忙或已关闭".into())
    }
}
impl Connection for Client {
    fn request(&self, action: &str, position_ms: Option<u64>, force: bool) -> Result<(), String> {
        if action == "connect" {
            self.start()?
        }
        if action == "disconnect" {
            return self.send(json!({"kind":"shutdown"}));
        }
        self.send(json!({"kind":"action","action":action,"positionMs":position_ms,"force":force}))
    }
    fn command(&self, command: &Command) -> bool {
        if !self.connected.load(Ordering::Acquire) {
            return false;
        }
        if matches!(command, Command::Play { .. }) {
            let _ = self.send(json!({"kind":"localPlay","command":command}));
            return true;
        }
        if !self.routing.load(Ordering::Acquire) {
            return false;
        }
        let (action, position) = match command {
            Command::Pause | Command::Stop => ("pause", None),
            Command::Resume => ("resume", None),
            Command::Seek { position_ms } => ("seek", Some(*position_ms)),
            Command::ResetBuffer => ("seek", Some(self.position.load(Ordering::Acquire))),
            Command::SetOutput { .. } => {
                let position = self.position.load(Ordering::Acquire);
                self.engine.send(Command::Stop);
                self.engine.send(command.clone());
                let _ = self.request("seek", Some(position), false);
                return true;
            }
            Command::QueueNext { .. } => return true,
            _ => return false,
        };
        let _ = self.request(action, position, false);
        true
    }
    fn event(&self, event: &Value) {
        if let Some(position) = event["positionMs"].as_u64() {
            self.position.store(position, Ordering::Release);
        }
        let _ = self.send(json!({"kind":"event","event":event}));
    }
    fn poll(&self) -> Vec<(Value, Vec<u8>)> {
        std::mem::take(&mut *self.updates.lock().unwrap())
    }
    fn shutdown(&self) {
        let _ = self.send(json!({"kind":"shutdown"}));
        let mut process = self.process.lock().unwrap();
        if let Some(child) = process.as_mut() {
            let end = Instant::now() + Duration::from_secs(12);
            while child.try_wait().ok().flatten().is_none() && Instant::now() < end {
                std::thread::sleep(Duration::from_millis(25));
            }
            if child.try_wait().ok().flatten().is_none() {
                let _ = child.kill();
            }
            let _ = child.wait();
        }
        *process = None;
        *self.writer.lock().unwrap() = None;
    }
}
impl Drop for Client {
    fn drop(&mut self) {
        self.shutdown()
    }
}

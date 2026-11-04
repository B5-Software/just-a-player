//! UI connection to the persistent audio host. Audio samples stay in that host.
use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Shutdown, TcpStream};
use std::path::Path;
use std::sync::{
    Arc, Weak,
    atomic::{AtomicBool, AtomicU64, Ordering},
};
use std::time::Duration;

use crate::EventSink;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use crossbeam_channel::{Sender, bounded};
use jap_core::{Command, Event, Query, QueryResponse};
use parking_lot::Mutex;
use serde_json::{Value, json};

type ExternalUpdates = VecDeque<(Value, Vec<u8>)>;
struct Inner {
    socket: TcpStream,
    writer: Sender<Value>,
    queries: Mutex<HashMap<u64, Sender<QueryResponse>>>,
    next_id: AtomicU64,
    frame: Mutex<Option<Vec<f32>>>,
    external: Mutex<ExternalUpdates>,
    sink: EventSink,
    configured: AtomicBool,
    ready: Sender<()>,
}
impl Drop for Inner {
    fn drop(&mut self) {
        let _ = self.socket.shutdown(Shutdown::Both);
    }
}

#[derive(Clone)]
pub struct Client(Arc<Inner>);
impl Client {
    pub fn connect(endpoint: &Path, sink: EventSink) -> Result<Self, String> {
        let config: Value =
            serde_json::from_slice(&std::fs::read(endpoint).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
        let port = config["port"]
            .as_u64()
            .filter(|p| *p > 0 && *p <= 65535)
            .ok_or("Invalid audio endpoint")?;
        let token = config["token"]
            .as_str()
            .ok_or("Missing audio token")?
            .to_owned();
        let socket = TcpStream::connect_timeout(
            &format!("127.0.0.1:{port}")
                .parse()
                .map_err(|_| "Invalid audio port")?,
            Duration::from_secs(3),
        )
        .map_err(|e| e.to_string())?;
        socket.set_nodelay(true).map_err(|e| e.to_string())?;
        let mut writer_socket = socket.try_clone().map_err(|e| e.to_string())?;
        let reader_socket = socket.try_clone().map_err(|e| e.to_string())?;
        let (writer, commands) = bounded::<Value>(256);
        let (ready, ready_rx) = bounded(1);
        let inner = Arc::new(Inner {
            socket,
            writer,
            queries: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
            frame: Mutex::new(None),
            external: Mutex::new(VecDeque::new()),
            sink,
            configured: AtomicBool::new(false),
            ready,
        });
        std::thread::Builder::new()
            .name("jap-audio-control".into())
            .spawn(move || {
                while let Ok(value) = commands.recv() {
                    let Ok(mut bytes) = serde_json::to_vec(&value) else {
                        break;
                    };
                    bytes.push(b'\n');
                    if writer_socket.write_all(&bytes).is_err() {
                        break;
                    }
                }
            })
            .map_err(|e| e.to_string())?;
        let weak = Arc::downgrade(&inner);
        std::thread::Builder::new()
            .name("jap-audio-events".into())
            .spawn(move || receive(reader_socket, weak))
            .map_err(|e| e.to_string())?;
        let client = Self(inner);
        client.send(json!({"kind":"hello","token":token}));
        ready_rx
            .recv_timeout(Duration::from_secs(5))
            .map_err(|_| "Audio host handshake timed out".to_owned())?;
        Ok(client)
    }
    pub fn configured(&self) -> bool {
        self.0.configured.load(Ordering::Acquire)
    }
    pub fn send(&self, value: Value) {
        if self.0.writer.try_send(value).is_err() {
            (self.0.sink)(Event::Error {
                message: "Audio control connection is unavailable".into(),
            });
        }
    }
    pub fn command(&self, command: Command) {
        self.send(json!({"kind":"command","command":command}));
    }
    pub fn query(&self, query: Query) -> QueryResponse {
        let id = self.0.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = bounded(1);
        self.0.queries.lock().insert(id, tx);
        self.send(json!({"kind":"query","id":id,"query":query}));
        let response = rx
            .recv_timeout(Duration::from_secs(15))
            .unwrap_or_else(|_| QueryResponse::Error {
                message: "Audio query timed out".into(),
            });
        self.0.queries.lock().remove(&id);
        response
    }
    pub fn frame(&self, out: &mut Vec<f32>) -> bool {
        if let Some(frame) = self.0.frame.lock().take() {
            *out = frame;
            true
        } else {
            false
        }
    }
    pub fn visual(&self, enabled: bool) {
        self.send(json!({"kind":"visibility","visible":enabled}));
    }
    pub fn external(&self, action: &str, position_ms: Option<u64>, force: bool) {
        let id = self.0.next_id.fetch_add(1, Ordering::Relaxed);
        self.send(json!({"kind":"external","id":id,"action":action,"positionMs":position_ms,"force":force}));
    }
    pub fn external_updates(&self) -> Vec<(Value, Vec<u8>)> {
        self.0.external.lock().drain(..).collect()
    }
    pub fn shutdown(&self) {
        self.send(json!({"kind":"shutdown"}));
    }
}

fn receive(socket: TcpStream, weak: Weak<Inner>) {
    let mut reader = BufReader::new(socket);
    loop {
        let mut bytes = Vec::new();
        match reader
            .by_ref()
            .take(24 * 1024 * 1024)
            .read_until(b'\n', &mut bytes)
        {
            Ok(0) | Err(_) => break,
            Ok(_) if bytes.last() != Some(&b'\n') => break,
            Ok(_) => {}
        }
        let Ok(mut value) = serde_json::from_slice::<Value>(&bytes) else {
            break;
        };
        let Some(inner) = weak.upgrade() else {
            return;
        };
        match value["kind"].as_str().unwrap_or("") {
            "hostReady" => {
                inner.configured.store(
                    value["active"].as_bool().unwrap_or(false),
                    Ordering::Release,
                );
                let _ = inner.ready.try_send(());
            }
            "event" => {
                if let Ok(event) = serde_json::from_value(value["event"].clone()) {
                    (inner.sink)(event);
                }
            }
            "queryResult" => {
                if let Some(id) = value["id"].as_u64()
                    && let Some(tx) = inner.queries.lock().remove(&id)
                    && let Ok(response) = serde_json::from_value(value["response"].clone())
                {
                    let _ = tx.send(response);
                }
            }
            "viz" => {
                if let Some(data) = value["frame"]["data"].as_str()
                    && let Ok(bytes) = STANDARD.decode(data)
                    && bytes.len().is_multiple_of(4)
                    && bytes.len() <= 65536
                {
                    *inner.frame.lock() = Some(
                        bytes
                            .as_chunks::<4>()
                            .0
                            .iter()
                            .map(|b| f32::from_le_bytes(*b))
                            .collect(),
                    );
                }
            }
            "externalState" => {
                let data = value["state"]["cover"]["data"]["data"]
                    .as_str()
                    .and_then(|text| STANDARD.decode(text).ok())
                    .unwrap_or_default();
                if value["state"]["cover"].is_object() {
                    value["state"]["cover"]
                        .as_object_mut()
                        .unwrap()
                        .remove("data");
                }
                let mut updates = inner.external.lock();
                // Keep cover-bearing updates until the native UI consumes them.
                updates.retain(|(previous, _)| {
                    previous["kind"] == "requestError"
                        || previous["state"].get("cover").is_some()
                        || previous["state"]["snapshot"].get("queue").is_some()
                });
                if updates.len() > 8 {
                    updates.pop_front();
                }
                updates.push_back((value, data));
            }
            "externalResult" if value["error"].is_string() => {
                inner.external.lock().push_back((
                    json!({"kind":"requestError","message":value["error"]}),
                    Vec::new(),
                ));
            }
            _ => {}
        }
    }
    if let Some(inner) = weak.upgrade() {
        inner.queries.lock().clear();
        (inner.sink)(Event::Error {
            message: "Audio service disconnected".into(),
        });
    }
}

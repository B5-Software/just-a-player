//! Small C ABI for HarmonyOS Node-API. Playback stays in the common Rust engine.
use base64::{Engine as _, engine::general_purpose::STANDARD};
use jap_core::{Command, Query};
use parking_lot::Mutex;
use serde_json::{Value, json};
use std::{
    collections::VecDeque,
    ffi::{CStr, CString, c_char},
    path::Path,
    sync::{Arc, OnceLock},
};
mod files;

struct Host {
    engine: jap_engine::Engine,
    events: Arc<Mutex<VecDeque<Value>>>,
    frame: Vec<f32>,
}
fn host() -> &'static Mutex<Option<Host>> {
    static HOST: OnceLock<Mutex<Option<Host>>> = OnceLock::new();
    HOST.get_or_init(Default::default)
}
fn run(input: &str) -> Result<Value, String> {
    let v: Value = serde_json::from_str(input).map_err(|e| e.to_string())?;
    if v["op"] == "files" {
        return files::request(&v);
    }
    if v["op"] == "init" {
        let mut lock = host().lock();
        if lock.is_none() {
            let events: Arc<Mutex<VecDeque<Value>>> = Arc::default();
            let sink = events.clone();
            let engine = jap_engine::Engine::new(Arc::new(move |event| {
                let mut queue = sink.lock();
                if queue.len() >= 512 {
                    queue.retain(|v| v["type"] != "position");
                }
                if queue.len() >= 512 {
                    queue.pop_front();
                }
                queue.push_back(serde_json::to_value(event).unwrap_or(Value::Null));
            }));
            *lock = Some(Host {
                engine,
                events,
                frame: Vec::new(),
            });
        }
        return Ok(json!({"ready":true}));
    }
    #[cfg(target_env = "ohos")]
    if v["op"] == "usbAttach" {
        jap_output::ohos::usb::register_usb(
            v["id"].as_str().ok_or("USB id")?.into(),
            v["fd"].as_i64().ok_or("USB fd")? as i32,
            v["name"].as_str().unwrap_or("USB DAC").into(),
            STANDARD
                .decode(v["descriptors"].as_str().ok_or("USB descriptors")?)
                .map_err(|e| e.to_string())?,
            v["vendor"].as_u64().unwrap_or(0) as u16,
            v["product"].as_u64().unwrap_or(0) as u16,
        )
        .map_err(|e| e.to_string())?;
        return Ok(json!(true));
    }
    #[cfg(target_env = "ohos")]
    if v["op"] == "usbDetach" {
        jap_output::ohos::usb::unregister_usb(v["id"].as_str().unwrap_or(""));
        return Ok(json!(true));
    }
    let mut lock = host().lock();
    let state = lock.as_mut().ok_or("Native engine not initialized")?;
    if v["op"] == "poll" {
        let mut events: Vec<Value> = state.events.lock().drain(..).collect();
        if v["visual"].as_bool().unwrap_or(false) && state.engine.viz_frame(&mut state.frame) {
            events.push(json!({"kind":"viz","base64":STANDARD.encode(state.frame.iter().flat_map(|v|v.to_le_bytes()).collect::<Vec<_>>())}));
        }
        return Ok(json!(events));
    }
    let v = if v["op"] == "message" {
        &v["message"]
    } else {
        &v
    };
    match v["kind"].as_str().unwrap_or("") {
        "offline" => {
            Ok(json!({"kind":"offlineResult","id":v["id"],"error":"鸿蒙端尚未接入后台视频编码器"}))
        }
        "command" => {
            state.engine.send(
                serde_json::from_value::<Command>(v["command"].clone())
                    .map_err(|e| e.to_string())?,
            );
            Ok(Value::Null)
        }
        "query" => Ok(
            json!({"kind":"queryResult","id":v["id"],"response":state.engine.query(serde_json::from_value::<Query>(v["query"].clone()).map_err(|e|e.to_string())?)}),
        ),
        "cover" => Ok(
            json!({"kind":"coverResult","id":v["id"],"cover":jap_engine::read_cover(Path::new(v["path"].as_str().unwrap_or(""))).map(|c|json!({"mime":c.mime,"base64":STANDARD.encode(c.data)}))}),
        ),
        _ => Err("不支持的引擎操作".into()),
    }
}
/// # Safety
/// `input` must point to a valid NUL-terminated UTF-8 string for the call duration.
/// The returned allocation must be released with `jap_harmony_free` exactly once.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn jap_harmony_request(input: *const c_char) -> *mut c_char {
    let value = std::panic::catch_unwind(|| {
        if input.is_null() {
            return json!({"error":"Empty native request"});
        }
        let input = unsafe { CStr::from_ptr(input) }.to_string_lossy();
        run(&input).unwrap_or_else(|e| json!({"error":e}))
    })
    .unwrap_or_else(|_| json!({"error":"Native request failed"}));
    CString::new(value.to_string()).unwrap().into_raw()
}
/// # Safety
/// `value` is null or a live allocation returned by `jap_harmony_request`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn jap_harmony_free(value: *mut c_char) {
    if !value.is_null() {
        unsafe {
            drop(CString::from_raw(value));
        }
    }
}

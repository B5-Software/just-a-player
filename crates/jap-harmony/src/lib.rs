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
    engine: Arc<jap_engine::Engine>,
    events: Arc<Mutex<VecDeque<Value>>>,
    frame: Vec<f32>,
}
fn host() -> &'static Mutex<Option<Host>> {
    static HOST: OnceLock<Mutex<Option<Host>>> = OnceLock::new();
    HOST.get_or_init(Default::default)
}
fn run(input: &str) -> Result<Value, String> {
    let v: Value = serde_json::from_str(input).map_err(|e| e.to_string())?;
    if v["op"] == "nativeInit" {
        let engine = host()
            .lock()
            .as_ref()
            .ok_or("Native engine not initialized")?
            .engine
            .clone();
        let root = std::path::PathBuf::from(v["root"].as_str().ok_or("Missing native storage")?);
        let file = root.join("light-handoff.json");
        let handoff = jap_light::model::read(&file);
        let _ = std::fs::remove_file(file);
        let mut settings = jap_light::model::read(&root.join("settings.json"));
        if !settings.is_object() {
            settings = json!({});
        }
        settings["nativeQa"] = v["qa"].clone();
        jap_light::host::init(engine, root, "ohos", settings, handoff);
        return Ok(json!(true));
    }
    if v["op"] == "nativeControl" {
        return Ok(jap_light::host::control(&v["input"]));
    }
    if v["op"] == "nativeTick" {
        let pending = {
            let lock = host().lock();
            lock.as_ref()
                .map(|h| h.events.lock().drain(..).collect::<Vec<Value>>())
                .unwrap_or_default()
        };
        for event in pending {
            jap_light::host::receive(event);
        }
        let mut lock = jap_light::host::surface().lock();
        if let Some(surface) = lock.as_mut() {
            surface.player.visible = v["visible"].as_bool().unwrap_or(false);
            surface.player.tick(&surface.ctx);
        }
        return Ok(Value::Null);
    }
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
                engine: Arc::new(engine),
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
        state
            .engine
            .set_visualization_enabled(v["visual"].as_bool().unwrap_or(false));
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
/// Output must refer to a writable RGBA allocation of at least capacity bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn jap_harmony_native_render(
    input: *const c_char,
    out: *mut u8,
    capacity: usize,
) -> *mut c_char {
    let result = std::panic::catch_unwind(|| {
        if input.is_null() || out.is_null() {
            return Err("Missing native frame".to_owned());
        }
        let input: Value =
            serde_json::from_str(&unsafe { CStr::from_ptr(input) }.to_string_lossy())
                .map_err(|e| e.to_string())?;
        let pending = {
            let lock = host().lock();
            lock.as_ref()
                .map(|h| h.events.lock().drain(..).collect::<Vec<Value>>())
                .unwrap_or_default()
        };
        for event in pending {
            jap_light::host::receive(event);
        }
        let mut lock = jap_light::host::surface().lock();
        let surface = lock.as_mut().ok_or("Native UI not initialized")?;
        let width = input["width"].as_u64().unwrap_or(0) as usize;
        let height = input["height"].as_u64().unwrap_or(0) as usize;
        if width < 160
            || height < 90
            || width > 2560
            || height > 1600
            || width * height * 4 > capacity
        {
            return Err("Invalid native surface size".into());
        }
        let result = surface.render(&input);
        unsafe {
            std::ptr::copy_nonoverlapping(
                surface.pixels.as_ptr().cast::<u8>(),
                out,
                width * height * 4,
            );
        }
        if surface.player.settings["nativeQa"] == true && surface.player.renders % 5 == 0 {
            let _ = jap_light::model::save(
                &surface.player.root.join("native-report.json"),
                &surface.player.debug(),
            );
        }
        Ok(result)
    });
    let result = match result {
        Ok(Ok(v)) => v,
        Ok(Err(e)) => json!({"error":e}),
        Err(_) => json!({"error":"Native UI frame failed"}),
    };
    CString::new(result.to_string()).unwrap().into_raw()
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

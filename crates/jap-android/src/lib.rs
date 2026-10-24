//! Android JNI host. The same Rust engine/protocol is used by Electron and WebView.
#[cfg(target_os = "android")]
mod bridge {
    use base64::{Engine as _, engine::general_purpose::STANDARD};
    use jap_core::{Command, Query};
    use jap_engine::Engine;
    use jni::{
        JNIEnv,
        objects::{JClass, JString},
        sys::{jboolean, jint, jstring},
    };
    use parking_lot::Mutex;
    use serde_json::{Value, json};
    use std::{
        collections::VecDeque,
        path::Path,
        sync::{Arc, OnceLock},
    };

    struct Host {
        engine: Arc<Engine>,
        events: Arc<Mutex<VecDeque<Value>>>,
        frame: Vec<f32>,
    }
    fn host() -> &'static Mutex<Option<Host>> {
        static HOST: OnceLock<Mutex<Option<Host>>> = OnceLock::new();
        HOST.get_or_init(Default::default)
    }
    fn offline(v: &Value) -> Result<Value, String> {
        static OFFLINE: OnceLock<Mutex<Option<jap_engine::OfflineRender>>> = OnceLock::new();
        let mut state = OFFLINE.get_or_init(Default::default).lock();
        let mut result = json!({"kind":"offlineResult","id":v["id"]});
        let action = v["action"].as_str().unwrap_or("");
        let work = (|| -> Result<(), String> {
            match action {
                "open" => {
                    let audio = v["audioPath"].as_str().unwrap_or("").to_owned();
                    *state = Some(jap_engine::OfflineRender::new_with_midi(
                        v["path"].as_str().ok_or("Missing audio path")?.into(),
                        audio.clone(),
                        v["startMs"].as_u64().unwrap_or(0) as u32,
                        v["soundfont"].as_str().map(str::to_owned),
                        v["midiRate"].as_u64().unwrap_or(96000) as u32,
                    )?);
                    result["audioPath"] = json!(audio);
                }
                "frame" => {
                    let frame = state
                        .as_mut()
                        .ok_or("Offline decoder not open")?
                        .frame_at(v["timeMs"].as_f64().unwrap_or(0.0))?;
                    let bytes: Vec<u8> = frame.iter().flat_map(|f| f.to_le_bytes()).collect();
                    result["base64"] = json!(STANDARD.encode(bytes));
                }
                "close" => {
                    if let Some(mut render) = state.take() {
                        render.close()?;
                    }
                }
                "original" => {
                    let source = v["path"].as_str().ok_or("Missing NCM path")?;
                    let target = v["audioPath"].as_str().ok_or("Missing original target")?;
                    let mut input = jap_decode::NcmReader::open(Path::new(source))
                        .map_err(|e| e.to_string())?;
                    let mut output =
                        std::fs::File::create_new(target).map_err(|e| e.to_string())?;
                    std::io::copy(&mut input, &mut output).map_err(|e| e.to_string())?;
                    result["audioPath"] = json!(target);
                }
                _ => return Err("Invalid offline action".into()),
            }
            Ok(())
        })();
        if let Err(e) = work {
            result["error"] = json!(e);
        }
        Ok(result)
    }
    fn read(env: &mut JNIEnv, s: JString) -> String {
        env.get_string(&s).map(|s| s.into()).unwrap_or_default()
    }
    fn output(env: &mut JNIEnv, work: impl FnOnce() -> Result<Value, String>) -> jstring {
        let value = std::panic::catch_unwind(std::panic::AssertUnwindSafe(work))
            .unwrap_or_else(|_| Err("Android native host panicked".into()));
        let json = match value {
            Ok(v) => v,
            Err(e) => json!({"error":e}),
        }
        .to_string();
        env.new_string(json)
            .map(|s| s.into_raw())
            .unwrap_or(std::ptr::null_mut())
    }
    #[unsafe(no_mangle)]
    pub extern "system" fn Java_org_b5_1software_justaplayer_Native_lightInit(
        mut env: JNIEnv,
        _class: JClass,
        root: JString,
        settings: JString,
        handoff: JString,
    ) -> jstring {
        let root = read(&mut env, root);
        let settings = read(&mut env, settings);
        let handoff = read(&mut env, handoff);
        output(&mut env, || {
            let engine = host()
                .lock()
                .as_ref()
                .ok_or("Native engine not initialized")?
                .engine
                .clone();
            jap_light::host::init(
                engine,
                root.into(),
                "android",
                serde_json::from_str(&settings).unwrap_or_default(),
                serde_json::from_str(&handoff).unwrap_or_default(),
            );
            Ok(json!(true))
        })
    }
    #[unsafe(no_mangle)]
    pub extern "system" fn Java_org_b5_1software_justaplayer_Native_lightEvent(
        mut env: JNIEnv,
        _class: JClass,
        message: JString,
    ) -> jstring {
        let message = read(&mut env, message);
        output(&mut env, || {
            jap_light::host::receive(serde_json::from_str(&message).map_err(|e| e.to_string())?);
            Ok(Value::Null)
        })
    }
    #[unsafe(no_mangle)]
    pub extern "system" fn Java_org_b5_1software_justaplayer_Native_lightControl(
        mut env: JNIEnv,
        _class: JClass,
        message: JString,
    ) -> jstring {
        let message = read(&mut env, message);
        output(&mut env, || {
            Ok(jap_light::host::control(
                &serde_json::from_str::<Value>(&message).map_err(|e| e.to_string())?,
            ))
        })
    }
    #[repr(C)]
    struct BitmapInfo {
        width: u32,
        height: u32,
        stride: u32,
        format: i32,
        flags: u32,
    }
    #[link(name = "jnigraphics")]
    unsafe extern "C" {
        fn AndroidBitmap_getInfo(
            env: *mut jni::sys::JNIEnv,
            bitmap: jni::sys::jobject,
            info: *mut BitmapInfo,
        ) -> i32;
        fn AndroidBitmap_lockPixels(
            env: *mut jni::sys::JNIEnv,
            bitmap: jni::sys::jobject,
            pixels: *mut *mut std::ffi::c_void,
        ) -> i32;
        fn AndroidBitmap_unlockPixels(env: *mut jni::sys::JNIEnv, bitmap: jni::sys::jobject)
        -> i32;
    }
    #[unsafe(no_mangle)]
    pub extern "system" fn Java_org_b5_1software_justaplayer_Native_lightDraw(
        mut env: JNIEnv,
        _class: JClass,
        bitmap: jni::objects::JObject,
        input: JString,
    ) -> jstring {
        let input = read(&mut env, input);
        let result = (|| -> Result<Value, String> {
            let mut info = BitmapInfo {
                width: 0,
                height: 0,
                stride: 0,
                format: 0,
                flags: 0,
            };
            if unsafe { AndroidBitmap_getInfo(env.get_raw(), bitmap.as_raw(), &mut info) } != 0
                || info.format != 1
                || info.width > 2560
                || info.height > 1600
                || info.stride < info.width * 4
            {
                return Err("Invalid native bitmap".into());
            }
            let mut lock = jap_light::host::surface().lock();
            let ui = lock.as_mut().ok_or("Native UI not initialized")?;
            let mut input: Value = serde_json::from_str(&input).map_err(|e| e.to_string())?;
            input["width"] = json!(info.width);
            input["height"] = json!(info.height);
            let result = ui.render(&input);
            let mut pixels = std::ptr::null_mut();
            if unsafe { AndroidBitmap_lockPixels(env.get_raw(), bitmap.as_raw(), &mut pixels) } != 0
            {
                return Err("Cannot lock native bitmap".into());
            }
            for row in 0..info.height as usize {
                unsafe {
                    std::ptr::copy_nonoverlapping(
                        ui.pixels
                            .as_ptr()
                            .cast::<u8>()
                            .add(row * info.width as usize * 4),
                        pixels.cast::<u8>().add(row * info.stride as usize),
                        info.width as usize * 4,
                    );
                }
            }
            unsafe {
                AndroidBitmap_unlockPixels(env.get_raw(), bitmap.as_raw());
            }
            Ok(result)
        })();
        output(&mut env, || result)
    }
    #[unsafe(no_mangle)]
    pub extern "system" fn Java_org_b5_1software_justaplayer_Native_init(
        mut env: JNIEnv,
        _class: JClass,
        home: JString,
        libs: JString,
    ) -> jstring {
        let home = read(&mut env, home);
        let libs = read(&mut env, libs);
        output(&mut env, || {
            let mut h = host().lock();
            if h.is_none() {
                // Set before any engine/decoder threads exist.
                unsafe {
                    std::env::set_var("TMPDIR", &home);
                    std::env::set_var(
                        "JAP_SOUNDFONT_PATH",
                        format!("{home}/../files/soundfonts/MuseScore_General_HQ.sf2"),
                    );
                    std::env::set_var("JAP_FFMPEG_PATH", format!("{libs}/libffmpeg.so"));
                    std::env::set_var("JAP_FFPROBE_PATH", format!("{libs}/libffprobe.so"));
                }
                let events = Arc::new(Mutex::new(VecDeque::new()));
                let queue = Arc::clone(&events);
                let engine = Engine::new(Arc::new(move |e| {
                    if let Ok(v) = serde_json::to_value(e) {
                        let mut q = queue.lock();
                        if q.len() >= 512 {
                            q.retain(|v: &Value| v["type"] != "position");
                        }
                        if q.len() >= 512 {
                            q.pop_front();
                        }
                        q.push_back(v);
                    }
                }));
                *h = Some(Host {
                    engine: Arc::new(engine),
                    events,
                    frame: Vec::new(),
                });
            }
            Ok(json!({"ready":true}))
        })
    }
    #[unsafe(no_mangle)]
    pub extern "system" fn Java_org_b5_1software_justaplayer_Native_message(
        mut env: JNIEnv,
        _class: JClass,
        message: JString,
    ) -> jstring {
        let message = read(&mut env, message);
        output(&mut env, || {
            let v: Value = serde_json::from_str(&message).map_err(|e| e.to_string())?;
            if v["kind"] == "offline" {
                return offline(&v);
            }
            let h = host().lock();
            let h = h.as_ref().ok_or("Native engine not initialized")?;
            match v["kind"].as_str().unwrap_or("") {
                "command" => {
                    let c: Command =
                        serde_json::from_value(v["command"].clone()).map_err(|e| e.to_string())?;
                    h.engine.send(c);
                    Ok(Value::Null)
                }
                "query" => {
                    let q: Query =
                        serde_json::from_value(v["query"].clone()).map_err(|e| e.to_string())?;
                    Ok(json!({"kind":"queryResult","id":v["id"],"response":h.engine.query(q)}))
                }
                "cover" => {
                    let cover = jap_engine::read_cover(Path::new(v["path"].as_str().unwrap_or("")))
                        .map(|c| json!({"mime":c.mime,"base64":STANDARD.encode(c.data)}));
                    Ok(json!({"kind":"coverResult","id":v["id"],"cover":cover}))
                }
                _ => Err("Unsupported engine message".into()),
            }
        })
    }
    #[unsafe(no_mangle)]
    pub extern "system" fn Java_org_b5_1software_justaplayer_Native_poll(
        mut env: JNIEnv,
        _class: JClass,
        visual: jboolean,
    ) -> jstring {
        output(&mut env, || {
            let mut lock = host().lock();
            let h = lock.as_mut().ok_or("Native engine not initialized")?;
            if jap_light::host::surface().lock().is_none() {
                h.engine.set_visualization_enabled(visual != 0);
            }
            let mut events: Vec<Value> = h.events.lock().drain(..).collect();
            if visual != 0 {
                let mut frame = std::mem::take(&mut h.frame);
                if h.engine.viz_frame(&mut frame) {
                    let bytes: Vec<u8> = frame.iter().flat_map(|f| f.to_le_bytes()).collect();
                    events.push(json!({"kind":"viz","base64":STANDARD.encode(bytes)}));
                }
                h.frame = frame;
            }
            Ok(json!(events))
        })
    }
    #[unsafe(no_mangle)]
    pub extern "system" fn Java_org_b5_1software_justaplayer_Native_usbAttach(
        mut env: JNIEnv,
        _class: JClass,
        id: JString,
        fd: jint,
        name: JString,
        descriptors: JString,
        vendor: jint,
        product: jint,
    ) -> jstring {
        let id = read(&mut env, id);
        let name = read(&mut env, name);
        let descriptors = read(&mut env, descriptors);
        output(&mut env, || {
            let bytes = STANDARD.decode(descriptors).map_err(|e| e.to_string())?;
            jap_output::android::register_usb(id, fd, name, bytes, vendor as u16, product as u16)
                .map_err(|e| e.to_string())?;
            Ok(json!(true))
        })
    }
    #[unsafe(no_mangle)]
    pub extern "system" fn Java_org_b5_1software_justaplayer_Native_usbDetach(
        mut env: JNIEnv,
        _class: JClass,
        id: JString,
    ) -> jstring {
        let id = read(&mut env, id);
        output(&mut env, || {
            jap_output::android::unregister_usb(&id);
            Ok(json!(true))
        })
    }
}

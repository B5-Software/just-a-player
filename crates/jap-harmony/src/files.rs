use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
};
type Result<T> = std::result::Result<T, String>;
fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}
fn key(path: &str) -> String {
    Sha256::digest(path.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
fn path(root: &Path, value: &Value) -> Result<PathBuf> {
    let input = Path::new(value.as_str().ok_or("Missing path")?);
    let resolved = input.canonicalize().map_err(err)?;
    if !resolved.starts_with(root.canonicalize().map_err(err)?) {
        return Err("文件位于授权目录之外".into());
    }
    Ok(resolved)
}
fn text(path: &Path) -> Value {
    fs::read_to_string(path)
        .ok()
        .map(Value::String)
        .unwrap_or(Value::Null)
}
fn read_mode(root: &Path) -> Value {
    text(&root.join("lightweight-mode.json"))
        .as_str()
        .and_then(|s| serde_json::from_str::<Value>(s).ok())
        .unwrap_or(json!({"enabled":false}))
}
fn read(path: &Path, limit: u64) -> Result<Value> {
    let file = fs::File::open(path).map_err(err)?;
    if file.metadata().map_err(err)?.len() > limit {
        return Err("此资源文件超过大小限制；音频请通过播放导入".into());
    }
    let mut data = Vec::new();
    file.take(limit + 1).read_to_end(&mut data).map_err(err)?;
    Ok(json!(STANDARD.encode(data)))
}
fn save(path: &Path, content: &[u8]) -> Result<Value> {
    static WRITES: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _guard = WRITES.lock().map_err(err)?;
    fs::create_dir_all(path.parent().ok_or("No parent")?).map_err(err)?;
    let temp = path.with_extension("pending");
    fs::write(&temp, content).map_err(err)?;
    fs::rename(temp, path).map_err(err)?;
    Ok(json!(true))
}
fn audio(path: &Path) -> bool {
    path.extension().and_then(|v| v.to_str()).is_some_and(|e| {
        [
            "flac", "wav", "wave", "aiff", "aif", "mp3", "m4a", "aac", "ogg", "oga", "opus",
            "alac", "caf", "mka", "dsf", "dff", "iso", "bin", "img", "cue", "ncm", "ape", "dts",
            "dtshd", "wv", "tta", "mid", "midi", "kar", "rmi",
        ]
        .contains(&e.to_ascii_lowercase().as_str())
    })
}
fn scan(path: &Path, recursive: bool, depth: u32, out: &mut Vec<String>) {
    if out.len() >= 100_000 || depth > 32 {
        return;
    }
    if path.is_file() {
        if audio(path) {
            out.push(path.to_string_lossy().into());
        }
        return;
    }
    if let Ok(entries) = fs::read_dir(path) {
        for entry in entries.flatten() {
            if entry.file_type().is_ok_and(|t| t.is_symlink()) {
                continue;
            }
            let p = entry.path();
            if p.is_file() || recursive {
                scan(&p, recursive, depth + 1, out);
            }
        }
    }
}
pub(super) fn request(v: &Value) -> Result<Value> {
    let root = Path::new(v["root"].as_str().ok_or("Missing private storage")?);
    let music = root.join("Music");
    fs::create_dir_all(&music).map_err(err)?;
    let p = &v["payload"];
    let method = v["method"].as_str().unwrap_or("");
    match method {
        "snapshot" => Ok(
            json!({"version":env!("CARGO_PKG_VERSION"),"lightHandoff":text(&root.join("light-handoff.json")).as_str().and_then(|s|serde_json::from_str::<Value>(s).ok()),"surface":"main","platform":"ohos","settings":text(&root.join("settings.json")).as_str().and_then(|s|serde_json::from_str::<Value>(s).ok()).unwrap_or(json!({})),"fonts":[],"bundledMidi":false}),
        ),
        "settings" => save(
            &root.join("settings.json"),
            p["patch"].to_string().as_bytes(),
        )
        .map(|_| p["patch"].clone()),
        "libraryLoad" => Ok(text(&root.join("library.json"))),
        "lightLoad" => Ok(text(&root.join("lightweight.json"))),
        "lightSave" => save(
            &root.join("lightweight.json"),
            p["json"]
                .as_str()
                .ok_or("Invalid light preferences")?
                .as_bytes(),
        ),
        "lightHandoff" => {
            let file = root.join("light-handoff.json");
            let result = text(&file)
                .as_str()
                .and_then(|s| serde_json::from_str::<Value>(s).ok())
                .unwrap_or(Value::Null);
            let _ = fs::remove_file(file);
            Ok(result)
        }
        "lightweightMode" => {
            save(
                &root.join("light-handoff.json"),
                p["handoff"].to_string().as_bytes(),
            )?;
            save(
                &root.join("lightweight-mode.json"),
                json!({"enabled":p["enabled"]}).to_string().as_bytes(),
            )
        }
        "lightMode" => Ok(read_mode(root)),
        "lightReady" | "lightVisuals" | "lightReplay" => Ok(Value::Null),
        "librarySave" => save(
            &root.join("library.json"),
            p["json"].as_str().ok_or("Invalid library")?.as_bytes(),
        ),
        "musicFolders" => Ok(json!([music])),
        "pathsExist" => Ok(json!(
            p["paths"]
                .as_array()
                .ok_or("Invalid paths")?
                .iter()
                .map(|p| path(root, p).is_ok())
                .collect::<Vec<_>>()
        )),
        "scan" => {
            let mut out = Vec::new();
            for item in p["paths"].as_array().ok_or("Invalid paths")? {
                if let Ok(file) = path(root, item) {
                    scan(
                        &file,
                        p["recursive"].as_bool().unwrap_or(false),
                        0,
                        &mut out,
                    );
                }
            }
            out.sort();
            out.dedup();
            Ok(json!(out))
        }
        "readFile" => read(&path(root, &p["path"])?, 64 * 1024 * 1024),
        "importSoundfont" => {
            let source = path(root, &p["path"])?;
            let mut input = fs::File::open(&source).map_err(err)?;
            let mut header = [0; 12];
            input.read_exact(&mut header).map_err(err)?;
            if &header[..4] != b"RIFF"
                || &header[8..] != b"sfbk"
                || input.metadata().map_err(err)?.len() > 1024 * 1024 * 1024
            {
                return Err("请选择不超过 1 GiB 的有效 SF2 音色库".into());
            }
            let target = root
                .join("soundfonts")
                .join(format!("user-{}.sf2", key(&source.to_string_lossy())));
            fs::create_dir_all(target.parent().unwrap()).map_err(err)?;
            fs::copy(&source, &target).map_err(err)?;
            Ok(json!(target))
        }
        "sidecarLyrics" => {
            let file = path(root, &p["path"])?.with_extension("lrc");
            if file.is_file() {
                read(&file, 8 * 1024 * 1024)
            } else {
                Ok(Value::Null)
            }
        }
        "sidecarCover" => {
            let file = path(root, &p["path"])?;
            let dir = file.parent().ok_or("Invalid folder")?;
            for candidate in [
                file.with_extension("jpg"),
                file.with_extension("png"),
                dir.join("cover.jpg"),
                dir.join("cover.png"),
                dir.join("folder.jpg"),
            ] {
                if candidate.is_file()
                    && candidate.metadata().map_err(err)?.len() <= 16 * 1024 * 1024
                {
                    let data = fs::read(candidate).map_err(err)?;
                    if let Some(mime) = jap_decode::cover_mime(&data) {
                        return Ok(json!({"mime":mime,"base64":STANDARD.encode(data)}));
                    }
                }
            }
            Ok(Value::Null)
        }
        "lyricsGet" => {
            let file = root
                .join("lyrics")
                .join(key(p["path"].as_str().unwrap_or("")));
            if file.is_file() {
                read(&file, 8 * 1024 * 1024)
            } else {
                Ok(Value::Null)
            }
        }
        "lyricsSet" => {
            let file = root
                .join("lyrics")
                .join(key(p["path"].as_str().unwrap_or("")));
            if let Some(data) = p["data"].as_str() {
                let bytes = STANDARD.decode(data).map_err(err)?;
                if bytes.len() > 8 * 1024 * 1024 {
                    return Err("歌词文件过大".into());
                }
                save(&file, &bytes)
            } else {
                let _ = fs::remove_file(file);
                Ok(json!(true))
            }
        }
        "browse" => {
            let dir = if p["path"].as_str().unwrap_or("").is_empty() {
                music.clone()
            } else {
                path(root, &p["path"])?
            };
            let mut entries = Vec::new();
            for entry in fs::read_dir(&dir).map_err(err)?.flatten() {
                let meta = entry.metadata().map_err(err)?;
                if !entry.file_type().is_ok_and(|t| t.is_symlink()) {
                    entries.push(json!({"name":entry.file_name().to_string_lossy(),"path":entry.path(),"directory":meta.is_dir(),"size":meta.len()}));
                }
            }
            entries.sort_by(|a, b| {
                b["directory"]
                    .as_bool()
                    .cmp(&a["directory"].as_bool())
                    .then_with(|| a["name"].as_str().cmp(&b["name"].as_str()))
            });
            Ok(
                json!({"path":dir,"parent":if dir==music{None}else{dir.parent()},"roots":[{"name":"音乐","path":music},{"name":"导入外部文件…","path":"native-import"}],"entries":entries}),
            )
        }
        "importFd" => {
            #[cfg(unix)]
            {
                use std::os::fd::FromRawFd;
                let fd = p["fd"].as_i64().ok_or("Invalid fd")? as i32;
                let fd = unsafe { libc::dup(fd) };
                if fd < 0 {
                    return Err(std::io::Error::last_os_error().to_string());
                }
                let mut input = unsafe { fs::File::from_raw_fd(fd) };
                let name = Path::new(p["name"].as_str().ok_or("Missing name")?)
                    .file_name()
                    .ok_or("Invalid name")?;
                let target = music.join(name);
                let temp = music.join(format!("{}.part", key(&name.to_string_lossy())));
                let mut output = fs::File::create(&temp).map_err(err)?;
                std::io::copy(&mut input, &mut output).map_err(err)?;
                drop(output);
                fs::rename(temp, &target).map_err(err)?;
                Ok(json!(target))
            }
            #[cfg(not(unix))]
            {
                Err("File descriptor import requires HarmonyOS".into())
            }
        }
        "takeOpenFiles" => Ok(json!([])),
        "videoQueue" => Ok(json!([])),
        "videoEnqueue" | "videoStart" => Err("鸿蒙端后台视频导出尚未接入原生编码器".into()),
        "permission" | "systemMedia" | "fullscreen" | "windowMode" | "visibility" => {
            Ok(Value::Null)
        }
        _ => Err(format!("尚未支持此操作：{method}")),
    }
}

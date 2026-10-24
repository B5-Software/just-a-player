use anyhow::{Context, Result};
use clap::Parser;
use jap_core::Command;
use jap_light::{Player, egui};
#[cfg(windows)]
use raw_window_handle::HasWindowHandle;
use serde_json::{Value, json};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
#[derive(Parser)]
struct Args {
    #[arg(long)]
    data_dir: Option<PathBuf>,
    #[arg(long)]
    resources: Option<PathBuf>,
    #[arg(long)]
    return_app: Option<PathBuf>,
    #[arg(long)]
    return_entry: Option<PathBuf>,
    #[arg(long)]
    handoff: Option<PathBuf>,
    #[arg(long)]
    ready_file: Option<PathBuf>,
    /// Local file-based native QA. No debugger, HTTP port or browser is started.
    #[arg(long)]
    qa: bool,
    #[arg(long)]
    smoke_report: Option<PathBuf>,
    #[arg(trailing_var_arg = true)]
    files: Vec<String>,
}
struct App {
    player: Player,
    events: Arc<Mutex<Vec<Value>>>,
    commands: std::sync::mpsc::Receiver<String>,
    media: Option<souvlaki::MediaControls>,
    last_media: Value,
    awake: Option<keepawake::KeepAwake>,
    ready: Option<PathBuf>,
    qa: bool,
    smoke: Option<PathBuf>,
    root: PathBuf,
    returned: Arc<std::sync::atomic::AtomicBool>,
    first: bool,
    last_mail: Instant,
    last_media_at: Instant,
    graphics: Value,
}
impl App {
    fn command(&mut self, command: &str) {
        match command {
            "next" => self.player.neighbour(1, false),
            "previous" => self.player.neighbour(-1, false),
            "pause" => self.player.command(Command::Pause),
            "stop" => self.player.command(Command::Stop),
            "play" => {
                if self.player.state != jap_core::PlaybackState::Playing {
                    self.player.toggle();
                }
            }
            "toggle" => self.player.toggle(),
            _ => {}
        }
    }
    fn screenshot(&self, image: &egui::ColorImage) {
        let path = self
            .smoke
            .as_ref()
            .map(|p| p.with_extension("png"))
            .unwrap_or_else(|| self.root.join("native-screenshot.png"));
        let _ = jap_light::surface::save_image(&path, image);
    }
}
impl eframe::App for App {
    fn logic(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        let minimized = ctx.input(|i| i.viewport().minimized.unwrap_or(false));
        self.player.visible = !minimized;
        if minimized {
            self.player.engine.set_visualization_enabled(false);
        }
        let messages = std::mem::take(&mut *self.events.lock().unwrap());
        for message in messages {
            self.player.receive(message);
        }
        while let Ok(command) = self.commands.try_recv() {
            self.command(&command);
        }
        for event in ctx.input(|i| i.events.clone()) {
            if let egui::Event::Screenshot { image, .. } = event {
                self.screenshot(&image);
                if self.smoke.is_some() {
                    ctx.send_viewport_cmd(egui::ViewportCommand::Close);
                }
            }
        }
        if self.last_mail.elapsed() > Duration::from_millis(100) {
            self.last_mail = Instant::now();
            if let Ok(entries) = std::fs::read_dir(self.root.join("light-inbox")) {
                for entry in entries.take(32).flatten() {
                    if let Some(paths) = jap_light::model::read(&entry.path()).as_array() {
                        self.player.external(
                            paths
                                .iter()
                                .filter_map(|p| p.as_str().map(str::to_owned))
                                .collect(),
                        );
                        ctx.send_viewport_cmd(egui::ViewportCommand::Minimized(false));
                        ctx.send_viewport_cmd(egui::ViewportCommand::Focus);
                    }
                    let _ = std::fs::remove_file(entry.path());
                }
            }
            if self.qa {
                let file = self.root.join("native-input.json");
                let input = jap_light::model::read(&file);
                let _ = std::fs::remove_file(file);
                match input["type"].as_str().unwrap_or("") {
                    "command" => self.command(input["command"].as_str().unwrap_or("")),
                    "import" => self.player.import(
                        input["paths"]
                            .as_array()
                            .map(|a| {
                                a.iter()
                                    .filter_map(|p| p.as_str().map(str::to_owned))
                                    .collect()
                            })
                            .unwrap_or_default(),
                    ),
                    "meter" => self.player.set_meter(
                        input["id"].as_str().unwrap_or("vu"),
                        input["enabled"].as_bool().unwrap_or(false),
                    ),
                    "volume" => {
                        let gain = input["gain"].as_f64().unwrap_or(0.2).clamp(0., 1.) as f32;
                        self.player.command(Command::SetVolume { gain });
                    }
                    "dialog" => self.player.dialog = input["name"].as_str().unwrap_or("").into(),
                    "screenshot" => {
                        ctx.send_viewport_cmd(egui::ViewportCommand::Screenshot(Default::default()))
                    }
                    "full" => {
                        let handoff = self.player.handoff();
                        self.player
                            .actions
                            .push(json!({"type":"returnFull","handoff":handoff}));
                    }
                    "close" => ctx.send_viewport_cmd(egui::ViewportCommand::Close),
                    _ => {}
                }
                let _ = jap_light::model::save(&self.root.join("native-report.json"), &{
                    let mut report = self.player.debug();
                    report["graphics"] = self.graphics.clone();
                    report
                });
            }
        }
        ctx.request_repaint_after(Duration::from_millis(if self.player.visible {
            200
        } else {
            1000
        }));
    }
    fn ui(&mut self, ui: &mut egui::Ui, _frame: &mut eframe::Frame) {
        jap_light::ui::draw(ui, &mut self.player);
        self.player.renders += 1;
        for action in std::mem::take(&mut self.player.actions) {
            match action["type"].as_str().unwrap_or("") {
                "returnFull" if self.player.can_return => {
                    let result = jap_light::model::save(
                        &self.root.join("light-return.json"),
                        &action["handoff"],
                    )
                    .and_then(|_| {
                        jap_light::model::save(
                            &self.root.join("lightweight-mode.json"),
                            &json!({"enabled":false}),
                        )
                    });
                    match result {
                        Ok(()) => {
                            self.returned
                                .store(true, std::sync::atomic::Ordering::Release);
                            ui.ctx().send_viewport_cmd(egui::ViewportCommand::Close);
                        }
                        Err(e) => self.player.error = Some(e),
                    }
                }
                "media" => {
                    if let Some(controls) = &mut self.media {
                        crate::media::update(
                            controls,
                            &action["value"],
                            &self.root,
                            &mut self.last_media,
                        );
                    }
                    self.last_media_at = Instant::now();
                }
                "settings" => {
                    let _ = jap_light::model::save(
                        &self.root.join("settings.json"),
                        &self.player.settings,
                    );
                }
                _ => {}
            }
        }
        if self.last_media_at.elapsed() > Duration::from_secs(1) {
            self.last_media_at = Instant::now();
            let media = self.player.media();
            if let Some(controls) = &mut self.media {
                crate::media::update(controls, &media, &self.root, &mut self.last_media);
            }
        }
        let hold = self.player.state == jap_core::PlaybackState::Playing
            && self.player.settings["keepScreenAwake"] == true;
        if hold && self.awake.is_none() {
            self.awake = keepawake::Builder::default()
                .display(true)
                .reason("Music playback")
                .app_name("Just A Player")
                .app_reverse_domain("org.b5_software.justaplayer")
                .create()
                .ok();
        }
        if !hold {
            self.awake = None;
        }
        if self.first {
            self.first = false;
            if let Some(file) = &self.ready {
                let _ = std::fs::write(file, b"native-ready");
            }
            if let Some(report) = &self.smoke {
                let mut state = self.player.debug();
                state["graphics"] = self.graphics.clone();
                state["passed"] = json!(!self.player.controls.is_empty());
                let _ = jap_light::model::save(report, &state);
                ui.ctx()
                    .send_viewport_cmd(egui::ViewportCommand::Screenshot(Default::default()));
            }
        }
    }
}
pub fn run() -> Result<()> {
    #[cfg(windows)]
    unsafe {
        windows::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID(windows::core::w!(
            "B5Software.JustAPlayer"
        ))?;
    }
    let args = Args::parse();
    let root = args.data_dir.clone().unwrap_or_else(|| {
        let base = std::env::var_os(if cfg!(windows) { "APPDATA" } else { "HOME" })
            .map(PathBuf::from)
            .unwrap_or_else(|| ".".into());
        base.join(if cfg!(windows) {
            "Just A Player"
        } else {
            ".local/share/just-a-player"
        })
    });
    std::fs::create_dir_all(root.join("light-inbox"))?;
    let instance = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(root.join("light-instance.lock"))?;
    if fs2::FileExt::try_lock_exclusive(&instance).is_err() {
        jap_light::model::save(
            &root
                .join("light-inbox")
                .join(format!("{}.json", jap_light::model::now_id())),
            &json!(args.files),
        )
        .map_err(anyhow::Error::msg)?;
        if let Some(path) = &args.ready_file {
            std::fs::write(path, b"native-ready")?;
        }
        return Ok(());
    }
    if let Some(resources) = &args.resources {
        unsafe {
            std::env::set_var(
                "JAP_FFMPEG_PATH",
                resources.join("media-tools/bin").join(if cfg!(windows) {
                    "ffmpeg.exe"
                } else {
                    "ffmpeg"
                }),
            );
            std::env::set_var(
                "JAP_FFPROBE_PATH",
                resources.join("media-tools/bin").join(if cfg!(windows) {
                    "ffprobe.exe"
                } else {
                    "ffprobe"
                }),
            );
            let bank = resources.join("soundfonts/MuseScore_General_HQ.sf2");
            if bank.is_file() {
                std::env::set_var("JAP_SOUNDFONT_PATH", bank);
            }
        }
    }
    let handoff = args
        .handoff
        .as_deref()
        .map(jap_light::model::read)
        .unwrap_or(Value::Null);
    if let Some(file) = args.handoff {
        let _ = std::fs::remove_file(file);
    }
    let events = Arc::new(Mutex::new(Vec::<Value>::new()));
    let sink = events.clone();
    let context: Arc<Mutex<Option<egui::Context>>> = Arc::default();
    let wake = context.clone();
    let engine = Arc::new(jap_engine::Engine::new(Arc::new(move |event| {
        let is_position = matches!(event, jap_core::Event::Position { .. });
        let mut queue = sink.lock().unwrap();
        if queue.len() > 256 {
            queue.retain(|v| v["type"] != "position");
        }
        queue.push(serde_json::to_value(event).unwrap_or_default());
        drop(queue);
        if !is_position && let Some(ctx) = wake.lock().unwrap().as_ref() {
            ctx.request_repaint();
        }
    })));
    engine.set_visualization_enabled(false);
    let platform = if cfg!(windows) {
        "win32"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else {
        "linux"
    };
    let mut player = Player::new(
        engine,
        root.clone(),
        platform.into(),
        jap_light::model::read(&root.join("settings.json")),
        handoff,
        args.return_app.is_some(),
    );
    if !args.files.is_empty() {
        player.external(args.files);
    }
    let returned = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let return_flag = returned.clone();
    let options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default()
            .with_title("Just A Player · Native")
            .with_inner_size([1150., 750.])
            .with_min_inner_size([660., 400.]),
        renderer: {
            #[cfg(windows)]
            {
                eframe::Renderer::Wgpu
            }
            #[cfg(not(windows))]
            {
                eframe::Renderer::Glow
            }
        },
        #[cfg(windows)]
        wgpu_options: windows_gpu(),
        run_and_return: true,
        ..Default::default()
    };
    let app_root = root.clone();
    eframe::run_native(
        "Just A Player",
        options,
        Box::new(move |cc| {
            #[cfg(windows)]
            let graphics=cc.wgpu_render_state.as_ref().map(|s|{let info=s.adapter.get_info();json!({"backend":format!("{:?}",info.backend),"deviceType":format!("{:?}",info.device_type),"name":info.name})}).unwrap_or_default();
            #[cfg(not(windows))]
            let graphics=json!({"backend":"OpenGL"});
            jap_light::ui::setup(&cc.egui_ctx);
            *context.lock().unwrap() = Some(cc.egui_ctx.clone());
            #[cfg(windows)]
            let hwnd = cc.window_handle().ok().and_then(|h| match h.as_raw() {
                raw_window_handle::RawWindowHandle::Win32(w) => {
                    Some(w.hwnd.get() as *mut std::ffi::c_void)
                }
                _ => None,
            });
            #[cfg(not(windows))]
            let hwnd = None;
            let (tx, commands) = std::sync::mpsc::channel();
            let mut media = souvlaki::MediaControls::new(souvlaki::PlatformConfig {
                dbus_name: "org.b5_software.justaplayer",
                display_name: "Just A Player",
                hwnd,
            })
            .ok();
            if let Some(c) = &mut media {
                let _ = c.attach(move |event| {
                    use souvlaki::MediaControlEvent as M;
                    let command = match event {
                        M::Play => "play",
                        M::Pause => "pause",
                        M::Toggle => "toggle",
                        M::Previous => "previous",
                        M::Next => "next",
                        M::Stop => "stop",
                        _ => return,
                    };
                    let _ = tx.send(command.into());
                });
            }
            Ok(Box::new(App {
                player,
                events,
                commands,
                media,
                last_media: Value::Null,
                awake: None,
                ready: args.ready_file,
                qa: args.qa,
                smoke: args.smoke_report,
                root: app_root,
                returned: return_flag,
                first: true,
                last_mail: Instant::now(),
                last_media_at: Instant::now() - Duration::from_secs(1),
                graphics,
            }))
        }),
    )
    .map_err(|e| anyhow::anyhow!("{e}"))?;
    if returned.load(std::sync::atomic::Ordering::Acquire)
        && let Some(app) = args.return_app
    {
        let mut command = std::process::Command::new(app);
        if let Some(entry) = args.return_entry {
            command.arg(entry);
        }
        command
            .arg("--jap-full")
            .arg(format!("--user-data-dir={}", root.display()))
            .spawn()
            .context("无法返回完整播放器")?;
    }
    Ok(())
}

#[cfg(windows)]
fn windows_gpu() -> eframe::egui_wgpu::WgpuConfiguration {
    use eframe::egui_wgpu::{WgpuSetup, WgpuSetupCreateNew};
    let force_software = std::env::var("JAP_LIGHT_SOFTWARE").is_ok_and(|v| v == "1");
    let mut setup = WgpuSetupCreateNew::without_display_handle();
    setup.instance_descriptor.backends = wgpu::Backends::DX12;
    setup.power_preference = wgpu::PowerPreference::LowPower;
    setup.native_adapter_selector = Some(Arc::new(move |adapters, surface| {
        adapters
            .iter()
            .filter(|a| {
                surface.is_none_or(|s| a.is_surface_supported(s))
                    && (!force_software || a.get_info().device_type == wgpu::DeviceType::Cpu)
            })
            .min_by_key(|a| match a.get_info().device_type {
                wgpu::DeviceType::IntegratedGpu => 0,
                wgpu::DeviceType::DiscreteGpu => 1,
                wgpu::DeviceType::VirtualGpu => 2,
                wgpu::DeviceType::Cpu => 3,
                _ => 4,
            })
            .cloned()
            .ok_or_else(|| "没有可用的 Direct3D 12 / WARP 渲染设备".into())
    }));
    eframe::egui_wgpu::WgpuConfiguration {
        wgpu_setup: WgpuSetup::CreateNew(setup),
        ..Default::default()
    }
}

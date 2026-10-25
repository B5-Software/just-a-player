use anyhow::{Context, Result};
use clap::Parser;
use jap_core::Command;
use jap_light::{Player, egui};
use serde_json::{Value, json};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use winit::{
    application::ApplicationHandler,
    dpi::{LogicalSize, PhysicalPosition, PhysicalSize},
    event::WindowEvent,
    event_loop::{ActiveEventLoop, ControlFlow, EventLoop},
    window::{Window, WindowId, WindowLevel},
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

#[derive(Debug, Clone)]
pub(crate) enum UserEvent {
    Wake,
    Show,
    Popup(i32, i32),
    Command(String),
}
#[derive(Debug, Clone, Copy, PartialEq)]
enum View {
    Main,
    Popup,
    Hidden,
    Minimized,
}
struct App {
    player: Player,
    events: Arc<Mutex<Vec<Value>>>,
    proxy: winit::event_loop::EventLoopProxy<UserEvent>,
    media: Option<souvlaki::MediaControls>,
    last_media: Value,
    last_media_at: Instant,
    awake: Option<keepawake::KeepAwake>,
    ready: Option<PathBuf>,
    qa: bool,
    smoke: Option<PathBuf>,
    root: PathBuf,
    returned: bool,
    quit: bool,
    first: bool,
    next_tick: Instant,
    window: Option<Arc<Window>>,
    gui: Option<crate::software::Gui>,
    tray: Option<crate::tray::Tray>,
    view: View,
    main_size: PhysicalSize<u32>,
    main_position: Option<PhysicalPosition<i32>>,
    capture: bool,
    background_ctx: egui::Context,
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
            "reset" => self.player.command(Command::ResetBuffer),
            _ => {}
        }
    }
    fn release_ui(&mut self) {
        self.player.visible = false;
        self.player.engine.set_visualization_enabled(false);
        self.player.cover = None;
        self.gui = None;
        self.awake = None;
    }
    fn resume_ui(&mut self) {
        self.player.mini = self.view == View::Popup;
        self.player.visible = true;
        if self.gui.is_none()
            && let Some(window) = &self.window
        {
            match crate::software::Gui::new(window.clone()) {
                Ok(gui) => self.gui = Some(gui),
                Err(e) => {
                    eprintln!("Native presentation unavailable: {e}");
                    self.quit = true;
                }
            }
        }
        if let Some(window) = &self.window {
            window.request_redraw();
        }
    }
    fn hide(&mut self) {
        if self.view == View::Main {
            self.remember_window();
        }
        self.view = View::Hidden;
        if let Some(window) = &self.window {
            window.set_visible(false);
        }
        self.release_ui();
    }
    fn remember_window(&mut self) {
        if let Some(window) = &self.window {
            self.main_size = window.inner_size();
            self.main_position = window.outer_position().ok();
        }
    }
    fn show(&mut self, popup: Option<(i32, i32)>) {
        if popup.is_some() && self.view == View::Popup {
            self.hide();
            return;
        }
        if popup.is_none() && self.view == View::Main {
            if let Some(w) = &self.window {
                w.set_minimized(false);
                w.set_visible(true);
                w.focus_window();
            }
            return;
        }
        if self.view == View::Main && popup.is_some() {
            self.remember_window();
        }
        let Some(window) = self.window.as_ref() else {
            return;
        };
        window.set_minimized(false);
        #[cfg(windows)]
        {
            use winit::platform::windows::WindowExtWindows;
            window.set_skip_taskbar(popup.is_some());
        }
        window.set_decorations(popup.is_none());
        window.set_resizable(popup.is_none());
        window.set_window_level(if popup.is_some() {
            WindowLevel::AlwaysOnTop
        } else {
            WindowLevel::Normal
        });
        if let Some((x, y)) = popup {
            window.set_min_inner_size(Some(LogicalSize::new(320., 300.)));
            let _ = window.request_inner_size(LogicalSize::new(344., 400.));
            let scale = window.scale_factor();
            let (w, h) = ((344. * scale) as i32, (400. * scale) as i32);
            let monitor = window.available_monitors().find(|m| {
                let p = m.position();
                let s = m.size();
                x >= p.x && y >= p.y && x < p.x + s.width as i32 && y < p.y + s.height as i32
            });
            let (px, py) = if let Some(m) = monitor {
                let p = m.position();
                let s = m.size();
                (
                    (x - w / 2).clamp(p.x, (p.x + s.width as i32 - w).max(p.x)),
                    (y - h - 12).clamp(p.y, (p.y + s.height as i32 - h).max(p.y)),
                )
            } else {
                (x - w / 2, y - h - 12)
            };
            window.set_outer_position(PhysicalPosition::new(px, py));
            self.view = View::Popup;
        } else {
            window.set_min_inner_size(Some(LogicalSize::new(660., 400.)));
            let _ = window.request_inner_size(self.main_size);
            if let Some(position) = self.main_position {
                window.set_outer_position(position);
            }
            self.view = View::Main;
        }
        // Clone the window before mutably rebuilding the renderer.
        let window = window.clone();
        self.resume_ui();
        window.set_visible(true);
        window.focus_window();
        window.request_redraw();
        self.next_tick = Instant::now();
    }
    fn close_window(&mut self) {
        if self.view == View::Popup {
            self.hide();
            return;
        }
        let background = self.player.settings["backgroundPlayback"]
            .as_bool()
            .unwrap_or(true);
        let to_tray = self.player.prefs["closeToTray"].as_bool().unwrap_or(true);
        if background && to_tray && self.tray.is_some() {
            self.hide();
        } else {
            self.quit = true;
        }
    }
    fn actions(&mut self) {
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
                            self.returned = true;
                            self.quit = true;
                        }
                        Err(e) => self.player.error = Some(e),
                    }
                }
                "media" => {
                    if let Some(c) = &mut self.media {
                        crate::media::update(c, &action["value"], &self.root, &mut self.last_media);
                    }
                    self.last_media_at = Instant::now();
                }
                "settings" => {
                    let _ = jap_light::model::save(
                        &self.root.join("settings.json"),
                        &self.player.settings,
                    );
                }
                "show" => self.show(None),
                "hide" => self.hide(),
                "quit" => self.quit = true,
                _ => {}
            }
        }
        if self.last_media_at.elapsed() > Duration::from_secs(1) {
            self.last_media_at = Instant::now();
            if let Some(c) = &mut self.media {
                crate::media::update(c, &self.player.media(), &self.root, &mut self.last_media);
            }
        }
        let hold = self.view == View::Main
            && self.player.state == jap_core::PlaybackState::Playing
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
    }
    fn logic(&mut self) {
        for message in std::mem::take(&mut *self.events.lock().unwrap()) {
            self.player.receive(message);
        }
        if self.gui.is_none() {
            self.player.tick(&self.background_ctx);
        }
        if let Ok(entries) = std::fs::read_dir(self.root.join("light-inbox")) {
            for entry in entries.take(32).flatten() {
                if let Some(paths) = jap_light::model::read(&entry.path()).as_array() {
                    self.player.external(
                        paths
                            .iter()
                            .filter_map(|p| p.as_str().map(str::to_owned))
                            .collect(),
                    );
                    self.show(None);
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
                        .into_iter()
                        .flatten()
                        .filter_map(|p| p.as_str().map(str::to_owned))
                        .collect(),
                ),
                "meter" => self.player.set_meter(
                    input["id"].as_str().unwrap_or("vu"),
                    input["enabled"].as_bool().unwrap_or(false),
                ),
                "volume" => self.player.command(Command::SetVolume {
                    gain: input["gain"].as_f64().unwrap_or(0.2).clamp(0., 1.) as f32,
                }),
                "pointer" => {
                    if let Some(gui) = &mut self.gui {
                        let pos = egui::pos2(
                            input["x"].as_f64().unwrap_or(0.) as f32,
                            input["y"].as_f64().unwrap_or(0.) as f32,
                        );
                        let events = &mut gui.input.egui_input_mut().events;
                        events.push(egui::Event::PointerMoved(pos));
                        events.push(egui::Event::PointerButton {
                            pos,
                            button: egui::PointerButton::Primary,
                            pressed: input["down"] == true,
                            modifiers: egui::Modifiers::default(),
                        });
                    }
                }
                "dialog" => self.player.dialog = input["name"].as_str().unwrap_or("").into(),
                "screenshot" => self.capture = true,
                "full" => {
                    let handoff = self.player.handoff();
                    self.player
                        .actions
                        .push(json!({"type":"returnFull","handoff":handoff}));
                }
                "window-close" => self.close_window(),
                "hide" => self.hide(),
                "show" => self.show(None),
                "minimize" => {
                    if let Some(w) = &self.window {
                        w.set_minimized(true);
                    }
                }
                "tray" => self.show(Some((
                    input["x"].as_i64().unwrap_or(1300) as i32,
                    input["y"].as_i64().unwrap_or(900) as i32,
                ))),
                "close" => self.quit = true,
                _ => {}
            }
            let _ = jap_light::model::save(&self.root.join("native-report.json"), &self.report());
        }
        self.actions();
    }
    fn report(&self) -> Value {
        let mut report = self.player.debug();
        report["graphics"] =
            json!({"backend":"Software","deviceType":"Cpu","name":"Native CPU rasterizer"});
        report["view"] = json!(format!("{:?}", self.view));
        report["tray"] = json!(self.tray.is_some());
        report["renderResourcesResident"] = json!(self.gui.is_some());
        report
    }
    fn render(&mut self) {
        let Some(gui) = self.gui.as_mut() else {
            return;
        };
        let popup = self.view == View::Popup;
        match gui.draw(
            &mut self.player,
            popup,
            self.capture || self.smoke.is_some(),
        ) {
            Ok(image) => {
                self.player.renders += 1;
                if let Some(image) = image {
                    let path = self
                        .smoke
                        .as_ref()
                        .map(|p| p.with_extension("png"))
                        .unwrap_or_else(|| self.root.join("native-screenshot.png"));
                    let _ = jap_light::surface::save_image(&path, &image);
                    self.capture = false;
                }
                if self.first {
                    self.first = false;
                    if let Some(file) = &self.ready {
                        let _ = std::fs::write(file, b"native-ready");
                    }
                    if let Some(file) = &self.smoke {
                        let mut report = self.report();
                        report["passed"] = json!(!self.player.controls.is_empty());
                        let _ = jap_light::model::save(file, &report);
                        self.quit = true;
                    }
                }
            }
            Err(e) => {
                self.player.error = Some(format!("Native presentation: {e}"));
            }
        }
        self.actions();
    }
}
impl ApplicationHandler<UserEvent> for App {
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        if self.window.is_some() {
            return;
        }
        let icon = (jap_light::branding::rgba(128), 128, 128);
        let attributes = Window::default_attributes()
            .with_title("Just A Player · Native")
            .with_theme(Some(winit::window::Theme::Dark))
            .with_inner_size(LogicalSize::new(1150., 750.))
            .with_min_inner_size(LogicalSize::new(660., 400.))
            .with_window_icon(winit::window::Icon::from_rgba(icon.0, icon.1, icon.2).ok());
        let window = match event_loop.create_window(attributes) {
            Ok(w) => Arc::new(w),
            Err(e) => {
                eprintln!("{e}");
                self.quit = true;
                return;
            }
        };
        #[cfg(windows)]
        let hwnd = {
            use raw_window_handle::HasWindowHandle;
            window.window_handle().ok().and_then(|h| match h.as_raw() {
                raw_window_handle::RawWindowHandle::Win32(w) => {
                    Some(w.hwnd.get() as *mut std::ffi::c_void)
                }
                _ => None,
            })
        };
        #[cfg(not(windows))]
        let hwnd = None;
        self.media = souvlaki::MediaControls::new(souvlaki::PlatformConfig {
            dbus_name: "org.b5_software.justaplayer",
            display_name: "Just A Player",
            hwnd,
        })
        .ok();
        if let Some(media) = &mut self.media {
            let proxy = self.proxy.clone();
            let _ = media.attach(move |event| {
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
                let _ = proxy.send_event(UserEvent::Command(command.into()));
            });
        }
        self.tray = match crate::tray::Tray::new(self.proxy.clone()) {
            Ok(tray) => Some(tray),
            Err(e) => {
                eprintln!("Tray unavailable: {e}");
                None
            }
        };
        self.main_size = window.inner_size();
        self.main_position = window.outer_position().ok();
        self.window = Some(window);
        self.show(None);
    }
    fn user_event(&mut self, _: &ActiveEventLoop, event: UserEvent) {
        match event {
            UserEvent::Wake => {}
            UserEvent::Show => self.show(None),
            UserEvent::Popup(x, y) => self.show(Some((x, y))),
            UserEvent::Command(c) => self.command(&c),
        }
        self.next_tick = Instant::now();
    }
    fn window_event(&mut self, _: &ActiveEventLoop, _: WindowId, event: WindowEvent) {
        if let Some(gui) = &mut self.gui {
            let response = gui.input.on_window_event(&gui.window, &event);
            if response.repaint && !matches!(event, WindowEvent::RedrawRequested) {
                gui.window.request_redraw();
            }
        }
        match event {
            WindowEvent::CloseRequested => self.close_window(),
            WindowEvent::Focused(false) if self.view == View::Popup => self.hide(),
            WindowEvent::Resized(size) => {
                let minimized = size.width == 0
                    || size.height == 0
                    || self
                        .window
                        .as_ref()
                        .is_some_and(|w| w.is_minimized() == Some(true));
                if minimized && self.view == View::Main {
                    self.view = View::Minimized;
                    self.release_ui();
                    if self.player.settings["backgroundPlayback"] == false {
                        self.command("pause");
                    }
                } else if !minimized && self.view == View::Minimized {
                    self.view = View::Main;
                    self.resume_ui();
                } else if !minimized && self.view == View::Main {
                    self.main_size = size;
                }
            }
            WindowEvent::Moved(position) if self.view == View::Main => {
                self.main_position = Some(position)
            }
            WindowEvent::Occluded(true) if self.view == View::Main => {
                self.view = View::Minimized;
                self.release_ui();
            }
            WindowEvent::Occluded(false)
                if self.view == View::Minimized
                    && self
                        .window
                        .as_ref()
                        .is_none_or(|w| w.is_minimized() != Some(true)) =>
            {
                self.view = View::Main;
                self.resume_ui();
            }
            WindowEvent::RedrawRequested => {
                if matches!(self.view, View::Main | View::Popup) {
                    self.render();
                }
            }
            _ => {}
        }
    }
    fn about_to_wait(&mut self, event_loop: &ActiveEventLoop) {
        let now = Instant::now();
        if now >= self.next_tick {
            self.logic();
            if let Some(window) = &self.window
                && matches!(self.view, View::Main | View::Popup)
            {
                window.request_redraw();
            }
            let ms = if self.player.visuals() {
                34
            } else if self.qa {
                100
            } else if matches!(self.view, View::Main | View::Popup)
                && self.player.state == jap_core::PlaybackState::Playing
            {
                200
            } else {
                1000
            };
            self.next_tick = now + Duration::from_millis(ms);
        }
        if self.quit {
            event_loop.exit();
        } else {
            event_loop.set_control_flow(ControlFlow::WaitUntil(self.next_tick));
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

    let event_loop = EventLoop::<UserEvent>::with_user_event().build()?;
    let proxy = event_loop.create_proxy();
    let events = Arc::new(Mutex::new(Vec::<Value>::new()));
    let sink = events.clone();
    let wake = proxy.clone();
    let engine = Arc::new(jap_engine::Engine::new(Arc::new(move |event| {
        let position = matches!(event, jap_core::Event::Position { .. });
        let mut queue = sink.lock().unwrap();
        if position {
            queue.retain(|v| v["type"] != "position");
        }
        queue.push(serde_json::to_value(event).unwrap_or_default());
        drop(queue);
        if !position {
            let _ = wake.send_event(UserEvent::Wake);
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
    let mut app = App {
        player,
        events,
        proxy,
        media: None,
        last_media: Value::Null,
        last_media_at: Instant::now() - Duration::from_secs(2),
        awake: None,
        ready: args.ready_file,
        qa: args.qa,
        smoke: args.smoke_report,
        root: root.clone(),
        returned: false,
        quit: false,
        first: true,
        next_tick: Instant::now(),
        window: None,
        gui: None,
        tray: None,
        view: View::Hidden,
        main_size: PhysicalSize::new(1150, 750),
        main_position: None,
        capture: false,
        background_ctx: egui::Context::default(),
    };
    event_loop.run_app(&mut app)?;
    let returned = app.returned;
    drop(app);
    if returned && let Some(executable) = args.return_app {
        let mut command = std::process::Command::new(executable);
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

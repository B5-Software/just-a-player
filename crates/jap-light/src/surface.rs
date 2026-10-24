//! Native framebuffer integration for Android View and ArkUI Image.
//! Egui builds and rasterizes the same Rust UI used by the desktop window.
use crate::{Player, ui};
use egui::{Event, PointerButton, Pos2, RawInput, Rect, Vec2};
use egui_software_backend::{BufferMutRef, ColorFieldOrder, EguiSoftwareRender};
use serde_json::{Value, json};
use std::time::Instant;
pub struct NativeSurface {
    pub player: Player,
    pub ctx: egui::Context,
    renderer: EguiSoftwareRender,
    pub pixels: Vec<[u8; 4]>,
    pub width: usize,
    pub height: usize,
    start: Instant,
    scale: f32,
    pub last_frame: Instant,
}
impl NativeSurface {
    pub fn new(player: Player) -> Self {
        let ctx = egui::Context::default();
        ui::setup(&ctx);
        Self {
            player,
            ctx,
            renderer: EguiSoftwareRender::new(ColorFieldOrder::Rgba),
            pixels: vec![],
            width: 0,
            height: 0,
            start: Instant::now(),
            scale: 1.,
            last_frame: Instant::now(),
        }
    }
    /// Input coordinates are normalized to the native view, independent of DPI.
    pub fn render(&mut self, input: &Value) -> Value {
        self.player.visible = input["visible"].as_bool().unwrap_or(true);
        self.player.mini = input["mini"].as_bool().unwrap_or(false);
        let width = input["width"].as_u64().unwrap_or(960).clamp(160, 2560) as usize;
        let height = input["height"].as_u64().unwrap_or(540).clamp(90, 1600) as usize;
        self.width = width;
        self.height = height;
        self.pixels.resize(width * height, [19, 18, 26, 255]);
        let logical_height = if self.player.mini {
            height as f32
        } else if self.player.mobile() {
            540.
        } else {
            (height as f32).clamp(480., 720.)
        };
        self.scale = height as f32 / logical_height;
        let logical = Vec2::new(width as f32 / self.scale, height as f32 / self.scale);
        let mut raw = RawInput {
            screen_rect: Some(Rect::from_min_size(Pos2::ZERO, logical)),
            time: Some(self.start.elapsed().as_secs_f64()),
            focused: true,
            ..Default::default()
        };
        raw.viewports
            .entry(egui::ViewportId::ROOT)
            .or_default()
            .native_pixels_per_point = Some(self.scale);
        if let Some(events) = input["events"].as_array() {
            for event in events {
                let x = event["x"].as_f64().unwrap_or(0.) as f32 * logical.x;
                let y = event["y"].as_f64().unwrap_or(0.) as f32 * logical.y;
                let pos = Pos2::new(x, y);
                match event["type"].as_str().unwrap_or("") {
                    "down" => {
                        raw.events.push(Event::PointerMoved(pos));
                        raw.events.push(Event::PointerButton {
                            pos,
                            button: PointerButton::Primary,
                            pressed: true,
                            modifiers: Default::default(),
                        });
                    }
                    "move" => raw.events.push(Event::PointerMoved(pos)),
                    "up" => {
                        raw.events.push(Event::PointerMoved(pos));
                        raw.events.push(Event::PointerButton {
                            pos,
                            button: PointerButton::Primary,
                            pressed: false,
                            modifiers: Default::default(),
                        });
                    }
                    "cancel" => {
                        raw.events.push(Event::PointerButton {
                            pos,
                            button: PointerButton::Primary,
                            pressed: false,
                            modifiers: Default::default(),
                        });
                        raw.events.push(Event::PointerGone);
                    }
                    "scroll" => raw.events.push(Event::MouseWheel {
                        unit: egui::MouseWheelUnit::Point,
                        phase: egui::TouchPhase::Move,
                        delta: Vec2::new(0., event["dy"].as_f64().unwrap_or(0.) as f32),
                        modifiers: Default::default(),
                    }),
                    "text" => raw
                        .events
                        .push(Event::Text(event["text"].as_str().unwrap_or("").into())),
                    "backspace" => raw.events.push(Event::Key {
                        key: egui::Key::Backspace,
                        physical_key: None,
                        pressed: true,
                        repeat: false,
                        modifiers: Default::default(),
                    }),
                    _ => {}
                }
            }
        }
        let out = self.ctx.run_ui(raw, |ui| ui::draw(ui, &mut self.player));
        let primitives = self.ctx.tessellate(out.shapes, out.pixels_per_point);
        self.renderer.render(
            &mut BufferMutRef::new(&mut self.pixels, width, height),
            &primitives,
            &out.textures_delta,
            out.pixels_per_point,
        );
        self.player.renders += 1;
        self.last_frame = Instant::now();
        let text = match self.player.focused_text.as_str() {
            "search" => &self.player.search,
            "import-path" => &self.player.import_path,
            "list-name" => &self.player.new_name,
            _ => &self.player.search,
        };
        json!({"actions":std::mem::take(&mut self.player.actions),"keyboard":self.ctx.egui_wants_keyboard_input(),"textField":self.player.focused_text,"textValue":text,"visual":self.player.visuals(),"playing":self.player.state==jap_core::PlaybackState::Playing,"width":width,"height":height,"logicalWidth":logical.x,"logicalHeight":logical.y,"debug":if self.player.settings["nativeQa"]==true{self.player.debug()}else{Value::Null}})
    }
}

pub fn save_image(path: &std::path::Path, image: &egui::ColorImage) -> Result<(), String> {
    let bytes: Vec<u8> = image.pixels.iter().flat_map(|p| p.to_array()).collect();
    image::save_buffer(
        path,
        &bytes,
        image.size[0] as u32,
        image.size[1] as u32,
        image::ColorType::Rgba8,
    )
    .map_err(|e| e.to_string())
}

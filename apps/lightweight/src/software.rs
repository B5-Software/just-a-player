//! One native window, CPU rasterization; no GPU device, browser or hidden renderer.
use anyhow::Result;
use egui_software_backend::{BufferMutRef, ColorFieldOrder, EguiSoftwareRender};
use jap_light::{Player, egui};
use std::{num::NonZeroU32, sync::Arc};
use winit::window::Window;
pub struct Gui {
    // The surface, clipboard and context must be dropped before the native window.
    surface: softbuffer::Surface<Arc<Window>, Arc<Window>>,
    pub input: egui_winit::State,
    ctx: egui::Context,
    renderer: EguiSoftwareRender,
    pub window: Arc<Window>,
}
impl Gui {
    pub fn new(window: Arc<Window>) -> Result<Self> {
        let ctx = egui::Context::default();
        jap_light::ui::setup(&ctx);
        let input = egui_winit::State::new(
            ctx.clone(),
            egui::ViewportId::ROOT,
            window.as_ref(),
            Some(window.scale_factor() as f32),
            window.theme(),
            None,
        );
        let context =
            softbuffer::Context::new(window.clone()).map_err(|e| anyhow::anyhow!("{e}"))?;
        let surface = softbuffer::Surface::new(&context, window.clone())
            .map_err(|e| anyhow::anyhow!("{e}"))?;
        Ok(Self {
            surface,
            input,
            ctx,
            renderer: EguiSoftwareRender::new(ColorFieldOrder::Bgra),
            window,
        })
    }
    pub fn draw(
        &mut self,
        p: &mut Player,
        popup: bool,
        capture: bool,
    ) -> Result<Option<egui::ColorImage>> {
        let size = self.window.inner_size();
        let (Some(w), Some(h)) = (NonZeroU32::new(size.width), NonZeroU32::new(size.height)) else {
            return Ok(None);
        };
        if p.cover.is_none()
            && let Some(image) = &p.cover_image
        {
            p.cover = Some(self.ctx.load_texture(
                "current-cover",
                image.clone(),
                egui::TextureOptions::LINEAR,
            ));
        }
        let raw = self.input.take_egui_input(&self.window);
        let out = self.ctx.run_ui(raw, |ui| {
            if popup {
                tray_panel(ui, p);
            } else {
                jap_light::ui::draw(ui, p);
            }
        });
        self.input
            .handle_platform_output(&self.window, out.platform_output);
        let primitives = self.ctx.tessellate(out.shapes, out.pixels_per_point);
        self.surface
            .resize(w, h)
            .map_err(|e| anyhow::anyhow!("{e}"))?;
        let mut buffer = self
            .surface
            .buffer_mut()
            .map_err(|e| anyhow::anyhow!("{e}"))?;
        let pixels: &mut [[u8; 4]] = bytemuck::cast_slice_mut(&mut buffer);
        self.renderer.render(
            &mut BufferMutRef::new(pixels, size.width as usize, size.height as usize),
            &primitives,
            &out.textures_delta,
            out.pixels_per_point,
        );
        let image = if capture {
            let rgba: Vec<u8> = pixels
                .iter()
                .flat_map(|c| [c[2], c[1], c[0], 255])
                .collect();
            Some(egui::ColorImage::from_rgba_unmultiplied(
                [size.width as usize, size.height as usize],
                &rgba,
            ))
        } else {
            None
        };
        for pixel in buffer.iter_mut() {
            *pixel &= 0x00ff_ffff;
        }
        buffer.present().map_err(|e| anyhow::anyhow!("{e}"))?;
        Ok(image)
    }
}
fn tray_panel(ui: &mut egui::Ui, p: &mut Player) {
    use egui::{Color32, RichText, vec2};
    use serde_json::json;
    p.tick(ui.ctx());
    p.controls.clear();
    p.viewport = ui.ctx().content_rect().size().into();
    egui::CentralPanel::default()
        .frame(
            egui::Frame::new()
                .fill(Color32::from_rgb(24, 22, 32))
                .inner_margin(18.),
        )
        .show_inside(ui, |ui| {
            ui.spacing_mut().item_spacing.y = 6.;
            ui.label(
                RichText::new("JUST A PLAYER")
                    .size(12.)
                    .color(jap_light::ui::ACCENT)
                    .strong(),
            );
            ui.add_space(10.);
            ui.horizontal(|ui| {
                if let Some(cover) = &p.cover {
                    ui.add(egui::Image::new((cover.id(), vec2(64., 64.))).corner_radius(14));
                } else {
                    jap_light::branding::icon(ui, 64.);
                }
                ui.vertical(|ui| {
                    ui.set_max_width(196.);
                    ui.add(
                        egui::Label::new(
                            RichText::new(
                                p.current
                                    .as_ref()
                                    .map(|t| jap_light::model::title(&json!(t)))
                                    .unwrap_or_else(|| "音乐随行".into()),
                            )
                            .size(18.)
                            .strong(),
                        )
                        .truncate(),
                    );
                    if let Some(track) = &p.current {
                        ui.label(
                            RichText::new(track.artist.as_deref().unwrap_or(""))
                                .size(13.)
                                .color(Color32::from_gray(160)),
                        );
                    }
                });
            });
            ui.add_space(12.);
            ui.columns(3, |columns| {
                if tray_button(&mut columns[0], p, "previous", "上一首") {
                    p.neighbour(-1, false);
                }
                let playing = p.state == jap_core::PlaybackState::Playing;
                if tray_button(
                    &mut columns[1],
                    p,
                    "play",
                    if playing { "暂停" } else { "播放" },
                ) {
                    p.toggle();
                }
                if tray_button(&mut columns[2], p, "next", "下一首") {
                    p.neighbour(1, false);
                }
            });
            ui.add_space(10.);
            ui.separator();
            ui.add_space(8.);
            for (id, label) in [
                ("show", "打开播放器"),
                ("reset", "重置音频缓冲区"),
                ("quit", "退出播放器"),
            ] {
                if tray_button(ui, p, id, label) {
                    if id == "reset" {
                        p.command(jap_core::Command::ResetBuffer);
                    } else {
                        p.actions.push(json!({"type":id}));
                    }
                }
            }
        });
}
fn tray_button(ui: &mut egui::Ui, p: &mut Player, id: &str, label: &str) -> bool {
    let r = ui.add_sized([ui.available_width(), 37.], egui::Button::new(label));
    p.controls.insert(
        id.into(),
        serde_json::json!([r.rect.min.x, r.rect.min.y, r.rect.max.x, r.rect.max.y]),
    );
    r.clicked()
}

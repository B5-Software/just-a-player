//! Shared application artwork for all native frontends and OS surfaces.
use crate::egui;
pub const PNG: &[u8] = include_bytes!("../../../apps/desktop/build/icon.png");
pub fn rgba(size: u32) -> Vec<u8> {
    let mut image = image::load_from_memory(PNG)
        .expect("bundled application icon")
        .resize_exact(size, size, image::imageops::FilterType::Lanczos3)
        .into_rgba8();
    let radius = size as f32 * 0.23;
    for (x, y, pixel) in image.enumerate_pixels_mut() {
        let (x, y) = (x as f32 + 0.5, y as f32 + 0.5);
        let dx = (radius - x).max(x - (size as f32 - radius)).max(0.);
        let dy = (radius - y).max(y - (size as f32 - radius)).max(0.);
        let coverage = (radius + 0.5 - dx.hypot(dy)).clamp(0., 1.);
        pixel.0[3] = (pixel.0[3] as f32 * coverage).round() as u8;
    }
    image.into_raw()
}
pub fn icon(ui: &mut egui::Ui, size: f32) {
    let id = egui::Id::new("just-a-player-artwork");
    let texture = ui
        .ctx()
        .data_mut(|d| d.get_temp::<egui::TextureHandle>(id))
        .unwrap_or_else(|| {
            let pixels = rgba(128);
            let texture = ui.ctx().load_texture(
                "Just A Player icon",
                egui::ColorImage::from_rgba_unmultiplied([128, 128], &pixels),
                egui::TextureOptions::LINEAR,
            );
            ui.ctx().data_mut(|d| d.insert_temp(id, texture.clone()));
            texture
        });
    ui.add(egui::Image::new((texture.id(), egui::vec2(size, size))));
}

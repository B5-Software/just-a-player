use egui::{
    Color32 as C, ColorImage, Context, CornerRadius, FontId, Stroke, Theme, ThemePreference, Ui,
    vec2,
};

use crate::Player;

const DEFAULT_ACCENT: C = C::from_rgb(132, 118, 255);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Palette {
    pub accent: C,
    pub accent_text: C,
    pub on_accent: C,
    pub ink: C,
    pub muted: C,
    pub canvas: C,
    pub panel: C,
    pub line: C,
    pub control: C,
    dark: bool,
}

impl Palette {
    fn new(dark: bool, accent: C) -> Self {
        let (canvas, panel, ink, muted) = if dark {
            (
                C::from_rgb(13, 13, 20),
                C::from_rgb(25, 24, 35),
                C::from_rgb(236, 236, 244),
                C::from_rgb(168, 167, 185),
            )
        } else {
            (
                C::from_rgb(243, 243, 248),
                C::from_rgb(253, 253, 255),
                C::from_rgb(22, 22, 32),
                C::from_rgb(94, 94, 111),
            )
        };
        let panel = mix(panel, accent, if dark { 0.06 } else { 0.035 });
        let mut accent_text = accent;
        for _ in 0..16 {
            if contrast(accent_text, panel).min(contrast(accent_text, canvas)) >= 4.5 {
                break;
            }
            accent_text = mix(accent_text, ink, 0.2);
        }
        Self {
            accent,
            accent_text,
            on_accent: if luminance(accent) > 0.179 {
                C::BLACK
            } else {
                C::WHITE
            },
            ink,
            muted,
            canvas,
            panel,
            dark,
            line: mix(panel, ink, 0.15),
            control: mix(panel, ink, if dark { 0.09 } else { 0.06 }),
        }
    }
}

pub fn hex(value: &str) -> Option<C> {
    let value = value.strip_prefix('#')?;
    if value.len() != 6 {
        return None;
    }
    let rgb = u32::from_str_radix(value, 16).ok()?;
    Some(C::from_rgb((rgb >> 16) as u8, (rgb >> 8) as u8, rgb as u8))
}

pub fn mix(a: C, b: C, amount: f32) -> C {
    let mix = |x: u8, y: u8| (f32::from(x) * (1. - amount) + f32::from(y) * amount).round() as u8;
    C::from_rgb(mix(a.r(), b.r()), mix(a.g(), b.g()), mix(a.b(), b.b()))
}

fn luminance(c: C) -> f32 {
    let linear = |v: u8| {
        let v = f32::from(v) / 255.;
        if v <= 0.04045 {
            v / 12.92
        } else {
            ((v + 0.055) / 1.055).powf(2.4)
        }
    };
    0.2126 * linear(c.r()) + 0.7152 * linear(c.g()) + 0.0722 * linear(c.b())
}

fn contrast(a: C, b: C) -> f32 {
    let a = luminance(a);
    let b = luminance(b);
    (a.max(b) + 0.05) / (a.min(b) + 0.05)
}

fn key() -> egui::Id {
    egui::Id::new("jap-native-palette")
}

pub fn colors(ui: &Ui) -> Palette {
    ui.ctx()
        .data(|data| data.get_temp(key()))
        .unwrap_or_else(|| Palette::new(ui.visuals().dark_mode, DEFAULT_ACCENT))
}

pub fn apply(ui: &mut Ui, player: &Player) {
    let ctx = ui.ctx();
    let dark = match player.settings["themeMode"].as_str() {
        Some("dark") => true,
        Some("light") => false,
        _ => ctx
            .system_theme()
            .map_or(player.prefs["systemThemeFallback"] != "light", |theme| {
                theme == Theme::Dark
            }),
    };
    let manual = player.settings["accent"]
        .as_str()
        .and_then(hex)
        .unwrap_or(DEFAULT_ACCENT);
    let automatic = player
        .handoff_accent
        .as_ref()
        .map(|(_, color)| *color)
        .or(player.cover_accent);
    let accent = if player.settings["autoAccent"] != false {
        automatic.unwrap_or(manual)
    } else {
        manual
    };
    let previous = ctx.data(|data| data.get_temp::<Palette>(key()));
    if previous.is_none_or(|p| p.accent != accent || p.dark != dark) {
        let palette = Palette::new(dark, accent);
        let theme = if dark { Theme::Dark } else { Theme::Light };
        ctx.set_theme(if dark {
            ThemePreference::Dark
        } else {
            ThemePreference::Light
        });
        configure(ctx, theme, palette);
        ctx.data_mut(|data| data.insert_temp(key(), palette));
    }
    ui.set_style(ui.ctx().global_style());
}

fn configure(ctx: &Context, theme: Theme, palette: Palette) {
    let mut style = (*ctx.global_style()).clone();
    let mut visuals = if palette.dark {
        egui::Visuals::dark()
    } else {
        egui::Visuals::light()
    };
    visuals.panel_fill = palette.canvas;
    visuals.window_fill = palette.panel;
    visuals.window_stroke = Stroke::new(1_f32, palette.line);
    visuals.window_corner_radius = CornerRadius::same(20);
    visuals.extreme_bg_color = palette.canvas;
    visuals.faint_bg_color = palette.control;
    visuals.override_text_color = Some(palette.ink);
    visuals.selection.bg_fill = mix(palette.panel, palette.accent, 0.25);
    visuals.selection.stroke = Stroke::new(1_f32, palette.accent_text);
    visuals.hyperlink_color = palette.accent_text;
    for (widget, fill, border) in [
        (&mut visuals.widgets.inactive, palette.control, palette.line),
        (
            &mut visuals.widgets.hovered,
            mix(palette.control, palette.accent, 0.16),
            palette.accent,
        ),
        (
            &mut visuals.widgets.active,
            mix(palette.control, palette.accent, 0.23),
            palette.accent_text,
        ),
        (&mut visuals.widgets.open, palette.control, palette.accent),
    ] {
        widget.bg_fill = fill;
        widget.weak_bg_fill = fill;
        widget.bg_stroke = Stroke::new(1_f32, border);
        widget.fg_stroke.color = palette.ink;
        widget.corner_radius = CornerRadius::same(12);
    }
    style.visuals = visuals;
    style.spacing.item_spacing = vec2(10., 10.);
    style.spacing.button_padding = vec2(13., 9.);
    style.animation_time = 0.;
    for (name, size) in [
        (egui::TextStyle::Body, 16.),
        (egui::TextStyle::Button, 15.),
        (egui::TextStyle::Small, 12.),
    ] {
        style.text_styles.insert(name, FontId::proportional(size));
    }
    ctx.set_style_of(theme, style);
}

/// Sample the decoded cover once, using the renderer's weighted hue buckets.
pub(crate) fn cover_accent(image: &ColorImage) -> Option<C> {
    let mut bins = [[0_f32; 4]; 12];
    let [width, height] = image.size;
    if width == 0 || height == 0 {
        return None;
    }
    let mut total = 0.;
    for y in 0..64 {
        for x in 0..64 {
            let c = image.pixels[y * height / 64 * width + x * width / 64];
            let [r, g, b, a] = c.to_srgba_unmultiplied();
            if a < 128 {
                continue;
            }
            let [r, g, b] = [r, g, b].map(|v| f32::from(v) / 255.);
            let max = r.max(g).max(b);
            let min = r.min(g).min(b);
            let delta = max - min;
            let light = (max + min) * 0.5;
            if !(0.12..=0.9).contains(&light) || delta == 0. {
                continue;
            }
            let saturation = delta / (1. - (2. * light - 1.).abs());
            if saturation < 0.2 {
                continue;
            }
            let hue = if max == r {
                (g - b) / delta
            } else if max == g {
                (b - r) / delta + 2.
            } else {
                (r - g) / delta + 4.
            };
            let weight = saturation * (1. - (light - 0.55).abs() * 1.2);
            let bin = &mut bins[((hue.rem_euclid(6.) * 2.) as usize).min(11)];
            bin[0] += weight;
            bin[1] += r * weight;
            bin[2] += g * weight;
            bin[3] += b * weight;
            total += weight;
        }
    }
    let [w, r, g, b] = bins.into_iter().max_by(|a, b| a[0].total_cmp(&b[0]))?;
    let value = |channel: f32| (channel / w * 255.).round() as u8;
    (total >= 64. * 64. * 0.02).then(|| C::from_rgb(value(r), value(g), value(b)))
}

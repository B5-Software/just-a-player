use jap_core::{OutputApi, OutputConfig};
use jap_light::{NativeSurface, Player};
use serde_json::{Value, json};
use std::sync::Arc;
fn surface(name: &str) -> NativeSurface {
    let root = std::env::temp_dir().join(format!("jap-native-{name}-{}", std::process::id()));
    let engine = Arc::new(jap_engine::Engine::new(Arc::new(|_| {})));
    let handoff = json!({"volume":0.2,"output":OutputConfig{api:OutputApi::Null,device_id:None,buffer_ms:40,dsd_mode:Default::default()}});
    NativeSurface::new(Player::new(
        engine,
        root,
        "win32".into(),
        json!({}),
        handoff,
        true,
    ))
}
fn render(s: &mut NativeSurface, events: Value) -> Value {
    s.render(&json!({"width":1200,"height":800,"events":events}))
}
fn center(s: &NativeSurface, id: &str) -> (f32, f32) {
    let r = &s.player.controls[id];
    (
        (r[0].as_f64().unwrap() + r[2].as_f64().unwrap() / 2.) as f32
            / s.ctx.content_rect().width(),
        (r[1].as_f64().unwrap() + r[3].as_f64().unwrap() / 2.) as f32
            / s.ctx.content_rect().height(),
    )
}
fn click(s: &mut NativeSurface, id: &str) {
    let (x, y) = center(s, id);
    render(s, json!([{"type":"down","x":x,"y":y}]));
    render(s, json!([{"type":"up","x":x,"y":y}]));
    render(s, json!([]));
}
#[test]
fn native_pixels_controls_touch_and_optional_meters() {
    let mut s = surface("touch");
    render(&mut s, json!([]));
    render(&mut s, json!([]));
    assert!(s.player.controls.contains_key("play"));
    assert_eq!(s.player.debug()["webview"], false);
    assert!(!s.player.visuals());
    assert!(
        s.pixels.iter().any(|p| p[0] > 150 && p[3] == 255),
        "No text/control pixels"
    );
    for id in ["play", "next", "previous", "volume", "settings", "full"] {
        let r = &s.player.controls[id];
        assert!(r[0].as_f64().unwrap() >= 0.);
        assert!(
            r[1].as_f64().unwrap() + r[3].as_f64().unwrap() <= 800.,
            "{id}: {r}"
        );
    }
    let before = s.player.volume;
    click(&mut s, "volume");
    assert_eq!(s.player.volume, before, "tap must not change gain");
    let (x, y) = center(&s, "volume");
    render(&mut s, json!([{"type":"down","x":x,"y":y}]));
    render(&mut s, json!([{"type":"move","x":x+0.02,"y":y}]));
    render(&mut s, json!([{"type":"up","x":x+0.02,"y":y}]));
    assert!(s.player.volume > before);
    click(&mut s, "settings");
    assert_eq!(s.player.dialog, "settings");
    click(&mut s, "meter-vu");
    assert!(s.player.enabled("vu"));
    assert!(
        !s.player.enabled("spectrum"),
        "meter toggles must be independent"
    );
    let target = std::env::var_os("JAP_NATIVE_SCREENSHOT").map(std::path::PathBuf::from);
    if let Some(path) = target {
        click(&mut s, "modal-close");
        assert!(s.player.dialog.is_empty());
        s.player.meter_levels = [0.1, 0.12];
        render(&mut s, json!([]));
        let bytes: Vec<u8> = s.pixels.iter().flatten().copied().collect();
        let image = egui::ColorImage::from_rgba_unmultiplied([s.width, s.height], &bytes);
        jap_light::surface::save_image(&path, &image).unwrap();
    }
    s.player.mini = true;
    s.render(&json!({"width":160,"height":90,"mini":true,"events":[]}));
    for id in ["play", "next", "previous"] {
        let report = s.player.debug();
        let r = &report["controls"][id];
        assert!(
            r[0].as_f64().unwrap() >= 0.
                && r[0].as_f64().unwrap() + r[2].as_f64().unwrap() <= 160.
                && r[1].as_f64().unwrap() + r[3].as_f64().unwrap() <= 90.,
            "mini control {id}: {r}"
        );
    }
    assert!(!s.player.visuals());
}
#[test]
fn native_surface_has_no_browser_assets_or_dependencies() {
    let source = include_str!("../src/lib.rs");
    assert!(!source.contains("include_str!"));
    let desktop = include_str!("../../../apps/lightweight/Cargo.toml");
    assert!(!desktop.contains("wry ="));
    assert!(!desktop.contains("tao ="));
}

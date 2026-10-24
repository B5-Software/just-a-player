//! One native UI per mobile audio host, sharing its existing engine.
use crate::{NativeSurface, Player};
use parking_lot::Mutex;
use serde_json::{Value, json};
use std::{
    path::PathBuf,
    sync::{Arc, OnceLock},
};
pub fn surface() -> &'static Mutex<Option<NativeSurface>> {
    static UI: OnceLock<Mutex<Option<NativeSurface>>> = OnceLock::new();
    UI.get_or_init(Default::default)
}
pub fn init(
    engine: Arc<jap_engine::Engine>,
    root: PathBuf,
    platform: &str,
    settings: Value,
    handoff: Value,
) {
    let mut state = surface().lock();
    let handoff = if handoff.is_null() {
        state
            .as_mut()
            .filter(|old| old.player.root == root)
            .map(|old| old.player.handoff())
            .unwrap_or(handoff)
    } else {
        handoff
    };
    drop(state.take());
    *state = Some(NativeSurface::new(Player::new(
        engine,
        root,
        platform.into(),
        settings,
        handoff,
        true,
    )));
}
pub fn receive(message: Value) {
    if let Some(ui) = surface().lock().as_mut() {
        ui.player.receive(message);
    }
}
pub fn control(input: &Value) -> Value {
    let mut lock = surface().lock();
    let Some(ui) = lock.as_mut() else {
        return json!(null);
    };
    match input["type"].as_str().unwrap_or("") {
        "close" => {
            drop(lock.take());
            return json!(null);
        }
        "import" => ui.player.import(
            input["paths"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(|p| p.as_str().map(str::to_owned))
                        .collect()
                })
                .unwrap_or_default(),
        ),
        "external" => ui.player.external(
            input["paths"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(|p| p.as_str().map(str::to_owned))
                        .collect()
                })
                .unwrap_or_default(),
        ),
        "media" => match input["command"].as_str().unwrap_or("") {
            "next" => ui.player.neighbour(1, false),
            "previous" => ui.player.neighbour(-1, false),
            "pause" => ui.player.command(jap_core::Command::Pause),
            "stop" => ui.player.command(jap_core::Command::Stop),
            "play" if ui.player.state != jap_core::PlaybackState::Playing => ui.player.toggle(),
            "toggle" => ui.player.toggle(),
            _ => {}
        },
        "back" => {
            let closed = !ui.player.dialog.is_empty() || ui.player.error.is_some();
            ui.player.dialog.clear();
            ui.player.error = None;
            return json!({"closed":closed});
        }
        "error" => ui.player.error = input["message"].as_str().map(str::to_owned),
        "visible" => {
            ui.player.visible = input["visible"].as_bool().unwrap_or(true);
            if !ui.player.visible {
                ui.player.engine.set_visualization_enabled(false);
            }
        }
        "edit" => {
            let text = input["text"].as_str().unwrap_or("");
            if text.len() <= 8192 {
                match ui.player.focused_text.as_str() {
                    "search" => ui.player.search = text.into(),
                    "import-path" => ui.player.import_path = text.into(),
                    "list-name" => ui.player.new_name = text.into(),
                    _ => {}
                }
            }
        }
        "debug" => return ui.player.debug(),
        "mediaState" => {
            ui.player.tick(&ui.ctx);
            return ui.player.media();
        }
        _ => {}
    }
    ui.player.debug()
}

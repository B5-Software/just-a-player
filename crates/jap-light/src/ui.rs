use crate::i18n::{tr, tr_text};
use crate::model::{METER_NAMES, METERS, Player, now_id, title};
use crate::theme::{self, colors};
use egui::{self, FontId, RichText, Sense, Stroke, Vec2, pos2, vec2};
use jap_core::{Command, OutputApi, PlaybackState, Query};
use serde_json::json;
use std::{path::PathBuf, sync::Arc};
pub fn setup(ctx: &egui::Context) {
    let mut fonts = egui::FontDefinitions::empty();
    for (name, bytes) in [
        (
            "NotoLatin",
            include_bytes!("../fonts/NotoLatin.ttf").as_slice(),
        ),
        ("NotoSC", include_bytes!("../fonts/NotoSC.ttf").as_slice()),
    ] {
        fonts
            .font_data
            .insert(name.into(), Arc::new(egui::FontData::from_static(bytes)));
        fonts
            .families
            .entry(egui::FontFamily::Proportional)
            .or_default()
            .push(name.into());
        fonts
            .families
            .entry(egui::FontFamily::Monospace)
            .or_default()
            .push(name.into());
    }
    ctx.set_fonts(fonts);
}
fn remember(p: &mut Player, id: &str, r: &egui::Response) {
    if r.has_focus()
        && [
            "search",
            "import-path",
            "list-name",
            "radio-address",
            "radio-name",
        ]
        .contains(&id)
    {
        p.focused_text = id.into();
    }
    let r = r.rect;
    p.controls
        .insert(id.into(), json!([r.min.x, r.min.y, r.width(), r.height()]));
}
fn button(ui: &mut egui::Ui, p: &mut Player, id: &str, label: &str) -> bool {
    if matches!(
        id,
        "play" | "previous" | "next" | "settings" | "import" | "reset" | "radio"
    ) {
        let width = if p.mini {
            36.
        } else if id == "play" {
            54.
        } else {
            40.
        };
        return icon_button(ui, p, id, label, width);
    }
    let r = ui.button(tr(label));
    remember(p, id, &r);
    r.clicked()
}
pub fn icon_button(ui: &mut egui::Ui, p: &mut Player, id: &str, label: &str, width: f32) -> bool {
    let palette = colors(ui);
    let primary = id == "play";
    let height = if p.mini { 26. } else { 38. };
    let mut button = egui::Button::new("").corner_radius(if primary { 19 } else { 12 });
    if primary {
        button = button.fill(palette.accent);
    }
    let response = ui
        .add_sized([width, height], button)
        .on_hover_text(tr(label));
    response.widget_info(|| {
        egui::WidgetInfo::labeled(egui::WidgetType::Button, ui.is_enabled(), label)
    });
    remember(p, id, &response);
    crate::icons::draw(
        id,
        label,
        ui.painter(),
        response.rect.center(),
        if primary {
            palette.on_accent
        } else {
            palette.ink
        },
    );
    if response.has_focus() {
        ui.painter().rect_stroke(
            response.rect.expand(1.),
            12,
            Stroke::new(1.5_f32, palette.accent_text),
            egui::StrokeKind::Outside,
        );
    }
    response.clicked()
}
fn switch(ui: &mut egui::Ui, p: &mut Player, id: &str, label: &str, on: bool) -> bool {
    let label = tr(label);
    let palette = colors(ui);
    let (r, response) = ui.allocate_exact_size(vec2(ui.available_width(), 38.), Sense::click());
    remember(p, id, &response);
    let painter = ui.painter();
    painter.text(
        pos2(r.left(), r.center().y),
        egui::Align2::LEFT_CENTER,
        label,
        FontId::proportional(15.),
        palette.ink,
    );
    let track =
        egui::Rect::from_min_size(pos2(r.right() - 50., r.center().y - 12.), vec2(48., 24.));
    painter.rect_filled(track, 12., if on { palette.accent } else { palette.line });
    painter.circle_filled(
        pos2(
            if on {
                track.right() - 12.
            } else {
                track.left() + 12.
            },
            track.center().y,
        ),
        9.,
        if on { palette.on_accent } else { palette.ink },
    );
    response.clicked()
}
fn drag_slider(ui: &mut egui::Ui, p: &mut Player, id: &str, value: f32, width: f32) -> Option<f32> {
    let palette = colors(ui);
    let (r, response) = ui.allocate_exact_size(vec2(width.max(32.), 32.), Sense::drag());
    remember(p, id, &response);
    let y = r.center().y;
    let x = r.left() + value.clamp(0., 1.) * r.width();
    ui.painter().line_segment(
        [pos2(r.left(), y), pos2(r.right(), y)],
        Stroke::new(5.0_f32, palette.line),
    );
    ui.painter().line_segment(
        [pos2(r.left(), y), pos2(x, y)],
        Stroke::new(5.0_f32, palette.accent),
    );
    ui.painter().circle_filled(pos2(x, y), 6., palette.accent);
    let deliberate = response.dragged()
        && ui.input(|i| {
            i.pointer
                .press_origin()
                .zip(i.pointer.interact_pos())
                .is_some_and(|(origin, at)| {
                    let delta = at - origin;
                    delta.x.abs() > 7. && delta.x.abs() > delta.y.abs() * 1.2
                })
        });
    let drag_id = response.id.with("deliberate-drag");
    if response.drag_started() {
        ui.ctx().data_mut(|d| d.insert_temp(drag_id, false));
    }
    let accepted = deliberate
        || ui
            .ctx()
            .data(|d| d.get_temp::<bool>(drag_id).unwrap_or(false));
    if deliberate {
        ui.ctx().data_mut(|d| d.insert_temp(drag_id, true));
    }
    if !response.dragged() {
        ui.ctx().data_mut(|d| d.remove::<bool>(drag_id));
    }
    if response.dragged() && accepted {
        response
            .interact_pointer_pos()
            .map(|at| ((at.x - r.left()) / r.width()).clamp(0., 1.))
    } else {
        None
    }
}
fn scalar(
    ui: &mut egui::Ui,
    p: &mut Player,
    id: &str,
    label: &str,
    value: f32,
    min: f32,
    max: f32,
) -> Option<f32> {
    let mut result = None;
    ui.horizontal(|ui| {
        ui.add_sized([105., 26.], egui::Label::new(label));
        result = drag_slider(
            ui,
            p,
            id,
            (value - min) / (max - min),
            (ui.available_width() - 62.).max(80.),
        )
        .map(|v| min + v * (max - min));
        ui.label(format!("{value:.1}"));
    });
    result
}
fn clock(ms: u64) -> String {
    format!("{}:{:02}", ms / 60000, (ms / 1000) % 60)
}
fn frame(ui: &egui::Ui) -> egui::Frame {
    let palette = colors(ui);
    egui::Frame::new()
        .fill(palette.panel)
        .stroke(Stroke::new(1_f32, palette.line))
        .corner_radius(20)
        .inner_margin(18)
}
pub fn draw(ui: &mut egui::Ui, p: &mut Player) {
    crate::i18n::configure(&p.settings);
    p.viewport = [
        ui.ctx().content_rect().width(),
        ui.ctx().content_rect().height(),
    ];
    p.controls.clear();
    p.tick(ui.ctx());
    theme::apply(ui, p);
    let palette = colors(ui);
    if p.mini {
        egui::CentralPanel::default()
            .frame(egui::Frame::new().fill(palette.panel).inner_margin(8))
            .show_inside(ui, |ui| {
                ui.spacing_mut().item_spacing.y = 3.;
                ui.label(
                    RichText::new("JUST A PLAYER")
                        .size(11.)
                        .color(palette.accent_text)
                        .strong(),
                );
                let name = p
                    .current
                    .as_ref()
                    .map(|t| title(&json!(t)))
                    .unwrap_or_else(|| tr("选择一首音乐").into());
                ui.add(egui::Label::new(RichText::new(name).size(13.)).truncate());
                ui.horizontal(|ui| {
                    ui.style_mut()
                        .text_styles
                        .insert(egui::TextStyle::Button, FontId::proportional(12.));
                    ui.spacing_mut().button_padding = vec2(4., 3.);
                    ui.spacing_mut().item_spacing.x = 4.;
                    if button(ui, p, "previous", tr("上一首")) {
                        p.neighbour(-1, false);
                    }
                    let label = if p.transport_playing() {
                        tr("暂停")
                    } else {
                        tr("播放")
                    };
                    if button(ui, p, "play", label) {
                        p.toggle();
                    }
                    if button(ui, p, "next", tr("下一首")) {
                        p.neighbour(1, false);
                    }
                });
            });
        ui.ctx()
            .request_repaint_after(std::time::Duration::from_millis(250));
        return;
    }
    let available = ui.available_rect_before_wrap();
    let small = available.height() < 340. || p.mini;
    egui::CentralPanel::default()
        .frame(
            egui::Frame::new()
                .fill(palette.canvas)
                .inner_margin(if small { 10 } else { 22 }),
        )
        .show_inside(ui, |ui| {
            ui.horizontal(|ui| {
                crate::branding::icon(ui, 36.);
                ui.vertical(|ui| {
                    ui.label(
                        RichText::new("JUST A PLAYER")
                            .size(if small { 13. } else { 18. })
                            .strong(),
                    );
                    if !small {
                        ui.label(
                            RichText::new(tr("NATIVE · 让音乐成为主角"))
                                .size(11.)
                                .color(palette.muted),
                        );
                    }
                });
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    if p.can_return && button(ui, p, "full", tr("完整模式")) {
                        let handoff = p.handoff();
                        p.actions
                            .push(json!({"type":"returnFull","handoff":handoff}));
                    }
                    if !small && button(ui, p, "settings", tr("设置")) {
                        p.dialog = "settings".into();
                    }
                    if !small && button(ui, p, "import", tr("导入音乐")) {
                        p.dialog = "import".into();
                    }
                    if !small && button(ui, p, "radio", tr("在线电台")) {
                        p.dialog = "radio".into();
                    }
                    let playlist_label = if p.prefs["playlistCollapsed"] == true {
                        tr("展开列表")
                    } else {
                        tr("收起列表")
                    };
                    if !small && button(ui, p, "playlist-toggle", playlist_label) {
                        p.prefs["playlistCollapsed"] = json!(p.prefs["playlistCollapsed"] != true);
                        p.persist();
                    }
                });
            });
            ui.add_space(if small { 6. } else { 18. });
            let bottom = if small { 62. } else { 94. };
            let body_height = (ui.available_height() - bottom - 16.).max(40.);
            let dialog_open = !p.dialog.is_empty();
            ui.add_enabled_ui(!dialog_open, |ui| {
                ui.allocate_ui_with_layout(
                    vec2(ui.available_width(), body_height),
                    egui::Layout::left_to_right(egui::Align::Min),
                    |ui| {
                        if !small
                            && ui.available_width() > 700.
                            && p.prefs["playlistCollapsed"] != true
                        {
                            let side = (ui.available_width() * 0.28).clamp(220., 330.);
                            ui.allocate_ui_with_layout(
                                vec2(side, body_height),
                                egui::Layout::top_down(egui::Align::Min),
                                |ui| {
                                    frame(ui).show(ui, |ui| {
                                        ui.set_width((side - 36.).max(180.));
                                        ui.set_height((body_height - 36.).max(20.));
                                        let external = matches!(
                                            p.external_state["phase"].as_str(),
                                            Some("routing" | "ready")
                                        );
                                        if external && p.prefs["externalLocalQueue"] != true {
                                            external_queue(ui, p, body_height);
                                            return;
                                        }
                                        if external
                                            && button(ui, p, "external-queue", tr("网易云播放队列"))
                                        {
                                            p.prefs["externalLocalQueue"] = json!(false);
                                        }
                                        let lists: Vec<_> = p.library["lists"]
                                            .as_array()
                                            .into_iter()
                                            .flatten()
                                            .map(|l| json!({"id":l["id"],"name":l["name"]}))
                                            .collect();
                                        let current = p.active();
                                        egui::ComboBox::from_id_salt("lists")
                                            .selected_text(
                                                lists
                                                    .get(current)
                                                    .and_then(|l| l["name"].as_str())
                                                    .unwrap_or(tr("默认列表")),
                                            )
                                            .width(ui.available_width() - 50.)
                                            .show_ui(ui, |ui| {
                                                for list in lists {
                                                    if ui
                                                        .selectable_label(
                                                            list["id"] == p.library["activeListId"],
                                                            list["name"]
                                                                .as_str()
                                                                .unwrap_or(tr("列表")),
                                                        )
                                                        .clicked()
                                                    {
                                                        p.library["activeListId"] =
                                                            list["id"].clone();
                                                        p.persist();
                                                    }
                                                }
                                            });
                                        if button(ui, p, "new-list", tr("＋ 新建列表")) {
                                            p.dialog = "new-list".into();
                                        }
                                        let r = ui.add(
                                            egui::TextEdit::singleline(&mut p.search)
                                                .hint_text(tr("搜索歌曲、歌手…"))
                                                .desired_width(ui.available_width()),
                                        );
                                        remember(p, "search", &r);
                                        ui.add_space(6.);
                                        let items = p.items();
                                        let search = p.search.to_lowercase();
                                        let filtered: Vec<_> = items
                                            .iter()
                                            .filter(|i| {
                                                search.is_empty()
                                                    || title(i).to_lowercase().contains(&search)
                                                    || i["artist"]
                                                        .as_str()
                                                        .unwrap_or("")
                                                        .to_lowercase()
                                                        .contains(&search)
                                            })
                                            .collect();
                                        let selected = p.current.as_ref().map(|t| t.path.clone());
                                        egui::ScrollArea::vertical()
                                            .id_salt("playlist")
                                            .max_height((body_height - 190.).max(70.))
                                            .show_rows(ui, 46., filtered.len(), |ui, rows| {
                                                for index in rows {
                                                    let item = filtered[index];
                                                    let path = item["path"].as_str().unwrap_or("");
                                                    let is_current =
                                                        selected.as_deref() == Some(path);
                                                    let text = format!(
                                                        "{:02}  {}",
                                                        index + 1,
                                                        title(item)
                                                    );
                                                    let r = ui.add_sized(
                                                        [ui.available_width(), 46.],
                                                        egui::Button::new(
                                                            RichText::new(text).color(
                                                                if is_current {
                                                                    palette.accent
                                                                } else {
                                                                    palette.ink
                                                                },
                                                            ),
                                                        )
                                                        .selected(is_current),
                                                    );
                                                    remember(p, &format!("track-{index}"), &r);
                                                    if r.clicked() {
                                                        p.play(path.into(), 0);
                                                    }
                                                }
                                            });
                                        ui.label(
                                            RichText::new(tr_text(format!(
                                                "{} 首歌曲",
                                                items.len()
                                            )))
                                            .size(11.)
                                            .color(palette.muted),
                                        );
                                    });
                                },
                            );
                            ui.add_space(6.);
                        }
                        ui.allocate_ui_with_layout(
                            vec2(ui.available_width(), body_height),
                            egui::Layout::top_down(egui::Align::Min),
                            |ui| {
                                if small {
                                    now_playing(ui, p, true);
                                } else {
                                    egui::ScrollArea::vertical()
                                        .id_salt("native-stage")
                                        .max_height(body_height)
                                        .show(ui, |ui| {
                                            now_playing(ui, p, false);
                                            ui.add_space(18.);
                                            lyric_view(ui, p);
                                            ui.add_space(18.);
                                            for (index, id) in METERS.iter().enumerate() {
                                                if p.enabled(id) {
                                                    meter(ui, p, index);
                                                    ui.add_space(10.);
                                                }
                                            }
                                        });
                                }
                            },
                        );
                    },
                );
                ui.add_space(10.);
                frame(ui).show(ui, |ui| {
                    ui.set_width(ui.available_width());
                    ui.horizontal(|ui| {
                        if button(ui, p, "previous", tr("上一首")) {
                            p.neighbour(-1, false);
                        }
                        let label = if p.transport_playing() {
                            tr("暂停")
                        } else {
                            tr("播放")
                        };
                        if button(ui, p, "play", label) {
                            p.toggle();
                        }
                        if button(ui, p, "next", tr("下一首")) {
                            p.neighbour(1, false);
                        }
                        if !small {
                            ui.add_space(10.);
                            let radio = p
                                .current
                                .as_ref()
                                .is_some_and(|track| jap_decode::radio::is_url(&track.path));
                            if radio {
                                ui.label(
                                    RichText::new(tr("●  在线电台 · 直播流"))
                                        .size(13.)
                                        .color(palette.accent_text),
                                );
                            } else {
                                ui.label(
                                    RichText::new(clock(p.position))
                                        .size(12.)
                                        .color(palette.muted),
                                );
                                let duration =
                                    p.current.as_ref().and_then(|t| t.duration_ms).unwrap_or(0);
                                let width = (ui.available_width() - 230.).max(90.);
                                if let Some(v) = drag_slider(
                                    ui,
                                    p,
                                    "seek",
                                    if duration > 0 {
                                        p.position as f32 / duration as f32
                                    } else {
                                        0.
                                    },
                                    width,
                                ) {
                                    p.command(Command::Seek {
                                        position_ms: (v * duration as f32) as u64,
                                    });
                                }
                                ui.label(
                                    RichText::new(clock(duration))
                                        .size(12.)
                                        .color(palette.muted),
                                );
                            }
                            if let Some(v) = drag_slider(ui, p, "volume", p.volume, 78.) {
                                p.volume = v;
                                p.command(Command::SetVolume { gain: v });
                            }
                            ui.label(
                                RichText::new(format!("{}%", (p.volume * 100.).round())).size(12.),
                            );
                            if button(ui, p, "reset", tr("重置")) {
                                p.command(Command::ResetBuffer);
                            }
                        }
                    });
                });
            });
        });
    if !p.dialog.is_empty() {
        dialog(ui.ctx(), p);
    }
    if let Some(error) = p.error.clone() {
        egui::Window::new(tr("播放提示"))
            .id(egui::Id::new("native-error"))
            .collapsible(false)
            .resizable(false)
            .anchor(egui::Align2::CENTER_CENTER, Vec2::ZERO)
            .default_width(480.)
            .show(ui.ctx(), |ui| {
                ui.label(tr_text(error));
                if button(ui, p, "dismiss-error", tr("知道了")) {
                    p.error = None;
                }
            });
    }
    let delay = if p.visuals() {
        33
    } else if p.state == PlaybackState::Playing {
        200
    } else {
        1000
    };
    ui.ctx()
        .request_repaint_after(std::time::Duration::from_millis(delay));
}

fn external_queue(ui: &mut egui::Ui, p: &mut Player, height: f32) {
    let snapshot = p.external_state["snapshot"].clone();
    let queue = &snapshot["queue"];
    ui.label(RichText::new(queue["name"].as_str().unwrap_or(tr("网易云播放队列"))).strong());
    if button(ui, p, "local-queue", tr("本地播放列表")) {
        p.prefs["externalLocalQueue"] = json!(true);
    }
    let modes = [
        ("off", tr("顺序播放"), "repeatOff"),
        ("all", tr("列表循环"), "repeatAll"),
        ("one", tr("单曲循环"), "repeatOne"),
        ("shuffle", tr("随机播放"), "shuffleOn"),
    ];
    let mode = snapshot["mode"].as_str().unwrap_or("all");
    egui::ComboBox::from_id_salt("external-mode")
        .selected_text(
            modes
                .iter()
                .find(|m| m.0 == mode)
                .map(|m| m.1)
                .unwrap_or(tr("客户端模式")),
        )
        .show_ui(ui, |ui| {
            for (id, label, action) in modes {
                if ui.selectable_label(id == mode, label).clicked() {
                    p.external_request(action);
                }
            }
        });
    ui.add(
        egui::TextEdit::singleline(&mut p.search)
            .hint_text(tr("搜索歌曲、歌手…"))
            .desired_width(ui.available_width()),
    );
    let items: Vec<_> = queue["items"]
        .as_array()
        .into_iter()
        .flatten()
        .enumerate()
        .filter(|(_, item)| {
            format!(
                "{} {}",
                item["title"].as_str().unwrap_or(""),
                item["artist"].as_str().unwrap_or("")
            )
            .to_lowercase()
            .contains(&p.search.to_lowercase())
        })
        .collect();
    egui::ScrollArea::vertical()
        .id_salt("external-playlist")
        .max_height((height - 220.).max(70.))
        .show_rows(ui, 46., items.len(), |ui, rows| {
            for row in rows {
                let (index, item) = items[row];
                let response = ui.add_sized(
                    [ui.available_width(), 46.],
                    egui::Button::new(format!(
                        "{:02}  {}",
                        index + 1,
                        item["title"].as_str().unwrap_or("")
                    ))
                    .selected(item["id"] == snapshot["track"]["id"]),
                );
                remember(p, &format!("external-track-{index}"), &response);
                if response.clicked()
                    && let Some(connection) = &p.external_connection
                    && let Err(error) = connection.request("playIndex", Some(index as u64), false)
                {
                    p.error = Some(error);
                }
            }
        });
    ui.label(
        RichText::new(tr_text(format!(
            "{} 首歌曲",
            queue["total"].as_u64().unwrap_or(0)
        )))
        .small(),
    );
}
fn now_playing(ui: &mut egui::Ui, p: &mut Player, mini: bool) {
    let palette = colors(ui);
    let track = p
        .current
        .as_ref()
        .map(|t| json!(t))
        .or_else(|| {
            p.library["lists"][p.active()]["items"]
                .as_array()
                .and_then(|a| a.first())
                .cloned()
        })
        .unwrap_or_default();
    ui.horizontal(|ui| {
        let size = if mini {
            52.
        } else {
            (ui.available_width() * 0.28).clamp(100., 210.)
        };
        if let Some(cover) = &p.cover {
            ui.add(
                egui::Image::new(cover)
                    .fit_to_exact_size(vec2(size, size))
                    .corner_radius(18),
            );
        } else {
            crate::branding::icon(ui, size);
        }
        ui.add_space(12.);
        ui.vertical(|ui| {
            if !mini {
                ui.label(
                    RichText::new("YOUR MUSIC, SIMPLY.")
                        .color(palette.accent_text)
                        .size(11.),
                );
                ui.add_space(8.);
            }
            let name = if track.is_null() {
                p.library["lists"][p.active()]["name"]
                    .as_str()
                    .unwrap_or(tr("默认列表"))
                    .to_owned()
            } else {
                title(&track)
            };
            ui.add(
                egui::Label::new(
                    RichText::new(name)
                        .size(if mini { 18. } else { 28. })
                        .strong(),
                )
                .wrap(),
            );
            ui.label(
                RichText::new(track["artist"].as_str().unwrap_or(if track.is_null() {
                    tr("选择音乐，开始聆听")
                } else {
                    track["album"].as_str().unwrap_or(tr("本地音乐"))
                }))
                .color(palette.muted),
            );
            if !mini {
                ui.add_space(8.);
                if let Some(t) = &p.current {
                    ui.label(
                        RichText::new(format!(
                            "{} · {:.1} kHz{}",
                            t.codec,
                            t.format.sample_rate as f64 / 1000.,
                            t.format
                                .bits
                                .map_or_else(String::new, |bits| format!(" · {bits} bit"))
                        ))
                        .size(12.)
                        .color(palette.muted),
                    );
                }
                if let Some(signal) = &p.signal {
                    ui.label(
                        RichText::new(match signal.verdict {
                            jap_core::Verdict::BitPerfect => tr("Bit-Perfect · 位精确"),
                            jap_core::Verdict::SystemMixed => tr("系统混音 · 非 Bit-Perfect"),
                            _ => tr("已处理 · 非 Bit-Perfect"),
                        })
                        .size(12.)
                        .color(palette.accent_text),
                    );
                }
            }
        });
    });
}
fn lyric_view(ui: &mut egui::Ui, p: &Player) {
    let palette = colors(ui);
    if p.lyrics.is_empty() {
        ui.label(
            RichText::new(tr("静下来，听一首。"))
                .size(24.)
                .color(palette.muted),
        );
        return;
    }
    let index = p
        .lyrics
        .partition_point(|l| l.at <= p.position)
        .saturating_sub(1);
    let size = p.prefs["lyricsSize"].as_f64().unwrap_or(100.) as f32 / 100.;
    if let Some(line) = p.lyrics.get(index) {
        let mut job = egui::text::LayoutJob::default();
        if line.words.is_empty() {
            job.append(
                &line.text,
                0.,
                egui::TextFormat {
                    font_id: FontId::proportional(27. * size),
                    color: palette.ink,
                    ..Default::default()
                },
            );
        } else {
            for (at, text) in &line.words {
                job.append(
                    text,
                    0.,
                    egui::TextFormat {
                        font_id: FontId::proportional(27. * size),
                        color: if *at <= p.position {
                            palette.accent_text
                        } else {
                            palette.muted
                        },
                        ..Default::default()
                    },
                );
            }
        }
        ui.label(job);
    }
    if let Some(next) = p.lyrics.get(index + 1) {
        ui.label(
            RichText::new(&next.text)
                .size(19. * size)
                .color(palette.muted),
        );
    }
}
pub fn vu_position(rms: f32) -> f32 {
    ((20. * rms.abs().max(1e-8).log10() + 48.) / 48.).clamp(0., 1.)
}
fn meter(ui: &mut egui::Ui, p: &Player, index: usize) {
    let palette = colors(ui);
    frame(ui).show(ui, |ui| {
        ui.set_width(ui.available_width());
        ui.label(
            RichText::new(METER_NAMES[index])
                .size(12.)
                .color(palette.muted),
        );
        let (r, _) = ui.allocate_exact_size(
            vec2(ui.available_width(), if index == 2 { 84. } else { 110. }),
            Sense::hover(),
        );
        let painter = ui.painter_at(r);
        painter.rect_filled(r, 8., palette.canvas);
        for i in 1..4 {
            let y = r.top() + r.height() * i as f32 / 4.;
            painter.line_segment(
                [pos2(r.left(), y), pos2(r.right(), y)],
                Stroke::new(1.0_f32, palette.line),
            );
        }
        match index {
            0 => {
                for b in 0..64 {
                    let v = p.frame[8 + b * 2].clamp(0., 1.);
                    let x = r.left() + b as f32 * r.width() / 64.;
                    painter.rect_filled(
                        egui::Rect::from_min_max(
                            pos2(x, r.bottom() - v * r.height()),
                            pos2(x + r.width() / 64. - 2., r.bottom()),
                        ),
                        1.,
                        palette.accent,
                    );
                }
            }
            1 => {
                let points = (0..256)
                    .map(|i| {
                        pos2(
                            r.left() + i as f32 * r.width() / 255.,
                            r.center().y - p.frame[136 + i] * r.height() * 0.43,
                        )
                    })
                    .collect();
                painter.add(egui::Shape::line(
                    points,
                    Stroke::new(1.5_f32, palette.accent),
                ));
            }
            2 => {
                for ch in 0..2 {
                    let y = r.top() + ch as f32 * 39. + 5.;
                    let level = vu_position(p.meter_levels[ch]);
                    painter.rect_filled(
                        egui::Rect::from_min_size(pos2(r.left(), y), vec2(r.width() * level, 16.)),
                        4.,
                        palette.accent,
                    );
                    for tick in [-30., -20., -10., 0., 6., 12., 18.] {
                        let x = r.left() + (tick + 30.) / 48. * r.width();
                        painter.line_segment(
                            [pos2(x, y), pos2(x, y + 18.)],
                            Stroke::new(1.0_f32, palette.line),
                        );
                    }
                    let db = 20. * p.meter_levels[ch].abs().max(1e-8).log10();
                    painter.text(
                        pos2(r.left() + 4., y + 20.),
                        egui::Align2::LEFT_TOP,
                        format!(
                            "{}  {:.1} VU  ·  {:.1} dBFS",
                            if ch == 0 { "L" } else { "R" },
                            (db + 18.).max(-99.),
                            db.max(-99.)
                        ),
                        FontId::monospace(10.),
                        palette.ink,
                    );
                }
                painter.text(
                    r.right_bottom(),
                    egui::Align2::RIGHT_BOTTOM,
                    tr("音源 RMS · 0 VU = −18 dBFS · 300 ms"),
                    FontId::proportional(10.),
                    palette.muted,
                );
            }
            3 => {
                let n = p.history.len().max(1);
                for (y, row) in p.history.iter().enumerate() {
                    for b in 0..48 {
                        let v = row[b * 128 / 48].clamp(0., 1.);
                        let color = theme::mix(palette.canvas, palette.accent, v);
                        painter.rect_filled(
                            egui::Rect::from_min_size(
                                pos2(
                                    r.left() + b as f32 * r.width() / 48.,
                                    r.top() + y as f32 * r.height() / n as f32,
                                ),
                                vec2(r.width() / 48. + 0.5, r.height() / n as f32 + 0.5),
                            ),
                            0.,
                            color,
                        );
                    }
                }
            }
            _ => {
                for i in 0..128 {
                    let l = p.frame[392 + i * 2];
                    let right = p.frame[393 + i * 2];
                    painter.circle_filled(
                        pos2(
                            r.center().x + (l - right) * r.height() * 0.4,
                            r.center().y - (l + right) * r.height() * 0.4,
                        ),
                        1.,
                        palette.accent,
                    );
                }
            }
        }
    });
}
fn dialog(ctx: &egui::Context, p: &mut Player) {
    let mut open = true;
    let kind = p.dialog.clone();
    let heading = match kind.as_str() {
        "settings" => tr("原生轻量模式"),
        "external" => tr("外部播放器 · 网易云音乐"),
        "output" => tr("音频输出"),
        "eq" => tr("DSP 与均衡器"),
        "import" => tr("导入音乐"),
        "radio" => tr("添加在线电台"),
        "new-list" => tr("新建列表"),
        "quality" => tr("音源分析"),
        _ => tr("设置"),
    };
    egui::Window::new(heading)
        .id(egui::Id::new("native-modal"))
        .open(&mut open)
        .collapsible(false)
        .resizable(false)
        .anchor(egui::Align2::CENTER_CENTER, Vec2::ZERO)
        .default_width(500.)
        .max_height((ctx.content_rect().height() - 60.).max(180.))
        .show(ctx, |ui| {
            let palette = colors(ui);
            if button(ui, p, "modal-close", tr("完成")) {
                p.dialog.clear();
                p.persist();
            }
            egui::ScrollArea::vertical()
                .id_salt("modal-content")
                .max_height((ctx.content_rect().height() - 180.).max(100.))
                .show(ui, |ui| {
                    match kind.as_str() {
                        "radio" => {
                            ui.label(RichText::new(tr("电台流地址")).color(palette.accent_text).strong());
                            let address = ui.add(egui::TextEdit::singleline(&mut p.radio_address)
                                .char_limit(4096).hint_text("https://…").desired_width(ui.available_width()));
                            remember(p, "radio-address", &address);
                            ui.label(tr("收藏名称（可选）"));
                            let name = ui.add(egui::TextEdit::singleline(&mut p.radio_name)
                                .char_limit(160).hint_text(tr("例如：夜间爵士")).desired_width(ui.available_width()));
                            remember(p, "radio-name", &name);
                            ui.label(RichText::new(tr("HTTP / HTTPS 直连音频，以及包含直连地址的 M3U 或 PLS 列表。"))
                                .size(12.).color(palette.muted));
                            let valid = jap_decode::radio::parse_url(p.radio_address.trim()).is_some();
                            let save = ui.add_enabled(valid, egui::Button::new(RichText::new(tr("保存并播放")).color(palette.on_accent)).fill(palette.accent));
                            remember(p, "radio-save", &save);
                            if save.clicked() && p.add_radio() { p.dialog.clear(); }
                        }
                        "settings" => {
                            let mut language = p.settings["language"].as_str().unwrap_or("system").to_owned();
                            egui::ComboBox::from_label(tr("语言"))
                                .selected_text(match language.as_str() { "zh-CN" => "简体中文", "en" => "English", _ => tr("跟随系统") })
                                .show_ui(ui, |ui| {
                                    for (id, label) in [("system",tr("跟随系统")),("zh-CN","简体中文"),("en","English")] {
                                        if ui.selectable_value(&mut language,id.to_owned(),label).changed() {
                                            p.settings["language"] = json!(language);
                                            p.actions.push(json!({"type":"settings","settings":p.settings}));
                                        }
                                    }
                                });
                            ui.label(RichText::new(tr("Rust 绘制 · 无浏览器运行时")).color(palette.accent_text));
                            ui.add_space(8.);
                            for (i, id) in METERS.iter().enumerate() {
                                if switch(
                                    ui,
                                    p,
                                    &format!("meter-{id}"),
                                    METER_NAMES[i],
                                    p.enabled(id),
                                ) {
                                    p.set_meter(id, !p.enabled(id));
                                }
                            }
                            ui.label(
                                RichText::new(tr("仪表默认关闭；暂停、隐藏与最小化时停止绘制。"))
                                    .size(12.)
                                    .color(palette.muted),
                            );
                            if !["android", "ohos"].contains(&p.platform.as_str()) {
                                for (key, label) in [
                                    ("backgroundPlayback", tr("后台继续播放")),
                                    ("closeToTray", tr("关闭窗口后收起到托盘")),
                                ] {
                                    let native_preference = key == "closeToTray";
                                    let enabled = if native_preference {
                                        &p.prefs[key]
                                    } else {
                                        &p.settings[key]
                                    }
                                    .as_bool()
                                    .unwrap_or(true);
                                    if switch(ui, p, key, label, enabled) {
                                        if native_preference {
                                            p.prefs[key] = json!(!enabled);
                                            p.persist();
                                        } else {
                                            p.settings[key] = json!(!enabled);
                                            p.actions.push(json!({"type":"settings"}));
                                        }
                                    }
                                }
                            }
                            if button(ui, p, "output", tr("输出设备、DSD 与格式表")) {
                                p.dialog = "output".into();
                                p.query(Query::ListOutputDevices { api: p.output.api });
                            }
                            if button(ui, p, "eq", "DSP / EQ") {
                                p.dialog = "eq".into();
                            }
                            if p.platform=="win32" && button(ui,p,"external-player",tr("连接网易云音乐")) {
                                p.dialog="external".into();
                            }
                            if button(ui, p, "quality", tr("音源质量分析")) {
                                p.dialog = "quality".into();
                            }
                            let size = p.prefs["lyricsSize"].as_f64().unwrap_or(100.) as f32;
                            if let Some(size) =
                                scalar(ui, p, "lyrics-size", tr("歌词字号 %"), size, 60., 180.)
                            {
                                p.prefs["lyricsSize"] = json!(size);
                                p.persist();
                            }
                            if switch(
                                ui,
                                p,
                                "awake",
                                tr("播放时保持屏幕常亮"),
                                p.settings["keepScreenAwake"] == true,
                            ) {
                                p.settings["keepScreenAwake"] =
                                    json!(p.settings["keepScreenAwake"] != true);
                                p.actions
                                    .push(json!({"type":"settings","settings":p.settings}));
                            }
                        }
                        "external" => {
                            ui.label(RichText::new(tr("原生 HiFi 通路")).color(palette.accent_text).strong());
                            ui.label(tr("客户端输出进入专用黑洞，原始音频交给此窗口的 Rust 引擎。歌词、封面与系统控制同步。"));
                            let phase=p.external_state["phase"].as_str().unwrap_or("disconnected").to_owned();
                            let connected=matches!(phase.as_str(),"ready"|"routing");
                            ui.add_enabled_ui(phase!="connecting" && p.external_connection.is_some(),|ui| {
                                if switch(ui,p,"external-connect",tr("连接网易云音乐"),connected) {
                                    p.external_request(if connected {"disconnect"}else{"connect"});
                                }
                            });
                            ui.add_enabled_ui(!connected&&phase!="connecting",|ui| {
                                if switch(ui,p,"external-force",tr("强制接管"),p.prefs["externalForce"]==true) {
                                    p.prefs["externalForce"]=json!(p.prefs["externalForce"]!=true);p.persist();
                                }
                            });
                            if phase=="ready" && button(ui,p,"external-route",tr("切换客户端到黑洞设备")) {p.external_request("route");}
                            if p.external_connection.is_none() {ui.label(tr("需要安装包中的连接组件；开发时请从完整版进入原生模式。"));}
                            if let Some(message)=p.external_state["message"].as_str() {ui.label(RichText::new(message).size(12.).color(palette.accent_text));}
                            if connected {
                                let packets=p.external_state["audioPackets"].as_u64().unwrap_or(0);
                                let bytes=p.external_state["nullBytes"].as_str().and_then(|s|s.parse::<u64>().ok()).unwrap_or(0);
                                ui.label(tr_text(format!("音频包 {packets}    黑洞 {:.1} MiB",bytes as f64/1048576.)));
                                ui.label(RichText::new(tr("仅连接时启动无界面适配进程；界面绘制、DSP、解码和硬件输出仍由 Rust 执行。")).size(12.).color(palette.muted));
                            }
                        }
                        "output" => {
                            let apis: Vec<(OutputApi, &str)> = match p.platform.as_str() {
                                "win32" => vec![
                                    (OutputApi::WasapiShared, tr("WASAPI 共享")),
                                    (OutputApi::WasapiExclusive, tr("WASAPI 独占")),
                                    (OutputApi::Asio, "ASIO"),
                                ],
                                "darwin" => vec![
                                    (OutputApi::CoreAudio, "CoreAudio"),
                                    (OutputApi::CoreAudioExclusive, tr("CoreAudio 独占")),
                                ],
                                "linux" => vec![
                                    (OutputApi::AlsaShared, tr("ALSA 共享")),
                                    (OutputApi::AlsaExclusive, tr("ALSA 独占")),
                                ],
                                "ohos" => vec![
                                    (OutputApi::OhosShared, "OHAudio"),
                                    (OutputApi::UsbExclusive, tr("USB 独占")),
                                ],
                                _ => vec![
                                    (OutputApi::AndroidShared, "AAudio"),
                                    (OutputApi::UsbExclusive, tr("USB 独占")),
                                ],
                            };
                            let old = p.output.clone();
                            egui::ComboBox::from_label(tr("音频接口"))
                                .selected_text(
                                    apis.iter()
                                        .find(|(a, _)| *a == p.output.api)
                                        .map(|(_, s)| *s)
                                        .unwrap_or(tr("默认")),
                                )
                                .show_ui(ui, |ui| {
                                    for (api, name) in apis {
                                        if ui
                                            .selectable_value(&mut p.output.api, api, name)
                                            .changed()
                                        {
                                            p.output.device_id = None;
                                            p.query(Query::ListOutputDevices { api });
                                            p.formats.clear();
                                        }
                                    }
                                });
                            egui::ComboBox::from_label(tr("设备"))
                                .selected_text(
                                    p.devices
                                        .iter()
                                        .find(|d| Some(&d.id) == p.output.device_id.as_ref())
                                        .map(|d| d.name.as_str())
                                        .unwrap_or(tr("系统默认")),
                                )
                                .show_ui(ui, |ui| {
                                    ui.selectable_value(&mut p.output.device_id, None, tr("系统默认"));
                                    for d in &p.devices {
                                        ui.selectable_value(
                                            &mut p.output.device_id,
                                            Some(d.id.clone()),
                                            &d.name,
                                        );
                                    }
                                });
                            egui::ComboBox::from_label(tr("DSD 输出"))
                                .selected_text(format!("{:?}", p.output.dsd_mode))
                                .show_ui(ui, |ui| {
                                    for (mode, name) in [
                                        (jap_core::device::DsdMode::Pcm, "DSD → PCM"),
                                        (jap_core::device::DsdMode::Dop, "DoP"),
                                        (jap_core::device::DsdMode::Native, tr("原生 DSD")),
                                    ] {
                                        ui.selectable_value(&mut p.output.dsd_mode, mode, name);
                                    }
                                });
                            if let Some(buffer) = scalar(
                                ui,
                                p,
                                "buffer",
                                tr("缓冲 ms"),
                                p.output.buffer_ms as f32,
                                10.,
                                500.,
                            ) {
                                p.output.buffer_ms = buffer.round() as u32;
                            }
                            if old != p.output {
                                p.command(Command::SetOutput {
                                    config: p.output.clone(),
                                });
                                p.persist();
                            }
                            if p.mobile() && button(ui, p, "usb", tr("连接 USB DAC")) {
                                p.actions.push(json!({"type":"usb"}));
                            }
                            if button(ui, p, "probe-formats", tr("检测设备格式")) {
                                p.query(Query::DeviceFormats {
                                    api: p.output.api,
                                    device_id: p.output.device_id.clone(),
                                });
                            }
                            // A fixed header outside the scrollable body never overlaps rows.
                            ui.horizontal(|ui| {
                                ui.add_sized([145., 28.], egui::Label::new(tr("采样率")));
                                ui.add_sized([150., 28.], egui::Label::new(tr("位深 / 编码")));
                                ui.label(tr("声道"));
                            });
                            egui::ScrollArea::vertical()
                                .id_salt("format-body")
                                .max_height(180.)
                                .show(ui, |ui| {
                                    for f in &p.formats {
                                        ui.horizontal(|ui| {
                                            ui.add_sized(
                                                [145., 24.],
                                                egui::Label::new(format!(
                                                    "{} kHz",
                                                    f.sample_rate as f64 / 1000.
                                                )),
                                            );
                                            ui.add_sized(
                                                [150., 24.],
                                                egui::Label::new(format!("{:?}", f.format)),
                                            );
                                            ui.label(format!("{}", f.channels));
                                        });
                                    }
                                });
                            if let Some(signal) = &p.signal {
                                for n in &signal.nodes {
                                    ui.label(
                                        RichText::new(format!("{} · {}", n.title, n.detail))
                                            .size(12.)
                                            .color(palette.muted),
                                    );
                                }
                            }
                        }
                        "eq" => {
                            if p.current.as_ref().is_some_and(|t|t.format.is_dsd()) && p.output.dsd_mode!=jap_core::device::DsdMode::Pcm && p.state!=PlaybackState::Stopped {
                                ui.label(tr("DSD 直通绕过 DSP；请先切换为 DSD → PCM。"));
                                ui.disable();
                            }
                            if switch(ui, p, "dsp-enabled", tr("开启 DSP"), p.dsp.enabled) {
                                p.dsp.enabled = !p.dsp.enabled;
                                p.command(Command::SetDsp {
                                    config: p.dsp.clone(),
                                });
                            }
                            let mut changed = false;
                            if let Some(value) = scalar(
                                ui,
                                p,
                                "preamp",
                                tr("前级 dB"),
                                p.dsp.preamp_db as f32,
                                -24.,
                                12.,
                            ) {
                                p.dsp.preamp_db = value as f64;
                                changed = true;
                            }
                            ui.horizontal_wrapped(|ui| {
                                for (index, name) in jap_core::DspConfig::PRESETS.iter().enumerate() {
                                    if button(ui, p, &format!("dsp-preset-{index}"), name) {
                                        p.dsp = jap_core::DspConfig::preset(name).unwrap();
                                        changed = true;
                                    }
                                }
                            });
                            for (i, hz) in [
                                "31", "63", "125", "250", "500", "1k", "2k", "4k", "8k", "16k",
                            ]
                            .iter()
                            .enumerate()
                            {
                                if let Some(value) = scalar(
                                    ui,
                                    p,
                                    &format!("eq-{i}"),
                                    &format!("{hz} Hz"),
                                    p.dsp.eq_db[i] as f32,
                                    -12.,
                                    12.,
                                ) {
                                    p.dsp.eq_db[i] = value as f64;
                                    changed = true;
                                }
                            }
                            if changed {
                                p.command(Command::SetDsp {
                                    config: p.dsp.clone(),
                                });
                                p.persist();
                            }
                        }
                        "import" => {
                            ui.label(tr("导入文件或目录。光盘镜像按原生轨道表拆分。"));
                            if button(ui, p, "import-radio", tr("添加在线电台")) {
                                p.dialog = "radio".into();
                            }
                            if p.mobile() && button(ui, p, "native-picker", tr("从文件管理器选择"))
                            {
                                p.actions.push(json!({"type":"importPicker"}));
                            }
                            if p.import_path.is_empty() {
                                p.import_path = std::env::var(if cfg!(windows) {
                                    "USERPROFILE"
                                } else {
                                    "HOME"
                                })
                                .unwrap_or_else(|_| p.root.to_string_lossy().into());
                            }
                            let response = ui.add(
                                egui::TextEdit::singleline(&mut p.import_path)
                                    .desired_width(460.)
                                    .hint_text(tr("音乐路径")),
                            );
                            remember(p, "import-path", &response);
                            ui.horizontal(|ui| {
                                if button(ui, p, "parent-folder", tr("上一级"))
                                    && let Some(parent) = PathBuf::from(&p.import_path).parent()
                                {
                                    p.import_path = parent.to_string_lossy().into();
                                }
                                if button(ui, p, "import-current", tr("导入此路径")) {
                                    p.import(vec![p.import_path.clone()]);
                                    p.dialog.clear();
                                }
                            });
                            if let Ok(entries) = std::fs::read_dir(&p.import_path) {
                                let mut paths: Vec<_> =
                                    entries.flatten().take(1000).map(|e| e.path()).collect();
                                paths.sort_by_key(|p| (!p.is_dir(), p.clone()));
                                egui::ScrollArea::vertical()
                                    .id_salt("native-file-browser")
                                    .max_height(260.)
                                    .show(ui, |ui| {
                                        for path in paths {
                                            let is_dir = path.is_dir();
                                            let label = format!(
                                                "{} {}",
                                                if is_dir { "＋" } else { "♫" },
                                                path.file_name()
                                                    .unwrap_or_default()
                                                    .to_string_lossy()
                                            );
                                            if ui.button(label).clicked() {
                                                if is_dir {
                                                    p.import_path = path.to_string_lossy().into();
                                                } else {
                                                    p.import(vec![path.to_string_lossy().into()]);
                                                    p.dialog.clear();
                                                }
                                            }
                                        }
                                    });
                            }
                        }
                        "new-list" => {
                            let r = ui.text_edit_singleline(&mut p.new_name);
                            remember(p, "list-name", &r);
                            if button(ui, p, "create-list", tr("创建")) && !p.new_name.trim().is_empty()
                            {
                                let id = now_id();
                                let name = p.new_name.trim().to_owned();
                                p.library["lists"]
                                    .as_array_mut()
                                    .unwrap()
                                    .push(json!({"id":id,"name":name,"items":[]}));
                                p.library["activeListId"] = json!(id);
                                p.new_name.clear();
                                p.dialog.clear();
                                p.persist();
                            }
                        }
                        "quality" => {
                            if p.current.is_some() && button(ui, p, "analyze", tr("开始分析")) {
                                p.command(Command::AnalyzeQuality {
                                    path: p.current.as_ref().unwrap().path.clone(),
                                });
                            }
                            if let Some(q) = &p.quality {
                                ui.heading(format!("{} / 100", q.score.unwrap_or(0)));
                                ui.label(tr_text(&q.score_explanation));
                                for f in &q.findings {
                                    ui.strong(tr_text(&f.title));
                                    ui.label(tr_text(&f.detail));
                                }
                            }
                        }
                        _ => {}
                    }
                    ui.add_space(10.);
                });
        });
    if !open {
        p.dialog.clear();
        p.persist();
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn vu_has_digital_headroom() {
        assert!((vu_position(10f32.powf(-18. / 20.)) - 0.625).abs() < 0.001);
        assert!(vu_position(10f32.powf(-8. / 20.)) < 0.85);
        assert_eq!(vu_position(1.), 1.);
        assert_eq!(vu_position(0.), 0.);
    }
}

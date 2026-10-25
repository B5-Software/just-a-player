use crate::desktop::UserEvent;
use anyhow::Result;
use winit::event_loop::EventLoopProxy;
pub fn icon() -> (Vec<u8>, u32, u32) {
    (jap_light::branding::rgba(32), 32, 32)
}
#[cfg(any(windows, target_os = "macos"))]
pub struct Tray {
    _icon: tray_icon::TrayIcon,
}
#[cfg(any(windows, target_os = "macos"))]
impl Tray {
    pub fn new(proxy: EventLoopProxy<UserEvent>) -> Result<Self> {
        use tray_icon::{MouseButton as B, MouseButtonState as S, TrayIconEvent as E};
        E::set_event_handler(Some(move |event| match event {
            E::Click {
                button: B::Left,
                button_state: S::Up,
                ..
            } => {
                let _ = proxy.send_event(UserEvent::Show);
            }
            E::Click {
                button: B::Right,
                button_state: S::Up,
                position,
                ..
            } => {
                let _ = proxy.send_event(UserEvent::Popup(position.x as i32, position.y as i32));
            }
            _ => {}
        }));
        let (rgba, w, h) = icon();
        let icon = tray_icon::TrayIconBuilder::new()
            .with_icon(tray_icon::Icon::from_rgba(rgba, w, h)?)
            .with_tooltip("Just A Player")
            .with_menu_on_left_click(false)
            .build()?;
        Ok(Self { _icon: icon })
    }
}
#[cfg(target_os = "linux")]
mod linux {
    use super::*;
    struct Item {
        proxy: EventLoopProxy<UserEvent>,
    }
    // StatusNotifierItem invokes our native panel directly, including ContextMenu.
    // No GTK window, dbusmenu renderer, or second UI engine is created.
    #[zbus::interface(name = "org.kde.StatusNotifierItem")]
    impl Item {
        fn activate(&self, _x: i32, _y: i32) {
            let _ = self.proxy.send_event(UserEvent::Show);
        }
        fn secondary_activate(&self, _x: i32, _y: i32) {
            let _ = self.proxy.send_event(UserEvent::Command("toggle".into()));
        }
        fn context_menu(&self, x: i32, y: i32) {
            let _ = self.proxy.send_event(UserEvent::Popup(x, y));
        }
        #[zbus(property)]
        fn category(&self) -> &str {
            "ApplicationStatus"
        }
        #[zbus(property)]
        fn id(&self) -> &str {
            "org.b5_software.justaplayer.native"
        }
        #[zbus(property)]
        fn title(&self) -> &str {
            "Just A Player"
        }
        #[zbus(property)]
        fn status(&self) -> &str {
            "Active"
        }
        #[zbus(property)]
        fn window_id(&self) -> u32 {
            0
        }
        #[zbus(property)]
        fn item_is_menu(&self) -> bool {
            false
        }
        #[zbus(property)]
        fn icon_name(&self) -> &str {
            ""
        }
        #[zbus(property)]
        fn icon_pixmap(&self) -> Vec<(i32, i32, Vec<u8>)> {
            let (rgba, w, h) = icon();
            vec![(
                w as i32,
                h as i32,
                rgba.as_chunks::<4>()
                    .0
                    .iter()
                    .flat_map(|c| [c[3], c[0], c[1], c[2]])
                    .collect(),
            )]
        }
    }
    pub struct Tray {
        _connection: zbus::blocking::Connection,
    }
    impl Tray {
        pub fn new(proxy: EventLoopProxy<UserEvent>) -> Result<Self> {
            let service = format!("org.kde.StatusNotifierItem-{}-1", std::process::id());
            let connection = zbus::blocking::connection::Builder::session()?
                .name(service.as_str())?
                .serve_at("/StatusNotifierItem", Item { proxy })?
                .build()?;
            connection.call_method(
                Some("org.kde.StatusNotifierWatcher"),
                "/StatusNotifierWatcher",
                Some("org.kde.StatusNotifierWatcher"),
                "RegisterStatusNotifierItem",
                &service,
            )?;
            Ok(Self {
                _connection: connection,
            })
        }
    }
}
#[cfg(target_os = "linux")]
pub use linux::Tray;

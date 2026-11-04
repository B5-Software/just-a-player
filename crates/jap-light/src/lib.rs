//! Native Rust player UI. No HTML, JavaScript, DOM, WebView or browser runtime.
pub mod branding;
pub mod external;
pub mod host;
mod icons;
pub mod lyrics;
pub mod model;
pub mod surface;
pub mod theme;
pub mod ui;
pub use egui;
pub use model::Player;
pub use surface::NativeSurface;
pub mod i18n;

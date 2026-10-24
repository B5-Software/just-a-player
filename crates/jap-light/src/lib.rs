//! Native Rust player UI. No HTML, JavaScript, DOM, WebView or browser runtime.
pub mod host;
pub mod lyrics;
pub mod model;
pub mod surface;
pub mod ui;
pub use egui;
pub use model::Player;
pub use surface::NativeSurface;

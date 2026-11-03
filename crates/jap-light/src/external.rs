//! Optional desktop process adapter. The UI and the audio engine stay native.
use jap_core::Command;
use serde_json::Value;

pub trait Connection: Send + Sync {
    fn request(&self, action: &str, position_ms: Option<u64>, force: bool) -> Result<(), String>;
    /// Returns true only if the external client owns this transport command.
    fn command(&self, command: &Command) -> bool;
    fn poll(&self) -> Vec<(Value, Vec<u8>)>;
    fn event(&self, event: &Value);
    fn shutdown(&self);
}

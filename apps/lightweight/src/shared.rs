use jap_core::Command;
use jap_light::external::Connection;
use serde_json::Value;

pub struct SharedConnection(pub jap_engine::remote::Client);
impl Connection for SharedConnection {
    fn request(&self, action: &str, position_ms: Option<u64>, force: bool) -> Result<(), String> {
        self.0.external(action, position_ms, force);
        Ok(())
    }
    fn command(&self, _: &Command) -> bool {
        false
    }
    fn poll(&self) -> Vec<(Value, Vec<u8>)> {
        self.0.external_updates()
    }
    fn event(&self, _: &Value) {}
    fn shutdown(&self) {}
}

use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", default)]
#[ts(export)]
pub struct DspConfig {
    pub enabled: bool,
    pub preamp_db: f64,
    pub eq_db: [f64; 10],
    pub balance: f64,
    pub stereo_width: f64,
    pub crossfeed: f64,
    pub limiter: bool,
}

impl Default for DspConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            preamp_db: -6.0,
            eq_db: [0.0; 10],
            balance: 0.0,
            stereo_width: 1.0,
            crossfeed: 0.0,
            limiter: true,
        }
    }
}

impl DspConfig {
    pub fn validate(&self) -> Result<(), String> {
        let valid = |v: f64, min, max| v.is_finite() && v >= min && v <= max;
        if !valid(self.preamp_db, -24.0, 12.0)
            || self.eq_db.iter().any(|&v| !valid(v, -12.0, 12.0))
            || !valid(self.balance, -1.0, 1.0)
            || !valid(self.stereo_width, 0.0, 2.0)
            || !valid(self.crossfeed, 0.0, 1.0)
        {
            return Err("DSP 参数超出范围".into());
        }
        Ok(())
    }
}

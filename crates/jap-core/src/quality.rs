use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct QualityReport {
    pub path: String,
    pub analyzed_seconds: f64,
    pub coverage: String,
    pub score: Option<u32>,
    pub score_explanation: String,
    pub peak_dbfs: f64,
    pub rms_dbfs: f64,
    pub crest_db: f64,
    pub clipped_samples: u32,
    pub clipped_runs: u32,
    pub dc_offset: f64,
    pub quiet_rms_dbfs: f64,
    pub effective_bits: Option<u32>,
    pub occupied_bandwidth_hz: f64,
    pub high_band_db: f64,
    pub stereo_correlation: f64,
    pub findings: Vec<QualityFinding>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct QualityFinding {
    pub title: String,
    pub detail: String,
    pub severity: String,
    pub confidence: String,
}

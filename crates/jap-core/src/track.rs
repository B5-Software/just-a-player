use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::format::AudioFormat;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TrackInfo {
    pub path: String,
    pub codec: String,
    pub format: AudioFormat,
    #[ts(type = "number | null")]
    pub duration_ms: Option<u64>,
    pub lossless: bool,
    #[ts(type = "number | null")]
    pub bitrate_kbps: Option<u32>,
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
}

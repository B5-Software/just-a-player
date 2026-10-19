use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::format::AudioFormat;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum NodeKind {
    Source,
    Decoder,
    ChannelMap,
    Dsp,
    Resampler,
    Quantizer,
    Output,
    Device,
}

/// 节点对样本数据的影响程度。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum Fidelity {
    /// 逐位透传。
    Exact,
    /// 改变了样本值（重采样、DSP、音量等）。
    Transformed,
    /// 有损压缩或不可逆的位深截断。
    Lossy,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SignalNode {
    pub kind: NodeKind,
    pub title: String,
    pub detail: String,
    pub format: Option<AudioFormat>,
    pub fidelity: Fidelity,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum Verdict {
    /// 软件侧可验证的比特完美。
    BitPerfect,
    /// 无损源，但中途被处理过。
    Processed,
    /// 源本身为有损编码。
    Lossy,
    /// 由系统混音器处理，无法保证比特一致。
    SystemMixed,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SignalPath {
    pub nodes: Vec<SignalNode>,
    pub verdict: Verdict,
}

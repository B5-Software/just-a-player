//! Offline sample inspection. Runs away from playback and the Node event loop.
use crate::EventSink;
use jap_core::{Event, QualityFinding, QualityReport};
use std::{
    path::Path,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

pub fn start(path: String, sink: EventSink, cancel: Arc<AtomicBool>) {
    let _ = std::thread::Builder::new()
        .name("jap-quality".into())
        .spawn(move || match analyze(&path, &cancel) {
            Ok(Some(report)) => sink(Event::Quality { report }),
            Err(message) if !cancel.load(Ordering::Relaxed) => {
                sink(Event::QualityError { path, message })
            }
            _ => {}
        });
}

pub fn analyze(path: &str, cancel: &AtomicBool) -> Result<Option<QualityReport>, String> {
    let mut source = jap_decode::open(Path::new(path)).map_err(|e| e.to_string())?;
    let info = source.info().clone();
    let format = source.playback_format();
    let channels = format.channels as usize;
    let mut stats = jap_analysis::quality::QualityAnalyzer::new(
        format.sample_rate,
        channels,
        if info.format.is_dsd() || info.format.float {
            None
        } else {
            info.format.bits
        },
    );
    let duration = info.duration_ms.unwrap_or(0);
    let offsets = if duration > 32000 {
        vec![0, duration / 4, duration / 2, duration * 3 / 4]
    } else {
        vec![0]
    };
    let mut decoded = Vec::new();
    for &offset in &offsets {
        if cancel.load(Ordering::Relaxed) {
            return Ok(None);
        }
        if offset > 0 {
            source.seek(offset).map_err(|e| e.to_string())?;
        }
        stats.begin_segment();
        let limit = u64::from(format.sample_rate) * if offsets.len() > 1 { 8 } else { 32 };
        let mut frames = 0;
        while frames < limit {
            if cancel.load(Ordering::Relaxed) {
                return Ok(None);
            }
            decoded.clear();
            let n = source.read(&mut decoded).map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            let take = n.min((limit - frames) as usize);
            stats.push(&decoded[..take * channels]);
            frames += take as u64;
        }
    }
    let mut report = stats.finish(path.to_owned());
    if jap_decode::midi::is_midi(Path::new(path)) {
        report
            .findings
            .retain(|f| !f.title.contains("升频") && !f.title.contains("位深"));
        report.findings.push(QualityFinding {
            title: "MIDI 合成音源".into(),
            detail: "评分仅评价当前音色库合成波形的削波、动态等指标；MIDI 不含录音采样，不能据此判断原始位深、升频或 AI 来源。".into(),
            severity: "info".into(), confidence: "high".into(),
        });
    }
    report.coverage = if offsets.len() > 1 {
        "抽样：开头、25%、50%、75% 位置各 8 秒".into()
    } else {
        "从开头分析，最长 32 秒".into()
    };
    if info.format.is_dsd() {
        report
            .findings
            .retain(|finding| finding.title != "疑似低带宽或升频来源");
        report.findings.push(QualityFinding { title: "DSD 监测副本".into(),
            detail: "这些指标来自低通后的 PCM 分析副本；不修改 DSD 直通数据，也不据此判断 DSD 原始位深。".into(),
            severity: "info".into(), confidence: "high".into() });
    }
    Ok(Some(report))
}

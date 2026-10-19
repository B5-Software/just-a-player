use std::collections::VecDeque;
use std::sync::Arc;

use jap_core::TrackInfo;

/// 环形缓冲时间线上的一段连续音频，来自同一曲目的某个起点。
pub struct Segment {
    /// 这一段的第一帧在环中的全局帧序号。
    pub start_frame: u64,
    /// 同一曲目（含其跳转产生的多个片段）共享的序号，用于检测换曲。
    pub serial: u64,
    pub info: Arc<TrackInfo>,
    /// 这一段第一帧对应的曲目内帧位置。
    pub source_offset: u64,
}

pub struct Located {
    pub serial: u64,
    pub info: Arc<TrackInfo>,
    pub position_frames: u64,
}

/// 记录生产者写入了哪些曲目片段，让控制线程把播放头换算成曲目与位置。
#[derive(Default)]
pub struct Timeline {
    segments: VecDeque<Segment>,
}

impl Timeline {
    /// A manual load/seek discards the old queued audio, including its timeline.
    pub fn clear(&mut self) {
        self.segments.clear();
    }
    pub fn push(&mut self, segment: Segment) {
        self.segments.push_back(segment);
    }

    /// 播放头越过的旧片段会被顺手清理。
    pub fn locate(&mut self, playhead: u64) -> Option<Located> {
        while self.segments.len() >= 2 && self.segments[1].start_frame <= playhead {
            self.segments.pop_front();
        }
        let seg = self.segments.front()?;
        Some(Located {
            serial: seg.serial,
            info: Arc::clone(&seg.info),
            position_frames: seg.source_offset + playhead.saturating_sub(seg.start_frame),
        })
    }
}

#[cfg(test)]
mod tests {
    use jap_core::AudioFormat;

    use super::*;

    fn info(name: &str) -> Arc<TrackInfo> {
        Arc::new(TrackInfo {
            path: name.into(),
            codec: "PCM".into(),
            format: AudioFormat {
                sample_rate: 48_000,
                channels: 2,
                bits: Some(16),
                float: false,
            },
            duration_ms: None,
            lossless: true,
            bitrate_kbps: None,
            title: None,
            artist: None,
            album: None,
        })
    }

    #[test]
    fn boundary_switches_track_and_restarts_position() {
        let mut t = Timeline::default();
        t.push(Segment {
            start_frame: 0,
            serial: 1,
            info: info("a"),
            source_offset: 0,
        });
        t.push(Segment {
            start_frame: 1000,
            serial: 2,
            info: info("b"),
            source_offset: 0,
        });

        let a = t.locate(999).unwrap();
        assert_eq!((a.serial, a.position_frames), (1, 999));
        let b = t.locate(1000).unwrap();
        assert_eq!((b.serial, b.position_frames), (2, 0));
        let b2 = t.locate(1500).unwrap();
        assert_eq!(b2.position_frames, 500);
    }

    #[test]
    fn seek_segment_keeps_serial_but_shifts_position() {
        let mut t = Timeline::default();
        t.push(Segment {
            start_frame: 0,
            serial: 1,
            info: info("a"),
            source_offset: 0,
        });
        t.push(Segment {
            start_frame: 500,
            serial: 1,
            info: info("a"),
            source_offset: 48_000,
        });

        assert_eq!(t.locate(499).unwrap().position_frames, 499);
        let after = t.locate(600).unwrap();
        assert_eq!((after.serial, after.position_frames), (1, 48_100));
    }
}

//! Bounded packet ingress for an explicitly connected external player.
//! No disk spool, polling file, whole-track buffer, or hidden sample conversion.
use std::collections::VecDeque;
use std::sync::Arc;

use jap_core::{SampleFormat, TrackInfo};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use symphonia::core::codecs::audio::{
    AudioCodecParameters, AudioDecoder, AudioDecoderOptions, well_known::CODEC_ID_FLAC,
};
use symphonia::core::packet::Packet;
use symphonia::core::units::{Duration, Timestamp};

use crate::{AudioSource, DecodeError, Result};

const MAX_PACKET: usize = 2 * 1024 * 1024;
const MAX_QUEUED_BYTES: usize = 16 * 1024 * 1024;
// Highly compressible FLAC can use thousands of small frames within a client's
// normal read-ahead. Keep the byte budget authoritative instead of rejecting a
// valid stream after only a few hundred KiB of compressed silence.
const MAX_PACKETS: usize = 8192;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum LiveEncoding {
    Flac {
        streaminfo: Vec<u8>,
    },
    Pcm {
        format: SampleFormat,
        #[serde(default)]
        planar: bool,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveConfig {
    pub track: TrackInfo,
    pub encoding: LiveEncoding,
    pub start_frame: u64,
    #[serde(default)]
    pub trim_start_frames: u32,
}

struct Block {
    pts: u64,
    frames: u32,
    data: Vec<u8>,
}
struct Queue {
    blocks: VecDeque<Block>,
    bytes: usize,
    next: u64,
    closed: bool,
}

#[derive(Clone)]
pub struct LiveInput {
    config: Arc<LiveConfig>,
    queue: Arc<Mutex<Queue>>,
}

impl LiveInput {
    pub fn new(config: LiveConfig) -> Result<Self> {
        let f = config.track.format;
        if !(8000..=12_288_000).contains(&f.sample_rate)
            || !(1..=32).contains(&f.channels)
            || f.is_dsd()
            || config.start_frame > 9_007_199_254_740_991
            || u64::from(config.trim_start_frames) > u64::from(f.sample_rate) * 10
        {
            return Err(DecodeError::Unsupported("无效的外部 PCM 流格式".into()));
        }
        match &config.encoding {
            LiveEncoding::Flac { streaminfo } if streaminfo.len() == 34 => {}
            LiveEncoding::Pcm { format, .. } if !format.is_dsd() => {}
            _ => return Err(DecodeError::Unsupported("无效的实时流编码参数".into())),
        }
        let start = config.start_frame;
        let input = Self {
            config: Arc::new(config),
            queue: Arc::new(Mutex::new(Queue {
                blocks: VecDeque::new(),
                bytes: 0,
                next: start,
                closed: false,
            })),
        };
        // Reject an incompatible decoder before replacing the current playback.
        input.source()?;
        Ok(input)
    }

    pub fn config(&self) -> &LiveConfig {
        &self.config
    }

    pub fn push(&self, pts: u64, frames: u32, data: Vec<u8>) -> Result<()> {
        if data.is_empty() || data.len() > MAX_PACKET || frames == 0 || frames > 262_144 {
            return Err(DecodeError::Decode("实时音频包超出预算或帧数无效".into()));
        }
        if let LiveEncoding::Pcm { format, .. } = self.config.encoding {
            let expected = frames as usize
                * self.config.track.format.channels as usize
                * format.container_bytes();
            if expected != data.len() {
                return Err(DecodeError::Decode("PCM 包长度与帧数不符".into()));
            }
        }
        let mut q = self.queue.lock();
        if q.closed {
            return Err(DecodeError::Decode("实时音源已断开".into()));
        }
        if pts != q.next {
            return Err(DecodeError::Seek(
                "外部流时间戳发生跳变，必须开启新一代流并清空旧缓冲".into(),
            ));
        }
        if q.blocks.len() >= MAX_PACKETS || q.bytes + data.len() > MAX_QUEUED_BYTES {
            return Err(DecodeError::Decode(
                "实时音源缓冲已满，已拒绝丢包；请重新同步".into(),
            ));
        }
        q.next = pts
            .checked_add(u64::from(frames))
            .ok_or_else(|| DecodeError::Decode("时间戳溢出".into()))?;
        q.bytes += data.len();
        q.blocks.push_back(Block { pts, frames, data });
        Ok(())
    }

    pub fn close(&self) {
        self.queue.lock().closed = true;
    }

    /// Reopening is used after an output-device reset. The controller requests
    /// a source seek to the audible position when continuity must be preserved.
    pub fn source(&self) -> Result<Box<dyn AudioSource>> {
        let decoder = match &self.config.encoding {
            LiveEncoding::Flac { streaminfo } => {
                let mut params = AudioCodecParameters::new();
                params
                    .for_codec(CODEC_ID_FLAC)
                    .with_extra_data(streaminfo.clone().into_boxed_slice());
                let decoder = symphonia::default::get_codecs()
                    .make_audio_decoder(&params, &AudioDecoderOptions::default())?;
                let p = decoder.codec_params();
                if p.sample_rate != Some(self.config.track.format.sample_rate)
                    || p.channels.as_ref().map(|c| c.count())
                        != Some(self.config.track.format.channels as usize)
                    || p.bits_per_sample != self.config.track.format.bits
                {
                    return Err(DecodeError::Decode("FLAC STREAMINFO 与流格式不一致".into()));
                }
                Some(decoder)
            }
            LiveEncoding::Pcm { .. } => None,
        };
        let q = self.queue.lock();
        let position = q.blocks.front().map_or(q.next, |b| b.pts);
        let trim = if position == self.config.start_frame {
            self.config.trim_start_frames as usize
        } else {
            0
        };
        Ok(Box::new(LiveSource {
            input: self.clone(),
            decoder,
            position: position + trim as u64,
            scratch: Vec::new(),
            trim,
        }))
    }
}

struct LiveSource {
    input: LiveInput,
    decoder: Option<Box<dyn AudioDecoder>>,
    position: u64,
    scratch: Vec<f64>,
    trim: usize,
}

impl AudioSource for LiveSource {
    fn info(&self) -> &TrackInfo {
        &self.input.config.track
    }
    fn position_frames(&self) -> u64 {
        self.position
    }
    fn seek(&mut self, _: u64) -> Result<u64> {
        Err(DecodeError::Seek("请通过外部播放器控制器跳转".into()))
    }
    fn read(&mut self, out: &mut Vec<f64>) -> Result<usize> {
        let block = {
            let mut q = self.input.queue.lock();
            match q.blocks.pop_front() {
                Some(b) => {
                    q.bytes -= b.data.len();
                    b
                }
                None if q.closed => return Ok(0),
                None => return Err(DecodeError::Pending),
            }
        };
        let channels = self.info().format.channels as usize;
        self.scratch.clear();
        let n = if let Some(decoder) = self.decoder.as_mut() {
            let packet = Packet::new(
                0,
                Timestamp::new(block.pts as i64),
                Duration::from(u64::from(block.frames)),
                block.data,
            );
            let decoded = decoder.decode(&packet)?;
            let n = decoded.frames();
            if n != block.frames as usize {
                return Err(DecodeError::Decode("解码帧数与外部时间戳不一致".into()));
            }
            decoded.copy_to_vec_interleaved::<f64>(&mut self.scratch);
            n
        } else {
            let LiveEncoding::Pcm { format, planar } = self.input.config.encoding else {
                unreachable!()
            };
            let width = format.container_bytes();
            for index in 0..block.frames as usize * channels {
                let at = if planar {
                    index % channels * block.frames as usize + index / channels
                } else {
                    index
                } * width;
                let b = &block.data[at..at + width];
                let x = match format {
                    SampleFormat::I16 => {
                        f64::from(i16::from_le_bytes(b.try_into().unwrap())) / 32768.
                    }
                    SampleFormat::I24Packed => {
                        f64::from(i32::from_le_bytes([
                            b[0],
                            b[1],
                            b[2],
                            if b[2] & 128 != 0 { 255 } else { 0 },
                        ])) / 8388608.
                    }
                    SampleFormat::I24In32 | SampleFormat::I32 => {
                        f64::from(i32::from_le_bytes(b.try_into().unwrap())) / 2147483648.
                    }
                    SampleFormat::F32 => f64::from(f32::from_le_bytes(b.try_into().unwrap())),
                    SampleFormat::F64 => f64::from_le_bytes(b.try_into().unwrap()),
                    _ => unreachable!(),
                };
                if !x.is_finite() {
                    return Err(DecodeError::Decode("实时 PCM 包含非有限数值".into()));
                }
                self.scratch.push(x);
            }
            block.frames as usize
        };
        if self.scratch.len() != n * channels {
            return Err(DecodeError::Decode("实时音源声道数不一致".into()));
        }
        let skip = self.trim.min(n);
        self.trim -= skip;
        self.position = (block.pts + n as u64).max(self.position);
        if skip == n {
            return Err(DecodeError::Pending);
        }
        out.extend_from_slice(&self.scratch[skip * channels..]);
        Ok(n - skip)
    }
}

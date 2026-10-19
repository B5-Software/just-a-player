use std::fs::File;
use std::path::Path;

use jap_core::{AudioFormat, TrackInfo};
use symphonia::core::audio::sample::SampleFormat;
use symphonia::core::codecs::audio::{AudioDecoder, AudioDecoderOptions};
use symphonia::core::errors::Error as SymError;
use symphonia::core::formats::probe::Hint;
use symphonia::core::formats::{FormatOptions, FormatReader, SeekMode, SeekTo, TrackType};
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::{MetadataOptions, StandardTag};
use symphonia::core::units::{Time, TimeBase};

use crate::error::{DecodeError, Result};
use crate::source::AudioSource;

pub struct SymphoniaSource {
    format: Box<dyn FormatReader>,
    decoder: Box<dyn AudioDecoder>,
    track_id: u32,
    time_base: Option<TimeBase>,
    start_ts: i64,
    info: TrackInfo,
    rate: u32,
    channels: usize,
    scratch: Vec<f64>,
    /// 精确跳转后需要丢弃的帧数（容器只能落在包边界上）。
    skip_frames: u64,
    position_frames: u64,
}

impl SymphoniaSource {
    pub fn open(path: &Path) -> Result<Self> {
        let is_ncm = path
            .extension()
            .is_some_and(|v| v.eq_ignore_ascii_case("ncm"));
        let mut ncm_meta = None;
        let media: Box<dyn symphonia::core::io::MediaSource> = if is_ncm {
            let reader = crate::ncm::NcmReader::open(path)?;
            ncm_meta = reader.metadata.clone();
            Box::new(reader)
        } else {
            Box::new(File::open(path)?)
        };
        let file_len = media.byte_len();
        let mss = MediaSourceStream::new(media, Default::default());

        let mut hint = Hint::new();
        if let Some(ext) = path
            .extension()
            .and_then(|e| e.to_str())
            .filter(|_| !is_ncm)
        {
            hint.with_extension(ext);
        }

        let mut format = symphonia::default::get_probe()
            .probe(
                &hint,
                mss,
                FormatOptions::default(),
                MetadataOptions::default(),
            )
            .map_err(|e| match e {
                SymError::Unsupported(_) => DecodeError::Unsupported(path.display().to_string()),
                other => DecodeError::from(other),
            })?;

        let track = format
            .default_track(TrackType::Audio)
            .ok_or_else(|| DecodeError::Unsupported("没有可播放的音频轨".into()))?;
        let track_id = track.id;
        let time_base = track.time_base;
        let start_ts = track.start_ts.get();
        let num_frames = track.num_frames;
        let params = track
            .codec_params
            .as_ref()
            .and_then(|p| p.audio())
            .ok_or_else(|| DecodeError::Unsupported("缺少音频编码参数".into()))?
            .clone();

        let decoder = symphonia::default::get_codecs()
            .make_audio_decoder(&params, &AudioDecoderOptions::default())
            .map_err(|e| match e {
                SymError::Unsupported(what) => DecodeError::Unsupported(format!("编码 {what}")),
                other => DecodeError::from(other),
            })?;

        let rate = params
            .sample_rate
            .ok_or_else(|| DecodeError::Unsupported("未知采样率".into()))?;
        let channels = params.channels.as_ref().map_or(0, |c| c.count());
        if channels == 0 {
            return Err(DecodeError::Unsupported("未知声道布局".into()));
        }

        let codec_short = decoder.codec_info().short_name;
        let is_float = matches!(
            params.sample_format,
            Some(SampleFormat::F32 | SampleFormat::F64)
        );
        let lossless = is_lossless(codec_short);
        let bits = params.bits_per_sample.or(match params.sample_format {
            Some(SampleFormat::U8 | SampleFormat::S8) => Some(8),
            Some(SampleFormat::U16 | SampleFormat::S16) => Some(16),
            Some(SampleFormat::U24 | SampleFormat::S24) => Some(24),
            Some(SampleFormat::U32 | SampleFormat::S32 | SampleFormat::F32) => Some(32),
            Some(SampleFormat::F64) => Some(64),
            None => None,
        });
        // 有损编码即便解出 32 位浮点，也没有固有位深
        let bits = if lossless { bits } else { None };

        let duration_ms = num_frames.map(|f| f * 1000 / u64::from(rate));
        let bitrate_kbps = match (file_len, duration_ms) {
            (Some(len), Some(ms)) if ms > 0 && !lossless => Some((len * 8 / ms) as u32),
            _ => None,
        };

        let (mut title, mut artist, mut album) = read_basic_tags(format.as_mut());
        if let Some(meta) = ncm_meta {
            title = title.or_else(|| meta["musicName"].as_str().map(str::to_owned));
            album = album.or_else(|| meta["album"].as_str().map(str::to_owned));
            artist = artist.or_else(|| {
                meta["artist"]
                    .as_array()
                    .map(|artists| {
                        artists
                            .iter()
                            .filter_map(|a| a[0].as_str())
                            .collect::<Vec<_>>()
                            .join(" / ")
                    })
                    .filter(|v| !v.is_empty())
            });
        }

        let info = TrackInfo {
            path: path.display().to_string(),
            codec: if is_ncm {
                format!("NCM / {}", display_codec(codec_short))
            } else {
                display_codec(codec_short)
            },
            format: AudioFormat {
                sample_rate: rate,
                channels: channels as u16,
                bits,
                float: is_float,
            },
            duration_ms,
            lossless,
            bitrate_kbps,
            title,
            artist,
            album,
        };

        Ok(Self {
            format,
            decoder,
            track_id,
            time_base,
            start_ts,
            info,
            rate,
            channels,
            scratch: Vec::new(),
            skip_frames: 0,
            position_frames: 0,
        })
    }

    fn ts_to_frames(&self, ts: i64) -> u64 {
        let rel = ts - self.start_ts;
        match self.time_base {
            Some(tb) => {
                let secs = tb
                    .calc_time(symphonia::core::units::Timestamp::new(rel))
                    .map_or(0.0, |t| t.as_secs_f64());
                (secs * f64::from(self.rate)).round().max(0.0) as u64
            }
            None => rel.max(0) as u64,
        }
    }
}

impl AudioSource for SymphoniaSource {
    fn info(&self) -> &TrackInfo {
        &self.info
    }

    fn read(&mut self, out: &mut Vec<f64>) -> Result<usize> {
        loop {
            let packet = match self.format.next_packet() {
                Ok(Some(p)) => p,
                Ok(None) => return Ok(0),
                Err(SymError::ResetRequired) => {
                    return Err(DecodeError::Unsupported("流中途改变了轨道布局".into()));
                }
                // 很多容器格式（MP3、FLAC、M4A 等）在文件尾部会触发 UnexpectedEof，
                // 这不是真正的读取错误，等同于文件正常结束 EOF。
                Err(SymError::IoError(ref e))
                    if e.kind() == std::io::ErrorKind::UnexpectedEof
                        || e.to_string().to_lowercase().contains("end of file") =>
                {
                    return Ok(0);
                }
                Err(e) => return Err(e.into()),
            };
            if packet.track_id != self.track_id {
                continue;
            }

            let decoded = match self.decoder.decode(&packet) {
                Ok(buf) => buf,
                // 坏包直接跳过，比整首中断体验更好
                Err(SymError::DecodeError(msg)) => {
                    tracing::warn!("跳过损坏的数据包: {msg}");
                    continue;
                }
                Err(SymError::IoError(e)) => {
                    tracing::warn!("跳过读取失败的数据包: {e}");
                    continue;
                }
                Err(e) => return Err(e.into()),
            };

            let mut frames = decoded.frames();
            if frames == 0 {
                continue;
            }
            self.scratch.clear();
            decoded.copy_to_vec_interleaved::<f64>(&mut self.scratch);

            let mut start = 0usize;
            if self.skip_frames > 0 {
                let drop = (self.skip_frames as usize).min(frames);
                self.skip_frames -= drop as u64;
                start = drop * self.channels;
                frames -= drop;
            }
            if frames == 0 {
                continue;
            }

            out.extend_from_slice(&self.scratch[start..start + frames * self.channels]);
            self.position_frames += frames as u64;
            return Ok(frames);
        }
    }

    fn seek(&mut self, position_ms: u64) -> Result<u64> {
        let target_frames = position_ms * u64::from(self.rate) / 1000;
        let seeked = self.format.seek(
            SeekMode::Accurate,
            SeekTo::Time {
                time: Time::from_millis_u64(position_ms),
                track_id: Some(self.track_id),
            },
        )?;
        self.decoder.reset();

        let actual_frames = self.ts_to_frames(seeked.actual_ts.get());
        if actual_frames <= target_frames {
            self.skip_frames = target_frames - actual_frames;
            self.position_frames = target_frames;
        } else {
            self.skip_frames = 0;
            self.position_frames = actual_frames;
        }
        Ok(self.position_frames * 1000 / u64::from(self.rate))
    }

    fn position_frames(&self) -> u64 {
        self.position_frames
    }
}

fn is_lossless(codec_short_name: &str) -> bool {
    codec_short_name.starts_with("pcm")
        || matches!(
            codec_short_name,
            "flac" | "alac" | "wavpack" | "ape" | "tta"
        )
}

fn display_codec(short: &str) -> String {
    match short {
        s if s.starts_with("pcm") => "PCM".to_string(),
        "flac" => "FLAC".to_string(),
        "alac" => "ALAC".to_string(),
        "mp1" | "mp2" | "mp3" => short.to_uppercase(),
        "aac" => "AAC".to_string(),
        "vorbis" => "Vorbis".to_string(),
        "opus" => "Opus".to_string(),
        other => other.to_uppercase(),
    }
}

fn read_basic_tags(
    format: &mut dyn FormatReader,
) -> (Option<String>, Option<String>, Option<String>) {
    let (mut title, mut artist, mut album) = (None, None, None);
    let mut meta = format.metadata();
    // 新版本的标签是对旧版本的“增补”，需要从旧到新依次叠加
    loop {
        if let Some(rev) = meta.current() {
            for tag in &rev.media.tags {
                match &tag.std {
                    Some(StandardTag::TrackTitle(v)) => title = Some(v.to_string()),
                    Some(StandardTag::Artist(v)) => artist = Some(v.to_string()),
                    Some(StandardTag::Album(v)) => album = Some(v.to_string()),
                    _ => {}
                }
            }
        }
        if meta.is_latest() {
            break;
        }
        meta.pop();
    }
    (title, artist, album)
}

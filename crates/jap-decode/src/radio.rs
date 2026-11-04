//! HTTP radio on a separate worker. Decoded samples reach the audio producer
//! through a bounded queue; network reads never hold up the device or controls.
use std::io::{self, BufRead, BufReader, Read};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Weak};
use std::thread;
use std::time::{Duration, Instant};

use crossbeam_channel::{Receiver, Sender, TryRecvError, bounded};
use jap_core::TrackInfo;
use symphonia::core::{formats::probe::Hint, io::ReadOnlySource};
use ureq::ResponseExt;
use url::Url;

use crate::{AudioSource, DecodeError, Result, SymphoniaSource};

const STARTUP: Duration = Duration::from_secs(20);
const MAX_PLAYLIST: usize = 64 * 1024;

pub fn is_url(path: &str) -> bool {
    path.split_once("://").is_some_and(|(scheme, _)| {
        scheme.eq_ignore_ascii_case("http") || scheme.eq_ignore_ascii_case("https")
    })
}

pub fn parse_url(path: &str) -> Option<Url> {
    if path.len() > 4096 || !is_url(path) || path.chars().any(char::is_control) {
        return None;
    }
    let mut url = Url::parse(path).ok()?;
    if url.host_str().is_none() || !url.username().is_empty() || url.password().is_some() {
        return None;
    }
    url.set_fragment(None);
    Some(url)
}

pub struct Connection {
    ready: Receiver<Result<Ready>>,
    alive: Arc<()>,
    deadline: Instant,
}

struct Ready {
    info: TrackInfo,
    samples: Receiver<Result<Vec<f64>>>,
}

impl Connection {
    pub fn start(path: String) -> Result<Self> {
        let url = parse_url(&path).ok_or_else(|| {
            DecodeError::Unsupported("请输入有效的 HTTP 或 HTTPS 电台地址".into())
        })?;
        let (tx, ready) = bounded(1);
        let alive = Arc::new(());
        let cancelled = Arc::downgrade(&alive);
        thread::Builder::new()
            .name("jap-radio".into())
            .spawn(move || {
                let agent = ureq::Agent::config_builder()
                    .user_agent("Just A Player")
                    .max_redirects(5)
                    .timeout_resolve(Some(Duration::from_secs(5)))
                    .timeout_connect(Some(Duration::from_secs(5)))
                    .timeout_recv_response(Some(Duration::from_secs(8)))
                    .timeout_per_read(Some(Duration::from_secs(8)))
                    .build()
                    .new_agent();
                let mut source = match open(&agent, &url, &path, &cancelled) {
                    Ok(source) => source,
                    Err(error) => {
                        let _ = tx.send(Err(error));
                        return;
                    }
                };
                let mut first = Vec::new();
                if let Err(error) = read_block(&mut source, &mut first) {
                    let _ = tx.send(Err(error));
                    return;
                }
                let info = source.info.clone();
                let (samples, rx) = bounded(12);
                if tx
                    .send(Ok(Ready {
                        info: info.clone(),
                        samples: rx,
                    }))
                    .is_ok()
                    && samples.send(Ok(first)).is_ok()
                {
                    pump(&agent, &url, &path, &cancelled, source, &info, &samples);
                }
            })?;
        Ok(Self {
            ready,
            alive,
            deadline: Instant::now() + STARTUP,
        })
    }

    pub fn poll(&self) -> Option<Result<Box<dyn AudioSource>>> {
        match self.ready.try_recv() {
            Ok(result) => Some(result.map(|Ready { info, samples }| {
                Box::new(RadioSource {
                    info,
                    samples,
                    position: 0,
                    _alive: self.alive.clone(),
                }) as Box<dyn AudioSource>
            })),
            Err(TryRecvError::Empty) if Instant::now() < self.deadline => None,
            Err(_) => Some(Err(DecodeError::Decode("连接电台超时或已中断".into()))),
        }
    }
}

fn read_block(source: &mut Station, samples: &mut Vec<f64>) -> Result<usize> {
    let frames = source.decoder.read(samples)?;
    if frames == 0 {
        return Err(DecodeError::Decode("电台已中断音频传输".into()));
    }
    source.probing.store(false, Ordering::Relaxed);
    Ok(frames)
}

fn pump(
    agent: &ureq::Agent,
    url: &Url,
    path: &str,
    alive: &Weak<()>,
    mut source: Station,
    info: &TrackInfo,
    tx: &Sender<Result<Vec<f64>>>,
) {
    let mut failures = 0;
    let mut steady_frames = 0;
    while alive.strong_count() > 0 {
        let mut samples = Vec::new();
        match read_block(&mut source, &mut samples) {
            Ok(frames) => {
                if tx.send(Ok(samples)).is_err() {
                    return;
                }
                steady_frames += frames;
                if steady_frames >= info.format.sample_rate as usize * 10 {
                    failures = 0;
                    steady_frames = 0;
                }
            }
            Err(mut error) => {
                steady_frames = 0;
                loop {
                    if failures == 4 {
                        let _ = tx.send(Err(DecodeError::Decode(format!("电台重连失败：{error}"))));
                        return;
                    }
                    let until = Instant::now() + Duration::from_secs(1 << failures);
                    failures += 1;
                    while Instant::now() < until {
                        if alive.strong_count() == 0 {
                            return;
                        }
                        thread::sleep(Duration::from_millis(50));
                    }
                    match open(agent, url, path, alive) {
                        Ok(next) if next.info.format == info.format => {
                            source = next;
                            break;
                        }
                        Ok(_) => {
                            let _ = tx.send(Err(DecodeError::Decode(
                                "电台音频格式已变化，请重新播放".into(),
                            )));
                            return;
                        }
                        Err(next_error) => error = next_error,
                    }
                }
            }
        }
    }
}

struct Station {
    decoder: SymphoniaSource,
    info: TrackInfo,
    probing: Arc<AtomicBool>,
}

fn open(agent: &ureq::Agent, initial: &Url, path: &str, alive: &Weak<()>) -> Result<Station> {
    let mut url = initial.clone();
    let deadline = Instant::now() + STARTUP;
    for _ in 0..4 {
        if alive.strong_count() == 0 {
            return Err(DecodeError::Pending);
        }
        let response = agent
            .get(url.as_str())
            .header("Icy-MetaData", "0")
            .call()
            .map_err(|e| DecodeError::Decode(format!("无法连接电台：{e}")))?;
        url = parse_url(&response.get_uri().to_string())
            .ok_or_else(|| DecodeError::Unsupported("无效的电台重定向地址".into()))?;
        let mime = response
            .body()
            .mime_type()
            .unwrap_or_default()
            .to_ascii_lowercase();
        if matches!(mime.as_str(), "text/html" | "application/json") {
            return Err(DecodeError::Unsupported(
                "该地址返回网页或数据，请使用电台音频流地址".into(),
            ));
        }
        let header = |key: &str| response.headers().get(key).and_then(|v| v.to_str().ok());
        let station = header("icy-name")
            .map(|v| v.trim().chars().take(160).collect::<String>())
            .filter(|v| !v.is_empty());
        let bitrate = header("icy-br").and_then(|v| v.parse::<u32>().ok());
        let interval = header("icy-metaint")
            .and_then(|v| v.parse::<usize>().ok())
            .filter(|v| *v > 0);
        let probing = Arc::new(AtomicBool::new(true));
        let mut body = BufReader::new(RadioReader {
            body: response.into_body().into_reader(),
            alive: alive.clone(),
            deadline,
            probing: probing.clone(),
            interval,
            remaining: interval.unwrap_or_default(),
        });
        let ext = url.path().rsplit_once('.').map_or("", |(_, ext)| ext);
        let prefix = body.fill_buf()?;
        let prefix = prefix.strip_prefix(b"\xef\xbb\xbf").unwrap_or(prefix);
        if matches!(ext.to_ascii_lowercase().as_str(), "m3u" | "m3u8" | "pls")
            || matches!(
                mime.as_str(),
                "audio/x-mpegurl"
                    | "audio/mpegurl"
                    | "application/x-mpegurl"
                    | "application/vnd.apple.mpegurl"
                    | "audio/x-scpls"
            )
            || prefix.starts_with(b"#EXTM3U")
            || prefix.starts_with(b"[playlist]")
        {
            url = playlist_url(&url, body)?;
            continue;
        }
        let mut hint = Hint::new();
        if !ext.is_empty() {
            hint.with_extension(ext);
        }
        if !mime.is_empty() {
            hint.mime_type(&mime);
        }
        let decoder = SymphoniaSource::from_media(
            "电台音频流",
            Box::new(ReadOnlySource::new(body)),
            &hint,
            false,
            None,
        )?;
        let mut info = decoder.info().clone();
        info.path = path.to_owned();
        info.duration_ms = None;
        info.title = station.or_else(|| url.host_str().map(str::to_owned));
        info.artist = None;
        info.album = Some("在线电台".into());
        info.bitrate_kbps = bitrate;
        return Ok(Station {
            decoder,
            info,
            probing,
        });
    }
    Err(DecodeError::Unsupported("电台播放列表嵌套过多".into()))
}

fn playlist_url(base: &Url, body: impl Read) -> Result<Url> {
    let mut bytes = Vec::new();
    body.take((MAX_PLAYLIST + 1) as u64)
        .read_to_end(&mut bytes)?;
    if bytes.len() > MAX_PLAYLIST {
        return Err(DecodeError::Unsupported("电台播放列表超过大小限制".into()));
    }
    let text = String::from_utf8_lossy(&bytes);
    let text = text.trim_start_matches('\u{feff}');
    if text
        .lines()
        .any(|line| line.trim_start().starts_with("#EXT-X-"))
    {
        return Err(DecodeError::Unsupported(
            "此电台使用 HLS 分段流，请使用直连音频地址".into(),
        ));
    }
    let pls = text
        .trim_start()
        .to_ascii_lowercase()
        .starts_with("[playlist]");
    text.lines()
        .map(str::trim)
        .filter_map(|line| {
            if pls {
                let (key, value) = line.split_once('=')?;
                let key = key.trim().to_ascii_lowercase();
                return key
                    .strip_prefix("file")
                    .filter(|n| n.parse::<u32>().is_ok())
                    .map(|_| value.trim());
            }
            (!line.is_empty() && !line.starts_with('#')).then_some(line)
        })
        .find_map(|line| base.join(line).ok().and_then(|url| parse_url(url.as_str())))
        .ok_or_else(|| DecodeError::Unsupported("播放列表中没有 HTTP 或 HTTPS 电台地址".into()))
}

struct RadioReader<R> {
    body: R,
    alive: Weak<()>,
    deadline: Instant,
    probing: Arc<AtomicBool>,
    interval: Option<usize>,
    remaining: usize,
}

impl<R: Read> Read for RadioReader<R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if buf.is_empty() {
            return Ok(0);
        }
        if self.alive.strong_count() == 0 {
            return Err(io::Error::other("电台连接已取消"));
        }
        if self.probing.load(Ordering::Relaxed) && Instant::now() >= self.deadline {
            return Err(io::Error::new(io::ErrorKind::TimedOut, "电台音频探测超时"));
        }
        let Some(interval) = self.interval else {
            return self.body.read(buf);
        };
        if self.remaining == 0 {
            let mut size = [0];
            self.body.read_exact(&mut size)?;
            let mut metadata = [0; 4080];
            self.body
                .read_exact(&mut metadata[..usize::from(size[0]) * 16])?;
            self.remaining = interval;
        }
        let len = buf.len().min(self.remaining);
        let n = self.body.read(&mut buf[..len])?;
        self.remaining -= n;
        Ok(n)
    }
}

struct RadioSource {
    info: TrackInfo,
    samples: Receiver<Result<Vec<f64>>>,
    position: u64,
    _alive: Arc<()>,
}

impl AudioSource for RadioSource {
    fn info(&self) -> &TrackInfo {
        &self.info
    }
    fn read(&mut self, out: &mut Vec<f64>) -> Result<usize> {
        let samples = match self.samples.try_recv() {
            Ok(samples) => samples?,
            Err(TryRecvError::Empty) => return Err(DecodeError::Pending),
            Err(TryRecvError::Disconnected) => return Ok(0),
        };
        let frames = samples.len() / usize::from(self.info.format.channels);
        self.position += frames as u64;
        out.extend(samples);
        Ok(frames)
    }
    fn seek(&mut self, _: u64) -> Result<u64> {
        Err(DecodeError::Seek("在线电台不能跳转".into()))
    }
    fn position_frames(&self) -> u64 {
        self.position
    }
}

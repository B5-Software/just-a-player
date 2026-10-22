use std::{io::Read, path::Path, process::Stdio};

/// Metadata only: FFprobe skips media payload, including RF64's 64-bit data chunk.
/// No decoded song or intermediate file is retained in memory.
pub fn read_lyrics(path: &Path) -> Option<String> {
    if crate::disc::parse(path).ok().flatten().is_some()
        || path.extension().is_some_and(|e| {
            ["iso", "bin", "cue", "img"]
                .iter()
                .any(|v| e.eq_ignore_ascii_case(v))
        })
    {
        return None;
    }
    if let Some(text) = native_lyrics(path) {
        return Some(text);
    }
    if path
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("ncm"))
    {
        return None; // FFprobe cannot read the encrypted container.
    }
    let mut child = crate::ffmpeg::command("ffprobe")
        .args([
            "-v",
            "error",
            "-show_entries",
            "format_tags:stream_tags",
            "-of",
            "json",
        ])
        .arg(path)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let mut bytes = Vec::new();
    let read = child
        .stdout
        .take()?
        .take(8 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes);
    if bytes.len() > 8 * 1024 * 1024 || read.is_err() {
        let _ = child.kill();
        let _ = child.wait();
        return None;
    }
    if !child.wait().ok()?.success() {
        return None;
    }
    let json: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    let mut candidates = Vec::new();
    for tags in std::iter::once(&json["format"]["tags"]).chain(
        json["streams"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|s| &s["tags"]),
    ) {
        if let Some(tags) = tags.as_object() {
            for (name, value) in tags {
                let key = name.to_ascii_lowercase().replace(['_', ' '], "");
                if (key == "lyrics"
                    || key.starts_with("lyrics-")
                    || key == "unsyncedlyrics"
                    || key == "syncedlyrics")
                    && let Some(text) = value.as_str().filter(|v| !v.trim().is_empty())
                {
                    candidates.push(text.to_owned());
                }
            }
        }
    }
    // Prefer timestamped lyrics when the container has both plain and synced tags.
    candidates.sort_by_key(|text| !text.contains("[00:"));
    candidates.into_iter().next()
}
fn native_lyrics(path: &Path) -> Option<String> {
    use symphonia::core::{
        formats::{FormatOptions, probe::Hint},
        io::{MediaSource, MediaSourceStream},
        meta::{MetadataOptions, StandardTag},
    };
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    if ![
        "flac", "mp3", "m4a", "mp4", "aac", "ogg", "oga", "opus", "aiff", "aif", "wav", "ncm",
    ]
    .contains(&ext.as_str())
    {
        return None;
    }
    let mut file: Box<dyn MediaSource> = if ext == "ncm" {
        Box::new(crate::NcmReader::open(path).ok()?)
    } else {
        Box::new(std::fs::File::open(path).ok()?)
    };
    let mut signature = [0; 4];
    file.read_exact(&mut signature).ok()?;
    // The native RF64 reader handles audio; use the fallback for its ID3 tags.
    if matches!(&signature, b"RF64" | b"BW64") {
        return None;
    }
    use std::io::{Seek, SeekFrom};
    file.seek(SeekFrom::Start(0)).ok()?;
    let mut hint = Hint::new();
    if ext != "ncm" {
        hint.with_extension(&ext);
    }
    let mut format = symphonia::default::get_probe()
        .probe(
            &hint,
            MediaSourceStream::new(file, Default::default()),
            FormatOptions::default(),
            MetadataOptions::default(),
        )
        .ok()?;
    let mut metadata = format.metadata();
    let mut result = None;
    loop {
        if let Some(rev) = metadata.current() {
            for tag in &rev.media.tags {
                let key = tag.raw.key.to_ascii_lowercase().replace(['_', ' '], "");
                let text = match &tag.std {
                    Some(StandardTag::Lyrics(text)) => Some(text.to_string()),
                    _ if key == "lyrics" || key == "unsyncedlyrics" => {
                        Some(tag.raw.value.to_string())
                    }
                    _ => None,
                };
                if let Some(text) =
                    text.filter(|v| !v.trim().is_empty() && v.len() <= 8 * 1024 * 1024)
                {
                    result = Some(text);
                }
            }
        }
        if metadata.is_latest() {
            break;
        }
        metadata.pop();
    }
    result
}

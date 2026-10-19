use std::fs::File;
use std::path::Path;

use symphonia::core::formats::probe::Hint;
use symphonia::core::formats::{FormatOptions, FormatReader};
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::{MetadataOptions, StandardVisualKey, Visual};

/// 文件内嵌的封面图：`mime` 由图片头判定，`data` 为原始图片字节。
#[derive(Debug, Clone)]
pub struct Cover {
    pub mime: String,
    pub data: Vec<u8>,
}

/// 读取内嵌的封面；没有封面或文件无法解析时返回 `None`。
pub fn read_cover(path: &Path) -> Option<Cover> {
    if path
        .extension()
        .is_some_and(|v| v.eq_ignore_ascii_case("ncm"))
    {
        return crate::ncm::NcmReader::open(path).ok()?.cover;
    }
    let file = File::open(path).ok()?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }
    let mut format = symphonia::default::get_probe()
        .probe(
            &hint,
            mss,
            FormatOptions::default(),
            MetadataOptions::default(),
        )
        .ok()?;
    pick_cover(format.as_mut())
}

/// 正面封面优先；同类之间后出现的版本覆盖先出现的版本。
fn pick_cover(format: &mut dyn FormatReader) -> Option<Cover> {
    let mut best: Option<(bool, Cover)> = None;
    let mut meta = format.metadata();
    loop {
        if let Some(rev) = meta.current() {
            for visual in &rev.media.visuals {
                if visual.data.is_empty() {
                    continue;
                }
                let front = visual.usage == Some(StandardVisualKey::FrontCover);
                let keep_front = best.as_ref().is_some_and(|(was_front, _)| *was_front) && !front;
                if !keep_front {
                    best = Some((front, to_cover(visual)));
                }
            }
        }
        if meta.is_latest() {
            break;
        }
        meta.pop();
    }
    best.map(|(_, cover)| cover)
}

fn to_cover(visual: &Visual) -> Cover {
    let mime = sniff_mime(&visual.data)
        .map(str::to_owned)
        .or_else(|| visual.media_type.clone())
        .unwrap_or_else(|| "application/octet-stream".to_owned());
    Cover {
        mime,
        data: visual.data.to_vec(),
    }
}

/// 只看图片头，不信任标签里可能写错的 MIME。
pub fn sniff_mime(data: &[u8]) -> Option<&'static str> {
    match data {
        [0xFF, 0xD8, 0xFF, ..] => Some("image/jpeg"),
        [0x89, b'P', b'N', b'G', ..] => Some("image/png"),
        [b'G', b'I', b'F', b'8', ..] => Some("image/gif"),
        [
            b'R',
            b'I',
            b'F',
            b'F',
            _,
            _,
            _,
            _,
            b'W',
            b'E',
            b'B',
            b'P',
            ..,
        ] => Some("image/webp"),
        [b'B', b'M', ..] => Some("image/bmp"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::sniff_mime;

    #[test]
    fn recognises_common_image_headers() {
        assert_eq!(sniff_mime(&[0xFF, 0xD8, 0xFF, 0xE0]), Some("image/jpeg"));
        assert_eq!(sniff_mime(b"\x89PNG\r\n\x1a\n"), Some("image/png"));
        assert_eq!(
            sniff_mime(b"RIFF\x00\x00\x00\x00WEBPVP8 "),
            Some("image/webp")
        );
        assert_eq!(sniff_mime(b"not an image"), None);
    }
}

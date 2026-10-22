//! Stable virtual paths identify a subsong without extracting or copying its image.
use crate::{AudioSource, DecodeError, Result, cd, sacd};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use jap_core::TrackInfo;
use std::path::{Path, PathBuf};

const PREFIX: &str = "jap-disc://";

pub fn track_path(path: &Path, track: usize) -> String {
    format!(
        "{PREFIX}{}/{track}",
        URL_SAFE_NO_PAD.encode(path.to_string_lossy().as_bytes())
    )
}

pub fn parse(path: &Path) -> Result<Option<(PathBuf, usize)>> {
    let Some(value) = path.to_str().and_then(|v| v.strip_prefix(PREFIX)) else {
        return Ok(None);
    };
    let invalid = || DecodeError::Decode("光盘曲目地址无效".into());
    let (encoded, index) = value.rsplit_once('/').ok_or_else(invalid)?;
    let track = index
        .parse::<usize>()
        .ok()
        .filter(|n| (1..=255).contains(n))
        .ok_or_else(invalid)?;
    let bytes = URL_SAFE_NO_PAD.decode(encoded).map_err(|_| invalid())?;
    let source = String::from_utf8(bytes).map_err(|_| invalid())?;
    if source.starts_with(PREFIX) || source.contains('\0') {
        return Err(invalid());
    }
    Ok(Some((PathBuf::from(source), track)))
}

pub fn source_path(path: &Path) -> Result<PathBuf> {
    Ok(parse(path)?.map_or_else(|| path.to_path_buf(), |(p, _)| p))
}

pub(crate) fn open(path: &Path, track: Option<usize>) -> Result<Box<dyn AudioSource>> {
    if sacd::is_sacd(path)? {
        return Ok(Box::new(sacd::open_track(path, track)?));
    }
    Ok(Box::new(cd::CdSource::open_track(path, track)?))
}

/// The TOC is small. Listing never decodes the audio or reads the entire ISO.
pub fn tracks(path: &Path) -> Result<Vec<TrackInfo>> {
    if let Some((source, track)) = parse(path)? {
        return Ok(vec![open(&source, Some(track))?.info().clone()]);
    }
    if sacd::is_sacd(path)? {
        sacd::tracks(path)
    } else {
        cd::tracks(path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unicode_paths_roundtrip_and_invalid_addresses_fail() {
        let path = Path::new("D:/音乐/名字 #1.iso");
        assert_eq!(
            parse(Path::new(&track_path(path, 20))).unwrap(),
            Some((path.into(), 20))
        );
        for value in ["jap-disc://x/0", "jap-disc://abc/256", "jap-disc://!/1"] {
            assert!(parse(Path::new(value)).is_err());
        }
    }
}

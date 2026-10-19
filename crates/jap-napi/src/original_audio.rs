use napi_derive::napi;
use std::{fs::File, path::Path};

/// Unwrap encryption only, preserving the original codec bytes.
#[napi]
pub fn unwrap_original_audio(source: String, target: String) -> napi::Result<()> {
    let mut input = jap_decode::NcmReader::open(Path::new(&source))
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let mut output =
        File::create_new(target).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    std::io::copy(&mut input, &mut output).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    Ok(())
}

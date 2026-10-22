use napi::bindgen_prelude::Float32Array;
use napi_derive::napi;
#[napi]
pub struct OfflineRender {
    inner: jap_engine::OfflineRender,
}
#[napi]
impl OfflineRender {
    #[napi(constructor)]
    pub fn new(
        path: String,
        audio_path: String,
        start_ms: u32,
        soundfont: Option<String>,
        midi_rate: Option<u32>,
    ) -> napi::Result<Self> {
        let render = if let Some(rate) = midi_rate {
            jap_engine::OfflineRender::new_with_midi(path, audio_path, start_ms, soundfont, rate)
        } else {
            jap_engine::OfflineRender::new(path, audio_path, start_ms)
        };
        render
            .map(|inner| Self { inner })
            .map_err(napi::Error::from_reason)
    }
    #[napi]
    pub fn frame_at(&mut self, relative_ms: f64) -> napi::Result<Float32Array> {
        self.inner
            .frame_at(relative_ms)
            .map(Float32Array::new)
            .map_err(napi::Error::from_reason)
    }
    #[napi]
    pub fn close(&mut self) -> napi::Result<()> {
        self.inner.close().map_err(napi::Error::from_reason)
    }
}

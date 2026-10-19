use jap_core::{DeviceInfo, OutputApi, StreamConfig};

use crate::backend::{OpenRequest, OpenedStream, OutputBackend, RenderSource};
use crate::capture::CaptureBackend;
use crate::error::OutputError;
use crate::error::Result;

/// Platform-native audio outputs; `Null` consumes at real-time pace without sound.
pub struct SystemBackend;

impl OutputBackend for SystemBackend {
    fn set_hardware_volume(
        &self,
        api: OutputApi,
        device_id: Option<&str>,
        gain: f32,
    ) -> Result<bool> {
        #[cfg(windows)]
        if api == OutputApi::WasapiExclusive {
            return crate::wasapi_backend::set_hardware_volume(device_id, gain);
        }
        let _ = (api, device_id, gain);
        Ok(false)
    }
    fn list_devices(&self, api: OutputApi) -> Result<Vec<DeviceInfo>> {
        match api {
            #[cfg(windows)]
            OutputApi::Asio => crate::asio_backend::list_devices(),
            #[cfg(windows)]
            OutputApi::WasapiShared | OutputApi::WasapiExclusive => {
                crate::wasapi_backend::list_devices()
            }
            OutputApi::Null => Ok(Vec::new()),
            #[cfg(any(target_os = "macos", target_os = "linux"))]
            OutputApi::CoreAudio
            | OutputApi::CoreAudioExclusive
            | OutputApi::AlsaShared
            | OutputApi::AlsaExclusive => crate::portable_backend::list_devices(api),
            other => Err(OutputError::UnsupportedApi(other)),
        }
    }

    fn probe_exclusive(&self, device_id: Option<&str>) -> Result<Vec<StreamConfig>> {
        #[cfg(windows)]
        {
            crate::wasapi_backend::probe_exclusive(device_id)
        }
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        {
            crate::portable_backend::probe_exclusive(device_id)
        }
        #[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
        {
            let _ = device_id;
            Err(OutputError::UnsupportedApi(OutputApi::WasapiExclusive))
        }
    }

    fn open(&self, request: &OpenRequest, source: Box<dyn RenderSource>) -> Result<OpenedStream> {
        match request.api {
            #[cfg(windows)]
            OutputApi::Asio => crate::asio_backend::open(request, source),
            #[cfg(windows)]
            OutputApi::WasapiShared | OutputApi::WasapiExclusive => {
                crate::wasapi_backend::open(request, source)
            }
            OutputApi::Null => CaptureBackend::new(true).discarding().open(request, source),
            #[cfg(target_os = "linux")]
            OutputApi::AlsaExclusive => crate::alsa_backend::open(request, source),
            #[cfg(any(target_os = "macos", target_os = "linux"))]
            OutputApi::CoreAudio | OutputApi::CoreAudioExclusive | OutputApi::AlsaShared => {
                crate::portable_backend::open(request, source)
            }
            other => {
                let _ = source;
                Err(OutputError::UnsupportedApi(other))
            }
        }
    }
}

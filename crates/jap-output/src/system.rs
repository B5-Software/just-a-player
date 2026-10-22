use jap_core::{DeviceInfo, OutputApi, StreamConfig};

use crate::backend::{OpenRequest, OpenedStream, OutputBackend, RenderSource};
use crate::capture::CaptureBackend;
use crate::error::OutputError;
use crate::error::Result;

/// Platform-native audio outputs; `Null` consumes at real-time pace without sound.
pub struct SystemBackend;

impl OutputBackend for SystemBackend {
    fn probe_formats(&self, api: OutputApi, device_id: Option<&str>) -> Result<Vec<StreamConfig>> {
        match api {
            #[cfg(target_env = "ohos")]
            OutputApi::OhosShared | OutputApi::UsbExclusive => {
                crate::ohos::probe_formats(api, device_id)
            }
            #[cfg(windows)]
            OutputApi::Asio => crate::asio_backend::probe_formats(device_id),
            #[cfg(windows)]
            OutputApi::WasapiShared => crate::wasapi_backend::probe_shared(device_id),
            #[cfg(target_os = "android")]
            OutputApi::AndroidShared => crate::android::probe_shared(),
            OutputApi::Null => Ok(Vec::new()),
            _ => self.probe_exclusive(device_id),
        }
    }
    fn set_hardware_volume(
        &self,
        api: OutputApi,
        device_id: Option<&str>,
        gain: f32,
    ) -> Result<bool> {
        #[cfg(target_os = "android")]
        if api == OutputApi::UsbExclusive {
            return crate::android::set_hardware_volume(device_id, gain);
        }
        #[cfg(windows)]
        if api == OutputApi::WasapiExclusive {
            return crate::wasapi_backend::set_hardware_volume(device_id, gain);
        }
        #[cfg(target_env = "ohos")]
        if api == OutputApi::UsbExclusive {
            return crate::ohos::set_hardware_volume(device_id, gain);
        }
        let _ = (api, device_id, gain);
        Ok(false)
    }
    fn list_devices(&self, api: OutputApi) -> Result<Vec<DeviceInfo>> {
        match api {
            #[cfg(target_env = "ohos")]
            OutputApi::OhosShared | OutputApi::UsbExclusive => crate::ohos::list_devices(api),
            #[cfg(target_os = "android")]
            OutputApi::AndroidShared | OutputApi::UsbExclusive => crate::android::list_devices(api),
            #[cfg(windows)]
            OutputApi::Asio => crate::asio_backend::list_devices(),
            #[cfg(windows)]
            OutputApi::WasapiShared | OutputApi::WasapiExclusive => {
                crate::wasapi_backend::list_devices()
            }
            OutputApi::Null => Ok(Vec::new()),
            #[cfg(any(
                target_os = "macos",
                all(target_os = "linux", not(target_env = "ohos"))
            ))]
            OutputApi::CoreAudio
            | OutputApi::CoreAudioExclusive
            | OutputApi::AlsaShared
            | OutputApi::AlsaExclusive => crate::portable_backend::list_devices(api),
            other => Err(OutputError::UnsupportedApi(other)),
        }
    }

    fn probe_exclusive(&self, device_id: Option<&str>) -> Result<Vec<StreamConfig>> {
        #[cfg(target_env = "ohos")]
        {
            crate::ohos::probe_formats(OutputApi::UsbExclusive, device_id)
        }
        #[cfg(target_os = "android")]
        {
            crate::android::probe(device_id)
        }
        #[cfg(windows)]
        {
            crate::wasapi_backend::probe_exclusive(device_id)
        }
        #[cfg(any(
            target_os = "macos",
            all(target_os = "linux", not(target_env = "ohos"))
        ))]
        {
            crate::portable_backend::probe_exclusive(device_id)
        }
        #[cfg(not(any(
            windows,
            target_os = "macos",
            target_os = "linux",
            target_os = "android"
        )))]
        {
            let _ = device_id;
            Err(OutputError::UnsupportedApi(OutputApi::WasapiExclusive))
        }
    }

    fn open(&self, request: &OpenRequest, source: Box<dyn RenderSource>) -> Result<OpenedStream> {
        match request.api {
            #[cfg(target_env = "ohos")]
            OutputApi::OhosShared | OutputApi::UsbExclusive => crate::ohos::open(request, source),
            #[cfg(target_os = "android")]
            OutputApi::AndroidShared | OutputApi::UsbExclusive => {
                crate::android::open(request, source)
            }
            #[cfg(windows)]
            OutputApi::Asio => crate::asio_backend::open(request, source),
            #[cfg(windows)]
            OutputApi::WasapiShared | OutputApi::WasapiExclusive => {
                crate::wasapi_backend::open(request, source)
            }
            OutputApi::Null => CaptureBackend::new(true).discarding().open(request, source),
            #[cfg(all(target_os = "linux", not(target_env = "ohos")))]
            OutputApi::AlsaExclusive => crate::alsa_backend::open(request, source),
            #[cfg(any(
                target_os = "macos",
                all(target_os = "linux", not(target_env = "ohos"))
            ))]
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

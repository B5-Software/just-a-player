//! A process-local DirectSound black-hole device. This DLL never opens an audio
//! endpoint, loads an audio driver, or sends samples to a physical device.
//! Its COM objects stay native and valid even if the instrumentation detaches.
#[cfg(windows)]
mod direct_sound;

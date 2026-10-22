//! RAII Hog ownership and physical format verification. Only our selected device is changed.
use crate::{OutputError, Result};
use jap_core::StreamConfig;
use std::{
    ffi::{CString, c_void},
    mem::size_of,
    ptr,
};
#[repr(C)]
struct Address {
    selector: u32,
    scope: u32,
    element: u32,
}
#[repr(C)]
#[derive(Clone, Copy, Default)]
struct Asbd {
    rate: f64,
    format: u32,
    flags: u32,
    packet_bytes: u32,
    frames_per_packet: u32,
    frame_bytes: u32,
    channels: u32,
    bits: u32,
    reserved: u32,
}
#[link(name = "CoreAudio", kind = "framework")]
unsafe extern "C" {
    fn AudioObjectGetPropertyData(
        object: u32,
        address: *const Address,
        qualifier_size: u32,
        qualifier: *const c_void,
        size: *mut u32,
        data: *mut c_void,
    ) -> i32;
    fn AudioObjectSetPropertyData(
        object: u32,
        address: *const Address,
        qualifier_size: u32,
        qualifier: *const c_void,
        size: u32,
        data: *const c_void,
    ) -> i32;
}
#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    fn CFStringCreateWithCString(
        allocator: *const c_void,
        text: *const i8,
        encoding: u32,
    ) -> *const c_void;
    fn CFRelease(value: *const c_void);
}
fn address(selector: u32, scope: u32) -> Address {
    Address {
        selector,
        scope,
        element: 0,
    }
}
fn get<T: Default>(object: u32, selector: u32, scope: u32) -> Result<T> {
    let mut value = T::default();
    let mut size = size_of::<T>() as u32;
    // SAFETY: callers use the CoreAudio type corresponding to this property.
    let status = unsafe {
        AudioObjectGetPropertyData(
            object,
            &address(selector, scope),
            0,
            ptr::null(),
            &mut size,
            (&mut value as *mut T).cast(),
        )
    };
    if status != 0 || size != size_of::<T>() as u32 {
        return Err(OutputError::Backend(format!(
            "CoreAudio 属性查询失败 {status}"
        )));
    }
    Ok(value)
}
fn set<T>(object: u32, selector: u32, value: &T) -> Result<()> {
    // SAFETY: value lives for the synchronous property operation, and has the property's ABI type.
    let status = unsafe {
        AudioObjectSetPropertyData(
            object,
            &address(selector, u32::from_be_bytes(*b"glob")),
            0,
            ptr::null(),
            size_of::<T>() as u32,
            (value as *const T).cast(),
        )
    };
    if status == 0 {
        Ok(())
    } else {
        Err(OutputError::Backend(format!(
            "CoreAudio 属性设置失败 {status}"
        )))
    }
}
pub(crate) struct HogGuard {
    device: u32,
    stream: u32,
    original: Asbd,
}
impl HogGuard {
    pub(crate) fn acquire(uid: &str) -> Result<Self> {
        let uid = CString::new(uid).map_err(|_| OutputError::DeviceNotFound)?;
        // SAFETY: CF retains a copy of the terminated UTF-8 UID; release it after translation.
        let cf = unsafe { CFStringCreateWithCString(ptr::null(), uid.as_ptr(), 0x08000100) };
        if cf.is_null() {
            return Err(OutputError::DeviceNotFound);
        }
        let mut device = 0u32;
        let mut size = 4;
        // kAudioHardwarePropertyTranslateUIDToDevice uses a CFStringRef qualifier.
        let status = unsafe {
            AudioObjectGetPropertyData(
                1,
                &address(u32::from_be_bytes(*b"uidd"), u32::from_be_bytes(*b"glob")),
                size_of::<*const c_void>() as u32,
                (&cf as *const *const c_void).cast(),
                &mut size,
                (&mut device as *mut u32).cast(),
            )
        };
        unsafe { CFRelease(cf) };
        if status != 0 || device == 0 {
            return Err(OutputError::DeviceNotFound);
        }
        let owner: i32 = get(
            device,
            u32::from_be_bytes(*b"oink"),
            u32::from_be_bytes(*b"glob"),
        )?;
        let pid = std::process::id() as i32;
        if owner != -1 && owner != pid {
            return Err(OutputError::DeviceBusy);
        }
        // First output stream; normal interleaved USB DACs have a single stream.
        // A scalar get is intentionally strict: multi-stream devices need a different path.
        let stream: u32 = get(
            device,
            u32::from_be_bytes(*b"stm#"),
            u32::from_be_bytes(*b"outp"),
        )?;
        let original: Asbd = get(
            stream,
            u32::from_be_bytes(*b"pft "),
            u32::from_be_bytes(*b"glob"),
        )?;
        let guard = Self {
            device,
            stream,
            original,
        };
        set(device, u32::from_be_bytes(*b"oink"), &pid)?;
        let owner: i32 = get(
            device,
            u32::from_be_bytes(*b"oink"),
            u32::from_be_bytes(*b"glob"),
        )?;
        if owner != pid {
            return Err(OutputError::DeviceBusy);
        }
        Ok(guard)
    }
    pub(crate) fn accepts(&self, config: StreamConfig) -> bool {
        let Ok(physical) = get::<Asbd>(
            self.stream,
            u32::from_be_bytes(*b"pft "),
            u32::from_be_bytes(*b"glob"),
        ) else {
            return false;
        };
        let float = physical.flags & 1 != 0;
        physical.format == u32::from_be_bytes(*b"lpcm")
            && (physical.rate - config.sample_rate as f64).abs() < 0.5
            && physical.channels == config.channels as u32
            && physical.bits >= config.format.valid_bits()
            && float == config.format.is_float()
    }
}
impl Drop for HogGuard {
    fn drop(&mut self) {
        let pid = std::process::id() as i32;
        if get::<i32>(
            self.device,
            u32::from_be_bytes(*b"oink"),
            u32::from_be_bytes(*b"glob"),
        )
        .ok()
            == Some(pid)
        {
            let _ = set(self.stream, u32::from_be_bytes(*b"pft "), &self.original);
            let _ = set(self.device, u32::from_be_bytes(*b"oink"), &-1i32);
        }
    }
}

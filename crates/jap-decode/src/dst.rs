use crate::{DecodeError, Result};
use std::{ffi::c_void, ptr::NonNull, sync::Mutex};
static INIT: Mutex<()> = Mutex::new(());
unsafe extern "C" {
    fn dst_decoder_new(channels: u32, frame_size: u32) -> *mut c_void;
    fn dst_decoder_free(handle: *mut c_void);
    fn dst_decoder_decode(
        handle: *mut c_void,
        data: *const u8,
        len: usize,
        out: *mut u8,
        out_len: usize,
    ) -> i32;
}
pub struct DstDecoder {
    ptr: NonNull<c_void>,
    len: usize,
}
// SAFETY: A decoder is owned by one audio producer and never called concurrently.
unsafe impl Send for DstDecoder {}
impl DstDecoder {
    pub fn new(channels: u32) -> Result<Self> {
        let _lock = INIT
            .lock()
            .map_err(|_| DecodeError::Decode("DST init lock".into()))?;
        // SAFETY: validated channels, fixed SACD64 frame size; protects native static initialization.
        let ptr = NonNull::new(unsafe { dst_decoder_new(channels, 4704) })
            .ok_or_else(|| DecodeError::Decode("DST allocation".into()))?;
        Ok(Self {
            ptr,
            len: channels as usize * 4704,
        })
    }
    pub fn decode(&mut self, data: &[u8]) -> Result<Vec<u8>> {
        if data.is_empty() || data.len() > 65536 {
            return Err(DecodeError::Decode("DST frame bounds".into()));
        }
        let mut out = vec![0; self.len];
        // SAFETY: both pointers remain valid through this synchronous call and lengths match allocations.
        if unsafe {
            dst_decoder_decode(
                self.ptr.as_ptr(),
                data.as_ptr(),
                data.len(),
                out.as_mut_ptr(),
                out.len(),
            )
        } != 0
        {
            return Err(DecodeError::Decode("损坏的 DST 帧".into()));
        }
        Ok(out)
    }
}
impl Drop for DstDecoder {
    fn drop(&mut self) {
        unsafe { dst_decoder_free(self.ptr.as_ptr()) }
    }
}

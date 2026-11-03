use std::cell::UnsafeCell;
use std::ffi::c_void;
use std::ptr::{self, null_mut};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, Once};
use std::time::{Duration, Instant};
use windows::Win32::Foundation::HANDLE;
use windows::Win32::System::Threading::SetEvent;
use windows::core::GUID;

type Hr = i32;
const INVALID: Hr = 0x80070057u32 as i32;
const NO_INTERFACE: Hr = 0x80004002u32 as i32;
const UNSUPPORTED: Hr = 0x80004001u32 as i32;
const MAX_BUFFER: usize = 64 * 1024 * 1024;
const DEVICE: GUID = GUID::from_u128(0xb5530f8d_4c93_48d6_a002_b55a00000001);
const UNKNOWN: GUID = GUID::from_u128(0x00000000_0000_0000_c000_000000000046);
const DS: GUID = GUID::from_u128(0x279afa83_4981_11ce_a521_0020af0be560);
const DS8: GUID = GUID::from_u128(0xc50a7e93_f395_4834_9ef6_7fa99de50966);
const BUFFER: GUID = GUID::from_u128(0x279afa85_4981_11ce_a521_0020af0be560);
const BUFFER8: GUID = GUID::from_u128(0x6825a449_7524_4d82_920f_50e36ab3ab1e);
const NOTIFY: GUID = GUID::from_u128(0xb0210783_89cd_11d0_af08_00a0c925cd16);
static BUFFERS: AtomicU32 = AtomicU32::new(0);
static DISCARDED: AtomicU64 = AtomicU64::new(0);
static DIAGNOSTICS: Once = Once::new();

#[repr(transparent)]
struct VTable<const N: usize>([*const (); N]);
// Immutable native function-pointer tables, shared by all COM objects.
unsafe impl<const N: usize> Sync for VTable<N> {}

#[repr(C)]
struct Device {
    vtable: *const VTable<12>,
    refs: AtomicU32,
}
#[repr(C)]
struct Notification {
    vtable: *const VTable<4>,
}
#[derive(Clone)]
struct Format {
    raw: Vec<u8>,
    rate: u32,
    align: u32,
    bytes_per_second: u64,
}
impl Default for Format {
    fn default() -> Self {
        let mut raw = vec![0; 18];
        raw[0..2].copy_from_slice(&1u16.to_le_bytes());
        raw[2..4].copy_from_slice(&2u16.to_le_bytes());
        raw[4..8].copy_from_slice(&48000u32.to_le_bytes());
        raw[8..12].copy_from_slice(&384000u32.to_le_bytes());
        raw[12..14].copy_from_slice(&8u16.to_le_bytes());
        raw[14..16].copy_from_slice(&32u16.to_le_bytes());
        Self {
            raw,
            rate: 48000,
            align: 8,
            bytes_per_second: 384000,
        }
    }
}
#[repr(C)]
struct Description {
    size: u32,
    flags: u32,
    bytes: u32,
    reserved: u32,
    format: *const u8,
    algorithm: GUID,
}
#[repr(C)]
#[derive(Clone, Copy)]
struct NotifyPosition {
    offset: u32,
    event: HANDLE,
}
// Only the integer HANDLE crosses threads. It remains owned by the caller.
unsafe impl Send for NotifyPosition {}
struct State {
    format: Format,
    flags: u32,
    volume: i32,
    pan: i32,
    frequency: u32,
    playing: bool,
    looping: bool,
    offset: u64,
    epoch: Instant,
    notify: Vec<NotifyPosition>,
}
impl State {
    fn counter(&self, len: usize) -> u64 {
        let extra = if self.playing {
            (self.epoch.elapsed().as_nanos()
                * u128::from(self.format.bytes_per_second)
                * u128::from(self.frequency)
                / u128::from(self.format.rate)
                / 1_000_000_000) as u64
        } else {
            0
        };
        let at = self
            .offset
            .saturating_add(extra / u64::from(self.format.align) * u64::from(self.format.align));
        if self.looping { at } else { at.min(len as u64) }
    }
    fn freeze(&mut self, len: usize) {
        self.offset = self.counter(len);
        self.epoch = Instant::now();
    }
}
#[repr(C)]
struct SoundBuffer {
    vtable: *const VTable<24>,
    refs: AtomicU32,
    notify_interface: Notification,
    state: Mutex<State>,
    data: Box<[UnsafeCell<u8>]>,
    worker: AtomicBool,
}
// Sample memory is exposed exclusively through the DirectSound Lock/Unlock
// contract; this black-hole implementation never reads it from Rust.
unsafe impl Send for SoundBuffer {}
unsafe impl Sync for SoundBuffer {}
impl Drop for SoundBuffer {
    fn drop(&mut self) {
        BUFFERS.fetch_sub(1, Ordering::Relaxed);
    }
}

unsafe fn format(p: *const u8) -> Result<Format, Hr> {
    // SAFETY: COM callers supply a valid WAVEFORMATEX and its cbSize payload.
    unsafe {
        if p.is_null() {
            return Ok(Format::default());
        }
        let w = std::slice::from_raw_parts(p, 16);
        let u16at = |i| u16::from_le_bytes([w[i], w[i + 1]]);
        let rate = u32::from_le_bytes(w[4..8].try_into().unwrap());
        let channels = u16at(2);
        let bits = u16at(14);
        let align = u16at(12);
        let tag = u16at(0);
        // PCM callers may provide the 16-byte PCMWAVEFORMAT; cbSize is ignored.
        let extra = if tag == 1 {
            0
        } else {
            u16::from_le_bytes([*p.add(16), *p.add(17)]) as usize
        };
        if !(8000..=12_288_000).contains(&rate)
            || !(1..=8).contains(&channels)
            || ![8, 16, 24, 32, 64].contains(&bits)
            || align != channels * (bits / 8)
            || ![1, 3, 0xfffe].contains(&tag)
            || extra > 64
        {
            return Err(INVALID);
        }
        if tag == 0xfffe && extra < 22 {
            return Err(INVALID);
        }
        if tag == 3 && ![32, 64].contains(&bits) {
            return Err(INVALID);
        }
        let mut raw = w.to_vec();
        raw.extend_from_slice(&(extra as u16).to_le_bytes());
        if extra > 0 {
            raw.extend_from_slice(std::slice::from_raw_parts(p.add(18), extra));
        }
        Ok(Format {
            raw,
            rate,
            align: u32::from(align),
            bytes_per_second: u64::from(rate) * u64::from(align),
        })
    }
}

unsafe extern "system" fn device_query(
    p: *mut Device,
    iid: *const GUID,
    out: *mut *mut c_void,
) -> Hr {
    unsafe {
        if out.is_null() || iid.is_null() {
            return INVALID;
        }
        *out = null_mut();
        if [UNKNOWN, DS, DS8].contains(&*iid) {
            device_add(p);
            *out = p.cast();
            0
        } else {
            NO_INTERFACE
        }
    }
}
unsafe extern "system" fn device_add(p: *mut Device) -> u32 {
    unsafe { (*p).refs.fetch_add(1, Ordering::Relaxed) + 1 }
}
unsafe extern "system" fn device_release(p: *mut Device) -> u32 {
    unsafe {
        let n = (*p).refs.fetch_sub(1, Ordering::AcqRel) - 1;
        if n == 0 {
            drop(Box::from_raw(p));
        }
        n
    }
}
unsafe extern "system" fn create_buffer(
    _: *mut Device,
    desc: *const Description,
    out: *mut *mut SoundBuffer,
    outer: *mut c_void,
) -> Hr {
    unsafe {
        if desc.is_null() || out.is_null() || !outer.is_null() {
            return INVALID;
        }
        *out = null_mut();
        let d = &*desc;
        if d.size < 24 || d.bytes as usize > MAX_BUFFER {
            return INVALID;
        }
        let f = match format(d.format) {
            Ok(f) => f,
            Err(e) => return e,
        };
        let size = if d.flags & 1 != 0 && d.bytes == 0 {
            4096
        } else {
            d.bytes as usize
        };
        if size == 0 || size % f.align as usize != 0 {
            return INVALID;
        }
        let rate = f.rate;
        let b = Arc::new(SoundBuffer {
            vtable: &BUFFER_TABLE,
            refs: AtomicU32::new(1),
            notify_interface: Notification {
                vtable: &NOTIFY_TABLE,
            },
            state: Mutex::new(State {
                format: f,
                flags: d.flags,
                volume: 0,
                pan: 0,
                frequency: rate,
                playing: false,
                looping: false,
                offset: 0,
                epoch: Instant::now(),
                notify: Vec::new(),
            }),
            data: (0..size).map(|_| UnsafeCell::new(0)).collect(),
            worker: AtomicBool::new(false),
        });
        BUFFERS.fetch_add(1, Ordering::Relaxed);
        *out = Arc::into_raw(b).cast_mut();
        0
    }
}
unsafe extern "system" fn device_caps(_: *mut Device, out: *mut u32) -> Hr {
    unsafe {
        if out.is_null() || *out < 96 {
            return INVALID;
        }
        let size = *out;
        ptr::write_bytes(out, 0, 24);
        *out = size;
        *out.add(1) = 0x1 | 0x2 | 0x4 | 0x8 | 0x10 | 0x20 | 0x100 | 0x200 | 0x400 | 0x800;
        *out.add(2) = 8000;
        *out.add(3) = 12_288_000;
        *out.add(4) = 1;
        0
    }
}
unsafe extern "system" fn duplicate(
    p: *mut Device,
    source: *mut SoundBuffer,
    out: *mut *mut SoundBuffer,
) -> Hr {
    unsafe {
        if source.is_null() {
            return INVALID;
        }
        let b = &*source;
        let s = b.state.lock().unwrap();
        let desc = Description {
            size: std::mem::size_of::<Description>() as u32,
            flags: s.flags,
            bytes: b.data.len() as u32,
            reserved: 0,
            format: s.format.raw.as_ptr(),
            algorithm: GUID::zeroed(),
        };
        create_buffer(p, &desc, out, null_mut())
    }
}
unsafe extern "system" fn cooperative(_: *mut Device, _: *mut c_void, _: u32) -> Hr {
    0
}
unsafe extern "system" fn device_ok(_: *mut Device) -> Hr {
    0
}
unsafe extern "system" fn speaker(_: *mut Device, out: *mut u32) -> Hr {
    unsafe {
        if out.is_null() {
            return INVALID;
        }
        *out = 4;
        0
    }
}
unsafe extern "system" fn set_speaker(_: *mut Device, _: u32) -> Hr {
    0
}
unsafe extern "system" fn initialize(_: *mut Device, _: *const GUID) -> Hr {
    0
}
unsafe extern "system" fn certified(_: *mut Device, out: *mut u32) -> Hr {
    unsafe {
        if out.is_null() {
            return INVALID;
        }
        *out = 2; // DS_UNCERTIFIED: this is a process-local software sink.
        0
    }
}

unsafe extern "system" fn buffer_query(
    p: *mut SoundBuffer,
    iid: *const GUID,
    out: *mut *mut c_void,
) -> Hr {
    unsafe {
        if out.is_null() || iid.is_null() {
            return INVALID;
        }
        *out = null_mut();
        if [UNKNOWN, BUFFER, BUFFER8].contains(&*iid) {
            buffer_add(p);
            *out = p.cast();
            0
        } else if *iid == NOTIFY {
            buffer_add(p);
            *out = ptr::addr_of_mut!((*p).notify_interface).cast();
            0
        } else {
            NO_INTERFACE
        }
    }
}
unsafe extern "system" fn buffer_add(p: *mut SoundBuffer) -> u32 {
    unsafe { (*p).refs.fetch_add(1, Ordering::Relaxed) + 1 }
}
unsafe extern "system" fn buffer_release(p: *mut SoundBuffer) -> u32 {
    unsafe {
        let n = (*p).refs.fetch_sub(1, Ordering::AcqRel) - 1;
        if n == 0 {
            // COM reports only the client's references. The clock holds a
            // separate Arc, so a caller releasing down to zero cannot destroy
            // memory still in use by that thread.
            (*p).state.lock().unwrap().playing = false;
            drop(Arc::from_raw(p));
        }
        n
    }
}
unsafe extern "system" fn buffer_caps(p: *mut SoundBuffer, out: *mut u32) -> Hr {
    unsafe {
        if out.is_null() || *out < 20 {
            return INVALID;
        }
        let b = &*p;
        let s = b.state.lock().unwrap();
        *out.add(1) = s.flags;
        *out.add(2) = b.data.len() as u32;
        *out.add(3) = 0;
        *out.add(4) = 0;
        0
    }
}
unsafe extern "system" fn position(p: *mut SoundBuffer, play: *mut u32, write: *mut u32) -> Hr {
    unsafe {
        let b = &*p;
        let s = b.state.lock().unwrap();
        let len = b.data.len() as u64;
        let at = s.counter(b.data.len()) % len;
        if !play.is_null() {
            *play = at as u32;
        }
        if !write.is_null() {
            *write = ((at + len / 4 / u64::from(s.format.align) * u64::from(s.format.align)) % len)
                as u32;
        }
        0
    }
}
unsafe extern "system" fn get_format(
    p: *mut SoundBuffer,
    out: *mut u8,
    size: u32,
    written: *mut u32,
) -> Hr {
    unsafe {
        let s = (*p).state.lock().unwrap();
        if !written.is_null() {
            *written = s.format.raw.len() as u32;
        }
        if out.is_null() {
            return if !written.is_null() { 0 } else { INVALID };
        }
        if (size as usize) < s.format.raw.len() {
            return INVALID;
        }
        ptr::copy_nonoverlapping(s.format.raw.as_ptr(), out, s.format.raw.len());
        0
    }
}
unsafe extern "system" fn volume(p: *mut SoundBuffer, out: *mut i32) -> Hr {
    unsafe {
        if out.is_null() {
            return INVALID;
        }
        *out = (*p).state.lock().unwrap().volume;
        0
    }
}
unsafe extern "system" fn pan(p: *mut SoundBuffer, out: *mut i32) -> Hr {
    unsafe {
        if out.is_null() {
            return INVALID;
        }
        *out = (*p).state.lock().unwrap().pan;
        0
    }
}
unsafe extern "system" fn frequency(p: *mut SoundBuffer, out: *mut u32) -> Hr {
    unsafe {
        if out.is_null() {
            return INVALID;
        }
        *out = (*p).state.lock().unwrap().frequency;
        0
    }
}
unsafe extern "system" fn status(p: *mut SoundBuffer, out: *mut u32) -> Hr {
    unsafe {
        if out.is_null() {
            return INVALID;
        }
        let b = &*p;
        let s = b.state.lock().unwrap();
        *out = if s.playing && (s.looping || s.counter(b.data.len()) < b.data.len() as u64) {
            1 | if s.looping { 4 } else { 0 }
        } else {
            0
        };
        0
    }
}
unsafe extern "system" fn buffer_init(
    _: *mut SoundBuffer,
    _: *mut Device,
    _: *const Description,
) -> Hr {
    UNSUPPORTED
}
unsafe extern "system" fn lock(
    p: *mut SoundBuffer,
    mut offset: u32,
    mut count: u32,
    first: *mut *mut c_void,
    first_len: *mut u32,
    second: *mut *mut c_void,
    second_len: *mut u32,
    flags: u32,
) -> Hr {
    unsafe {
        if first.is_null() || first_len.is_null() {
            return INVALID;
        }
        let b = &*p;
        let len = b.data.len() as u32;
        if flags & 2 != 0 {
            offset = 0;
            count = len;
        }
        if flags & 1 != 0 {
            position(p, null_mut(), &mut offset);
        }
        if offset >= len || count > len {
            return INVALID;
        }
        let a = count.min(len - offset);
        let tail = count - a;
        if tail > 0 && (second.is_null() || second_len.is_null()) {
            return INVALID;
        }
        *first = b
            .data
            .as_ptr()
            .cast_mut()
            .cast::<u8>()
            .add(offset as usize)
            .cast();
        *first_len = a;
        if !second.is_null() {
            *second = if tail > 0 {
                b.data.as_ptr().cast_mut().cast()
            } else {
                null_mut()
            };
        }
        if !second_len.is_null() {
            *second_len = tail;
        }
        0
    }
}

unsafe fn start_worker(p: *mut SoundBuffer) {
    unsafe {
        if (*p).worker.swap(true, Ordering::AcqRel) {
            return;
        }
        Arc::increment_strong_count(p);
        let address = p as usize;
        let spawned = std::thread::Builder::new()
            .name("jap-null-clock".into())
            .spawn(move || {
                let p = address as *mut SoundBuffer;
                let b = Arc::from_raw(p);
                let mut before = 0;
                loop {
                    let (playing, now, positions) = {
                        let s = b.state.lock().unwrap();
                        (s.playing, s.counter(b.data.len()), s.notify.clone())
                    };
                    if !playing || b.refs.load(Ordering::Acquire) == 0 {
                        for n in positions {
                            if n.offset == u32::MAX {
                                let _ = SetEvent(n.event);
                            }
                        }
                        break;
                    }
                    let len = b.data.len() as u64;
                    if now < before {
                        before = now;
                    }
                    for n in positions {
                        if n.offset == u32::MAX || u64::from(n.offset) >= len {
                            continue;
                        }
                        let distance = (u64::from(n.offset) + len - before % len) % len;
                        if now.saturating_sub(before) >= if distance == 0 { len } else { distance }
                        {
                            let _ = SetEvent(n.event);
                        }
                    }
                    before = now;
                    std::thread::sleep(Duration::from_millis(2));
                }
                b.worker.store(false, Ordering::Release);
            });
        if spawned.is_err() {
            (*p).worker.store(false, Ordering::Release);
            Arc::decrement_strong_count(p);
        }
    }
}
unsafe extern "system" fn play(p: *mut SoundBuffer, _: u32, _: u32, flags: u32) -> Hr {
    unsafe {
        let b = &*p;
        {
            let mut s = b.state.lock().unwrap();
            if !s.playing {
                s.epoch = Instant::now();
            }
            s.looping = flags & 1 != 0;
            s.playing = true;
        }
        start_worker(p);
        0
    }
}
unsafe extern "system" fn set_position(p: *mut SoundBuffer, offset: u32) -> Hr {
    unsafe {
        let b = &*p;
        if offset as usize >= b.data.len() {
            return INVALID;
        }
        let mut s = b.state.lock().unwrap();
        s.offset = u64::from(offset);
        s.epoch = Instant::now();
        0
    }
}
unsafe extern "system" fn set_format(p: *mut SoundBuffer, f: *const u8) -> Hr {
    unsafe {
        let f = match format(f) {
            Ok(f) => f,
            Err(e) => return e,
        };
        let b = &*p;
        let mut s = b.state.lock().unwrap();
        s.freeze(b.data.len());
        s.frequency = f.rate;
        s.format = f;
        0
    }
}
unsafe extern "system" fn set_volume(p: *mut SoundBuffer, value: i32) -> Hr {
    unsafe {
        if !(-10000..=0).contains(&value) {
            return INVALID;
        }
        (*p).state.lock().unwrap().volume = value;
        0
    }
}
unsafe extern "system" fn set_pan(p: *mut SoundBuffer, value: i32) -> Hr {
    unsafe {
        if !(-10000..=10000).contains(&value) {
            return INVALID;
        }
        (*p).state.lock().unwrap().pan = value;
        0
    }
}
unsafe extern "system" fn set_frequency(p: *mut SoundBuffer, value: u32) -> Hr {
    unsafe {
        let b = &*p;
        let mut s = b.state.lock().unwrap();
        let rate = if value == 0 { s.format.rate } else { value };
        if !(8000..=12_288_000).contains(&rate) {
            return INVALID;
        }
        s.freeze(b.data.len());
        s.frequency = rate;
        0
    }
}
unsafe extern "system" fn stop(p: *mut SoundBuffer) -> Hr {
    unsafe {
        let b = &*p;
        let mut s = b.state.lock().unwrap();
        s.freeze(b.data.len());
        s.playing = false;
        0
    }
}
unsafe extern "system" fn unlock(
    _: *mut SoundBuffer,
    _: *mut c_void,
    a: u32,
    _: *mut c_void,
    b: u32,
) -> Hr {
    DISCARDED.fetch_add(u64::from(a) + u64::from(b), Ordering::Relaxed);
    0
}
unsafe extern "system" fn restore(_: *mut SoundBuffer) -> Hr {
    0
}
unsafe extern "system" fn effects(
    _: *mut SoundBuffer,
    _: u32,
    _: *const c_void,
    _: *mut u32,
) -> Hr {
    UNSUPPORTED
}
unsafe extern "system" fn resources(_: *mut SoundBuffer, _: u32, _: u32, _: *mut u32) -> Hr {
    UNSUPPORTED
}
unsafe extern "system" fn object_path(
    _: *mut SoundBuffer,
    _: *const GUID,
    _: u32,
    _: *const GUID,
    out: *mut *mut c_void,
) -> Hr {
    unsafe {
        if !out.is_null() {
            *out = null_mut();
        }
        NO_INTERFACE
    }
}

unsafe fn owner(p: *mut Notification) -> *mut SoundBuffer {
    unsafe {
        p.cast::<u8>()
            .sub(std::mem::offset_of!(SoundBuffer, notify_interface))
            .cast()
    }
}
unsafe extern "system" fn notify_query(
    p: *mut Notification,
    iid: *const GUID,
    out: *mut *mut c_void,
) -> Hr {
    unsafe { buffer_query(owner(p), iid, out) }
}
unsafe extern "system" fn notify_add(p: *mut Notification) -> u32 {
    unsafe { buffer_add(owner(p)) }
}
unsafe extern "system" fn notify_release(p: *mut Notification) -> u32 {
    unsafe { buffer_release(owner(p)) }
}
unsafe extern "system" fn set_notifications(
    p: *mut Notification,
    count: u32,
    positions: *const NotifyPosition,
) -> Hr {
    unsafe {
        if count > 256 || (count > 0 && positions.is_null()) {
            return INVALID;
        }
        let b = &*owner(p);
        let entries = if count == 0 {
            Vec::new()
        } else {
            std::slice::from_raw_parts(positions, count as usize).to_vec()
        };
        if entries
            .iter()
            .any(|n| n.offset != u32::MAX && n.offset as usize >= b.data.len())
        {
            return INVALID;
        }
        b.state.lock().unwrap().notify = entries;
        0
    }
}

static DEVICE_TABLE: VTable<12> = VTable([
    device_query as _,
    device_add as _,
    device_release as _,
    create_buffer as _,
    device_caps as _,
    duplicate as _,
    cooperative as _,
    device_ok as _,
    speaker as _,
    set_speaker as _,
    initialize as _,
    certified as _,
]);
static BUFFER_TABLE: VTable<24> = VTable([
    buffer_query as _,
    buffer_add as _,
    buffer_release as _,
    buffer_caps as _,
    position as _,
    get_format as _,
    volume as _,
    pan as _,
    frequency as _,
    status as _,
    buffer_init as _,
    lock as _,
    play as _,
    set_position as _,
    set_format as _,
    set_volume as _,
    set_pan as _,
    set_frequency as _,
    stop as _,
    unlock as _,
    restore as _,
    effects as _,
    resources as _,
    object_path as _,
]);
static NOTIFY_TABLE: VTable<4> = VTable([
    notify_query as _,
    notify_add as _,
    notify_release as _,
    set_notifications as _,
]);

/// Factory used only for DEVICE. Never fall back to a physical sound device.
#[unsafe(no_mangle)]
pub unsafe extern "system" fn jap_null_create(
    guid: *const GUID,
    out: *mut *mut c_void,
    outer: *mut c_void,
) -> Hr {
    DIAGNOSTICS.call_once(|| {
        // This DLL has its own Rust runtime. Preserve a diagnostic if a foreign
        // caller violates its COM contract instead of losing the panic text in
        // a GUI process with no console.
        std::panic::set_hook(Box::new(|info| {
            use std::io::Write;
            if let Ok(mut file) = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(std::env::temp_dir().join("just-a-player-null-output.log"))
            {
                let _ = writeln!(
                    file,
                    "{info}\n{}",
                    std::backtrace::Backtrace::force_capture()
                );
            }
        }));
    });
    unsafe {
        if guid.is_null() || out.is_null() || !outer.is_null() {
            return INVALID;
        }
        *out = null_mut();
        if *guid != DEVICE {
            return INVALID;
        }
        *out = Box::into_raw(Box::new(Device {
            vtable: &DEVICE_TABLE,
            refs: AtomicU32::new(1),
        }))
        .cast();
        0
    }
}
#[unsafe(no_mangle)]
pub extern "system" fn jap_null_guid() -> *const GUID {
    &DEVICE
}
#[unsafe(no_mangle)]
pub extern "system" fn jap_null_buffer_count() -> u32 {
    BUFFERS.load(Ordering::Relaxed)
}
#[unsafe(no_mangle)]
pub extern "system" fn jap_null_discarded_bytes() -> u64 {
    DISCARDED.load(Ordering::Relaxed)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn virtual_device_has_a_real_clock_discards_bytes_and_never_needs_an_endpoint() {
        unsafe {
            let mut p = null_mut();
            assert_eq!(jap_null_create(&DEVICE, &mut p, null_mut()), 0);
            let d = p.cast::<Device>();
            let mut raw = Format::default().raw;
            raw[4..8].copy_from_slice(&768000u32.to_le_bytes());
            raw[8..12].copy_from_slice(&6144000u32.to_le_bytes());
            let desc = Description {
                size: std::mem::size_of::<Description>() as u32,
                flags: 0x10000,
                bytes: 614400,
                reserved: 0,
                format: raw.as_ptr(),
                algorithm: GUID::zeroed(),
            };
            let mut b = null_mut();
            assert_eq!(create_buffer(d, &desc, &mut b, null_mut()), 0);
            let mut first = null_mut();
            let mut n = 0;
            assert_eq!(
                lock(b, 0, 0, &mut first, &mut n, null_mut(), null_mut(), 2),
                0
            );
            assert_eq!(n, desc.bytes);
            ptr::write_bytes(first, 0x55, n as usize);
            assert_eq!(unlock(b, first, n, null_mut(), 0), 0);
            assert_eq!(play(b, 0, 0, 1), 0);
            // Internal clock ownership must not leak into COM Release counts.
            assert_eq!(buffer_add(b), 2);
            assert_eq!(buffer_release(b), 1);
            std::thread::sleep(Duration::from_millis(20));
            let mut pos = 0;
            assert_eq!(position(b, &mut pos, null_mut()), 0);
            assert!((50000..400000).contains(&pos));
            assert_eq!(pos % 8, 0);
            assert_eq!(stop(b), 0);
            let stopped = pos;
            position(b, &mut pos, null_mut());
            assert!(pos >= stopped);
            std::thread::sleep(Duration::from_millis(5));
            let mut after = 0;
            position(b, &mut after, null_mut());
            assert_eq!(pos, after);
            // Restart and immediately release the final client reference while
            // the asynchronous clock still owns the allocation.
            assert_eq!(play(b, 0, 0, 1), 0);
            assert_eq!(buffer_release(b), 0);
            device_release(d);
            std::thread::sleep(Duration::from_millis(10));
            assert_eq!(jap_null_buffer_count(), 0);
        }
    }
}

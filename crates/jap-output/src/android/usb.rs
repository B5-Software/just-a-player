use crate::usb_audio::{self, Alternate, Pacer};
use crate::{
    OpenRequest, OpenedStream, OutputError, RenderSource, Result, StreamEvent, StreamHandle,
};
use jap_core::{DeviceInfo, SampleFormat, StreamConfig};
use libusb1_sys as u;
use parking_lot::Mutex;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::sync::{
    Arc, OnceLock,
    atomic::{AtomicBool, Ordering},
    mpsc,
};
use std::thread::JoinHandle;
use std::time::Duration;
use std::{cell::UnsafeCell, collections::BTreeMap};

struct Registered {
    fd: OwnedFd,
    name: String,
    descriptors: Vec<u8>,
    vendor: u16,
    product: u16,
}
fn registry() -> &'static Mutex<BTreeMap<String, Registered>> {
    static R: OnceLock<Mutex<BTreeMap<String, Registered>>> = OnceLock::new();
    R.get_or_init(Default::default)
}
pub fn register_usb(
    id: String,
    fd: i32,
    name: String,
    descriptors: Vec<u8>,
    vendor: u16,
    product: u16,
) -> Result<()> {
    let copy = unsafe { libc::dup(fd) };
    if copy < 0 {
        return Err(OutputError::Backend(
            std::io::Error::last_os_error().to_string(),
        ));
    }
    registry().lock().insert(
        id,
        Registered {
            fd: unsafe { OwnedFd::from_raw_fd(copy) },
            name,
            descriptors,
            vendor,
            product,
        },
    );
    Ok(())
}
pub fn unregister_usb(id: &str) {
    registry().lock().remove(id);
}
pub(super) fn devices() -> Result<Vec<DeviceInfo>> {
    Ok(registry()
        .lock()
        .iter()
        .enumerate()
        .map(|(i, (id, d))| DeviceInfo {
            id: id.clone(),
            name: d.name.clone(),
            is_default: i == 0,
        })
        .collect())
}
struct Device {
    id: String,
    ctx: *mut u::libusb_context,
    handle: *mut u::libusb_device_handle,
    _fd: OwnedFd,
    claimed: Vec<u8>,
    selected: Option<u8>,
    descriptors: Vec<u8>,
}
impl Device {
    fn gain(&self, a: &Alternate, gain: f32) -> Result<bool> {
        let Some((unit, channels)) = usb_audio::volume_feature(&self.descriptors, a) else {
            return Ok(false);
        };
        let index = u16::from(unit) << 8 | u16::from(a.control_interface);
        for channel in channels {
            let value = 0x0200 | u16::from(channel);
            let (min, max, step) = if a.protocol == 0x20 {
                let mut data = [0; 8];
                if self.control(0xa1, 2, value, index, &mut data)? < 8
                    || u16::from_le_bytes([data[0], data[1]]) != 1
                {
                    return Ok(false);
                }
                (
                    i16::from_le_bytes([data[2], data[3]]),
                    i16::from_le_bytes([data[4], data[5]]),
                    i16::from_le_bytes([data[6], data[7]]),
                )
            } else {
                let mut min = [0; 2];
                let mut max = [0; 2];
                let mut step = [0; 2];
                self.control(0xa1, 0x82, value, index, &mut min)?;
                self.control(0xa1, 0x83, value, index, &mut max)?;
                self.control(0xa1, 0x84, value, index, &mut step)?;
                (
                    i16::from_le_bytes(min),
                    i16::from_le_bytes(max),
                    i16::from_le_bytes(step),
                )
            };
            if min > max || step < 0 {
                return Ok(false);
            }
            let db = (20.0 * gain.max(0.0000001).log10() * 256.0).floor() as i32;
            if gain > 0.0 && db < i32::from(min) {
                return Ok(false);
            }
            let mut db = db.clamp(i32::from(min), i32::from(max));
            if step > 0 {
                db = i32::from(min) + (db - i32::from(min)) / i32::from(step) * i32::from(step);
            }
            let mut bytes = (db as i16).to_le_bytes();
            if self.control(0x21, 1, value, index, &mut bytes)? != 2 {
                return Ok(false);
            }
            let mut read = [0; 2];
            if self.control(
                0xa1,
                if a.protocol == 0x20 { 1 } else { 0x81 },
                value,
                index,
                &mut read,
            )? != 2
                || read != bytes
            {
                return Ok(false);
            }
        }
        Ok(true)
    }
    fn control(
        &self,
        ty: u8,
        request: u8,
        value: u16,
        index: u16,
        data: &mut [u8],
    ) -> Result<usize> {
        let n = unsafe {
            u::libusb_control_transfer(
                self.handle,
                ty,
                request,
                value,
                index,
                data.as_mut_ptr(),
                data.len() as u16,
                1000,
            )
        };
        if n < 0 {
            Err(error("USB control", n))
        } else {
            Ok(n as usize)
        }
    }
    fn claim(&mut self, interface: u8) -> Result<()> {
        if self.claimed.contains(&interface) {
            return Ok(());
        }
        let code = unsafe { u::libusb_claim_interface(self.handle, i32::from(interface)) };
        if code < 0 {
            return Err(error("USB claim interface", code));
        }
        self.claimed.push(interface);
        Ok(())
    }
    fn clock(&self, a: &Alternate) -> Result<u8> {
        let mut clock = a.clock;
        // A clock selector can point to another selector. Walk at most 8 nodes.
        for _ in 0..8 {
            let descriptors = &self.descriptors;
            let mut offset = 0;
            let mut next = None;
            while offset + 2 <= descriptors.len() {
                let len = usize::from(descriptors[offset]);
                if len < 2 || offset + len > descriptors.len() {
                    break;
                }
                let d = &descriptors[offset..offset + len];
                offset += len;
                if len >= 7
                    && d[1] == 0x24
                    && d[2] == 0x0b
                    && d[3] == clock
                    && len >= 7 + usize::from(d[4])
                {
                    let mut pin = [0];
                    self.control(
                        0xa1,
                        1,
                        0x0100,
                        (u16::from(clock) << 8) | u16::from(a.control_interface),
                        &mut pin,
                    )?;
                    if pin[0] == 0 || pin[0] > d[4] {
                        return Err(OutputError::UnsupportedFormat(
                            "USB clock selector has no active source".into(),
                        ));
                    }
                    next = Some(d[5 + usize::from(pin[0]) - 1]);
                    break;
                }
            }
            match next {
                Some(n) => clock = n,
                None => {
                    return if clock == 0 {
                        Err(OutputError::UnsupportedFormat(
                            "UAC2 clock source missing".into(),
                        ))
                    } else {
                        Ok(clock)
                    };
                }
            }
        }
        Err(OutputError::UnsupportedFormat(
            "USB clock selector cycle".into(),
        ))
    }
    fn rates(&self, a: &Alternate) -> Result<Vec<u32>> {
        if a.protocol != 0x20 {
            return Ok(a.rates.clone());
        }
        let clock = self.clock(a)?;
        let index = (u16::from(clock) << 8) | u16::from(a.control_interface);
        let mut count = [0; 2];
        self.control(0xa1, 2, 0x0100, index, &mut count)?;
        let count = usize::from(u16::from_le_bytes(count));
        if count == 0 || count > 64 {
            return Err(OutputError::UnsupportedFormat(
                "Invalid USB clock RANGE".into(),
            ));
        }
        let mut data = vec![0; 2 + 12 * count];
        let n = self.control(0xa1, 2, 0x0100, index, &mut data)?;
        if n != data.len() {
            return Err(OutputError::UnsupportedFormat(
                "Truncated USB clock RANGE".into(),
            ));
        }
        let mut rates = Vec::new();
        for r in data[2..].as_chunks::<12>().0 {
            let lo = u32::from_le_bytes(r[..4].try_into().unwrap());
            let hi = u32::from_le_bytes(r[4..8].try_into().unwrap());
            let step = u32::from_le_bytes(r[8..12].try_into().unwrap());
            for rate in [
                44100, 48000, 88200, 96000, 176400, 192000, 352800, 384000, 705600, 768000,
                1411200, 1536000,
            ] {
                if rate >= lo
                    && rate <= hi
                    && (step == 0 || (rate - lo) % step == 0)
                    && !rates.contains(&rate)
                {
                    rates.push(rate);
                }
            }
        }
        Ok(rates)
    }
    fn set_rate(&self, a: &Alternate, rate: u32) -> Result<()> {
        if a.protocol == 0x20 {
            let clock = self.clock(a)?;
            let index = u16::from(clock) << 8 | u16::from(a.control_interface);
            let mut current = [0; 4];
            if self.control(0xa1, 1, 0x0100, index, &mut current)? == 4
                && u32::from_le_bytes(current) == rate
            {
                return Ok(());
            }
            let mut bytes = rate.to_le_bytes();
            if self.control(0x21, 1, 0x0100, index, &mut bytes)? != 4 {
                return Err(OutputError::UnsupportedFormat(
                    "USB clock SET_CUR failed".into(),
                ));
            }
            let mut read = [0; 4];
            self.control(0xa1, 1, 0x0100, index, &mut read)?;
            if u32::from_le_bytes(read) != rate {
                return Err(OutputError::UnsupportedFormat(
                    "USB clock readback differs".into(),
                ));
            }
        } else {
            if a.rates.len() == 1 && a.rates[0] == rate {
                return Ok(());
            }
            let mut bytes = rate.to_le_bytes()[..3].to_vec();
            self.control(0x22, 1, 0x0100, u16::from(a.endpoint), &mut bytes)?;
            let mut read = [0; 3];
            self.control(0xa2, 0x81, 0x0100, u16::from(a.endpoint), &mut read)?;
            if read != bytes.as_slice() {
                return Err(OutputError::UnsupportedFormat(
                    "UAC1 rate readback differs".into(),
                ));
            }
        }
        Ok(())
    }
}
impl Drop for Device {
    fn drop(&mut self) {
        unsafe {
            if let Some(i) = self.selected {
                u::libusb_set_interface_alt_setting(self.handle, i32::from(i), 0);
            }
            for i in self.claimed.iter().rev() {
                u::libusb_release_interface(self.handle, i32::from(*i));
            }
            u::libusb_close(self.handle);
            u::libusb_exit(self.ctx);
        }
    }
}
fn error(operation: &str, code: i32) -> OutputError {
    OutputError::Backend(format!("{operation}: libusb {code}"))
}
fn connect(id: Option<&str>) -> Result<(Device, Vec<Alternate>, String)> {
    let reg = registry().lock();
    let (id, d) = match id {
        Some(id) => reg.get_key_value(id),
        None => reg.iter().next(),
    }
    .ok_or(OutputError::DeviceNotFound)?;
    let fd = unsafe { libc::dup(d.fd.as_raw_fd()) };
    if fd < 0 {
        return Err(OutputError::DeviceNotFound);
    }
    let fd = unsafe { OwnedFd::from_raw_fd(fd) };
    let mut ctx = std::ptr::null_mut();
    let mut handle = std::ptr::null_mut();
    static INIT: OnceLock<()> = OnceLock::new();
    INIT.get_or_init(|| unsafe {
        u::libusb_set_option(std::ptr::null_mut(), 2);
    });
    let code = unsafe { u::libusb_init(&mut ctx) };
    if code < 0 {
        return Err(error("USB init", code));
    }
    let code = unsafe { u::libusb_wrap_sys_device(ctx, fd.as_raw_fd() as _, &mut handle) };
    if code < 0 {
        unsafe {
            u::libusb_exit(ctx);
        }
        return Err(error("USB wrap authorized fd", code));
    }
    unsafe {
        u::libusb_set_auto_detach_kernel_driver(handle, 1);
    }
    let alts = usb_audio::parse(&d.descriptors, d.vendor, d.product);
    let name = d.name.clone();
    let descriptors = d.descriptors.clone();
    let id = id.clone();
    drop(reg);
    Ok((
        Device {
            id,
            ctx,
            handle,
            _fd: fd,
            claimed: Vec::new(),
            selected: None,
            descriptors,
        },
        alts,
        name,
    ))
}
pub(super) fn probe(id: Option<&str>) -> Result<Vec<StreamConfig>> {
    let (mut device, alts, _) = connect(id)?;
    let mut result = Vec::new();
    for a in alts {
        device.claim(a.control_interface)?;
        let rates = device.rates(&a)?;
        for rate in rates {
            for f in [
                SampleFormat::I16,
                SampleFormat::I24Packed,
                SampleFormat::I24In32,
                SampleFormat::I32,
                SampleFormat::F32,
                SampleFormat::DsdU8Msb,
            ] {
                let c = StreamConfig {
                    sample_rate: rate
                        * if f == SampleFormat::DsdU8Msb {
                            u32::from(a.subslot)
                        } else {
                            1
                        },
                    channels: a.channels,
                    format: f,
                };
                if a.accepts(c) && !result.contains(&c) {
                    result.push(c);
                }
            }
        }
    }
    Ok(result)
}
struct Control {
    start: AtomicBool,
    stop: AtomicBool,
}
type VolumeRequest = (f32, mpsc::SyncSender<Result<bool>>);
fn volume_controls() -> &'static Mutex<BTreeMap<String, mpsc::Sender<VolumeRequest>>> {
    static CONTROLS: OnceLock<Mutex<BTreeMap<String, mpsc::Sender<VolumeRequest>>>> =
        OnceLock::new();
    CONTROLS.get_or_init(Default::default)
}
pub(super) fn set_gain(id: Option<&str>, gain: f32) -> Result<bool> {
    if !gain.is_finite() || !(0.0..=1.0).contains(&gain) {
        return Ok(false);
    }
    let id = match id {
        Some(id) => id.to_owned(),
        None => registry()
            .lock()
            .keys()
            .next()
            .cloned()
            .ok_or(OutputError::DeviceNotFound)?,
    };
    let active = volume_controls().lock().get(&id).cloned();
    if let Some(tx) = active {
        let (reply, rx) = mpsc::sync_channel(1);
        tx.send((gain, reply))
            .map_err(|e| OutputError::Backend(e.to_string()))?;
        return rx
            .recv_timeout(Duration::from_secs(2))
            .map_err(|e| OutputError::Backend(e.to_string()))?;
    }
    let (mut device, alts, _) = connect(Some(&id))?;
    for a in alts {
        if usb_audio::volume_feature(&device.descriptors, &a).is_some() {
            device.claim(a.control_interface)?;
            return device.gain(&a, gain);
        }
    }
    Ok(false)
}
struct UsbStream {
    control: Arc<Control>,
    thread: Option<JoinHandle<()>>,
}
impl StreamHandle for UsbStream {
    fn start(&self) {
        self.control.start.store(true, Ordering::Release);
    }
}
impl Drop for UsbStream {
    fn drop(&mut self) {
        self.control.stop.store(true, Ordering::Release);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}
pub(super) fn open(req: &OpenRequest, source: Box<dyn RenderSource>) -> Result<OpenedStream> {
    let req = req.clone();
    let control = Arc::new(Control {
        start: AtomicBool::new(false),
        stop: AtomicBool::new(false),
    });
    let worker = Arc::clone(&control);
    let (ready, rx) = mpsc::sync_channel(1);
    let (events, receiver) = mpsc::channel();
    let thread = std::thread::Builder::new()
        .name("jap-usb-isoc".into())
        .spawn(
            move || match prepare(&req, source, Arc::clone(&worker), events.clone()) {
                Ok(mut state) => {
                    let (volume_tx, volume_rx) = mpsc::channel();
                    volume_controls()
                        .lock()
                        .insert(state.device.id.clone(), volume_tx);
                    state.volume = Some(volume_rx);
                    let _ = ready.send(Ok((state.config, state.name.clone(), state.buffer_frames)));
                    while !worker.start.load(Ordering::Acquire)
                        && !worker.stop.load(Ordering::Acquire)
                    {
                        state.apply_volume();
                        std::thread::sleep(Duration::from_millis(2));
                    }
                    if !worker.stop.load(Ordering::Acquire) {
                        state.run();
                    }
                    volume_controls().lock().remove(&state.device.id);
                }
                Err(e) => {
                    let _ = ready.send(Err(e));
                }
            },
        )
        .map_err(|e| OutputError::Backend(e.to_string()))?;
    match rx.recv().map_err(|e| OutputError::Backend(e.to_string()))? {
        Ok((config, name, frames)) => Ok(OpenedStream {
            config,
            buffer_frames: frames,
            exclusive: true,
            device_name: name,
            api_label: "USB Host · UAC 直接独占".into(),
            events: receiver,
            handle: Box::new(UsbStream {
                control,
                thread: Some(thread),
            }),
        }),
        Err(e) => {
            let _ = thread.join();
            Err(e)
        }
    }
}
// Mutated only on this libusb event thread, including reentrant control callbacks.
struct TransferState {
    source: Box<dyn RenderSource>,
    pacer: Pacer,
    inflight: usize,
    failed: bool,
    scratch: Vec<u8>,
}
struct State {
    device: Device,
    alt: Alternate,
    config: StreamConfig,
    name: String,
    buffer_frames: u32,
    io: UnsafeCell<TransferState>,
    interval_scale: f64,
    control: Arc<Control>,
    events: mpsc::Sender<StreamEvent>,
    volume: Option<mpsc::Receiver<VolumeRequest>>,
    transfers: usize,
    feedback_size: usize,
}
struct Slot {
    state: *const State,
    feedback: bool,
    buffer: Vec<u8>,
    transfer: *mut u::libusb_transfer,
}
fn prepare(
    req: &OpenRequest,
    source: Box<dyn RenderSource>,
    control: Arc<Control>,
    events: mpsc::Sender<StreamEvent>,
) -> Result<Box<State>> {
    let (mut device, mut alts, name) = connect(req.device_id.as_deref())?;
    for a in &mut alts {
        device.claim(a.control_interface)?;
        if a.protocol == 0x20 {
            a.rates = device.rates(a)?;
        }
    }
    alts.retain(|a| a.protocol != 0x20 || !a.rates.is_empty());
    let (config, alt) = req
        .candidates
        .iter()
        .find_map(|c| alts.iter().find(|a| a.accepts(*c)).map(|a| (*c, a.clone())))
        .ok_or_else(|| {
            OutputError::UnsupportedFormat(
                "USB DAC 未报告与源一致的 PCM / DoP / 原生 DSD 格式".into(),
            )
        })?;
    device.claim(alt.interface)?;
    let code =
        unsafe { u::libusb_set_interface_alt_setting(device.handle, i32::from(alt.interface), 0) };
    if code < 0 {
        return Err(error("USB idle alternate", code));
    }
    device.selected = Some(alt.interface);
    device.set_rate(&alt, alt.clock_rate(config))?;
    let code = unsafe {
        u::libusb_set_interface_alt_setting(
            device.handle,
            i32::from(alt.interface),
            i32::from(alt.alternate),
        )
    };
    if code < 0 {
        return Err(error("USB audio alternate", code));
    }
    let speed = unsafe { u::libusb_get_device_speed(u::libusb_get_device(device.handle)) };
    let base = if speed >= 3 { 8000.0 } else { 1000.0 };
    let interval_scale = f64::from(1_u32 << (alt.interval - 1));
    let intervals = base / interval_scale;
    let frame_bytes = usize::from(alt.channels) * usize::from(alt.subslot);
    if (f64::from(alt.clock_rate(config)) / intervals).ceil() as usize * frame_bytes
        > alt.max_packet
    {
        return Err(OutputError::UnsupportedFormat(
            "USB endpoint bandwidth insufficient".into(),
        ));
    }
    let packets = (16384 / alt.max_packet).clamp(1, 8);
    let transfers = (f64::from(req.buffer_ms) * intervals / 1000.0 / packets as f64)
        .ceil()
        .clamp(2.0, 32.0) as usize;
    let buffer_frames =
        (f64::from(config.sample_rate) / intervals * (packets * transfers) as f64).ceil() as u32;
    let pacer = Pacer::new(alt.clock_rate(config), intervals);
    let feedback_size = if alt.feedback_size == 0 {
        if speed >= 3 { 4 } else { 3 }
    } else {
        usize::from(alt.feedback_size)
    };
    if feedback_size < 3 {
        return Err(OutputError::UnsupportedFormat(
            "Invalid USB feedback endpoint".into(),
        ));
    }
    Ok(Box::new(State {
        device,
        alt,
        config,
        name,
        buffer_frames,
        io: UnsafeCell::new(TransferState {
            source,
            pacer,
            inflight: 0,
            failed: false,
            scratch: vec![0; 16384],
        }),
        interval_scale,
        control,
        events,
        volume: None,
        transfers,
        feedback_size,
    }))
}
// All callbacks and source access happen serially on the libusb event thread.
extern "system" fn callback(transfer: *mut u::libusb_transfer) {
    unsafe {
        let slot = &mut *((*transfer).user_data.cast::<Slot>());
        let state = &*slot.state;
        let io = &mut *state.io.get();
        io.inflight -= 1;
        if (*transfer).status != 0 && (*transfer).status != 3 {
            io.failed = true;
            let _ = state.events.send(StreamEvent::Failed(format!(
                "USB isochronous transfer: {}",
                (*transfer).status
            )));
        }
        if (*transfer).status == 0 {
            for i in 0..(*transfer).num_iso_packets as usize {
                let desc = &*(*transfer).iso_packet_desc.as_ptr().add(i);
                if desc.status != 0 {
                    io.failed = true;
                    let _ = state
                        .events
                        .send(StreamEvent::ResetRequired("USB packet lost".into()));
                }
                if slot.feedback && desc.actual_length >= 3 {
                    let b = &slot.buffer;
                    let value = if desc.actual_length >= 4 {
                        u32::from_le_bytes([b[0], b[1], b[2], b[3]]) as f64 / 65536.0
                    } else {
                        (u32::from(b[0]) | u32::from(b[1]) << 8 | u32::from(b[2]) << 16) as f64
                            / 16384.0
                    };
                    io.pacer.feedback(value * state.interval_scale);
                }
            }
        }
        if !state.control.stop.load(Ordering::Acquire) && !io.failed {
            submit(slot);
        }
    }
}
unsafe fn submit(slot: &mut Slot) {
    unsafe {
        let state = &*slot.state;
        let io = &mut *state.io.get();
        let t = &mut *slot.transfer;
        let frame_bytes = usize::from(state.alt.channels) * usize::from(state.alt.subslot);
        let mut offset = 0;
        for i in 0..t.num_iso_packets as usize {
            let len = if slot.feedback {
                slot.buffer.len()
            } else {
                io.pacer.next(state.alt.max_packet / frame_bytes) * frame_bytes
            };
            (*t.iso_packet_desc.as_mut_ptr().add(i)).length = len as u32;
            if !slot.feedback {
                if state.config.format == SampleFormat::DsdU8Msb {
                    io.source.render(&mut io.scratch[..len]);
                    usb_audio::pack_dsd(
                        &io.scratch[..len],
                        &mut slot.buffer[offset..offset + len],
                        usize::from(state.alt.channels),
                        usize::from(state.alt.subslot),
                    );
                } else {
                    io.source.render(&mut slot.buffer[offset..offset + len]);
                }
            }
            offset += len;
        }
        t.length = offset as i32;
        let code = u::libusb_submit_transfer(slot.transfer);
        if code < 0 {
            io.failed = true;
            let _ = state
                .events
                .send(StreamEvent::Failed(format!("USB submit: {code}")));
        } else {
            io.inflight += 1;
        }
    }
}
impl State {
    fn apply_volume(&self) {
        if let Some(rx) = &self.volume {
            while let Ok((gain, reply)) = rx.try_recv() {
                let _ = reply.send(self.device.gain(&self.alt, gain));
            }
        }
    }
    fn run(&self) {
        unsafe {
            let packets = (16384 / self.alt.max_packet).clamp(1, 8);
            let mut slots: Vec<Box<Slot>> = Vec::new();
            for index in 0..(self.transfers + usize::from(self.alt.feedback != 0)) {
                let feedback = index == self.transfers;
                let num = if feedback { 1 } else { packets };
                let transfer = u::libusb_alloc_transfer(num as i32);
                if transfer.is_null() {
                    (*self.io.get()).failed = true;
                    break;
                }
                let mut slot = Box::new(Slot {
                    state: self,
                    feedback,
                    buffer: vec![
                        0;
                        if feedback {
                            self.feedback_size
                        } else {
                            packets * self.alt.max_packet
                        }
                    ],
                    transfer,
                });
                u::libusb_fill_iso_transfer(
                    transfer,
                    self.device.handle,
                    if feedback {
                        self.alt.feedback
                    } else {
                        self.alt.endpoint
                    },
                    slot.buffer.as_mut_ptr(),
                    slot.buffer.len() as i32,
                    num as i32,
                    callback,
                    (&mut *slot as *mut Slot).cast(),
                    1000,
                );
                submit(&mut slot);
                slots.push(slot);
            }
            let timeout = libc::timeval {
                tv_sec: 0,
                tv_usec: 10000,
            };
            while !self.control.stop.load(Ordering::Acquire) && !(*self.io.get()).failed {
                self.apply_volume();
                let code = u::libusb_handle_events_timeout(self.device.ctx, &timeout);
                if code < 0 && code != -10 {
                    (*self.io.get()).failed = true;
                    let _ = self
                        .events
                        .send(StreamEvent::Failed(format!("USB event loop: {code}")));
                }
            }
            self.control.stop.store(true, Ordering::Release);
            for slot in &slots {
                u::libusb_cancel_transfer(slot.transfer);
            }
            // libusb owns submitted URBs until cancellation callbacks complete.
            while (*self.io.get()).inflight > 0 {
                u::libusb_handle_events_timeout(self.device.ctx, &timeout);
            }
            for slot in slots {
                u::libusb_free_transfer(slot.transfer);
            }
        }
    }
}

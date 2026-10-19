//! One wallpaper HWND spans the physical virtual desktop, including negative origins.
use napi::bindgen_prelude::Buffer;
use napi_derive::napi;

#[cfg(windows)]
mod win {
    use napi::bindgen_prelude::Buffer;
    use std::sync::Mutex;
    type Hwnd = isize;
    #[derive(Clone, Copy)]
    struct DesktopWindow {
        hwnd: Hwnd,
        style: isize,
        ex_style: isize,
        parent: Hwnd,
        after: Hwnd,
    }
    #[repr(C)]
    struct Point {
        x: i32,
        y: i32,
    }
    static SAVED: Mutex<Option<DesktopWindow>> = Mutex::new(None);
    #[link(name = "user32")]
    unsafe extern "system" {
        fn FindWindowW(class: *const u16, title: *const u16) -> Hwnd;
        fn FindWindowExW(parent: Hwnd, after: Hwnd, class: *const u16, title: *const u16) -> Hwnd;
        fn EnumWindows(callback: unsafe extern "system" fn(Hwnd, isize) -> i32, data: isize)
        -> i32;
        fn SendMessageTimeoutW(
            hwnd: Hwnd,
            msg: u32,
            w: usize,
            l: isize,
            flags: u32,
            timeout: u32,
            result: *mut usize,
        ) -> isize;
        fn SetParent(child: Hwnd, parent: Hwnd) -> Hwnd;
        fn GetParent(hwnd: Hwnd) -> Hwnd;
        fn GetWindowLongPtrW(hwnd: Hwnd, index: i32) -> isize;
        fn SetWindowLongPtrW(hwnd: Hwnd, index: i32, value: isize) -> isize;
        fn SetWindowPos(hwnd: Hwnd, after: Hwnd, x: i32, y: i32, w: i32, h: i32, flags: u32)
        -> i32;
        fn IsWindow(hwnd: Hwnd) -> i32;
        fn SetLayeredWindowAttributes(hwnd: Hwnd, key: u32, alpha: u8, flags: u32) -> i32;
        fn GetSystemMetrics(index: i32) -> i32;
        fn SetThreadDpiAwarenessContext(context: isize) -> isize;
        fn MapWindowPoints(from: Hwnd, to: Hwnd, points: *mut Point, count: u32) -> i32;
    }
    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain([0]).collect()
    }
    unsafe extern "system" fn find_worker(hwnd: Hwnd, data: isize) -> i32 {
        let class = wide("SHELLDLL_DefView");
        let worker = wide("WorkerW");
        // SAFETY: EnumWindows invokes us synchronously; data points to its caller's HWND.
        unsafe {
            if FindWindowExW(hwnd, 0, class.as_ptr(), std::ptr::null()) != 0 {
                let next = FindWindowExW(0, hwnd, worker.as_ptr(), std::ptr::null());
                if next != 0 {
                    *(data as *mut Hwnd) = next;
                    return 0;
                }
            }
        }
        1
    }
    fn window_handle(handle: &Buffer) -> napi::Result<Hwnd> {
        let bytes: [u8; 8] = handle
            .as_ref()
            .try_into()
            .map_err(|_| napi::Error::from_reason("无效 HWND"))?;
        Ok(isize::from_le_bytes(bytes))
    }
    fn fit(window: &mut DesktopWindow) -> napi::Result<()> {
        // SAFETY: all structures match Win32 layouts, and SAVED owns a validated HWND.
        unsafe {
            if IsWindow(window.hwnd) == 0 || IsWindow(window.parent) == 0 {
                return Err(napi::Error::from_reason("桌面窗口已失效"));
            }
            let previous_dpi = SetThreadDpiAwarenessContext(-4);
            // These are physical pixels, not Electron DIPs or work-area coordinates.
            // SetParent changes the coordinate space: size AND position must be reset
            // afterwards, including secondary monitors with a negative screen origin.
            let mut origin = Point {
                x: GetSystemMetrics(76), // SM_XVIRTUALSCREEN
                y: GetSystemMetrics(77), // SM_YVIRTUALSCREEN
            };
            MapWindowPoints(0, window.parent, &mut origin, 1);
            let result = SetWindowPos(
                window.hwnd,
                window.after,
                origin.x,
                origin.y,
                GetSystemMetrics(78), // SM_CXVIRTUALSCREEN
                GetSystemMetrics(79), // SM_CYVIRTUALSCREEN
                0x0270,
            );
            if previous_dpi != 0 {
                SetThreadDpiAwarenessContext(previous_dpi);
            }
            if result == 0 {
                return Err(napi::Error::from_reason("无法铺满桌面窗口"));
            }
        }
        Ok(())
    }
    pub fn refresh(handle: Buffer) -> napi::Result<()> {
        let hwnd = window_handle(&handle)?;
        let mut saved = SAVED
            .lock()
            .map_err(|_| napi::Error::from_reason("桌面状态不可用"))?;
        if let Some(window) = saved.as_mut().filter(|window| window.hwnd == hwnd) {
            fit(window)
        } else {
            Err(napi::Error::from_reason("窗口尚未挂载到桌面"))
        }
    }
    pub fn set(handle: Buffer, enabled: bool) -> napi::Result<()> {
        let hwnd = window_handle(&handle)?;
        let mut saved = SAVED
            .lock()
            .map_err(|_| napi::Error::from_reason("桌面状态不可用"))?;
        // SAFETY: HWND is supplied by Electron getNativeWindowHandle, checked by IsWindow.
        // All native calls run on the owning Electron main thread. No foreign window is modified.
        unsafe {
            if IsWindow(hwnd) == 0 {
                return Err(napi::Error::from_reason("窗口已失效"));
            }
            if !enabled {
                if let Some(window) = *saved {
                    if window.hwnd != hwnd {
                        return Err(napi::Error::from_reason("窗口不匹配"));
                    }
                    SetParent(hwnd, 0);
                    SetWindowLongPtrW(hwnd, -16, window.style);
                    SetWindowLongPtrW(hwnd, -20, window.ex_style);
                    SetWindowPos(hwnd, 0, 0, 0, 0, 0, 0x0037);
                    *saved = None;
                }
                return Ok(());
            }
            if saved.is_some() {
                return Ok(());
            }
            let progman = FindWindowW(wide("Progman").as_ptr(), std::ptr::null());
            if progman == 0 {
                return Err(napi::Error::from_reason("未找到 Windows 桌面"));
            }
            let mut result = 0;
            SendMessageTimeoutW(progman, 0x052c, 0xd, 1, 2, 1000, &mut result);
            // Windows 11 24H2+ places WorkerW inside Progman.
            let mut worker = FindWindowExW(progman, 0, wide("WorkerW").as_ptr(), std::ptr::null());
            if worker == 0 {
                SendMessageTimeoutW(progman, 0x052c, 0xd, 0, 2, 1000, &mut result);
                SendMessageTimeoutW(progman, 0x052c, 0, 0, 2, 1000, &mut result);
            }
            if worker == 0 {
                worker = FindWindowExW(progman, 0, wide("WorkerW").as_ptr(), std::ptr::null());
            }
            if worker == 0 {
                EnumWindows(find_worker, &mut worker as *mut Hwnd as isize);
            }
            if worker == 0 {
                return Err(napi::Error::from_reason(
                    "当前 Windows 桌面没有可用 WorkerW，未改变窗口",
                ));
            }
            let style = GetWindowLongPtrW(hwnd, -16);
            let ex_style = GetWindowLongPtrW(hwnd, -20);
            let def_view = FindWindowExW(
                progman,
                0,
                wide("SHELLDLL_DefView").as_ptr(),
                std::ptr::null(),
            );
            let raised = GetParent(worker) == progman && def_view != 0;
            let desktop_parent = if raised { progman } else { worker };
            // Remove all top-level frame/caption/min/max styles. A retained thick
            // frame otherwise leaves a visible border and shrinks Chromium's viewport.
            SetWindowLongPtrW(hwnd, -16, (style & !0xa1cf0000isize) | 0x40000000);
            let desktop_ex_style = (ex_style & !0x40309isize) | 0x08000080;
            SetWindowLongPtrW(hwnd, -20, desktop_ex_style);
            if raised {
                SetWindowLongPtrW(hwnd, -20, desktop_ex_style | 0x80000);
                SetLayeredWindowAttributes(hwnd, 0, 255, 2);
            }
            SetParent(hwnd, desktop_parent);
            if GetParent(hwnd) != desktop_parent {
                SetWindowLongPtrW(hwnd, -16, style);
                SetWindowLongPtrW(hwnd, -20, ex_style);
                return Err(napi::Error::from_reason("Windows 拒绝桌面窗口挂载"));
            }
            let mut window = DesktopWindow {
                hwnd,
                style,
                ex_style,
                parent: desktop_parent,
                after: if raised { def_view } else { 0 },
            };
            if let Err(error) = fit(&mut window) {
                SetParent(hwnd, 0);
                SetWindowLongPtrW(hwnd, -16, style);
                SetWindowLongPtrW(hwnd, -20, ex_style);
                SetWindowPos(hwnd, 0, 0, 0, 0, 0, 0x0037);
                return Err(error);
            }
            *saved = Some(window);
        }
        Ok(())
    }
}
#[napi]
pub fn refresh_desktop_wallpaper(handle: Buffer) -> napi::Result<()> {
    #[cfg(windows)]
    {
        win::refresh(handle)
    }
    #[cfg(not(windows))]
    {
        let _ = handle;
        Err(napi::Error::from_reason("此平台不支持桌面壁纸模式"))
    }
}
#[napi]
pub fn set_desktop_wallpaper(handle: Buffer, enabled: bool) -> napi::Result<()> {
    #[cfg(windows)]
    {
        win::set(handle, enabled)
    }
    #[cfg(not(windows))]
    {
        let _ = (handle, enabled);
        Err(napi::Error::from_reason("此平台不支持桌面壁纸模式"))
    }
}

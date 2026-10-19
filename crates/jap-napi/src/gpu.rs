use napi_derive::napi;

#[napi(object)]
pub struct GpuAdapter {
    pub id: String,
    pub name: String,
    pub luid: String,
    pub memory_mb: u32,
}

/// DXGI LUID is resolved on every launch; only the PCI identity is saved.
#[napi]
pub fn gpu_adapters() -> napi::Result<Vec<GpuAdapter>> {
    #[cfg(windows)]
    {
        use windows::Win32::Graphics::Dxgi::{
            CreateDXGIFactory1, DXGI_ADAPTER_FLAG_SOFTWARE, IDXGIFactory1,
        };
        // SAFETY: DXGI initializes its factory and owns all returned COM pointers.
        let factory: IDXGIFactory1 =
            unsafe { CreateDXGIFactory1() }.map_err(|e| napi::Error::from_reason(e.to_string()))?;
        let mut result: Vec<GpuAdapter> = Vec::new();
        for index in 0..64 {
            let Ok(adapter) = (unsafe { factory.EnumAdapters1(index) }) else {
                break;
            };
            let desc = unsafe { adapter.GetDesc1() }
                .map_err(|e| napi::Error::from_reason(e.to_string()))?;
            if desc.Flags & DXGI_ADAPTER_FLAG_SOFTWARE.0 as u32 != 0 {
                continue;
            }
            let len = desc.Description.iter().position(|&v| v == 0).unwrap_or(128);
            let key = format!(
                "{:04x}:{:04x}:{:08x}:{:02x}",
                desc.VendorId, desc.DeviceId, desc.SubSysId, desc.Revision
            );
            let occurrence = result.iter().filter(|g| g.id.starts_with(&key)).count();
            result.push(GpuAdapter {
                id: format!("{key}:{occurrence}"),
                name: String::from_utf16_lossy(&desc.Description[..len]),
                luid: format!("{},{}", desc.AdapterLuid.HighPart, desc.AdapterLuid.LowPart),
                memory_mb: (desc.DedicatedVideoMemory / (1024 * 1024)) as u32,
            });
        }
        Ok(result)
    }
    #[cfg(not(windows))]
    Ok(Vec::new())
}

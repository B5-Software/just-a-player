#![cfg_attr(
    all(target_os = "windows", not(debug_assertions)),
    windows_subsystem = "windows"
)]

#[cfg(all(not(target_os = "android"), not(target_env = "ohos")))]
mod desktop;
#[cfg(all(not(target_os = "android"), not(target_env = "ohos")))]
mod media;

fn main() -> anyhow::Result<()> {
    #[cfg(all(not(target_os = "android"), not(target_env = "ohos")))]
    desktop::run()?;
    Ok(())
}

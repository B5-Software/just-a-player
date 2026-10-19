use jap_core::OutputApi;

#[derive(Debug, thiserror::Error)]
pub enum OutputError {
    #[error("找不到指定的输出设备")]
    DeviceNotFound,
    #[error("设备正被其他程序占用")]
    DeviceBusy,
    #[error("设备不接受该音频格式: {0}")]
    UnsupportedFormat(String),
    #[error("暂不支持的输出接口: {0:?}")]
    UnsupportedApi(OutputApi),
    #[error("输出设备错误: {0}")]
    Backend(String),
}

pub type Result<T> = std::result::Result<T, OutputError>;

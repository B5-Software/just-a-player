use std::io;

#[derive(Debug, thiserror::Error)]
pub enum DecodeError {
    #[error("无法读取文件: {0}")]
    Io(#[from] io::Error),
    #[error("不支持的格式: {0}")]
    Unsupported(String),
    #[error("解码失败: {0}")]
    Decode(String),
    #[error("跳转失败: {0}")]
    Seek(String),
}

pub type Result<T> = std::result::Result<T, DecodeError>;

impl From<symphonia::core::errors::Error> for DecodeError {
    fn from(err: symphonia::core::errors::Error) -> Self {
        use symphonia::core::errors::Error as E;
        match err {
            E::IoError(e) => Self::Io(e),
            E::SeekError(kind) => Self::Seek(format!("{kind:?}")),
            E::Unsupported(what) => Self::Unsupported(what.to_string()),
            other => Self::Decode(other.to_string()),
        }
    }
}

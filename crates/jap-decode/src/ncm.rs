//! Seekable NCM decryption. No converted file or whole-track allocation.
//! Algorithm adapted from B5-Software/ncmdump-js-b5s (MIT); see THIRD_PARTY.md.
use crate::{Cover, DecodeError, Result};
use aes::{
    Aes128,
    cipher::{BlockDecrypt, KeyInit, generic_array::GenericArray},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use std::{
    fs::File,
    io::{self, Read, Seek, SeekFrom},
    path::Path,
};
use symphonia::core::io::MediaSource;

fn invalid(msg: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, msg)
}
fn u32le(file: &mut File) -> io::Result<u32> {
    let mut b = [0; 4];
    file.read_exact(&mut b)?;
    Ok(u32::from_le_bytes(b))
}
fn block(file: &mut File, max: usize) -> io::Result<Vec<u8>> {
    let len = u32le(file)? as usize;
    if len > max {
        return Err(invalid("NCM header exceeds limit"));
    }
    let mut data = vec![0; len];
    file.read_exact(&mut data)?;
    Ok(data)
}
fn decrypt(key: &[u8; 16], mut data: Vec<u8>) -> io::Result<Vec<u8>> {
    if data.is_empty() || !data.len().is_multiple_of(16) {
        return Err(invalid("NCM AES block length"));
    }
    let cipher = Aes128::new(GenericArray::from_slice(key));
    for b in data.as_chunks_mut::<16>().0 {
        cipher.decrypt_block(GenericArray::from_mut_slice(b));
    }
    let pad = usize::from(*data.last().unwrap());
    if pad == 0
        || pad > 16
        || !data[data.len() - pad..]
            .iter()
            .all(|&v| usize::from(v) == pad)
    {
        return Err(invalid("NCM AES padding"));
    }
    data.truncate(data.len() - pad);
    Ok(data)
}
pub struct NcmReader {
    file: File,
    start: u64,
    len: u64,
    pos: u64,
    mask: [u8; 256],
    pub metadata: Option<serde_json::Value>,
    pub cover: Option<Cover>,
}
impl NcmReader {
    pub fn open(path: &Path) -> Result<Self> {
        let mut file = File::open(path)?;
        let mut magic = [0; 10];
        file.read_exact(&mut magic)?;
        if &magic[..8] != b"CTENFDAM" {
            return Err(DecodeError::Unsupported("无效 NCM 文件头".into()));
        }
        let mut key = block(&mut file, 4096)?;
        key.iter_mut().for_each(|v| *v ^= 0x64);
        let key = decrypt(b"hzHRAmso5kInbaxW", key)?;
        if key.len() <= 17 || !key.starts_with(b"neteasecloudmusic") {
            return Err(invalid("NCM key prefix").into());
        }
        let key = &key[17..];
        let mut box_ = std::array::from_fn::<u8, 256, _>(|i| i as u8);
        let mut j = 0usize;
        for i in 0..256 {
            j = (j + usize::from(box_[i]) + usize::from(key[i % key.len()])) & 255;
            box_.swap(i, j);
        }
        let mask = std::array::from_fn(|i| {
            let j = (i + 1) & 255;
            box_[(usize::from(box_[j]) + usize::from(box_[(usize::from(box_[j]) + j) & 255])) & 255]
        });
        let mut meta = block(&mut file, 4 * 1024 * 1024)?;
        meta.iter_mut().for_each(|v| *v ^= 0x63);
        let metadata = if meta.is_empty() {
            None
        } else {
            let decoded = meta
                .get(22..)
                .and_then(|v| STANDARD.decode(v).ok())
                .and_then(|v| decrypt(b"#14ljk_!\\]&0U<'(", v).ok());
            decoded.and_then(|v| {
                v.strip_prefix(b"music:")
                    .and_then(|v| serde_json::from_slice(v).ok())
            })
        };
        file.seek(SeekFrom::Current(5))?;
        let cover_frame = u64::from(u32le(&mut file)?);
        let cover_len = u64::from(u32le(&mut file)?);
        if cover_len > cover_frame || cover_frame > 32 * 1024 * 1024 {
            return Err(invalid("NCM cover bounds").into());
        }
        let mut data = vec![0; cover_len as usize];
        file.read_exact(&mut data)?;
        file.seek(SeekFrom::Current((cover_frame - cover_len) as i64))?;
        let start = file.stream_position()?;
        let len = file
            .metadata()?
            .len()
            .checked_sub(start)
            .ok_or_else(|| invalid("NCM data bounds"))?;
        let cover = crate::cover::sniff_mime(&data).map(|mime| Cover {
            mime: mime.into(),
            data,
        });
        Ok(Self {
            file,
            start,
            len,
            pos: 0,
            mask,
            metadata,
            cover,
        })
    }
}
impl Read for NcmReader {
    fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
        let len = out.len().min((self.len - self.pos) as usize);
        let n = self.file.read(&mut out[..len])?;
        for (i, b) in out[..n].iter_mut().enumerate() {
            *b ^= self.mask[((self.pos + i as u64) & 255) as usize];
        }
        self.pos += n as u64;
        Ok(n)
    }
}
impl Seek for NcmReader {
    fn seek(&mut self, from: SeekFrom) -> io::Result<u64> {
        let pos = match from {
            SeekFrom::Start(v) => i128::from(v),
            SeekFrom::Current(v) => i128::from(self.pos) + i128::from(v),
            SeekFrom::End(v) => i128::from(self.len) + i128::from(v),
        };
        if pos < 0 || pos > i128::from(self.len) {
            return Err(invalid("NCM seek bounds"));
        }
        self.pos = pos as u64;
        self.file.seek(SeekFrom::Start(self.start + self.pos))?;
        Ok(self.pos)
    }
}
impl MediaSource for NcmReader {
    fn is_seekable(&self) -> bool {
        true
    }
    fn byte_len(&self) -> Option<u64> {
        Some(self.len)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use aes::cipher::BlockEncrypt;
    #[test]
    fn encrypted_wav_is_seekable_and_plays_without_converted_file() {
        let path = std::env::temp_dir().join(format!("jap-ncm-{}.ncm", std::process::id()));
        let mut wav = io::Cursor::new(Vec::new());
        let mut writer = hound::WavWriter::new(
            &mut wav,
            hound::WavSpec {
                channels: 2,
                sample_rate: 48000,
                bits_per_sample: 16,
                sample_format: hound::SampleFormat::Int,
            },
        )
        .unwrap();
        for i in 0..96000 {
            writer.write_sample((i % 20000) as i16).unwrap();
        }
        writer.finalize().unwrap();
        let audio = wav.into_inner();
        let mut key = b"neteasecloudmusic-test-stream-key".to_vec();
        let pad = 16 - key.len() % 16;
        key.extend(std::iter::repeat_n(pad as u8, pad));
        let cipher = Aes128::new(GenericArray::from_slice(b"hzHRAmso5kInbaxW"));
        for b in key.as_chunks_mut::<16>().0 {
            cipher.encrypt_block(GenericArray::from_mut_slice(b));
        }
        key.iter_mut().for_each(|b| *b ^= 0x64);
        let mut bytes = b"CTENFDAM\0\0".to_vec();
        bytes.extend((key.len() as u32).to_le_bytes());
        bytes.extend(key);
        bytes.extend([0; 17]);
        std::fs::write(&path, &bytes).unwrap();
        let reader = NcmReader::open(&path).unwrap();
        bytes.extend(
            audio
                .iter()
                .enumerate()
                .map(|(i, b)| b ^ reader.mask[i & 255]),
        );
        std::fs::write(&path, bytes).unwrap();
        let mut reader = NcmReader::open(&path).unwrap();
        reader.seek(SeekFrom::Start(255)).unwrap();
        let mut part = [0; 300];
        reader.read_exact(&mut part).unwrap();
        assert_eq!(part, audio[255..555]);
        reader.seek(SeekFrom::Start(0)).unwrap();
        let mut all = Vec::new();
        reader.read_to_end(&mut all).unwrap();
        assert_eq!(all, audio);
        let mut source = crate::open(&path).unwrap();
        assert!(source.info().codec.starts_with("NCM"));
        let mut out = Vec::new();
        assert!(source.read(&mut out).unwrap() > 0);
        source.seek(500).unwrap();
        drop(source);
        drop(reader);
        std::fs::remove_file(path).unwrap();
    }
}

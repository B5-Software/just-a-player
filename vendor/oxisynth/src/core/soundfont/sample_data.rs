use std::{
    io::{self, Read, Seek, SeekFrom},
    sync::Arc,
};

use soundfont::raw::SampleChunk;

#[derive(Debug, Clone)]
pub(crate) struct SampleData(Arc<[i16]>);

impl SampleData {
    #[cfg_attr(not(feature = "sf3"), allow(dead_code))]
    pub fn new(data: Arc<[i16]>) -> Self {
        Self(data)
    }

    pub fn load<F: Read + Seek>(file: &mut F, smpl: &SampleChunk) -> io::Result<Self> {
        let sample_pos = smpl.offset;
        let sample_size = smpl.len as usize;

        if let Err(err) = file.seek(SeekFrom::Start(sample_pos)) {
            log::error!("Failed to seek position in data file: {err}");
            return Err(err);
        }

        // Just A Player: the HQ bank is ~467 MiB. Vec -> Arc would temporarily
        // allocate it twice and can kill 32-bit/low-memory Android processes.
        let mut storage = Arc::<[i16]>::new_uninit_slice(sample_size / 2);
        for sample in Arc::get_mut(&mut storage).unwrap() {
            sample.write(0);
        }
        // SAFETY: every element above was initialized to a valid i16 value.
        let mut data = unsafe { storage.assume_init() };

        {
            let byte_slice =
                crate::unsafe_stuff::slice_i16_to_u8_mut(Arc::get_mut(&mut data).unwrap());

            if let Err(err) = file.read_exact(byte_slice) {
                log::error!("Failed to read sample data: {err}");
                return Err(err);
            }
        }

        // Sample is in LittleEndian so if we are on BigEndian flip the bits around?
        // TODO: Not sure if this is working as expected, gotta test this in a VM
        if cfg!(target_endian = "big") {
            for n in Arc::get_mut(&mut data).unwrap().iter_mut() {
                *n = n.to_le();
            }
        }

        Ok(Self(data))
    }

    #[cfg_attr(not(feature = "sf3"), allow(dead_code))]
    pub fn as_byte_slice(&self) -> &[u8] {
        crate::unsafe_stuff::slice_i16_to_u8(&self.0)
    }
}

impl std::ops::Deref for SampleData {
    type Target = [i16];

    #[inline(always)]
    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

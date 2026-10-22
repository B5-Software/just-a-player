# Original test media

The MIDI, sine SF2, generated CD/SACD images, and `pcm24-768.flac` fixtures are
original synthetic test signals by B5-Software, dedicated under CC0-1.0. They
contain no commercial recording or instrument sample library.

`pcm24-768.flac` has 8192 stereo, 24-bit samples at 768000 Hz. Its original integer
channels are `((i * 3511) % 14000001) - 7000000` and
`7000000 - ((i * 7193) % 14000001)`. Tests compare every sample after a 5 ms seek.
`disc.mjs` generates two CD tracks and two SACD DSD tracks with known boundaries
and metadata, including SACD text stored across TOC sectors.

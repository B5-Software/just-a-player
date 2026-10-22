Vendored Symphonia 0.6.1, MPL-2.0, upstream https://github.com/pdeljanov/Symphonia.
Change: accept the complete 20-bit FLAC sample-rate field (1..1048575 Hz, RFC 9639). Keeps 24/768 decoding native on every platform.
The FLAC demuxer's binary seek also handles a midpoint inside the final frame:
EOF narrows the upper search bound, then the existing linear scan verifies the
preceding frame. This fixes precise seeking in valid single-frame FLAC files.
Regression: `native_768khz_flac_seeks_inside_its_final_frame_sample_exactly`.
Original copyright notices and MPL-2.0 license are preserved.

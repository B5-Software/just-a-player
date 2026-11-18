Vendored from crates.io oxisynth 0.1.0 (LGPL-2.1; see LICENSE).

Local change: derive Clone for SoundFont. Its Vec contains Arc<Preset>; cloning
shares immutable samples instead of allocating another complete HQ sound bank
for metadata probing, gapless playback, analysis or offline export.

SampleData allocates its initialized i16 slice directly inside Arc, avoiding
the temporary second complete copy from Vec -> Arc during initial loading.

Seventh-order interpolation uses explicit wrapping for its centered 32.32 phase
offset. Zero-start sample loops can retain a negative half-sample remainder;
the modular representation must not panic on unsigned addition/subtraction in
checked builds. Covered by the complete partial-bank MIDI rendering regression.

MIDI system reset restores the standard drum preset on channel 10 and retains
the configured interpolation, chorus and reverb parameters. Bank Select resolves
GS-style SoundFont variations when a combined CC0/CC32 bank is unavailable.

Linear SoundFont 2.04 modulators normalize 7-bit sources by 128, with the
bipolar midpoint at 64. Pitch wheel modulation retains the 14-bit range on
either source.

The sibling `oxisynth-reverb` directory contains the LGPL-2.1 source of
oxisynth-reverb 0.1.0. Its delay lengths and damping track sample rate,
and reset clears the buffers without changing configured coefficients. The
reverb and chorus return settings come from OxiSynth upstream.

Upstream: https://github.com/PolyMeilex/OxiSynth

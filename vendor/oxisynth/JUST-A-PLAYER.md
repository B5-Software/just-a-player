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

Upstream: https://github.com/PolyMeilex/OxiSynth

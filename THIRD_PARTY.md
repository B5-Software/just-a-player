# Third-party notices

## Lightweight interface

The embedded 2D interface is original project code (GPL-3.0-or-later) and uses
installed system fonts; it bundles no additional commercial fonts.
Desktop hosting uses Wry 0.57.1 (MIT / Apache-2.0), Tao 0.37.2 (Apache-2.0),
Souvlaki 0.8.3 (MIT), fs2 0.4.3 (MIT / Apache-2.0), and keepawake 0.6.1 (MIT).
Their full dependency notices are collected by the existing package notice scripts.

## MIDI synthesis and sound bank

The `with-midi` desktop and Android packages bundle **MuseScore General HQ 0.2.1**, an uncompressed SF2 bank
(489,517,354 bytes). It is distributed under the MIT license with the complete
copyright, attribution and sample-source notices in
`assets/soundfonts/documentation/`. The checksum-pinned upstream archive comes
from the [Debian source distribution](https://deb.debian.org/debian/pool/main/m/musescore-general-soundfont/).
The desktop installer retains these files under `resources/soundfonts/documentation/`;
Android includes them in `assets/licenses/`. Exports synthesized with the default
bank receive an adjacent `.midi-license.txt` so its attribution can travel with
the audio. Imported banks remain subject to their own terms.

The Rust MIDI parser is [midly](https://github.com/negamartin/midly) 0.5.3
(MIT / Apache-2.0). SoundFont synthesis uses
[OxiSynth](https://github.com/PolyMeilex/OxiSynth) 0.1.0 (LGPL-2.1), retained in
`vendor/oxisynth/` with its full source and license. Local changes share immutable
sample data across synth instances and initialize sample storage directly in an
Arc allocation to avoid a second large sample-buffer copy on mobile. Changes are
documented in `vendor/oxisynth/JUST-A-PLAYER.md`.
The centered fixed-point phase in seventh-order interpolation also uses explicit
wrapping arithmetic for sample loops beginning at zero.

## Android

Android shares the desktop OFL font assets and Rust engine. Its native USB Host transport
statically links libusb 1.0.27 through libusb1-sys 0.7.0 (LGPL-2.1-or-later).
DST's C++ runtime is statically linked from Android NDK 26.1.10909125
(Apache-2.0 with LLVM exceptions and the notices in the NDK toolchain distribution).
Full notices are in `apps/android/app/src/main/assets/licenses/`.

Android FFmpeg 9.0.2 and x264 c24e06c2e184345ceb33eb20a15d1024d9fd3497
are built from checksum-pinned upstream source with GPL enabled and nonfree disabled.
The source URLs and hashes are in `apps/android/scripts/prepare-codecs.mjs`;
build flags are in `build-codecs.sh`. Both source archives accompany CI artifacts.

The Rust seekable NCM source adapts the file-format and key-box algorithm from
[B5-Software/ncmdump-js-b5s](https://github.com/B5-Software/ncmdump-js-b5s),
copyright (c) 2024 B5-Software, MIT. The complete upstream notice is included at
`crates/jap-decode/NCM-MIT-LICENSE.txt`. It decrypts only the bytes requested by the
decoder and supports seeking without generating a converted audio file.

All bundled text fonts are distributed under SIL Open Font License 1.1:
Noto Sans SC, Noto Serif SC, Noto Sans Mono, LXGW WenKai, ZCOOL KuaiLe,
Ma Shan Zheng, Long Cang, Zhi Mang Xing, Liu Jian Mao Cao, ZCOOL XiaoWei and
ZCOOL QingKe HuangYou. Complete individual notices are in
`apps/desktop/src/renderer/public/licenses/fonts/`. Professional 2D instruments use
Noto Sans SC and Noto Sans Mono; no proprietary font assets are embedded.
The same eleven notices are copied into the built application's `licenses/fonts/`.
Imported user fonts stay in the local user-data directory and are not bundled.
Fontkit (MIT) reads imported font metadata and collections; its font extraction
does not subset or replace glyphs. Fontkit declares MIT in its npm metadata and
[upstream README](https://github.com/foliojs/fontkit#license).

Release installers bundle unmodified FFmpeg and ffprobe 9.0.2-tas, with their
shared runtime libraries, from
[NevermindNilas/TAS-FFMPEG v9.0.2](https://github.com/NevermindNilas/TAS-FFMPEG/releases/tag/v9.0.2).
This build is GPL-2.0-or-later (including x264/x265); nonfree components are
disabled. Each archive is pinned by SHA-256 in
`apps/desktop/scripts/media-tools.lock.json`. Full individual dependency
licenses, the upstream manifest, configure options and `SOURCE.md` are installed
under `resources/media-tools/` (macOS: inside the application's Contents).
The complete corresponding source, dependencies and build scripts are mirrored
beside every release using these binaries, as
`tas-ffmpeg-9.0.2-corresponding-source.tar.xz`; they are not needed to run the app.
Windows ARM64 uses the upstream x64 CLI helper processes through Windows 11 ARM
emulation; the player, Rust engine and audio outputs remain native ARM64.

`crates/jap-decode/vendor/dst/` includes the DST decoder distributed in
[KGAFT/ndsd-read 0.1.2](https://github.com/KGAFT/ndsd-read), derived from Maxim
V. Anisiutkin's SACD Decoder (LGPL-2.1-or-later). Its supplied COPYING/LICENSE
and source headers are retained. The small C ABI wrapper is modified locally
to contain exceptions and suppress native console logging. Only the decoder
core is built; this project does not link ndsd-read's reader or bindgen.

SACD sector and packet layout was cross-checked with
[sacd-ripper](https://github.com/hank/sacd-ripper), GPL-2.0-or-later. SACD ISO is
split using the disc's track table and text metadata. Individual tracks preserve
their audio boundaries, with PCM monitoring, DoP and native DSD transports.
Stereo is preferred; multichannel is used when no stereo area exists.

## Native FLAC and resampling

[Symphonia](https://github.com/pdeljanov/Symphonia) 0.6.1 is MPL-2.0. The complete
modified source of `symphonia-common` and `symphonia-bundle-flac` is included under
`vendor/`, with original licenses and a `JUST-A-PLAYER.md` change log in each.
The patches accept FLAC's 20-bit sample-rate field and fix seeking inside the
final frame. Corresponding source is included in this repository and GitHub's
release source archives; MPL-2.0 continues to apply to those files.

[Rubato](https://github.com/HEnquist/rubato) 0.16.2 is MIT. It provides bounded,
64-bit FFT anti-aliasing for automatic output-rate adaptation and the separate
high-rate visualization analysis copy. Unchanged-rate audio bypasses it.

## HarmonyOS

The experimental HarmonyOS frontend uses the same OFL assets and Rust engine.
USB uses the same libusb transport and LGPL notices as Android. The original
Huawei DevEco project template headers retain their Apache-2.0 notices; new
application code is GPL-3.0-or-later. Huawei SDK components are provided by the
developer's SDK installation and are not included in this repository.


## Native lightweight UI

The native frontend uses egui / eframe 0.34.3 (MIT OR Apache-2.0), egui_software_backend 0.0.3 (MIT OR Apache-2.0),
and the native window / graphics integrations selected by eframe. It does not use Wry or a WebView.
Android and HarmonyOS present Rust-rasterized pixels using their native View / PixelMap APIs.
Only Noto Sans SC and Latin fonts are embedded in this UI, under SIL OFL 1.1; see crates/jap-light/fonts/OFL.txt.
The TTF assets are decoded from the same OFL WOFF2 subsets used by the complete UI.

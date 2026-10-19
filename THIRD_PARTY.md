# Third-party notices

The Rust seekable NCM source adapts the file-format and key-box algorithm from
[B5-Software/ncmdump-js-b5s](https://github.com/B5-Software/ncmdump-js-b5s),
copyright (c) 2024 B5-Software, MIT. The complete upstream notice is included at
`crates/jap-decode/NCM-MIT-LICENSE.txt`. It decrypts only the bytes requested by the
decoder and supports seeking without generating a converted audio file.

All bundled text fonts are distributed under SIL Open Font License 1.1:
Noto Sans SC, Noto Serif SC, Noto Sans Mono, LXGW WenKai, ZCOOL KuaiLe,
Ma Shan Zheng, Long Cang, Zhi Mang Xing, Liu Jian Mao Cao, ZCOOL XiaoWei and
ZCOOL QingKe HuangYou. Complete individual notices are in
`apps/desktop/src/renderer/src/fonts/licenses/`. Professional 2D instruments use
Noto Sans SC and Noto Sans Mono; no proprietary font assets are embedded.
The same eleven notices are copied into the built application's `fonts/licenses/`.
Imported user fonts stay in the local user-data directory and are not bundled.
Fontkit (MIT) reads imported font metadata and collections; its font extraction
does not subset or replace glyphs. Fontkit declares MIT in its npm metadata and
[upstream README](https://github.com/foliojs/fontkit#license).

FFmpeg integration invokes a separately installed FFmpeg executable; no binary
or third-party codec library is redistributed by this source tree.

`crates/jap-decode/vendor/dst/` includes the DST decoder distributed in
[KGAFT/ndsd-read 0.1.2](https://github.com/KGAFT/ndsd-read), derived from Maxim
V. Anisiutkin's SACD Decoder (LGPL-2.1-or-later). Its supplied COPYING/LICENSE
and source headers are retained. The small C ABI wrapper is modified locally
to contain exceptions and suppress native console logging. Only the decoder
core is built; this project does not link ndsd-read's reader or bindgen.

SACD sector and packet layout was cross-checked with
[sacd-ripper](https://github.com/hank/sacd-ripper), GPL-2.0-or-later. SACD ISO is
currently presented as one continuous stereo area (multichannel area when no
stereo area exists), with PCM monitoring, DoP and native DSD transports.

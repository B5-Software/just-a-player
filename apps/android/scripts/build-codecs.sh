#!/usr/bin/env bash
set -euo pipefail
# Standalone Android PIE tools; no nonfree components and no downloaded APK code.
cd "$(dirname "$0")/.."
app_dir="$PWD"
ndk="${ANDROID_NDK_HOME:-${ANDROID_HOME:?Set ANDROID_HOME}/ndk/26.1.10909125}"
case "$(uname -s)" in
  MINGW*|MSYS*) host=windows-x86_64; exe=.exe; make_bin="$ndk/prebuilt/windows-x86_64/bin/make.exe"; task_shell='C:/Progra~1/Git/usr/bin/sh.exe' ;;
  Darwin*) host=darwin-x86_64; exe=; make_bin=make; task_shell=/bin/sh ;;
  *) host=linux-x86_64; exe=; make_bin=make; task_shell=/bin/sh ;;
esac
tc="$ndk/toolchains/llvm/prebuilt/$host"
if [[ "$host" == windows* ]]; then tc="$(cygpath -m "$tc")"; make_bin="$(cygpath -m "$make_bin")"; fi
for abi in "${@:-x86_64}"; do
  case "$abi" in
    arm64-v8a) triple=aarch64-linux-android; arch=aarch64 ;;
    armeabi-v7a) triple=armv7a-linux-androideabi; arch=arm ;;
    x86) triple=i686-linux-android; arch=x86 ;;
    x86_64) triple=x86_64-linux-android; arch=x86_64 ;;
    *) echo "Unsupported Android ABI: $abi" >&2; exit 1 ;;
  esac
  work="$app_dir/build/codecs/$abi"; mkdir -p "$work/x264" "$work/ffmpeg" "$work/prefix"
  prefix="$work/prefix"; if [[ "$host" == windows* ]]; then prefix="$(cygpath -m "$prefix")"; fi
  cc="$tc/bin/clang$exe --target=${triple}28"
  cflags="--sysroot=$tc/sysroot -fPIC -O2"
  cd "$work/x264"
  if [[ ! -f "$prefix/lib/libx264.a" ]]; then
    CC="$cc" AR="$tc/bin/llvm-ar$exe" RANLIB="$tc/bin/llvm-ranlib$exe" STRIP="$tc/bin/llvm-strip$exe" \
      "$app_dir/build/codecs/sources/x264-c24e06c2e184345ceb33eb20a15d1024d9fd3497/configure" \
      --host="$triple" --prefix="$prefix" --enable-static --enable-pic --disable-cli --disable-asm --disable-opencl --bit-depth=8 --extra-cflags="$cflags"
    # x264's one-command dependency generator exceeds CreateProcess's command
    # length on Windows. Each ABI gets a clean, dedicated build directory.
    if [[ "$host" == windows* ]]; then touch .depend; fi
    "$make_bin" -j"${JAP_CODEC_JOBS:-6}" "SHELL=$task_shell" > "$work/x264-build.log" 2>&1
    "$make_bin" "SHELL=$task_shell" install-lib-static install-lib-dev >> "$work/x264-build.log" 2>&1
  fi
  cat > "$work/pkg-config" <<EOF
#!/usr/bin/env bash
if [[ "\$*" == --version ]]; then echo 0.29.2; exit 0; fi
[[ "\$*" == *x264* ]] || exit 1
case "\$*" in
  *--modversion*) echo 0.165 ;;
  *--cflags*) echo '-I$prefix/include' ;;
  *--libs*) echo '-L$prefix/lib -lx264 -lm' ;;
esac
EOF
  chmod +x "$work/pkg-config"
  cd "$work/ffmpeg"
  signature="$(sha256sum "$app_dir/scripts/build-codecs.sh" | cut -d' ' -f1)"
  if [[ ! -f config.signature || "$(cat config.signature)" != "$signature" ]]; then
    rm -f ffbuild/config.mak ffmpeg ffprobe
  fi
  if [[ ! -f ffmpeg ]]; then
    if [[ ! -f ffbuild/config.mak ]]; then
    ../../sources/ffmpeg-9.0.2/configure --target-os=android --arch="$arch" --enable-cross-compile \
      --cc="$cc" --cxx="$tc/bin/clang++$exe --target=${triple}28" --ar="$tc/bin/llvm-ar$exe" --ranlib="$tc/bin/llvm-ranlib$exe" --nm="$tc/bin/llvm-nm$exe" --strip="$tc/bin/llvm-strip$exe" \
      --sysroot="$tc/sysroot" --prefix="$prefix" --pkg-config="$work/pkg-config" \
      --extra-cflags="$cflags" --extra-ldflags="-Wl,-z,max-page-size=16384" --extra-ldexeflags=-pie \
      --disable-autodetect --disable-asm --disable-debug --disable-doc --disable-network --disable-shared --enable-static --enable-gpl --enable-libx264 \
      --disable-everything --enable-ffmpeg --enable-ffprobe \
      --enable-decoder=ape,dca,pcm_s16le,pcm_s16be,pcm_s24le,pcm_s24be,pcm_s32le,pcm_f32le,pcm_f64le,flac,mp3,aac,alac,vorbis,opus,dsd_lsbf,dsd_msbf,dsd_lsbf_planar,dsd_msbf_planar,rawvideo \
      --enable-encoder=libx264,aac,flac,pcm_s16le,pcm_s24le,pcm_s32le,pcm_f32le,pcm_f64le,opus \
      --enable-parser=dca,mpegaudio,aac,flac,opus,vorbis \
      --enable-demuxer=ape,dts,wav,rawvideo,flac,mp3,mov,aac,ogg,aiff,dsf,iff,matroska \
      --enable-muxer=mp4,matroska,wav,flac,null,pcm_f32le,pcm_f64le \
      --enable-bsf=aac_adtstoasc,extract_extradata,h264_mp4toannexb \
      --enable-protocol=file,pipe --enable-filter=aresample,aformat,format,scale,anull,apad,atrim,setpts,asetpts,buffer,buffersink,abuffer,abuffersink
    echo "$signature" > config.signature
    fi
    if [[ "$host" == windows* ]]; then
      windows_app_dir="$(cygpath -m "$app_dir")"
      sed -i "s#$app_dir#$windows_app_dir#g" Makefile ffbuild/config.mak
    fi
    "$make_bin" -j"${JAP_CODEC_JOBS:-6}" "SHELL=$task_shell" > "$work/ffmpeg-build.log" 2>&1
  fi
  mkdir -p "$app_dir/app/src/main/jniLibs/$abi"
  cp ffmpeg "$app_dir/app/src/main/jniLibs/$abi/libffmpeg.so"
  cp ffprobe "$app_dir/app/src/main/jniLibs/$abi/libffprobe.so"
  "$tc/bin/llvm-strip$exe" "$app_dir/app/src/main/jniLibs/$abi/libffmpeg.so" "$app_dir/app/src/main/jniLibs/$abi/libffprobe.so"
  echo "Android FFmpeg/ffprobe ready: $abi"
done

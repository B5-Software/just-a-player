fn main() {
    println!("cargo:rerun-if-changed=vendor/dst");
    let mut build = cc::Build::new();
    build
        .cpp(true)
        .std("c++17")
        .include("vendor/dst")
        .files(["vendor/dst/decoder.cpp", "vendor/dst/dst_wrapper.cpp"])
        .warnings(false);
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("android") {
        // Keep the C++ runtime inside our 16-KiB-aligned JNI library. Older
        // NDKs ship a 4-KiB-only libc++_shared.so which fails on 16-KiB phones.
        build.cpp_link_stdlib("c++_static");
        println!("cargo:rustc-link-lib=c++abi");
    }
    build.compile("jap_dst");
}

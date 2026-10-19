fn main() {
    println!("cargo:rerun-if-changed=vendor/dst");
    cc::Build::new()
        .cpp(true)
        .std("c++17")
        .include("vendor/dst")
        .files(["vendor/dst/decoder.cpp", "vendor/dst/dst_wrapper.cpp"])
        .warnings(false)
        .compile("jap_dst");
}

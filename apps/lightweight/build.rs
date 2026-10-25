fn main() {
    println!("cargo:rerun-if-changed=../desktop/build/icon.ico");
    #[cfg(windows)]
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        winresource::WindowsResource::new()
            .set_icon("../desktop/build/icon.ico")
            .set("ProductName", "Just A Player")
            .set("FileDescription", "Just A Player Native")
            .set("CompanyName", "B5-Software")
            .set("LegalCopyright", "B5-Software · GPL-3.0-or-later")
            .compile()
            .expect("embed native application icon and identity");
    }
}

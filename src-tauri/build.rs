use std::path::PathBuf;

fn main() {
    copy_xterm();
    tauri_build::build()
}

/// The phone page's Terminal uses the same xterm.js the desktop window bundles. Copies it out of
/// node_modules (the nearest one up from here, so a git worktree finds the main checkout's) into
/// OUT_DIR, where remote.rs embeds it.
fn copy_xterm() {
    const FILES: [(&str, &str); 3] = [
        ("@xterm/xterm/lib/xterm.js", "xterm.js"),
        ("@xterm/xterm/css/xterm.css", "xterm.css"),
        ("@xterm/addon-fit/lib/addon-fit.js", "addon-fit.js"),
    ];
    let here = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let out = PathBuf::from(std::env::var("OUT_DIR").unwrap());
    let modules = here
        .ancestors()
        .map(|d| d.join("node_modules"))
        .find(|m| FILES.iter().all(|(src, _)| m.join(src).is_file()))
        .expect("xterm.js not found in any node_modules above src-tauri: run `npm install` in the Hangar folder");
    for (src, dst) in FILES {
        let from = modules.join(src);
        println!("cargo:rerun-if-changed={}", from.display());
        std::fs::copy(&from, out.join(dst)).unwrap_or_else(|e| panic!("copy {}: {e}", from.display()));
    }
}

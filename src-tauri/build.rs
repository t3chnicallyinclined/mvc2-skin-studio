use std::path::Path;

fn main() {
    stage_frontend();
    tauri_build::build();
}

// Stage a clean frontend for the bundle: copy ../web -> ./wwwroot EXCLUDING the ROM-derived
// web/test-atlas/ so the installer ships NO game data (BYOR). Pure Rust so the build has no
// Python/Node dependency and works identically on Windows, macOS, and Linux (incl. CI).
fn stage_frontend() {
    let manifest = env!("CARGO_MANIFEST_DIR");
    let src = Path::new(manifest).parent().unwrap().join("web");
    let dst = Path::new(manifest).join("wwwroot");

    // Re-stage when a frontend source changes (watch code files, not the huge test-atlas/).
    println!("cargo:rerun-if-changed=build.rs");
    for f in [
        "skin-studio.html",
        "panels/tile-editor.mjs",
        "platform.mjs",
        "rom-bake.mjs",
        "rom-reader.mjs",
    ] {
        println!("cargo:rerun-if-changed=../web/{f}");
    }

    if dst.exists() {
        std::fs::remove_dir_all(&dst).expect("failed to clear wwwroot");
    }
    copy_dir_excluding(&src, &dst, "test-atlas");
}

fn copy_dir_excluding(src: &Path, dst: &Path, exclude: &str) {
    std::fs::create_dir_all(dst).unwrap_or_else(|e| panic!("mkdir {dst:?}: {e}"));
    for entry in std::fs::read_dir(src).unwrap_or_else(|e| panic!("read_dir {src:?}: {e}")) {
        let entry = entry.unwrap();
        if entry.file_name() == exclude {
            continue; // ROM-derived per-user sprite data — never bundled
        }
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if from.is_dir() {
            copy_dir_excluding(&from, &to, exclude);
        } else {
            std::fs::copy(&from, &to).unwrap_or_else(|e| panic!("copy {from:?}: {e}"));
        }
    }
}

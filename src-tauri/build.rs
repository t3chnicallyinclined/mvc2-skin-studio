fn main() {
    // The frontend is staged into ./wwwroot by the Tauri `beforeBuildCommand`
    // (scripts/stage-frontend.mjs) before this build runs.
    tauri_build::build()
}

// MVC2 Skin Studio — Tauri v2 backend.
//
// The whole editor (decode + palette/pixel edit + byte-faithful bake) already runs in
// JavaScript inside the WebView — see web/rom-reader.mjs and web/rom-bake.mjs. The ONLY
// thing a browser can't do is real filesystem I/O on the user's ~1.2 GB track03.bin ROM.
// These four commands provide exactly that, as positioned range reads/writes (seek +
// read_exact / write_all) so the huge file is never read or rewritten whole.
//
// web/platform.mjs wraps these in an object that duck-types the File System Access API,
// so rom-reader.mjs / rom-bake.mjs stay unchanged.

use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::Path;
use tauri::ipc::Response;

/// Size of the ROM in bytes (the FS-Access `File.size` equivalent).
#[tauri::command]
fn rom_size(path: String) -> Result<u64, String> {
    std::fs::metadata(&path)
        .map(|m| m.len())
        .map_err(|e| e.to_string())
}

/// Read `length` bytes at `offset`. Returned as a raw binary IPC body (→ ArrayBuffer in JS,
/// no JSON). `length` is clamped to the bytes actually available so a sector-aligned read of
/// the final region can't error on a short read — matching browser `Blob.slice` semantics.
#[tauri::command]
fn rom_read(path: String, offset: u64, length: u64) -> Result<Response, String> {
    let mut f = File::open(&path).map_err(|e| e.to_string())?;
    let size = f.metadata().map_err(|e| e.to_string())?.len();
    let avail = size.saturating_sub(offset);
    let len = length.min(avail) as usize;
    f.seek(SeekFrom::Start(offset)).map_err(|e| e.to_string())?;
    let mut buf = vec![0u8; len];
    f.read_exact(&mut buf).map_err(|e| e.to_string())?;
    Ok(Response::new(buf))
}

/// Write `data` at `position`, in place. Opens read+write WITHOUT truncate/create so the rest
/// of the 1.2 GB file is preserved. Bake writes are tiny (one 2 KB sector per call), so the
/// bytes crossing IPC as a JSON array are negligible; the big file never crosses IPC.
#[tauri::command]
fn rom_write(path: String, position: u64, data: Vec<u8>) -> Result<(), String> {
    let mut f = OpenOptions::new()
        .read(true)
        .write(true)
        .open(&path)
        .map_err(|e| e.to_string())?;
    f.seek(SeekFrom::Start(position)).map_err(|e| e.to_string())?;
    f.write_all(&data).map_err(|e| e.to_string())?;
    Ok(())
}

/// Create `<path>.bak` (a pristine OS-level copy) if it doesn't already exist. Returns true if
/// a new backup was made, false if one was already there. This is the safety net the browser
/// build never had — a file handle can't create a sibling file.
#[tauri::command]
fn rom_backup(path: String) -> Result<bool, String> {
    let bak = format!("{path}.bak");
    if Path::new(&bak).exists() {
        return Ok(false);
    }
    std::fs::copy(&path, &bak).map_err(|e| e.to_string())?;
    Ok(true)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            rom_size, rom_read, rom_write, rom_backup
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

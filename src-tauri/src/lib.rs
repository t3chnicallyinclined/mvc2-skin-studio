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
use std::path::{Path, PathBuf};
use tauri::ipc::Response;

// A Dreamcast GDI data track: raw 2352-byte sectors, whose ISO-9660 Primary Volume Descriptor
// sits at LBA 45016. In the raw track (LBA 45000 = byte 0) that's byte 16*2352, and "CD001"
// is at +1 of the descriptor's 2048-byte user area (+16 past the sector's sync/header).
const PVD_CD001_OFFSET: u64 = 16 * 2352 + 16;

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

/// True if `p` looks like a MvC2 GDI data track (the ISO PVD's "CD001" is where it should be).
fn is_data_track(p: &Path) -> bool {
    let Ok(mut f) = File::open(p) else { return false };
    if f.seek(SeekFrom::Start(PVD_CD001_OFFSET)).is_err() {
        return false;
    }
    let mut b = [0u8; 6];
    f.read_exact(&mut b).is_ok() && &b[1..6] == b"CD001"
}

/// Recursively search `dir` for the data track. Prefers a file literally named `track03.bin`;
/// otherwise the largest `.bin`/`.iso`/`.img` whose ISO PVD validates. Returns its path.
fn find_data_track(dir: &Path) -> Option<String> {
    let mut best: Option<(u64, PathBuf)> = None;
    let mut named: Option<PathBuf> = None;
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&d) else { continue };
        for entry in rd.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
            if !matches!(ext.as_str(), "bin" | "iso" | "img") || !is_data_track(&path) {
                continue;
            }
            let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("").to_lowercase();
            if name == "track03.bin" {
                named = Some(path.clone());
            }
            let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
            if best.as_ref().map(|(s, _)| size > *s).unwrap_or(true) {
                best = Some((size, path));
            }
        }
    }
    named.or(best.map(|(_, p)| p)).map(|p| p.to_string_lossy().into_owned())
}

/// The sibling folder a zip extracts into (…/foo.zip → …/foo_extracted).
fn zip_extract_dir(zip: &Path) -> PathBuf {
    let stem = zip.file_stem().and_then(|s| s.to_str()).unwrap_or("rom");
    zip.parent().unwrap_or_else(|| Path::new(".")).join(format!("{stem}_extracted"))
}

/// Extract every entry of `zip` under `out` (guards against zip-slip via `enclosed_name`).
fn extract_zip(zip: &Path, out: &Path) -> Result<(), String> {
    let f = File::open(zip).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(f).map_err(|e| e.to_string())?;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        let Some(rel) = entry.enclosed_name() else { continue };
        let dest = out.join(rel);
        if entry.is_dir() {
            std::fs::create_dir_all(&dest).ok();
            continue;
        }
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut outf = File::create(&dest).map_err(|e| e.to_string())?;
        std::io::copy(&mut entry, &mut outf).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Resolve whatever the user picked — a `.zip` (of a GDI), a `.gdi`/`.bin`/`.iso`, or a folder —
/// down to the actual MvC2 data track path the reader/baker want. Zips are extracted once to a
/// sibling folder (re-used if already extracted). This is the "just hand us your dump" step.
#[tauri::command]
fn rom_prepare(path: String) -> Result<String, String> {
    let p = Path::new(&path);
    let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();

    if ext == "zip" {
        let out = zip_extract_dir(p);
        // Re-use a prior extraction if it already holds a valid data track; else (re)extract.
        if find_data_track(&out).is_none() {
            extract_zip(p, &out)?;
        }
        return find_data_track(&out)
            .ok_or_else(|| "That zip didn't contain a MvC2 GDI data track (track03.bin).".to_string());
    }

    // The picked file is itself the data track.
    if p.is_file() && is_data_track(p) {
        return Ok(path);
    }

    // A .gdi / .bin / .iso alongside the track, or a folder → search there.
    let dir = if p.is_dir() {
        p.to_path_buf()
    } else {
        p.parent().map(|x| x.to_path_buf()).unwrap_or_default()
    };
    find_data_track(&dir)
        .ok_or_else(|| "Couldn't find a MvC2 GDI data track (track03.bin) in that file or folder.".to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            rom_size, rom_read, rom_write, rom_backup, rom_prepare
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

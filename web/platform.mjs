// platform.mjs — filesystem adapter for the ROM (desktop Tauri vs. plain browser).
//
// Returns a ROM "handle" that DUCK-TYPES the subset of the File System Access API that
// rom-reader.mjs and rom-bake.mjs already use — so those two byte-faithful modules stay
// completely unchanged. Under Tauri the handle is backed by the Rust rom_* commands (real
// filesystem, any-size file, a real sibling .bak). In a plain Chromium browser it IS the
// native FileSystemFileHandle, exactly as before.
//
// FS-Access surface the ROM modules rely on:
//   handle.name, handle.getFile(), handle.createWritable(),
//   handle.queryPermission({mode}), handle.requestPermission({mode})
//   file.size, file.name, file.slice(start, end).arrayBuffer()
//   writable.write({ type:'write', position, data:Uint8Array }), writable.close()

export const isTauri = typeof window !== 'undefined' && !!window.__TAURI__;

const WEB_TYPES = [{
  description: 'GDI data track (track03.bin)',
  accept: { 'application/octet-stream': ['.bin'] },
}];

// Pick the ROM. Returns an FS-Access-shaped handle, or null if the user cancelled (or, on
// desktop, if the pick couldn't be resolved to a data track — the status line shows why).
// Desktop accepts whatever a Dreamcast dump usually is — a zipped GDI, a .gdi, the raw
// track03.bin, or a loose .iso — and `rom_prepare` (Rust) extracts/locates the real data track.
export async function pickRomHandle() {
  if (!isTauri) {
    const [h] = await window.showOpenFilePicker({ mode: 'readwrite', types: WEB_TYPES });
    return h;                                   // native FileSystemFileHandle (unchanged path)
  }
  const { invoke } = window.__TAURI__.core;
  const { open } = window.__TAURI__.dialog;
  const picked = await open({
    multiple: false,
    directory: false,
    filters: [{ name: 'MvC2 ROM — track03.bin, .gdi or .zip', extensions: ['bin', 'gdi', 'zip', 'iso', 'img'] }],
  });
  if (!picked) return null;                     // cancelled
  const path = String(picked);
  const st = (typeof document !== 'undefined') ? document.querySelector('.ss-romsrc') : null;
  if (st) st.textContent = /\.zip$/i.test(path) ? '📦 extracting zip & finding track03.bin…' : 'finding the data track…';
  try {
    const dataPath = await invoke('rom_prepare', { path });   // → resolved track03.bin (extracts a zip if needed)
    return makeTauriHandle(String(dataPath), invoke);
  } catch (e) {
    if (st) st.textContent = `❌ ${e}`;         // e.g. "That zip didn't contain a MvC2 GDI data track"
    return null;                                // treated as cancel by callers; the status shows the reason
  }
}

function makeTauriHandle(path, invoke) {
  const name = path.split(/[\\/]/).pop();
  return {
    name,
    _tauriPath: path,                           // used by backupRom()
    async queryPermission() { return 'granted'; },
    async requestPermission() { return 'granted'; },

    async getFile() {
      const size = await invoke('rom_size', { path });
      return {
        size,
        name,
        // Mirrors Blob.slice(start, end) — end exclusive, defaults to end-of-file.
        slice(start, end) {
          const offset = start;
          const length = (end == null ? size : end) - start;
          return {
            async arrayBuffer() {
              // rom_read returns a raw binary body → ArrayBuffer. Normalize across the
              // shapes a given Tauri/WebView version may hand back.
              const buf = await invoke('rom_read', { path, offset, length });
              if (buf instanceof ArrayBuffer) return buf;
              if (ArrayBuffer.isView(buf)) return buf.buffer;
              return new Uint8Array(buf).buffer;   // number[] fallback
            },
          };
        },
      };
    },

    async createWritable() {
      // rom-bake writes one sector (or a 4-byte ISO size patch) per call, then close().
      return {
        async write(chunk) {
          const position = chunk.position;
          const bytes = Array.from(chunk.data);  // compacts any subarray view for the arg
          await invoke('rom_write', { path, position, data: bytes });
        },
        async close() { /* every write already flushed to disk by the command */ },
      };
    },
  };
}

// Rebuild a ROM handle from a stored path (desktop only) — used by "remember last ROM" to reopen
// without a file dialog.
export async function romHandleFromPath(path) {
  if (!isTauri || !path) return null;
  const { invoke } = window.__TAURI__.core;
  return makeTauriHandle(String(path), invoke);
}

// Make a pristine <rom>.bak next to the ROM if one doesn't exist yet. Tauri-only — the browser
// build can't create a sibling file, so it relies on the extract-step / server .bak instead.
// Returns { created, name } under Tauri, or null on the web.
export async function backupRom(handle) {
  if (!isTauri) return null;
  const path = handle && handle._tauriPath;
  if (!path) return null;
  const { invoke } = window.__TAURI__.core;
  const created = await invoke('rom_backup', { path });
  return { created, name: handle.name + '.bak' };
}

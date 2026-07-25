// Stage a clean frontend for the Tauri bundle: copy web/ -> src-tauri/wwwroot EXCLUDING the
// ROM-derived web/test-atlas/ so the installer ships NO game data (BYOR). Runs as Tauri's
// beforeBuildCommand / beforeDevCommand (before Tauri checks that frontendDist exists), in plain
// Node so it's identical on Windows, macOS, and Linux — and CI already has Node (it installs the
// Tauri CLI via npm). Paths are resolved from this file, so the working directory doesn't matter.
import { cp, rm, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'web');
const dst = join(root, 'src-tauri', 'wwwroot');

if (!existsSync(src)) { console.error(`[stage-frontend] frontend source not found: ${src}`); process.exit(1); }
if (existsSync(dst)) await rm(dst, { recursive: true, force: true });
await mkdir(dst, { recursive: true });
await cp(src, dst, {
  recursive: true,
  filter: (p) => !p.split(/[\\/]/).includes('test-atlas'), // skip the ROM-derived per-user sprite bundles
});
console.log(`[stage-frontend] ${src} -> ${dst} (excluded test-atlas)`);

// rom-bake.mjs — browser-native MVC2 sprite bake. Pure-JS port of tools/gfx1_lzss.py +
// rebuild_gfx1.py + part_png.py + bake_skin.py, validated byte-for-byte against them in Node.
// No DOM here — these are pure functions over Uint8Array so they run in Node (validation) AND
// the browser. The File System Access glue lives in tile-editor.mjs.
//
// Reference (CONFIRMED): GFX1 LZSS decoder loc_8c0354c0; offset table = nParts u32, table[0]=
// nParts*4, no sentinel, last part ends at GFX2; parts tight-packed [hdr(lw,lh,sw,sh)+blob];
// pixels 4bpp PAL4 PVR-twiddled; placement model -dx (editor). DAT header u32: GFX1@0, GFX2@4, Pal@8.

const RAW = 2352, BASE = 45000, SECU = 2048;   // GDI track03: raw sector, track LBA, user bytes

// ---- little-endian helpers ----
const u32 = (a, o) => (a[o] | (a[o+1]<<8) | (a[o+2]<<16) | (a[o+3]<<24)) >>> 0;
const setU32 = (a, o, v) => { a[o]=v&255; a[o+1]=(v>>>8)&255; a[o+2]=(v>>>16)&255; a[o+3]=(v>>>24)&255; };

// ---- GFX1 LZSS (port of decodeA/encodeA) ----
export function decodeA(src, destLen) {
  const out = new Uint8Array(destLen); let op = 0, sp = 0, bc = 0, flags = 0; const n = src.length;
  while (op < destLen && sp < n) {
    if (bc === 0) { flags = src[sp++]; bc = 0x80; if (sp >= n) break; }
    if ((flags & bc) === 0) { out[op++] = src[sp++]; }
    else { const b = src[sp++]; let srcpos = op - (b >> 4) - 1; const cnt = (b & 0x0F) + 2;
      for (let k = 0; k < cnt && op < destLen; k++) { out[op++] = (srcpos >= 0 && srcpos < op) ? out[srcpos] : 0; srcpos++; } }
    bc >>= 1;
  }
  return out;
}
export function encodeA(data) {
  const out = []; let i = 0; const n = data.length;
  while (i < n) {
    const flagPos = out.length; out.push(0); let flags = 0;
    for (let bit = 0; bit < 8 && i < n; bit++) {
      const bc = 0x80 >> bit; let bestLen = 0, bestStart = 0; const lo = Math.max(0, i - 16);
      for (let start = lo; start < i; start++) {
        const period = i - start; let l = 0;
        while (l < 17 && i + l < n && data[i + l] === data[start + (l % period)]) l++;
        if (l > bestLen) { bestLen = l; bestStart = start; if (l === 17) break; }
      }
      if (bestLen >= 2) { flags |= bc; const dist = i - bestStart - 1; out.push((dist << 4) | ((bestLen - 2) & 0x0F)); i += bestLen; }
      else { out.push(data[i]); i++; }
    }
    out[flagPos] = flags;
  }
  return Uint8Array.from(out);
}

// ---- PVR PAL4 twiddle (port of extract_gfx1_atlas detwiddle + part_png twiddle) ----
function twiddleSlow(x, y, xSz, ySz) {
  let rv = 0, sh = 0; xSz >>= 1; ySz >>= 1;
  while (xSz !== 0 || ySz !== 0) {
    if (ySz !== 0) { rv |= (y & 1) << sh; ySz >>= 1; y >>= 1; sh++; }
    if (xSz !== 0) { rv |= (x & 1) << sh; xSz >>= 1; x >>= 1; sh++; }
  }
  return rv;
}
const DETW = [[], []];
for (let s = 0; s < 11; s++) {
  const ysz = 1 << s; DETW[0][s] = new Int32Array(1024); DETW[1][s] = new Int32Array(1024);
  for (let i = 0; i < 1024; i++) { DETW[0][s][i] = twiddleSlow(i, 0, 1024, ysz); DETW[1][s][i] = twiddleSlow(0, i, ysz, 1024); }
}
const PAL4_ORDER = [[0,0],[0,1],[1,0],[1,1],[0,2],[0,3],[1,2],[1,3],[2,0],[2,1],[3,0],[3,1],[2,2],[2,3],[3,2],[3,3]];
const bcl = (n) => 31 - Math.clz32(n);   // bit_length-1
export function detwiddlePal4(data, w, h) {
  const bcx = bcl(w), bcy = bcl(h); const idx = new Uint8Array(w * h);
  for (let y = 0; y < h; y += 4) for (let x = 0; x < w; x += 4) {
    const blk = ((DETW[0][bcy][x] + DETW[1][bcx][y]) / 16) | 0, base = blk * 8;
    for (let i = 0; i < 16; i++) { const cx = PAL4_ORDER[i][0], cy = PAL4_ORDER[i][1];
      const b = (base + (i >> 1) < data.length) ? data[base + (i >> 1)] : 0;
      idx[(y + cy) * w + (x + cx)] = (i & 1) === 0 ? (b & 0xF) : ((b >> 4) & 0xF); }
  }
  return idx;
}
export function twiddlePal4(idx, w, h) {
  const bcx = bcl(w), bcy = bcl(h); const data = new Uint8Array((w * h) / 2);
  for (let y = 0; y < h; y += 4) for (let x = 0; x < w; x += 4) {
    const blk = ((DETW[0][bcy][x] + DETW[1][bcx][y]) / 16) | 0, base = blk * 8;
    for (let i = 0; i < 16; i++) { const cx = PAL4_ORDER[i][0], cy = PAL4_ORDER[i][1];
      const nib = idx[(y + cy) * w + (x + cx)] & 0xF, bp = base + (i >> 1); if (bp >= data.length) continue;
      data[bp] = (i & 1) === 0 ? ((data[bp] & 0xF0) | nib) : ((data[bp] & 0x0F) | (nib << 4)); }
  }
  return data;
}
export function vflip(buf, w, h) { const o = new Uint8Array(buf.length); for (let y = 0; y < h; y++) o.set(buf.subarray((h-1-y)*w, (h-1-y)*w + w), y*w); return o; }

// display-order indices (right-side-up, as the editor paints) -> twiddled 4bpp blob pixels
export function paintedToBlobPixels(idx, w, h) { return twiddlePal4(vflip(idx, w, h), w, h); }

// ---- DAT parse + offset-table rebuild (port of rebuild_dat) ----
export function parseDAT(dat) {
  const gfx1 = u32(dat, 0), gfx2 = u32(dat, 4), pal = u32(dat, 8);
  const nParts = u32(dat, gfx1) >>> 2;
  return { gfx1, gfx2, pal, nParts, span: gfx2 - gfx1 };
}
export function partInfo(dat, sel) {
  const { gfx1, gfx2, nParts } = parseDAT(dat);
  const o0 = u32(dat, gfx1 + sel * 4), o1 = (sel + 1 < nParts) ? u32(dat, gfx1 + (sel + 1) * 4) : (gfx2 - gfx1);
  const sw = dat[gfx1 + o0 + 2], sh = dat[gfx1 + o0 + 3];
  return { o0, o1, w: sw * 8, h: sh * 8, blobOff: gfx1 + o0 + 4, blobEnd: gfx1 + o1 };
}
// edits: Map<sel, Uint8Array twiddled-4bpp pixels>. Unedited parts keep their original blob bytes.
export function rebuildDat(dat, edits) {
  const { gfx1, gfx2, nParts, span } = parseDAT(dat);
  const tbl = []; for (let i = 0; i < nParts; i++) tbl.push(u32(dat, gfx1 + i * 4));
  const newTbl = []; const parts = []; let cur = nParts * 4;
  for (let i = 0; i < nParts; i++) {
    const o0 = tbl[i], o1 = (i + 1 < nParts) ? tbl[i + 1] : span;
    const header = dat.subarray(gfx1 + o0, gfx1 + o0 + 4);
    let blob;
    if (edits.has(i)) blob = encodeA(edits.get(i));
    else blob = dat.subarray(gfx1 + o0 + 4, gfx1 + o1);
    newTbl.push(cur); parts.push(header, blob); cur += 4 + blob.length;
  }
  const total = nParts * 4 + parts.reduce((s, p) => s + p.length, 0);
  const writeGfx1 = (buf) => { for (let i = 0; i < nParts; i++) setU32(buf, gfx1 + i * 4, newTbl[i]); let off = gfx1 + nParts * 4; for (const p of parts) { buf.set(p, off); off += p.length; } };
  if (total <= span) {                                  // fits — pad GFX1 to original span, DAT size unchanged
    const out = new Uint8Array(dat); out.fill(0, gfx1, gfx1 + span); writeGfx1(out); return out;
  }
  // GROW: GFX1 needs `shift` more bytes → push everything after GFX1 down, update header pointers.
  const shift = total - span;
  const out = new Uint8Array(dat.length + shift);
  out.set(dat.subarray(0, gfx1), 0);                    // header + pre-GFX1
  writeGfx1(out);                                       // grown GFX1 (size = total, no pad)
  out.set(dat.subarray(gfx2), gfx1 + total);            // GFX2/Pal/sections, shifted by `shift`
  for (let i = 0; i < (gfx1 >> 2); i++) { const v = u32(out, i * 4); if (v !== 0 && v >= gfx2) setU32(out, i * 4, v + shift); }  // bump EVERY header section ptr (the header runs [0,gfx1); 14 real on PL17). loader: loc_8c031fa0
  return out;
}
function argb4444(r, g, b, a) { return (((a >> 4) << 12) | ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4)) >>> 0; }
export function applyPalette(dat, palEdits) {
  const { pal } = parseDAT(dat); const out = new Uint8Array(dat);
  for (const bank in palEdits) for (const idx in palEdits[bank]) {
    const [r, g, b, a] = palEdits[bank][idx]; const off = pal + (bank * 16 + (+idx)) * 2; const v = argb4444(r, g, b, a);
    out[off] = v & 255; out[off + 1] = (v >> 8) & 255;
  }
  return out;
}

// ---- ISO9660 (find PLxx_DAT.BIN in a desectored track03 directory image) ----
// readUser(absLba) must return the 2048 user bytes of that sector (caller provides it,
// since in the browser we read slices and in Node we read the file).
export function findDAT(readUser, charname) {
  const pvd = readUser(BASE + 16);
  const rl = u32(pvd, 156 + 2), rn = u32(pvd, 156 + 10);
  const nsec = Math.ceil(rn / SECU); const d = new Uint8Array(nsec * SECU);
  for (let i = 0; i < nsec; i++) d.set(readUser(rl + i), i * SECU);
  const tgt = (charname.toUpperCase() + "_DAT"); let off = 0;
  const dec = new TextDecoder('latin1');
  while (off < rn) {
    const L = d[off]; if (L === 0) { off = (((off / SECU) | 0) + 1) * SECU; if (off >= rn) break; continue; }
    const e = u32(d, off + 2), ln = u32(d, off + 10), nl = d[off + 32];
    const nm = dec.decode(d.subarray(off + 33, off + 33 + nl));
    if (nm.toUpperCase().startsWith(tgt)) return { lba: e, size: ln, rootLba: rl, entryOff: off };
    off += L;
  }
  throw new Error("DAT not found: " + charname);
}
export function desector(readUser, lba, size) {
  const nsec = Math.ceil(size / SECU); const out = new Uint8Array(nsec * SECU);
  for (let i = 0; i < nsec; i++) out.set(readUser(lba + i), i * SECU);
  return out.subarray(0, size);
}
export const consts = { RAW, BASE, SECU };

// ---- File System Access API: bake straight into a picked GDI track03.bin, IN PLACE ----
// Reads only the sprite sectors (slices — never the whole 1.2GB), patches them, writes back.
async function rd(file, off, len) { return new Uint8Array(await file.slice(off, off + len).arrayBuffer()); }
export async function bakeToTrack03(handle, char, edits, palEdits) {
  const file = await handle.getFile();
  const pvd = await rd(file, 16 * RAW + 16, SECU);                    // ISO PVD = sector (BASE+16)
  if (String.fromCharCode(pvd[1], pvd[2], pvd[3], pvd[4], pvd[5]) !== "CD001")
    throw new Error("That file isn't the GDI data track — pick track03.bin");
  const rl = u32(pvd, 156 + 2), rn = u32(pvd, 156 + 10);
  const rootRaw = await rd(file, (rl - BASE) * RAW, Math.ceil(rn / SECU) * RAW);
  const readUser = (abs) => abs === BASE + 16 ? pvd : rootRaw.subarray((abs - rl) * RAW + 16, (abs - rl) * RAW + 16 + SECU);
  const { lba, size, rootLba, entryOff } = findDAT(readUser, char);
  const datNsec = Math.ceil(size / SECU), sectorAlloc = datNsec * SECU;
  const datRaw = await rd(file, (lba - BASE) * RAW, datNsec * RAW);
  const readUserDat = (abs) => datRaw.subarray((abs - lba) * RAW + 16, (abs - lba) * RAW + 16 + SECU);
  let dat = desector(readUserDat, lba, size);
  if (palEdits) dat = applyPalette(dat, palEdits);
  if (edits.size) dat = rebuildDat(dat, edits);          // may grow the DAT (GFX1 + shifted sections)
  const newSize = dat.length;
  if (newSize > sectorAlloc)
    throw new Error(`edit needs ${newSize - size} more bytes; only ${sectorAlloc - size} of free slack in this file. Simplify the edit (fewer colours / more transparent), or a full disc repack is needed.`);
  const newNsec = Math.ceil(newSize / SECU);
  const w = await handle.createWritable({ keepExistingData: true });   // don't truncate the 1.2GB
  for (let i = 0; i < newNsec; i++)
    await w.write({ type: "write", position: (lba - BASE + i) * RAW + 16, data: dat.subarray(i * SECU, Math.min((i + 1) * SECU, newSize)) });
  if (newSize !== size) {                                 // DAT grew → patch ISO9660 dir size (LE @+10, BE @+14)
    const esec = rootLba + Math.floor(entryOff / SECU), ew = entryOff % SECU;
    const le = new Uint8Array(4); setU32(le, 0, newSize);
    const be = Uint8Array.of((newSize >>> 24) & 255, (newSize >>> 16) & 255, (newSize >>> 8) & 255, newSize & 255);
    await w.write({ type: "write", position: (esec - BASE) * RAW + 16 + ew + 10, data: le });
    await w.write({ type: "write", position: (esec - BASE) * RAW + 16 + ew + 14, data: be });
  }
  await w.close();
  // VERIFY the write actually persisted (re-open the file fresh and read the DAT back)
  const v = await handle.getFile();
  const vNsec = Math.ceil(newSize / SECU);
  const vraw = new Uint8Array(await v.slice((lba - BASE) * RAW, (lba - BASE + vNsec) * RAW).arrayBuffer());
  const vReadUser = (abs) => vraw.subarray((abs - lba) * RAW + 16, (abs - lba) * RAW + 16 + SECU);
  const vdat = desector(vReadUser, lba, newSize);
  let diff = 0; for (let i = 0; i < newSize; i++) if (vdat[i] !== dat[i]) diff++;
  return { char, lba, size: newSize, grew: newSize - size, parts: edits.size, banks: palEdits ? Object.keys(palEdits).length : 0, verified: diff === 0, diff };
}
export const supportsFS = () => typeof window !== 'undefined' && !!window.showOpenFilePicker;

// Create <fileName>.bak next to the ROM (in dirHandle) if it doesn't already exist — a
// pristine, streamed full-file copy so an in-place bake is always recoverable. If a .bak
// is already there we keep it (it's the untouched original). On any error the partial
// .bak is aborted + removed and the error re-thrown so the caller can refuse to bake.
export async function ensureBackup(dirHandle, fileName, onProgress) {
  const bakName = fileName + '.bak';
  try { await dirHandle.getFileHandle(bakName); return { created: false, name: bakName }; } catch { /* not there yet */ }
  const srcH = await dirHandle.getFileHandle(fileName);
  const src = await srcH.getFile();
  const bakH = await dirHandle.getFileHandle(bakName, { create: true });
  const w = await bakH.createWritable();
  try {
    const total = src.size; let done = 0;
    const reader = src.stream().getReader();
    for (;;) {
      const { done: d, value } = await reader.read();
      if (d) break;
      await w.write(value); done += value.byteLength;
      onProgress && onProgress(done, total);
    }
    await w.close();
    return { created: true, name: bakName, bytes: src.size };
  } catch (e) {
    try { await w.abort(); } catch { /* ignore */ }
    try { await dirHandle.removeEntry(bakName); } catch { /* ignore */ }   // don't leave a truncated .bak
    throw e;
  }
}

// Read a character's raw DAT bytes from a GDI data track (for backup / inspection).
export async function readDat(handle, char) {
  const file = await handle.getFile();
  const pvd = await rd(file, 16 * RAW + 16, SECU);
  if (String.fromCharCode(pvd[1],pvd[2],pvd[3],pvd[4],pvd[5]) !== 'CD001')
    throw new Error("Not the GDI data track — pick track03.bin");
  const rl = u32(pvd, 156+2), rn = u32(pvd, 156+10);
  const rootRaw = await rd(file, (rl-BASE)*RAW, Math.ceil(rn/SECU)*RAW);
  const readUser = (abs) => abs === BASE+16 ? pvd : rootRaw.subarray((abs-rl)*RAW+16, (abs-rl)*RAW+16+SECU);
  const { lba, size } = findDAT(readUser, char);
  const datNsec = Math.ceil(size/SECU);
  const datRaw = await rd(file, (lba-BASE)*RAW, datNsec*RAW);
  const readDatU = abs => datRaw.subarray((abs-lba)*RAW+16, (abs-lba)*RAW+16+SECU);
  return { dat: desector(readDatU, lba, size), lba, size };
}

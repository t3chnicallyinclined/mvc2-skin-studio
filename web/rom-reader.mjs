// rom-reader.mjs — in-browser character extractor from a GDI track03.bin.
// Builds in-memory equivalents of PLxx_lut.json + PLxx_asm.json + PLxx_edit bundle,
// so Skin Studio can load and edit characters directly from the user's ROM.
// All decoders are re-used from rom-bake.mjs — no separate copy.

import { parseDAT, partInfo, findDAT, desector, decodeA, detwiddlePal4, vflip, consts } from './rom-bake.mjs?v=6';

const { RAW, BASE, SECU } = consts;
const HEX2 = n => n.toString(16).toUpperCase().padStart(2, '0');
const u32 = (a, o) => (a[o] | (a[o+1]<<8) | (a[o+2]<<16) | (a[o+3]<<24)) >>> 0;
const s16 = (a, o) => (a[o] | (a[o+1]<<8)) << 16 >> 16;
const ATLAS_W = 2048;

async function rd(file, off, len) {
  return new Uint8Array(await file.slice(off, off + len).arrayBuffer());
}

export class RomReader {
  constructor(file, rl, rn, pvd) {
    this._file = file; this._rl = rl; this._rn = rn; this._pvd = pvd;
  }

  // file: File object (from handle.getFile() or <input type=file>)
  static async fromFile(file) {
    const pvd = await rd(file, 16 * RAW + 16, SECU);
    if (String.fromCharCode(pvd[1],pvd[2],pvd[3],pvd[4],pvd[5]) !== 'CD001')
      throw new Error("Not the GDI data track — pick track03.bin");
    return new RomReader(file, u32(pvd, 156+2), u32(pvd, 156+10), pvd);
  }

  // Locate the GDI data track inside a directory handle. Prefers track03.bin by name,
  // else the largest .bin whose ISO PVD validates. Returns { handle, name }.
  static async findInDir(dir) {
    let best = null, bestSize = -1;
    for await (const [name, h] of dir.entries()) {
      if (h.kind !== 'file' || !/\.bin$/i.test(name)) continue;
      let f; try { f = await h.getFile(); } catch { continue; }
      try { await RomReader.fromFile(f); } catch { continue; }   // not a CD001 data track
      if (name.toLowerCase() === 'track03.bin') return { handle: h, name };
      if (f.size > bestSize) { best = { handle: h, name }; bestSize = f.size; }
    }
    if (best) return best;
    throw new Error('No GDI data track (track03.bin) found in that folder');
  }

  async _getDat(charname) {
    const rootRaw = await rd(this._file, (this._rl-BASE)*RAW, Math.ceil(this._rn/SECU)*RAW);
    const readUser = abs => abs === BASE+16 ? this._pvd
      : rootRaw.subarray((abs-this._rl)*RAW+16, (abs-this._rl)*RAW+16+SECU);
    const { lba, size } = findDAT(readUser, charname);
    const datRaw = await rd(this._file, (lba-BASE)*RAW, Math.ceil(size/SECU)*RAW);
    const readDatU = abs => datRaw.subarray((abs-lba)*RAW+16, (abs-lba)*RAW+16+SECU);
    return desector(readDatU, lba, size);
  }

  // Returns { lut, asm, bundle, bundleImg, bundleData } — same shape as server-side files.
  async extractChar(cid) {
    const dat = await this._getDat(`PL${HEX2(cid)}`);
    const { gfx1, gfx2, pal, nParts } = parseDAT(dat);

    // --- Palette (bank 0, ARGB4444 LE → [r,g,b,a]) ---
    const bank0 = Array.from({ length: 16 }, (_, i) => {
      if (i === 0) return [0,0,0,0];
      const off = pal + i*2;
      if (off+1 >= dat.length) return [0,0,0,0];
      const v = dat[off] | (dat[off+1]<<8);
      const a = ((v>>12)&0xF)*17, r = ((v>>8)&0xF)*17, g = ((v>>4)&0xF)*17, bl = (v&0xF)*17;
      return [r, g, bl, a === 0 ? 0 : 255];
    });
    const lut = { bodyBank: 0, banks: { 0: bank0 } };

    // --- GFX2 assembly (sprite_id → [{dx,dy,part,flip,flipy}] with cumulative pen) ---
    const gfx2Sec = dat.subarray(gfx2, pal);
    const assemblies = {};
    if (gfx2Sec.length >= 4) {
      const n = u32(gfx2Sec, 0) >> 2;
      for (let idx = 0; idx < n; idx++) {
        const off = u32(gfx2Sec, idx*4);
        if (off+2 > gfx2Sec.length) continue;
        const cnt = gfx2Sec[off] | (gfx2Sec[off+1]<<8);
        if (!cnt || cnt > 256 || off+2+cnt*8 > gfx2Sec.length) continue;
        let p = off+2, px = 0, py = 0;
        const recs = [];
        for (let ri = 0; ri < cnt; ri++, p += 8) {
          const dx = s16(gfx2Sec, p), dy = s16(gfx2Sec, p+2);
          const flags = gfx2Sec[p+4]|(gfx2Sec[p+5]<<8), sel = gfx2Sec[p+6]|(gfx2Sec[p+7]<<8);
          px += dx; py -= dy;
          recs.push({ dx: px, dy: py, part: sel, flip: !!(flags&0x4000), flipy: !!(flags&0x8000) });
        }
        if (recs.length) assemblies[String(idx)] = recs;
      }
    }

    // --- GFX1 part pixels: decode → detwiddle → vflip → RGBA, shelf-pack into atlas ---
    const tiles = [];
    for (let sel = 0; sel < nParts; sel++) {
      const { w, h, blobOff, blobEnd } = partInfo(dat, sel);
      if (w <= 0 || h <= 0 || w > 1024 || h > 1024) continue;
      const destLen = (w*h) >> 1; if (!destLen) continue;
      const raw = decodeA(dat.subarray(blobOff, blobEnd), destLen);
      const disp = vflip(detwiddlePal4(raw, w, h), w, h); // right-side-up display order
      const rgba = new Uint8Array(w*h*4);
      for (let i = 0; i < w*h; i++) {
        const c = bank0[disp[i]]; if (!c || disp[i] === 0 || c[3] === 0) continue;
        const p = i<<2; rgba[p]=c[0]; rgba[p+1]=c[1]; rgba[p+2]=c[2]; rgba[p+3]=255;
      }
      tiles.push({ sel, w, h, rgba });
    }

    tiles.sort((a, b) => b.h - a.h);
    const rects = {}; let ax = 0, ay = 0, rowh = 0;
    const placed = [];
    for (const { sel, w, h, rgba } of tiles) {
      if (ax + w > ATLAS_W) { ax = 0; ay += rowh; rowh = 0; }
      rects[sel] = { x: ax, y: ay, w, h };
      placed.push({ ax, ay, w, h, rgba });
      ax += w+1; rowh = Math.max(rowh, h);
    }
    const atlasH = ay + rowh || 1;
    const bundleData = new Uint8ClampedArray(ATLAS_W * atlasH * 4);
    for (const { ax, ay, w, h, rgba } of placed)
      for (let y = 0; y < h; y++)
        bundleData.set(rgba.subarray(y*w*4, (y+1)*w*4), ((ay+y)*ATLAS_W+ax)*4);

    const bundleImg = await createImageBitmap(new ImageData(bundleData, ATLAS_W, atlasH));

    // --- Animation groups (header slot 5 = ANIMATION_DATA) ---
    const anim = _parseAnimGroups(dat, cid);

    return { lut, asm: { assemblies }, bundle: { w: ATLAS_W, h: atlasH, parts: rects }, bundleImg, bundleData, anim };
  }
}

function _parseAnimGroups(dat, cid) {
  const u8  = (o) => dat[o];
  const u16 = (o) => dat[o] | (dat[o+1]<<8);
  const u32 = (o) => (dat[o] | (dat[o+1]<<8) | (dat[o+2]<<16) | (dat[o+3]<<24)) >>> 0;

  const animBase = u32(5 * 4);   // header slot 5 = byte offset 0x14
  const nextSec  = u32(6 * 4);   // header slot 6 (HITBOX_PATTERN_TABLE)
  const secLen   = nextSec - animBase;

  // Sentinel (char 0x34) uses a 0x200-byte pre-table header; all others use 0x100.
  const preTableSize = (cid === 0x34) ? 0x200 : 0x100;
  const GT = animBase + preTableSize;  // group pointer table base (abs offset in dat)

  // Scan group table until we hit a null entry.
  const groupBases = [];
  for (let i = 0; i < 256; i++) {
    const entry = u32(GT + i * 4);
    if (!entry) break;
    groupBases.push(entry);
  }

  const groups = {};
  for (let g = 0; g < groupBases.length; g++) {
    const base = groupBases[g];

    // Scan per-group anim pointer table until null entry.
    const subanims = [];
    for (let si = 0; si < 256; si++) {
      const cellOff = u32(animBase + base + si * 4);
      if (!cellOff || cellOff >= secLen) break;

      const cells = [];
      let pos = animBase + cellOff;
      for (let guard = 0; guard < 512; guard++) {
        if (pos + 20 > dat.length) break;
        const ender     = u8(pos + 3);
        const sprite_id = u16(pos + 4);
        cells.push({ sprite_id, duration: u8(pos + 2), ender,
                     renderExtra: u8(pos + 0x11), hitboxGroup: u8(pos + 0x12) });
        pos += 20;
        if (ender & 0x80) break;
      }
      if (cells.length) subanims.push({ cells });
    }
    if (!subanims.length) continue;

    const sids   = subanims.flatMap(s => s.cells.map(c => c.sprite_id)).filter(s => s !== 0xFFFF);
    const masked = sids.map(s => s & 0x7FFF);
    const scaled = sids.some(s => s & 0x8000);
    const smax   = masked.length ? Math.max(...masked) : 0;
    const smin   = masked.length ? Math.min(...masked) : 0;
    const kind   = scaled ? 'effect' : smax >= 180 ? 'special' : 'body';

    groups[String(g)] = { name: `group ${g}`, kind, sidRange: [smin, smax], subanims };
  }
  return { groups };
}

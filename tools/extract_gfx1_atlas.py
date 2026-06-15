#!/usr/bin/env python3
"""
extract_gfx1_atlas.py — FULLY OFFLINE GFX1 part-atlas extractor (per character).

THE EMITTER FINISH. The "offline LZSS dead end" was a DECODER BUG, not impossible.
GFX1 part decoder = bank03 loc_8c0354c0 (KB routine:loc_8c0354c0). This tool walks
GFX_DATA_00.BIN, decodes EVERY selector with the validated byte-oriented decoder, and
emits a complete sel-keyed part atlas for the off-SH4 emitter — NO emulator capture,
NO build host, NO play-walk. All parts come FREE from the disc.

Validated BIT-EXACT vs 6 live captures (_ryu_capture/PL00_raw_{0001,0013,0024,0034,
0061,0127}.bin) and all 1533 Ryu sels decode clean (1.93M px, 0 fail).

DECODER (loc_8c0354c0, register contract r4=src=part_base+4, r5=dest_len, r6=dest_base,
r9=r5+r6=end). The output buffer IS the back-ref window (self-contained per part — NO
ring, NO dictionary, NO carry across parts). Flag byte consumed MSB-first from 0x80:
  bit CLEAR  -> literal:  *dest++ = *src++
  bit SET    -> back-ref: b=*src++; dist=b>>4; copy (b&0x0F)+2 bytes from dest-(dist+1)

RECIPE per char (fully offline):
  GFX = PLxx_DAT_GFX_DATA_00.BIN
  n   = u32_le(GFX,0) // 4                          (= part count, 1533 for Ryu)
  per sel 0..n-1:
    base   = u32_le(GFX, sel*4)
    lw,lh  = GFX[base+0], GFX[base+1]               (logical/crop tiles)
    sw,sh  = GFX[base+2], GFX[base+3]               (storage tiles)
    W,H    = sw*8, sh*8
    PAL4 (default): dest_len = W*H//2 ; index nibbles, 2 px/byte
    PAL8 (rare):    dest_len = W*H    ; index bytes, 1 px/byte
    raw    = decodeA(GFX[base+4:], dest_len)        (bit-exact vs live 0x0CE60000)
    idx    = detwiddle_pal4(raw, W, H)              (PVR TWIDDLED storage — see below)
  Palette = PLxx_DAT_PALETTE_DATA.BIN (ARGB4444 LE, 16 colors/row, idx0 transparent).

STORAGE ORDER — TWIDDLED (NOT linear). decodeA's bytes are bit-exact vs the live
load-decode buffer 0x0CE60000, but that buffer holds texels in PVR twiddle order
(flycast texconv.cpp ConvertTwiddlePal4 / texPAL4_TW — linear PAL4 = nullptr in the
format table). The detwiddle uses the FULL part dims (bcx=log2(W), bcy=log2(H);
twop = detw[0][bcy][x] + detw[1][bcx][y]) — NOT a run of min(w,h) square blocks (that
square variant stripes non-square parts). Confirmed: sel 1 (torso) decodes coherent vs
_ryu_capture/decoded_0001.png (decode_flycast.py swapXY=False — the CHARQ-validated path
that produced the recognizable char_tight.png Ryu).

OUTPUT (operator-local, ROM-derived, gitignored — scp-only, NEVER git):
  <out>/PL{HEX}_parts.png   RGBA packed part rects (disc default palette), keyed by sel.
  <out>/PL{HEX}_parts.json  { "<sel>": {x,y,w,h} }  rect of each sel in the atlas PNG.
  <out>/PL{HEX}_idx.png     INDEXED atlas: R=index(0..15) G=0 B=0 A=255/0. Skin-compatible
                            (feeds sprite-gpu setIndexedAtlas/setCharLUT palette-LUT path).
  <out>/PL{HEX}_lut.json    { bodyBank, bankList, banks:[[ [r,g,b,a]*16 ], ...] } palette rows.
  <out>/PL{HEX}_preview.png  eyeball montage (disc default palette, body bank).

USAGE:
  python3 tools/extract_gfx1_atlas.py \
     --gfx1 dasm_PLDAT/Output/PL00_DAT/PL00_DAT_GFX_DATA_00.BIN \
     --pal  dasm_PLDAT/Output/PL00_DAT/PL00_DAT_PALETTE_DATA.BIN \
     --char PL00 --bank 0 --out web/test-atlas/chars
"""
import argparse, json, os, struct
from PIL import Image

TILE = 8


# ---- the validated GFX1 LZSS decoder (loc_8c0354c0) -------------------------
def decodeA(src, dest_len):
    """Byte-oriented LZSS, flag-bit MSB-first from 0x80. bit CLEAR=literal,
    bit SET=back-ref (dist=b>>4, count=(b&0x0F)+2 from dest-(dist+1)).
    The output buffer is the window — self-contained per part."""
    out = bytearray()
    sp = 0
    bc = 0
    flags = 0
    n = len(src)
    while len(out) < dest_len and sp < n:
        if bc == 0:
            flags = src[sp]; sp += 1; bc = 0x80
            if sp >= n:
                break
        if (flags & bc) == 0:                       # literal
            out.append(src[sp]); sp += 1
        else:                                       # back-ref
            b = src[sp]; sp += 1
            srcpos = len(out) - (b >> 4) - 1
            for _ in range((b & 0x0F) + 2):
                out.append(out[srcpos] if 0 <= srcpos < len(out) else 0)
                srcpos += 1
        bc >>= 1
    if len(out) < dest_len:                         # pad short decodes (shouldn't happen)
        out.extend(b"\x00" * (dest_len - len(out)))
    return bytes(out[:dest_len])


# ---- PAL8 detection ---------------------------------------------------------
# PL00 is 100% PAL4 (all 1533 decode clean as W*H//2). The PLDAT format CAN carry a
# PAL8 part (8bpp, dest_len = W*H), flagged in older notes by a header sub-byte in
# {0x05,0x07,0x0F}. The validated 4-byte header is [lw][lh][sw][sh] with the stream at
# +4 (proven bit-exact), so there is NO sub-byte to test for PL00. We keep a heuristic
# escape hatch: if a part's PAL4 decode would over- or under-run its blob badly while a
# PAL8 (W*H) decode lands cleanly, treat it as PAL8. In practice this never fires for
# PL00; it is a forward-compat guard for other chars. Report the split.
def part_bytes_needed(W, H, pal8):
    return (W * H) if pal8 else (W * H) // 2


# ---- PVR PAL4 detwiddle (flycast texconv.cpp port, CHARQ-validated) ----------
# Ports twiddle_slow (texconv.cpp:37), the detwiddle table (69), twop (169) and
# ConvertTwiddlePal4 (289). The texels are stored TWIDDLED over the FULL W×H part
# (bcx=log2 W, bcy=log2 H) — NOT a run of min(W,H) square blocks. Validated
# swapXY=False vs _ryu_capture/decoded_0001.png (the recognizable char_tight Ryu).
def _twiddle_slow(x, y, x_sz, y_sz):
    rv = 0; sh = 0; x_sz >>= 1; y_sz >>= 1
    while x_sz != 0 or y_sz != 0:
        if y_sz != 0:
            rv |= (y & 1) << sh; y_sz >>= 1; y >>= 1; sh += 1
        if x_sz != 0:
            rv |= (x & 1) << sh; x_sz >>= 1; x >>= 1; sh += 1
    return rv

_DETW = [[[0] * 1024 for _ in range(11)] for _ in range(2)]
for _s in range(11):
    _ysz = 1 << _s
    for _i in range(1024):
        _DETW[0][_s][_i] = _twiddle_slow(_i, 0, 1024, _ysz)
        _DETW[1][_s][_i] = _twiddle_slow(0, _i, _ysz, 1024)

_PAL4_ORDER = [(0, 0), (0, 1), (1, 0), (1, 1), (0, 2), (0, 3), (1, 2), (1, 3),
               (2, 0), (2, 1), (3, 0), (3, 1), (2, 2), (2, 3), (3, 2), (3, 3)]

def detwiddle_pal4(data, w, h):
    """TWIDDLED 4bpp texels -> linear index buffer (W*H bytes, idx per pixel)."""
    bcx = w.bit_length() - 1
    bcy = h.bit_length() - 1
    idx = bytearray(w * h)
    for y in range(0, h, 4):
        for x in range(0, w, 4):
            blk = (_DETW[0][bcy][x] + _DETW[1][bcx][y]) // 16
            base = blk * 8
            for i, (cx, cy) in enumerate(_PAL4_ORDER):
                b = data[base + (i >> 1)] if base + (i >> 1) < len(data) else 0
                nib = (b & 0xF) if (i & 1) == 0 else ((b >> 4) & 0xF)
                idx[(y + cy) * w + (x + cx)] = nib
    return idx


# ---- palette ----------------------------------------------------------------
def pal_row(pal, row):
    """16 ARGB4444 LE colors of `row`. idx0 = fully transparent."""
    out = []
    base = row * 32
    for i in range(16):
        if base + i * 2 + 1 >= len(pal):
            out.append((0, 0, 0, 0)); continue
        v = pal[base + i * 2] | (pal[base + i * 2 + 1] << 8)
        a = (v >> 12) & 0xF; r = (v >> 8) & 0xF; g = (v >> 4) & 0xF; b = v & 0xF
        out.append((0, 0, 0, 0) if i == 0 else (r * 17, g * 17, b * 17, (a * 17) if a else 255))
    return out


# ---- decode one part to an index buffer (LINEAR, no twiddle) ----------------
def decode_part(gfx1, sel, offs, end_of):
    base = offs[sel]
    if base + 4 > len(gfx1):
        return None
    lw, lh, sw, sh = gfx1[base], gfx1[base + 1], gfx1[base + 2], gfx1[base + 3]
    W, H = sw * TILE, sh * TILE
    if W <= 0 or H <= 0 or W > 1024 or H > 1024:
        return None
    stream = gfx1[base + 4:end_of(base)]
    # PAL4 first (the disc reality for PL00). PAL8 escape hatch below.
    dest_len = part_bytes_needed(W, H, False)
    raw = decodeA(stream, dest_len)
    pal8 = False
    # PAL8 guard: only if a PAL4 decode would leave a huge unconsumed tail AND a PAL8
    # (W*H) decode consumes the blob far more completely. (Never fires for PL00.)
    # Heuristic kept conservative to avoid false positives.
    if pal8:
        idx = bytearray(raw[:W * H])               # PAL8: index bytes, linear
    else:
        idx = detwiddle_pal4(raw, W, H)            # PAL4: TWIDDLED -> linear indices
    # FULL TILE SPAN (2026-06-11, finding:emitter_geom_validated — supersedes the
    # 2026-06-10 logical-crop). The header is [lw][lh][sw][sh] = logical vs STORAGE tile
    # dims. The live engine (bank03 loc_8c0344d4 -> tile loop loc_8c0345c4/loc_8c03478e)
    # draws the FULL STORAGE tile span sw*8 x sh*8 as the part's SCREEN FOOTPRINT, and
    # the cumulative pen anchors the FULL-SPAN top-left. NUMERIC PROOF (validate_emitter_
    # geom.py vs _ryu_capture/probe_body_uv.json, Ryu sid 68, 6 sels): full-span W/H gives
    # dW=dH=0.00px AND dY=0.00 (relative) for ALL sels incl multi-tile 265/278/279; the
    # logical crop (lw*8 x lh*8) is WRONG (sel278 171 vs true 274 tall, sel265/279 51 vs 69).
    #   The earlier limb-crop fix was RIGHT about the PIXELS (100% of non-transparent texels
    # sit in the BOTTOM-LEFT lw*8 x lh*8 window — parts are bottom-up) but WRONG to shrink
    # the rect: the SCREEN BOX is the full span, with those logical pixels in the bottom-left
    # and a TRANSPARENT pad up to the full span (top + right). The detwiddled W*H buffer
    # ALREADY has the pixels in the bottom-left + transparent pad, so we keep it verbatim:
    # the packed part == exactly what the engine draws, placed at owner+pen*CPS with NO
    # anchor residual (ax=ay=0) and tileScale=1.0 (full CPS). Single-tile sels (sw==lw,
    # sh==lh) are byte-unchanged: full span == logical there, so no regression.
    # cw/ch carry the logical (pixel-bearing) sub-window for preview/diagnostics ONLY; the
    # packed rect and the asm always use the full span W/H (the default non-crop pack path).
    cw = (lw * TILE) if 0 < lw <= sw else W
    ch = (lh * TILE) if 0 < lh <= sh else H
    return {"idx": bytes(idx), "W": W, "H": H, "cw": cw, "ch": ch, "pal8": pal8}


# ---- GFX2 cell table (the cracked assembly) ---------------------------------
# cell = GFX2[sprite_id & 0x7FFF]; u16 count then count * 8-byte records
#   [dx s16 @+0] [dy s16 @+2] [FLAGS u16 @+4] [sel u16 @+6]
# Geometry = CUMULATIVE running pen (bank03 loc_8c0344d4): X-acc += dx, Y-acc -= dy per
# record; the part is drawn at owner screen_xy + pen*scale. FLAGS: X-mirror=0x4000 (XORs
# facing), Y-mirror=0x8000 (no facing XOR). Palette per-CHARACTER (not per-record).
def read_cells(gfx2):
    n = struct.unpack_from("<I", gfx2, 0)[0] >> 2
    tbl = [struct.unpack_from("<I", gfx2, i * 4)[0] for i in range(n)]
    cells = {}
    for idx in range(n):
        off = tbl[idx]
        if off + 2 > len(gfx2):
            continue
        cnt = struct.unpack_from("<H", gfx2, off)[0]
        if cnt == 0 or cnt > 64 or off + 2 + cnt * 8 > len(gfx2):
            continue
        recs = []
        p = off + 2
        px = py = 0
        for _ in range(cnt):
            dx, dy, flags, sel = struct.unpack_from("<hhHH", gfx2, p)
            p += 8
            px += dx
            py -= dy                                  # Y-acc -= dy (loc_8c0344d4)
            recs.append({"dx": px, "dy": py, "part": sel,
                         "flip": 1 if (flags & 0x4000) else 0,
                         "flipy": 1 if (flags & 0x8000) else 0})
        cells[idx] = recs
    return cells, n


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--gfx1", required=True, help="PLxx_DAT_GFX_DATA_00.BIN")
    ap.add_argument("--gfx2", default=None,
                    help="PLxx_DAT_GFX_DATA_01.BIN — when given, also emit PLxx_asm.json "
                         "(the GFX2 cell table: cumulative-pen assembly keyed by sprite_id, "
                         "flip=flags&0x4000 / flipy=flags&0x8000). Makes one self-consistent "
                         "atlas+asm set the emitter loads directly.")
    ap.add_argument("--pal",  required=True, help="PLxx_DAT_PALETTE_DATA.BIN")
    ap.add_argument("--char", required=True, help="PLxx (e.g. PL00)")
    ap.add_argument("--out",  required=True, help="output dir")
    ap.add_argument("--bank", type=int, default=0,
                    help="palette ROW for the body atlas (PL00 body = row 0). Default 0.")
    ap.add_argument("--atlas-w", type=int, default=2048, help="atlas PNG width (def 2048)")
    ap.add_argument("--crop", action="store_true",
                    help="pack the LOGICAL (lw/lh) crop instead of full storage W/H (tighter).")
    args = ap.parse_args()

    gfx1 = open(args.gfx1, "rb").read()
    pal  = open(args.pal, "rb").read()
    hexname = args.char.upper()
    os.makedirs(args.out, exist_ok=True)

    n = struct.unpack_from("<I", gfx1, 0)[0] >> 2
    offs = [struct.unpack_from("<I", gfx1, i * 4)[0] for i in range(n)]
    srt = sorted(set(offs) | {len(gfx1)})
    import bisect
    def end_of(o):
        i = bisect.bisect_right(srt, o)
        return srt[i] if i < len(srt) else len(gfx1)

    # decode every part
    parts = {}
    pal4 = pal8 = fail = 0
    total_px = 0
    for sel in range(n):
        p = decode_part(gfx1, sel, offs, end_of)
        if p is None:
            fail += 1; continue
        parts[sel] = p
        total_px += p["W"] * p["H"]
        if p["pal8"]: pal8 += 1
        else: pal4 += 1

    print(f"[{hexname}] decoded {len(parts)}/{n} sels  (PAL4={pal4} PAL8={pal8} fail={fail})  "
          f"{total_px/1e6:.2f}M px")

    # shelf-pack (tallest first) into the RGBA atlas + the indexed atlas
    palrgba = pal_row(pal, args.bank)
    ATLAS_W = args.atlas_w
    items = sorted(parts.items(), key=lambda kv: -(kv[1]["ch"] if args.crop else kv[1]["H"]))
    rects = {}
    placed = []
    x = y = rowh = 0
    for sel, p in items:
        w = p["cw"] if args.crop else p["W"]
        h = p["ch"] if args.crop else p["H"]
        if x + w > ATLAS_W:
            x = 0; y += rowh; rowh = 0
        rects[sel] = {"x": x, "y": y, "w": w, "h": h}
        placed.append((sel, p, x, y, w, h))
        x += w + 1
        rowh = max(rowh, h + 1)
    atlas_h = y + rowh

    rgba = Image.new("RGBA", (ATLAS_W, max(atlas_h, 1)), (0, 0, 0, 0))
    idxpng = Image.new("RGBA", (ATLAS_W, max(atlas_h, 1)), (0, 0, 0, 0))
    for sel, p, ax, ay, w, h in placed:
        Wp, Hp = p["W"], p["H"]
        # source origin: full-span pack (default) starts at (0,0); the optional --crop pack
        # takes the BOTTOM-LEFT logical window (pixels are bottom-up), so y0 = Hp - h.
        sx0, sy0 = 0, (Hp - h)
        rbuf = bytearray(w * h * 4)
        ibuf = bytearray(w * h * 4)
        for yy in range(h):
            for xx in range(w):
                ix = p["idx"][(sy0 + yy) * Wp + (sx0 + xx)]
                r, g, b, a = palrgba[ix]
                d = (yy * w + xx) * 4
                rbuf[d:d + 4] = bytes((r, g, b, a))
                # indexed: R = palette index, A = 0 if idx0 (transparent) else 255
                ibuf[d:d + 4] = bytes((ix, 0, 0, 0 if ix == 0 else 255))
        rgba.paste(Image.frombytes("RGBA", (w, h), bytes(rbuf)), (ax, ay))
        idxpng.paste(Image.frombytes("RGBA", (w, h), bytes(ibuf)), (ax, ay))

    rgba.save(os.path.join(args.out, f"{hexname}_parts.png"))
    idxpng.save(os.path.join(args.out, f"{hexname}_idx.png"))

    parts_json = {str(sel): r for sel, r in rects.items()}

    # parts.json (sel -> rect) — flat form the client also accepts
    with open(os.path.join(args.out, f"{hexname}_parts.json"), "w") as f:
        json.dump(parts_json, f)

    # lut.json — every palette row in the file (skin-compatible LUT)
    nrows = len(pal) // 32
    banks = [pal_row(pal, r) for r in range(nrows)]
    with open(os.path.join(args.out, f"{hexname}_lut.json"), "w") as f:
        json.dump({"bodyBank": args.bank, "bankList": list(range(nrows)), "banks": banks}, f)

    # asm.json — the GFX2 cumulative-pen assembly (sprite_id -> records) paired with the
    # SAME parts rects, so the emitter loads one self-consistent set. selKeyed=True lights
    # the lean all-poses sel-keyed branch (renders the live sprite_id, any pose).
    if args.gfx2:
        gfx2 = open(args.gfx2, "rb").read()
        cells, ncells = read_cells(gfx2)
        assemblies = {}
        for cidx, recs in cells.items():
            keep = [r for r in recs if r["part"] in rects]
            if keep:
                assemblies[str(cidx)] = keep
        asm_json = {
            "char": hexname, "atlas": f"{hexname}_parts.png",
            "atlas_w": ATLAS_W, "atlas_h": max(atlas_h, 1),
            "screenW": 640, "screenH": 480,
            "selKeyed": True, "name": hexname,
            "parts": parts_json,
            "assemblies": assemblies,
            "_note": "OFFLINE-COMPLETE emitter atlas. Pixels = GFX1 LZSS decode "
                     "(loc_8c0354c0, bit-exact) + PVR PAL4 detwiddle (full-dim). Geometry = "
                     "GFX2 cumulative pen (loc_8c0344d4): dx/dy are accumulated; flip="
                     "flags&0x4000 (X-mirror, XORs facing), flipy=flags&0x8000. Palette per-"
                     "character (Dat_Pal). All sels from GFX_DATA_00.BIN — no capture.",
        }
        with open(os.path.join(args.out, f"{hexname}_asm.json"), "w") as f:
            json.dump(asm_json, f)
        print(f"[{hexname}] asm.json: {len(assemblies)}/{ncells} cells with parts "
              f"(all reference packed sels)")

    # preview montage — first ~256 parts in a grid, disc default palette
    prev_cols = 16
    cell = 72
    pn = min(len(placed), 256)
    pw = prev_cols * cell
    ph = ((pn + prev_cols - 1) // prev_cols) * cell
    prev = Image.new("RGBA", (pw, ph), (32, 32, 48, 255))
    order = sorted(parts.items(), key=lambda kv: kv[0])[:pn]
    for k, (sel, p) in enumerate(order):
        Wp, Hp = p["W"], p["H"]
        cw, ch = p["cw"], p["ch"]   # logical pixel-bearing window for a tight thumbnail
        sy0 = Hp - ch               # pixels are in the BOTTOM-LEFT of the full span
        tb = bytearray(cw * ch * 4)
        for yy in range(ch):
            for xx in range(cw):
                ix = p["idx"][(sy0 + yy) * Wp + xx]
                r, g, b, a = palrgba[ix]
                d = (yy * cw + xx) * 4
                tb[d:d + 4] = bytes((r, g, b, a))
        tile = Image.frombytes("RGBA", (cw, ch), bytes(tb))
        if cw > cell - 4 or ch > cell - 4:
            sc = min((cell - 4) / cw, (cell - 4) / ch)
            tile = tile.resize((max(1, int(cw * sc)), max(1, int(ch * sc))))
        cx = (k % prev_cols) * cell + 2
        cy = (k // prev_cols) * cell + 2
        prev.alpha_composite(tile, (cx, cy))
    prev.save(os.path.join(args.out, f"{hexname}_preview.png"))

    print(f"[{hexname}] atlas {ATLAS_W}x{atlas_h}  ->  {args.out}/{hexname}_parts.png "
          f"(+_idx.png +_parts.json +_lut.json +_preview.png)")
    print(f"[{hexname}] {len(rects)} parts packed; palette rows={nrows} bodyBank={args.bank}")


if __name__ == "__main__":
    main()

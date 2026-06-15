#!/usr/bin/env python3
"""Indexed-PNG bridge — export a character's sprite parts as INDEXED PNGs (the char's
16-color palette baked in, right-side-up) for editing in Aseprite / LibreSprite / GIMP /
Piskel, and import them back into the DAT's twiddled 4bpp storage for the bake.

The artist edits in their own tool; we handle detwiddle/twiddle + encode + offset-table
rebuild. Indexed PNG (color-type 3) carries per-pixel indices natively → on import we read
indices directly (exact); an RGBA PNG is quantized to nearest palette color.

CLI:
  part_png.py export PL17 198,205,210 <outdir>     # write PLxx_selNNN.png + manifest
  part_png.py roundtrip PL17                        # self-test: export∘import == original
"""
import os, sys, json, struct
sys.path.insert(0, os.path.dirname(__file__))
from gfx1_lzss import decodeA
from extract_gfx1_atlas import detwiddle_pal4, pal_row, _DETW, _PAL4_ORDER
from rebuild_gfx1 import find_dat, desector, SRC_DIR, TRACK
from PIL import Image


def twiddle_pal4(idx, w, h):
    """LINEAR W*H index buffer -> TWIDDLED 4bpp bytes (W*H/2). Exact inverse of detwiddle_pal4."""
    bcx = w.bit_length() - 1; bcy = h.bit_length() - 1
    data = bytearray((w * h) // 2)
    for y in range(0, h, 4):
        for x in range(0, w, 4):
            blk = (_DETW[0][bcy][x] + _DETW[1][bcx][y]) // 16
            base = blk * 8
            for i, (cx, cy) in enumerate(_PAL4_ORDER):
                nib = idx[(y + cy) * w + (x + cx)] & 0xF
                bp = base + (i >> 1)
                if bp >= len(data):
                    continue
                if (i & 1) == 0:
                    data[bp] = (data[bp] & 0xF0) | nib
                else:
                    data[bp] = (data[bp] & 0x0F) | (nib << 4)
    return bytes(data)


def _vflip(buf, w, h):
    rows = [buf[y * w:(y + 1) * w] for y in range(h)]
    rows.reverse()
    return b"".join(bytes(r) for r in rows)


def part_geom(dat, sel):
    gfx1 = struct.unpack_from("<I", dat, 0)[0]; gfx2 = struct.unpack_from("<I", dat, 4)[0]
    nParts = struct.unpack_from("<I", dat, gfx1)[0] // 4
    o0 = struct.unpack_from("<I", dat, gfx1 + sel * 4)[0]
    o1 = struct.unpack_from("<I", dat, gfx1 + (sel + 1) * 4)[0] if sel + 1 < nParts else (gfx2 - gfx1)
    hdr = dat[gfx1 + o0:gfx1 + o0 + 4]; sw, sh = hdr[2], hdr[3]
    return gfx1, o0, o1, sw * 8, sh * 8


def body_palette(dat, bank=0):
    pal = struct.unpack_from("<I", dat, 8)[0]
    return pal_row(dat[pal:], bank)            # 16 RGBA, idx0 transparent


def part_to_linear(dat, sel):
    """Decoded part -> (linear indices storage-order, W, H)."""
    gfx1, o0, o1, W, H = part_geom(dat, sel)
    blob = decodeA(dat[gfx1 + o0 + 4:gfx1 + o1], W * H // 2)
    return detwiddle_pal4(blob, W, H), W, H


def export_part_png(dat, sel, path, bank=0):
    """Write an indexed PNG (right-side-up) for `sel`."""
    lin, W, H = part_to_linear(dat, sel)
    disp = _vflip(lin, W, H)                    # storage is bottom-up → flip to right-side-up
    img = Image.frombytes('P', (W, H), disp)
    pal = body_palette(dat, bank)
    flat = [];
    for i in range(256):
        flat += list(pal[i][:3]) if i < 16 else [0, 0, 0]
    img.putpalette(flat)
    img.save(path, transparency=0)             # index 0 transparent
    return W, H


def png_to_blob(path_or_img, dat, sel, bank=0):
    """Edited PNG (path OR PIL Image) -> TWIDDLED 4bpp bytes for `sel`."""
    _, _, _, W, H = part_geom(dat, sel)
    img = path_or_img if isinstance(path_or_img, Image.Image) else Image.open(path_or_img)
    if img.size != (W, H):
        raise SystemExit("PNG %s is %dx%d, expected %dx%d for sel %d" % (path, img.size[0], img.size[1], W, H, sel))
    if img.mode == 'P':
        idx = list(img.getdata())              # native indices — exact
    else:
        pal = body_palette(dat, bank)
        rgba = list(img.convert('RGBA').getdata())
        idx = []
        for r, g, b, a in rgba:
            if a < 128:
                idx.append(0); continue
            best, bd = 0, 1e9
            for i in range(1, 16):
                pr, pg, pb, pa = pal[i]
                d = (r - pr) ** 2 + (g - pg) ** 2 + (b - pb) ** 2
                if d < bd:
                    bd, best = d, i
            idx.append(best)
    storage = _vflip(bytes(idx), W, H)         # flip back to storage order
    return twiddle_pal4(storage, W, H)


def _load_char(charname):
    lba, size = find_dat(os.path.join(SRC_DIR, TRACK), charname)
    return desector(os.path.join(SRC_DIR, TRACK), lba, size)


def main():
    cmd = sys.argv[1]
    if cmd == "export":
        char = sys.argv[2]; sels = [int(s) for s in sys.argv[3].split(",")]
        outdir = sys.argv[4] if len(sys.argv) > 4 else "."
        dat = _load_char(char); os.makedirs(outdir, exist_ok=True)
        manifest = {"char": char, "parts": {}}
        for sel in sels:
            p = os.path.join(outdir, "%s_sel%03d.png" % (char, sel))
            W, H = export_part_png(dat, sel, p)
            manifest["parts"][sel] = {"png": os.path.basename(p), "w": W, "h": H}
            print("exported sel %d (%dx%d) -> %s" % (sel, W, H, p))
        json.dump(manifest, open(os.path.join(outdir, "%s_parts_manifest.json" % char), "w"), indent=2)
    elif cmd == "roundtrip":
        char = sys.argv[2]; dat = _load_char(char)
        gfx1 = struct.unpack_from("<I", dat, 0)[0]
        nParts = struct.unpack_from("<I", dat, gfx1)[0] // 4
        import tempfile, random
        rng = random.Random(2); ok = bad = 0
        for sel in rng.sample(range(nParts), 120):
            _, o0, o1, W, H = part_geom(dat, sel)
            if W == 0 or H == 0:
                continue
            orig = decodeA(dat[gfx1 + o0 + 4:gfx1 + o1], W * H // 2)
            with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as tf:
                export_part_png(dat, sel, tf.name)
                blob = png_to_blob(tf.name, dat, sel)
            os.unlink(tf.name)
            ok += (blob == orig); bad += (blob != orig)
        print("PNG bridge round-trip: %d exact, %d mismatched" % (ok, bad))
        print("BRIDGE", "EXACT" if bad == 0 else "BROKEN")


if __name__ == "__main__":
    main()

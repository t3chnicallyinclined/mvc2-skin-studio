#!/usr/bin/env python3
"""Export an in-browser editor bundle for a character: a parts atlas in the EXACT
bake-faithful orientation (export_part_png convention: detwiddle + vertical flip,
right-side-up) plus a manifest of sel rects + the 16-color palette. The Skin Studio
painter loads this, paints in index space, and exports edited parts that bake_skin
re-twiddles + rebuilds. (The display atlas PLxx_parts.png uses a different orientation
and does NOT round-trip — hence this dedicated bundle.)

Out: <outdir>/PLxx_edit.png (RGBA, palette colors, idx0 transparent)
     <outdir>/PLxx_edit.json {char, palette:[[r,g,b,a]*16], parts:{sel:{x,y,w,h}}}

CLI: export_editor_bundle.py PL17 [outdir]   # default outdir = web/test-atlas/chars
"""
import os, sys, json, struct
sys.path.insert(0, os.path.dirname(__file__))
from rebuild_gfx1 import find_dat, desector, SRC_DIR, TRACK
from part_png import part_to_linear, part_geom, body_palette, _vflip
from PIL import Image

MAXW = 2048


def main():
    char = sys.argv[1]
    outdir = sys.argv[2] if len(sys.argv) > 2 else "web/test-atlas/chars"
    lba, size = find_dat(os.path.join(SRC_DIR, TRACK), char)
    dat = desector(os.path.join(SRC_DIR, TRACK), lba, size)
    gfx1 = struct.unpack_from("<I", dat, 0)[0]
    nParts = struct.unpack_from("<I", dat, gfx1)[0] // 4
    pal = body_palette(dat, 0)

    # decode every part to right-side-up RGBA (palette colors, idx0 transparent)
    tiles = []  # (sel, W, H, rgba bytes)
    for sel in range(nParts):
        _, _, _, W, H = part_geom(dat, sel)
        if W == 0 or H == 0:
            continue
        lin, _, _ = part_to_linear(dat, sel)
        disp = _vflip(lin, W, H)                     # right-side-up
        rgba = bytearray(W * H * 4)
        for i, idx in enumerate(disp):
            r, g, b, a = pal[idx & 0xF]
            rgba[i * 4:i * 4 + 4] = bytes((r, g, b, a))
        tiles.append((sel, W, H, bytes(rgba)))

    # shelf-pack into an atlas (sorted by height for tighter rows)
    tiles.sort(key=lambda t: -t[2])
    rects = {}; x = y = rowh = 0
    placed = []
    for sel, W, H, rgba in tiles:
        if x + W > MAXW:
            x = 0; y += rowh; rowh = 0
        rects[sel] = {"x": x, "y": y, "w": W, "h": H}
        placed.append((x, y, W, H, rgba))
        x += W + 1; rowh = max(rowh, H)
    atlasW, atlasH = MAXW, y + rowh
    atlas = Image.new("RGBA", (atlasW, atlasH), (0, 0, 0, 0))
    for x0, y0, W, H, rgba in placed:
        atlas.paste(Image.frombytes("RGBA", (W, H), rgba), (x0, y0))

    os.makedirs(outdir, exist_ok=True)
    atlas.save(os.path.join(outdir, f"{char}_edit.png"))
    json.dump({"char": char, "palette": [list(c) for c in pal],
               "atlas": f"{char}_edit.png", "w": atlasW, "h": atlasH, "parts": rects},
              open(os.path.join(outdir, f"{char}_edit.json"), "w"))
    print(f"{char}: packed {len(rects)} parts into {atlasW}x{atlasH} -> {outdir}/{char}_edit.png")


if __name__ == "__main__":
    main()

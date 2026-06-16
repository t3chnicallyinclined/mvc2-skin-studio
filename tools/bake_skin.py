#!/usr/bin/env python3
"""Bake a skin (palette + optional pixel edits) into a COPY of the GDI.

skin.json:
{
  "char": "PL17",
  "palette": { "<bank>": { "<index>": [r,g,b,a], ... }, ... },   # recolor (Pal section edit)
  "recolor": { "<fromIndex>": <toIndex>, ... },                  # global index remap (GFX1 rebuild)
  "parts":   { "<sel>": "<base64 4bpp twiddled index bytes>" }    # per-part pixel override (GFX1 rebuild)
}

Palette edits patch the DAT's Pal section in place (no GFX1 rebuild). recolor/parts
go through rebuild_gfx1.rebuild_dat (offset-table rebuild → any size). Writes a patched
GDI to <dst_dir> (default C:\\roms\\mvc2_us_skin). Never touches the source ROM.
"""
import os, sys, json, struct, shutil, base64, io
sys.path.insert(0, os.path.dirname(__file__))
from gfx1_lzss import decodeA
from rebuild_gfx1 import find_dat, find_dat_full, desector, rebuild_dat, SRC_DIR, TRACK, RAW, BASE
from part_png import png_to_blob          # indexed-PNG bridge (Aseprite/GIMP edits)
from PIL import Image


def argb4444(rgba):
    r, g, b, a = rgba
    return ((a >> 4) << 12) | ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4)


def apply_palette(dat, pal_edits):
    """Patch the DAT Pal section. pal_edits = {bank: {index: [r,g,b,a]}}. Returns new dat."""
    out = bytearray(dat)
    pal = struct.unpack_from("<I", dat, 8)[0]            # header[2] = Pal offset
    for bank, idxmap in pal_edits.items():
        b = int(bank)
        for idx, rgba in idxmap.items():
            off = pal + (b * 16 + int(idx)) * 2
            struct.pack_into("<H", out, off, argb4444(rgba))
    return bytes(out)


def build_gfx1_edits(dat, recolor, parts, parts_png=None, parts_png_b64=None, base_dir="."):
    """Return edits={sel: pixels} for rebuild_dat from a recolor map, raw pixel overrides,
    edited indexed PNG files (parts_png = {sel: png_path}), and/or inline base64 PNGs
    (parts_png_b64 = {sel: base64-png} — what the in-browser painter exports)."""
    gfx1 = struct.unpack_from("<I", dat, 0)[0]
    gfx2 = struct.unpack_from("<I", dat, 4)[0]
    nParts = struct.unpack_from("<I", dat, gfx1)[0] // 4
    tbl = [struct.unpack_from("<I", dat, gfx1 + i * 4)[0] for i in range(nParts)]
    edits = {}
    if recolor:
        rmap = {int(k): int(v) for k, v in recolor.items()}

        def rm(v):
            return rmap.get(v, v)
        for i in range(nParts):
            o0 = tbl[i]; o1 = tbl[i + 1] if i + 1 < nParts else (gfx2 - gfx1)
            hdr = dat[gfx1 + o0:gfx1 + o0 + 4]; sw, sh = hdr[2], hdr[3]; dl = (sw * 8) * (sh * 8) // 2
            px = decodeA(dat[gfx1 + o0 + 4:gfx1 + o1], dl)
            edits[i] = bytes(((rm(x >> 4) << 4) | rm(x & 0xF)) for x in px)
    for sel, b64 in (parts or {}).items():
        edits[int(sel)] = base64.b64decode(b64)        # already twiddled 4bpp bytes
    for sel, png in (parts_png or {}).items():
        path = png if os.path.isabs(png) else os.path.join(base_dir, png)
        edits[int(sel)] = png_to_blob(path, dat, int(sel))   # indexed PNG -> twiddled 4bpp
    for sel, b64 in (parts_png_b64 or {}).items():
        raw = b64.split(",", 1)[1] if b64.startswith("data:") else b64   # strip data-URL prefix
        img = Image.open(io.BytesIO(base64.b64decode(raw)))
        edits[int(sel)] = png_to_blob(img, dat, int(sel))    # inline PNG -> twiddled 4bpp
    return edits


def bake(skin, dst_dir=None, base_dir="."):
    """Bake a skin into the GDI.

    Default (dst_dir=None): edit track03.bin IN PLACE, after making a one-time pristine
    <track>.bak next to it — same behaviour as the in-browser bake. To undo, delete the
    edited track and rename the .bak back.
    Pass dst_dir to instead write a patched COPY of the whole track folder there and leave
    the source untouched.
    Returns (output_path, info-string)."""
    charname = skin["char"]
    src_track = os.path.join(SRC_DIR, TRACK)
    lba, size, root_lba, entry_off = find_dat_full(src_track, charname)
    dat = desector(src_track, lba, size)
    info = ["%s_DAT @ LBA %d, %d bytes" % (charname, lba, size)]

    if skin.get("palette"):
        dat = apply_palette(dat, skin["palette"]); info.append("palette: %d bank(s)" % len(skin["palette"]))
    if skin.get("recolor") or skin.get("parts") or skin.get("parts_png") or skin.get("parts_png_b64"):
        edits = build_gfx1_edits(dat, skin.get("recolor"), skin.get("parts"),
                                 skin.get("parts_png"), skin.get("parts_png_b64"), base_dir)
        dat, total, span = rebuild_dat(dat, edits=edits)
        info.append("GFX1 rebuilt, %d edited part(s) (%d/%d bytes)" % (len(edits), total, span))
    new_size = len(dat)
    sector_alloc = ((size + 2047) // 2048) * 2048
    if new_size > sector_alloc:
        raise SystemExit("edit needs %d more bytes than the file's %d-byte sector slack — simplify the edit or a full ISO repack is required."
                         % (new_size - size, sector_alloc - size))
    if new_size != size:
        info.append("DAT grew %d bytes (into sector slack)" % (new_size - size))

    if dst_dir is None:
        # In-place: back up the source track ONCE (pristine), then patch it directly.
        dst_track = src_track
        bak = src_track + ".bak"
        if not os.path.exists(bak):
            shutil.copy2(src_track, bak); info.append("backup -> %s" % os.path.basename(bak))
        else:
            info.append("backup exists (%s)" % os.path.basename(bak))
    else:
        # Copy: mirror the whole track folder, patch the copy, leave the source untouched.
        os.makedirs(dst_dir, exist_ok=True)
        for n in os.listdir(SRC_DIR):
            s = os.path.join(SRC_DIR, n); d = os.path.join(dst_dir, n)
            if not os.path.exists(d) or os.path.getsize(d) != os.path.getsize(s):
                shutil.copy2(s, d)
        dst_track = os.path.join(dst_dir, TRACK)

    new_nsec = (new_size + 2047) // 2048
    with open(dst_track, "r+b") as f:
        for i in range(new_nsec):
            f.seek((lba - BASE + i) * RAW + 16); f.write(dat[i * 2048:min((i + 1) * 2048, new_size)])
        if new_size != size:   # DAT grew → patch ISO9660 dir entry size (LE @+10, BE @+14)
            esec = root_lba + entry_off // 2048; ew = entry_off % 2048
            pos = (esec - BASE) * RAW + 16 + ew
            f.seek(pos + 10); f.write(struct.pack("<I", new_size))
            f.seek(pos + 14); f.write(struct.pack(">I", new_size))
    assert desector(dst_track, lba, new_size) == dat
    out_path = dst_track
    if dst_dir is not None:
        gdis = [n for n in os.listdir(dst_dir) if n.lower().endswith(".gdi")]
        if gdis: out_path = os.path.join(dst_dir, gdis[0])
    return out_path, " · ".join(info)


def main():
    with open(sys.argv[1], encoding="utf-8") as fh:
        skin = json.load(fh)
    dst_dir = sys.argv[2] if len(sys.argv) > 2 else None   # default: in-place + .bak
    path, info = bake(skin, dst_dir, os.path.dirname(os.path.abspath(sys.argv[1])))
    print(info); print("baked + verified ->", path)


if __name__ == "__main__":
    main()

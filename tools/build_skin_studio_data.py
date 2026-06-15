#!/usr/bin/env python3
"""build_skin_studio_data.py — generate all Skin Studio data files from a GDI data track.

Produces (per character):
  PLxx_edit.json + PLxx_edit.png  — part atlas + rect manifest (tools/export_editor_bundle.py)
  PLxx_lut.json                   — palette banks in the format loadChar() expects
  PLxx_asm.json                   — GFX2 sprite-assembly table (sprite_id → part list)

Usage:
  python tools/build_skin_studio_data.py /path/to/track03.bin
  python tools/build_skin_studio_data.py /path/to/track03.bin --char PL17
  python tools/build_skin_studio_data.py /path/to/track03.bin --out web/test-atlas/chars

If no path given, falls back to the SRC_DIR/TRACK constants in rebuild_gfx1.py.
Requires Pillow: pip install Pillow
"""

import argparse, json, os, sys, struct, shutil
try: sys.stdout.reconfigure(encoding="utf-8")   # Windows cp1252 consoles choke on non-ASCII status output
except Exception: pass
sys.path.insert(0, os.path.dirname(__file__))

from rebuild_gfx1 import find_dat, desector, SRC_DIR, TRACK
from part_png import part_to_linear, part_geom, _vflip
from extract_gfx1_atlas import pal_row
from PIL import Image

MAXW = 2048

ALL_CHARS = [
    ('00','Ryu'),('01','Zangief'),('02','Guile'),('03','Morrigan'),('04','Anakaris'),
    ('05','Strider'),('06','Cyclops'),('07','Wolverine (metal)'),('08','Psylocke'),
    ('09','Iceman'),('0A','Rogue'),('0B','Captain America'),('0C','Spider-Man'),
    ('0D','Hulk'),('0E','Venom'),('0F','Dr. Doom'),('10','Tron'),('11','Jill'),
    ('12','Hayato'),('13','Ruby Heart'),('14','SonSon'),('15','Amingo'),('16','Marrow'),
    ('17','Cable'),('18','Abyss1'),('19','Abyss2'),('1A','Abyss3'),('1B','Chun-Li'),
    ('1C','Mega Man'),('1D','Roll'),('1E','Akuma'),('1F','B.B.Hood'),('20','Felicia'),
    ('21','Charlie'),('22','Sakura'),('23','Dan'),('24','Cammy'),('25','Dhalsim'),
    ('26','M.Bison'),('27','Ken'),('28','Gambit'),('29','Juggernaut'),('2A','Storm'),
    ('2B','Sabretooth'),('2C','Magneto'),('2D','Shuma-Gorath'),('2E','War Machine'),
    ('2F','Silver Samurai'),('30','Omega Red'),('31','Spiral'),('32','Colossus'),
    ('33','Iron Man'),('34','Sentinel'),('35','Blackheart'),('36','Thanos'),('37','Jin'),
    ('38','Captain Commando'),('39','Wolverine (bone)'),('3A','Servbot'),
]


def build_lut(dat):
    """Extract all palette banks from the DAT's pal section as {bodyBank, banks}."""
    pal_off = struct.unpack_from("<I", dat, 8)[0]
    pal_data = dat[pal_off:]
    n_banks = len(pal_data) // 32
    banks = {}
    for b in range(n_banks):
        colors = pal_row(pal_data, b)
        banks[str(b)] = [list(c) for c in colors]
    return {"bodyBank": 0, "banks": banks}


def parse_gfx2(dat):
    """Parse the GFX2 section into {sprite_id_str: [{dx,dy,part,flip,flipy},...]}."""
    gfx2_off = struct.unpack_from("<I", dat, 4)[0]
    pal_off  = struct.unpack_from("<I", dat, 8)[0]
    gfx2 = dat[gfx2_off:pal_off]
    if len(gfx2) < 4:
        return {}
    n = struct.unpack_from("<I", gfx2, 0)[0] >> 2  # entry count = first_offset / 4
    assemblies = {}
    for idx in range(n):
        off = struct.unpack_from("<I", gfx2, idx * 4)[0]
        if off + 2 > len(gfx2):
            continue
        cnt = struct.unpack_from("<H", gfx2, off)[0]
        if cnt == 0 or cnt > 256 or off + 2 + cnt * 8 > len(gfx2):
            continue
        px = py = 0
        recs = []
        p = off + 2
        for _ in range(cnt):
            dx = struct.unpack_from("<h", gfx2, p)[0]   # s16
            dy = struct.unpack_from("<h", gfx2, p+2)[0]
            flags = struct.unpack_from("<H", gfx2, p+4)[0]
            sel   = struct.unpack_from("<H", gfx2, p+6)[0]
            p += 8
            px += dx; py -= dy   # cumulative pen (same convention as rom-reader.mjs)
            recs.append({"dx": px, "dy": py, "part": sel,
                         "flip": bool(flags & 0x4000), "flipy": bool(flags & 0x8000)})
        if recs:
            assemblies[str(idx)] = recs
    return assemblies


def build_atlas(dat, char):
    """Build the part atlas (same logic as export_editor_bundle.py)."""
    gfx1 = struct.unpack_from("<I", dat, 0)[0]
    n_parts = struct.unpack_from("<I", dat, gfx1)[0] // 4
    pal = pal_row(dat[struct.unpack_from("<I", dat, 8)[0]:], 0)  # bank 0

    tiles = []
    for sel in range(n_parts):
        try:
            _, _, _, W, H = part_geom(dat, sel)
        except Exception:
            continue
        if W == 0 or H == 0:
            continue
        try:
            lin, _, _ = part_to_linear(dat, sel)
        except Exception:
            continue
        disp = _vflip(lin, W, H)
        rgba = bytearray(W * H * 4)
        for i, idx in enumerate(disp):
            r, g, b, a = pal[idx & 0xF]
            rgba[i*4:i*4+4] = bytes((r, g, b, a))
        tiles.append((sel, W, H, bytes(rgba)))

    tiles.sort(key=lambda t: -t[2])
    rects = {}; x = y = rowh = 0; placed = []
    for sel, W, H, rgba in tiles:
        if x + W > MAXW:
            x = 0; y += rowh; rowh = 0
        rects[sel] = {"x": x, "y": y, "w": W, "h": H}
        placed.append((x, y, W, H, rgba))
        x += W + 1; rowh = max(rowh, H)
    atlas_w, atlas_h = MAXW, y + rowh or 1
    img = Image.new("RGBA", (atlas_w, atlas_h), (0, 0, 0, 0))
    for x0, y0, W, H, rgba in placed:
        img.paste(Image.frombytes("RGBA", (W, H), rgba), (x0, y0))
    return img, {"char": char, "atlas": f"{char}_edit.png",
                 "w": atlas_w, "h": atlas_h, "parts": rects}


def process_char(track_path, hexid, name, outdir):
    char = f"PL{hexid.upper()}"
    print(f"  {char} {name}...", end="", flush=True)
    try:
        lba, size = find_dat(track_path, char)
        dat = bytes(desector(track_path, lba, size))
    except Exception as e:
        print(f" SKIP ({e})")
        return False

    # PLxx_lut.json
    lut = build_lut(dat)
    with open(os.path.join(outdir, f"{char}_lut.json"), "w") as f:
        json.dump(lut, f)

    # PLxx_asm.json
    asm = parse_gfx2(dat)
    with open(os.path.join(outdir, f"{char}_asm.json"), "w") as f:
        json.dump({"char": char, "assemblies": asm}, f)

    # PLxx_edit.png + PLxx_edit.json
    try:
        img, meta = build_atlas(dat, char)
        img.save(os.path.join(outdir, f"{char}_edit.png"))
        with open(os.path.join(outdir, f"{char}_edit.json"), "w") as f:
            json.dump(meta, f)
    except Exception as e:
        print(f" atlas failed ({e})")
        return False

    n_asm = len(asm)
    print(f" {n_asm} sprites, {len(meta['parts'])} parts, {meta['h']}px atlas")
    return True


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("track", nargs="?", default=None,
                    help="Path to GDI data track (track03.bin). Defaults to SRC_DIR/TRACK from rebuild_gfx1.py")
    ap.add_argument("--char", default=None,
                    help="Single character to build, e.g. PL17 or 17. Default: all 59.")
    ap.add_argument("--out", default="web/test-atlas/chars",
                    help="Output directory (default: web/test-atlas/chars)")
    ap.add_argument("--no-backup", action="store_true",
                    help="skip the one-time track03.bin.bak safety backup")
    args = ap.parse_args()

    track_path = args.track or os.path.join(SRC_DIR, TRACK)
    if not os.path.exists(track_path):
        sys.exit(f"ROM not found: {track_path}\nPass path as first argument or set SRC_DIR in rebuild_gfx1.py")

    # One-time safety backup of the data track, so a pristine copy always sits in the same
    # folder before any baking. (A browser file-handle can't write a sibling .bak, so we make
    # it here.) Skipped if a .bak already exists or --no-backup is given.
    bak = track_path + ".bak"
    if not args.no_backup and not os.path.exists(bak):
        print(f"backing up {os.path.basename(track_path)} -> {os.path.basename(bak)} "
              f"(one-time, ~{os.path.getsize(track_path) // (1024*1024)} MB)…")
        shutil.copy2(track_path, bak)

    outdir = args.out
    os.makedirs(outdir, exist_ok=True)

    if args.char:
        hexid = args.char.upper().replace("PL", "")
        match = [(h, n) for h, n in ALL_CHARS if h.upper() == hexid]
        if not match:
            sys.exit(f"Unknown char: {args.char}. Use hex like 17 or PL17.")
        chars = match
    else:
        chars = ALL_CHARS

    print(f"Building {len(chars)} character(s) → {outdir}")
    print(f"ROM: {track_path}")
    ok = fail = 0
    for hexid, name in chars:
        if process_char(track_path, hexid, name, outdir):
            ok += 1
        else:
            fail += 1
    print(f"\nDone: {ok} built, {fail} failed.")
    if fail == 0:
        print(f"Copy {outdir}/ to your web server and open skin-studio.html — no ROM required.")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""build_anim_catalog.py — extract per-character animation catalogs from the cached anotak corpus
(no emulator, no ROM). Output web/anim/PL{HEX}.json = { char_id, name, groups: { "<g>": { name,
subanims: [ { cells: [ {sprite_id, duration, ender, render_extra, hitbox_group} ] } ] } } }.

Grounded (mvc2-sh4-re-expert): the 20-byte cell carries sprite_id@+0x04 (u16 LE), duration@+0x02,
Ender@+0x03 (0x80=end), render_extra@+0x11, hitbox_group@+0x12. The cached HTML `<input value="HEX40">`
is the authoritative 20 cell bytes (the distilled JSON dropped sprite_id). atlas key = sprite_id & 0x7FFF;
0xFFFF = blank (hold/skip). A group = several sub-anims, split on Ender 0x80.

  python tools/build_anim_catalog.py --char PL00 --cache <anotak_cache> --data <distilled> --out web/anim
  python tools/build_anim_catalog.py --char all  ...
"""
import argparse, json, os, re, glob

CELL_RE = re.compile(r'value="([0-9a-fA-F]{40})"')          # the 20-byte (40 hex) cell input
GROUPNUM_RE = re.compile(r'animgroup(\d+)\.html$', re.I)

def parse_cell(hexstr):
    b = bytes.fromhex(hexstr)
    return {
        "sprite_id": b[4] | (b[5] << 8),
        "duration": b[2],
        "ender": b[3],
        "render_extra": b[0x11],
        "hitbox_group": b[0x12],
    }

def parse_group_file(path):
    """Return a list of sub-anims (each a list of cells), split on Ender 0x80, in document order."""
    html = open(path, "r", errors="replace").read()
    subanims, cur = [], []
    for m in CELL_RE.finditer(html):
        c = parse_cell(m.group(1))
        cur.append(c)
        if c["ender"] & 0x80:                                # terminator closes a sub-anim
            subanims.append(cur); cur = []
    if cur: subanims.append(cur)                             # trailing (unterminated) run
    return subanims

def group_names(distilled_path):
    if not os.path.exists(distilled_path): return {}, None
    d = json.load(open(distilled_path, "r", errors="replace"))
    names = {}
    for g in d.get("anim_groups", []):
        gn = g.get("group_num");
        if gn is not None: names[int(gn)] = g.get("name")
    return names, d.get("name")

def build_char(plx, cache, data, out):
    cid = int(plx[2:], 16)
    names, charname = group_names(os.path.join(data, f"anotak_{plx}.json"))
    groups = {}
    for f in sorted(glob.glob(os.path.join(cache, f"{plx}_DAT_animgroup*.html"))):
        m = GROUPNUM_RE.search(os.path.basename(f))
        if not m: continue
        g = int(m.group(1))
        subs = parse_group_file(f)
        if not subs: continue
        # classify by sprite_id range (mvc2-sh4-re-expert): body ~61-160, special/projectile ~180+,
        # effect = any raw bit15 (0x8000 per-part-scale dispatch). 0xFFFF = blank, skip.
        sids = [k["sprite_id"] for s in subs for k in s if k["sprite_id"] != 0xFFFF]
        masked = [x & 0x7FFF for x in sids]
        scaled = any(x & 0x8000 for x in sids)
        smin, smax = (min(masked), max(masked)) if masked else (0, 0)
        kind = "effect" if scaled else ("special" if smax >= 180 else "body")
        groups[str(g)] = {"name": names.get(g, f"group {g}"), "kind": kind,
                          "sidRange": [smin, smax],
                          "subanims": [{"cells": s} for s in subs]}
    cat = {"char_id": cid, "name": charname or plx, "groups": groups}
    os.makedirs(out, exist_ok=True)
    p = os.path.join(out, f"{plx}.json")
    json.dump(cat, open(p, "w"), separators=(",", ":"))
    ncells = sum(len(s["cells"]) for grp in groups.values() for s in grp["subanims"])
    print(f"  {plx} ({cat['name']}): {len(groups)} groups, "
          f"{sum(len(grp['subanims']) for grp in groups.values())} sub-anims, {ncells} cells -> {p}")
    return cat

if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--char", default="all", help="PL00 | all")
    ap.add_argument("--cache", default="../maplecast-flycast/tools/re_kb/ingest/cache/anotak")
    ap.add_argument("--data", default="../maplecast-flycast/tools/re_kb/ingest/data")
    ap.add_argument("--out", default="web/anim")
    a = ap.parse_args()
    if a.char.lower() == "all":
        plxs = sorted({GROUPNUM_RE.sub("", os.path.basename(f)).split("_")[0]
                       for f in glob.glob(os.path.join(a.cache, "PL*_DAT_animgroup*.html"))})
        for plx in plxs: build_char(plx, a.cache, a.data, a.out)
    else:
        build_char(a.char.upper(), a.cache, a.data, a.out)

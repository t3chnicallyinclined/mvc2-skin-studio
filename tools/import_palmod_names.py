#!/usr/bin/env python3
"""Import per-palette NAMES from PalMod's MVC2 descriptions into web/palnames/PLxx.json.

PalMod (by Preppy, https://github.com/Preppy/PalMod) hand-labels MVC2's palette table:
"Main Color", "Hadouken", "Viper Beam", etc. Each character has a
`MVC2_MOVE_DESCRIPTIONS_<NAME>` vector of `{ 0xNN, L"name" }` where 0xNN is the palette
index — which maps 1:1 to our decoded bank index (verified: Ryu bank 1 = the Hadouken
palette). We parse those into small public JSON label files the editor uses to show a
MEANINGFUL palette selector (and to hide the thousands of duplicate/unused banks).

Names only — no game data. Output is public metadata, safe to commit (like web/anim/).

Run:  python tools/import_palmod_names.py            # fetches PalMod's header
      python tools/import_palmod_names.py descs.h    # or parse a local copy
"""
import os, re, sys, json, urllib.request

DESCS_URL = "https://raw.githubusercontent.com/Preppy/PalMod/master/palmod/Game/mvc2_descs.h"
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.normpath(os.path.join(HERE, "..", "web", "palnames"))

# PalMod block name -> our character id (hex). Only the chars PalMod documented; the
# disambiguated ones are explicit (GOUKI=Akuma, the two Wolverines, Tron, War Machine).
BLOCK_TO_CID = {
    "RYU": 0x00, "GUILE": 0x02, "ANAKARIS": 0x04, "STRIDER": 0x05,
    "WOLVERINE": 0x07, "PSYLOCKE": 0x08, "CAPTAINAMERICA": 0x0B, "HULK": 0x0D,
    "VENOM": 0x0E, "TRONBONNE": 0x10, "JILL": 0x11, "HAYATO": 0x12,
    "RUBYHEART": 0x13, "AMINGO": 0x15, "MARROW": 0x16, "CABLE": 0x17,
    "ABYSS1": 0x18, "ABYSS2": 0x19, "ABYSS3": 0x1A, "CHUNLI": 0x1B,
    "GOUKI": 0x1E, "FELICIA": 0x20, "CHARLIE": 0x21, "DAN": 0x23,
    "KEN": 0x27, "SABRETOOTH": 0x2B, "MAGNETO": 0x2C, "WARMACHINE": 0x2E,
    "IRONMAN": 0x33, "SENTINEL": 0x34, "BLACKHEART": 0x35, "THANOS": 0x36,
    "BONERINE": 0x39,
}

BLOCK_RE = re.compile(r"MVC2_MOVE_DESCRIPTIONS_(\w+)\s*=[^{]*\{(.*?)\n\};", re.DOTALL)
ENTRY_RE = re.compile(r'\{\s*0x([0-9A-Fa-f]+)\s*,\s*L"((?:[^"\\]|\\.)*)"')


def clean(name):
    return name.replace('\\"', '"').replace("\\\\", "\\").strip()


def main():
    if len(sys.argv) > 1:
        txt = open(sys.argv[1], encoding="utf-8", errors="replace").read()
    else:
        print("fetching", DESCS_URL)
        txt = urllib.request.urlopen(DESCS_URL).read().decode("utf-8", "replace")

    os.makedirs(OUT, exist_ok=True)
    written = 0
    for block, body in ((m.group(1), m.group(2)) for m in BLOCK_RE.finditer(txt)):
        cid = BLOCK_TO_CID.get(block)
        if cid is None:
            print("  (skip unmapped block %s)" % block); continue
        names = {str(int(idx, 16)): clean(nm) for idx, nm in ENTRY_RE.findall(body)}
        if not names:
            continue
        path = os.path.join(OUT, "PL%02X.json" % cid)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(names, f, ensure_ascii=True, indent=0)
        written += 1
        print("  PL%02X (%s): %d named palettes" % (cid, block, len(names)))
    print("wrote %d label files to %s" % (written, OUT))


if __name__ == "__main__":
    main()

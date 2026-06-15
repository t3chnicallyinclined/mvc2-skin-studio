#!/usr/bin/env python3
"""Diagnose a baked track03.bin by diffing it against its pristine .bak and
strictly validating the edited character's DAT the way the REAL SH4 decoder
(loc_8c0354c0) reads it — no forgiving clamps. Flags exactly what would corrupt
or crash on hardware.

Usage: diag_baked_rom.py "C:\\roms\\roms\\track03.bin" ["...\\track03.bin.bak"]
"""
import sys, struct

RAW = 2352; BASE = 45000; SECU = 2048

def user_sector(f, abs_lba):
    f.seek((abs_lba - BASE) * RAW + 16); return f.read(SECU)

def read_range(f, lba, size):
    n = (size + SECU - 1) // SECU
    out = bytearray()
    for i in range(n):
        out += user_sector(f, lba + i)
    return bytes(out[:size])

def list_dats(path):
    """Return {name: (lba, size, entry_abs_byte)} for every *_DAT in the ISO root."""
    out = {}
    with open(path, "rb") as f:
        pvd = user_sector(f, BASE + 16)
        rl = struct.unpack_from("<I", pvd, 158)[0]; rn = struct.unpack_from("<I", pvd, 166)[0]
        d = b"".join(user_sector(f, rl + i) for i in range((rn + SECU - 1) // SECU))
    off = 0
    while off < rn:
        L = d[off]
        if L == 0:
            off = ((off // SECU) + 1) * SECU
            if off >= rn: break
            continue
        e = struct.unpack_from("<I", d, off + 2)[0]; ln = struct.unpack_from("<I", d, off + 10)[0]
        nm = d[off + 33:off + 33 + d[off + 32]].decode('ascii', 'replace')
        if "_DAT" in nm.upper():
            out[nm.upper().split(";")[0]] = (e, ln, rl * 0 + off)  # off is within root section
        off += L
    return out, rl, rn

def strict_decode(blob, dest_len):
    """Mimic loc_8c0354c0 EXACTLY: no clamps. Return (ok, reason, bytes_emitted, src_used)."""
    out = bytearray(); sp = 0; n = len(blob)
    while len(out) < dest_len:
        if sp >= n:
            return False, "SOURCE OVERRUN (blob exhausted at out=%d/%d, would read into next part)" % (len(out), dest_len), len(out), sp
        flag = blob[sp]; sp += 1
        for bit in range(8):
            if len(out) >= dest_len: break
            if flag & (0x80 >> bit):
                if sp >= n:
                    return False, "SOURCE OVERRUN mid-token (out=%d/%d)" % (len(out), dest_len), len(out), sp
                b = blob[sp]; sp += 1
                dist = b >> 4; count = (b & 0x0F) + 2
                srcpos = len(out) - (dist + 1)
                if srcpos < 0:
                    return False, "BACKREF UNDERFLOW (dist=%d but only %d bytes emitted) @out=%d" % (dist, len(out), len(out)), len(out), sp
                for _ in range(count):
                    if len(out) >= dest_len:
                        return False, "DEST OVERRUN (backref count ran past dest_len by writing at %d)" % len(out), len(out), sp
                    out.append(out[srcpos]); srcpos += 1
            else:
                if sp >= n:
                    return False, "SOURCE OVERRUN on literal (out=%d/%d)" % (len(out), dest_len), len(out), sp
                out.append(blob[sp]); sp += 1
    return True, "ok", len(out), sp

def analyze_dat(dat, label):
    gfx1 = struct.unpack_from("<I", dat, 0)[0]; gfx2 = struct.unpack_from("<I", dat, 4)[0]
    nslots = gfx1 // 4
    hdr = [struct.unpack_from("<I", dat, i * 4)[0] for i in range(nslots)]
    print("  [%s] size=%d gfx1=0x%x gfx2=0x%x header_slots=%d" % (label, len(dat), gfx1, gfx2, nslots))
    print("  header ptrs:", [hex(v) for v in hdr])
    # sanity: every nonzero ptr must be < len(dat) and (except gfx1) >= gfx2
    for i, v in enumerate(hdr):
        if v == 0: continue
        flags = []
        if v >= len(dat): flags.append("OUT-OF-RANGE (>= dat size)")
        if i > 0 and 0 < v < gfx2: flags.append("BELOW gfx2 (stale/shifted?)")
        if flags: print("    !! hdr[%d]=0x%x  %s" % (i, v, " ".join(flags)))
    nParts = struct.unpack_from("<I", dat, gfx1)[0] // 4
    tbl = [struct.unpack_from("<I", dat, gfx1 + i * 4)[0] for i in range(nParts)]
    span = gfx2 - gfx1
    bad = 0; checked = 0
    for i in range(nParts):
        o0 = tbl[i]; o1 = tbl[i + 1] if i + 1 < nParts else span
        if not (0 <= o0 < o1 <= span):
            print("    !! part %d bad table range o0=%d o1=%d span=%d" % (i, o0, o1, span)); bad += 1; continue
        hb = dat[gfx1 + o0: gfx1 + o0 + 4]; sw, sh = hb[2], hb[3]
        dl = (sw * 8) * (sh * 8) // 2
        if dl <= 0: continue
        blob = dat[gfx1 + o0 + 4: gfx1 + o1]
        ok, reason, emit, used = strict_decode(blob, dl)
        checked += 1
        if not ok:
            print("    !! part %d (sw=%d sh=%d dl=%d blob=%d): %s" % (i, sw, sh, dl, len(blob), reason)); bad += 1
    print("  parts=%d  strict-decoded=%d  FAILURES=%d" % (nParts, checked, bad))
    return bad

def main():
    edited = sys.argv[1]
    bak = sys.argv[2] if len(sys.argv) > 2 else edited + ".bak"
    print("EDITED:", edited)
    print("BACKUP:", bak)

    dats_e, rl, rn = list_dats(edited)
    dats_b, _, _ = list_dats(bak)
    print("\nDATs in edited ISO: %d   in backup: %d" % (len(dats_e), len(dats_b)))

    # find which DATs differ (compare size, then bytes)
    changed = []
    with open(edited, "rb") as fe, open(bak, "rb") as fb:
        for nm in sorted(dats_e):
            le, se, _ = dats_e[nm]
            if nm not in dats_b: changed.append((nm, "NEW")); continue
            lb, sb, _ = dats_b[nm]
            de = read_range(fe, le, se); db = read_range(fb, lb, sb)
            if de != db:
                changed.append((nm, "size %d->%d" % (sb, se)))
    print("CHANGED DATs:", changed if changed else "NONE")

    # deep-analyze each changed char in the EDITED file (and compare header to backup)
    with open(edited, "rb") as fe, open(bak, "rb") as fb:
        for nm, why in changed:
            print("\n=== %s (%s) ===" % (nm, why))
            le, se, _ = dats_e[nm]; de = read_range(fe, le, se)
            tot_bad = analyze_dat(de, "edited")
            if nm in dats_b:
                lb, sb, _ = dats_b[nm]; db = read_range(fb, lb, sb)
                print("  -- backup header for diff --")
                g1 = struct.unpack_from("<I", db, 0)[0]
                hb = [struct.unpack_from("<I", db, i * 4)[0] for i in range(g1 // 4)]
                print("  backup ptrs:", [hex(v) for v in hb])
            print("  >>> %s: %s" % (nm, "STRUCTURALLY BROKEN" if tot_bad else "decodes clean (strict)"))

if __name__ == "__main__":
    main()

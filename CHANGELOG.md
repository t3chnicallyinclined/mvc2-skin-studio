# Changelog

All notable changes to MvC2 Skin Studio. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/); dates are `YYYY-MM-DD`.

## 2026-06-16

### Added — editing tools
- **▣ Region tool** — drag a box over a feature (e.g. the head) to select all of its parts
  *across every frame* of the animation, then edit / propagate.
- **Click-to-edit parts** — in the Selected Parts panel, click a part to solo + edit it; the
  change applies to **every animation that uses that tile** (parts are shared).
- **↪ Propagate edit** — apply the active part's edit onto the other selected parts that match
  it (same size + similar shape), in one undoable step.
- **⟳ All-frames cascade** + **top-anchor** — apply a stroke / fill / stamp to the same spot
  across the whole animation; top-anchor maps relative to the sprite's top-center so it tracks
  a head as the body bobs.
- **Impact view** — part boxes are color-coded **amber = shared with other animations** /
  **blue = unique to this one**, with an *"✎ editing here also changes…"* line that lists the
  affected animations; click a chip to **preview** it without losing your place.
- **Stylus / pen / touch drawing** — Pointer Events input (pointer capture, pen pressure,
  `touch-action`) so you can draw with a tablet/pen, not just a mouse. *(Contributed by
  rob2d / ModNao.)*

### Added — palette
- **Extended / Extras palette space** — edit **any** palette bank (body **and** the
  effect / projectile / super palettes), via a bank selector labeled with **PalMod** names
  ("Viper Beam", "Hyper Viper Beam", …). The bake writes every palette you touch.
- **⧉ Copy hex** — copy all 16 palette colors as a hex list (for Aseprite / GIMP / any
  editor); each swatch tooltip now also shows its `#rrggbb`.
- **⇄ Flip view** — preview / edit from the other facing (P1 ⇄ P2). Display-only; doesn't
  change the sprite or the bake.

### Added — save & share
- **💾 Save project / 📂 Open project** — one portable JSON holding **every character you've
  edited** (palette edits across all banks + painted pixels + layer order). Reopen to keep
  working; switch characters to see each one restored. Highlighted on the dashboard. (The
  editor also autosaves a per-character draft to the browser between refreshes.)

### Added — tooling
- `tools/import_palmod_names.py` — parses [PalMod](https://github.com/Preppy/PalMod)'s MvC2
  descriptions into `web/palnames/PLxx.json` (the per-palette names the bank selector shows).

### Fixed
- **ES modules failed to load on Windows** — `skin_server.py` now serves `.mjs` / `.js` as
  `text/javascript` (Windows' registry often maps them to `text/plain`, which browsers refuse
  to run as `type="module"`). Also added a CORS-preflight handler.
- **Windows README commands** — added PowerShell (`$env:`) and CMD (`%…%`) variants of the
  decode command (the `$MVC2_ROM_DIR` form only worked in bash).
- **Dashboard README link** pointed at a placeholder; now points to the repo.
- **File handling** — `bake_skin.py` / `build_anim_catalog.py` now read/write with explicit
  UTF-8 and context managers.

## 2026-06-15

### Added
- **Initial public release.** Browser-based MvC2 sprite editor: decode a character from your
  own GDI, recolor the palette and paint pixels on the fully-assembled sprite, then bake the
  edits straight into `track03.bin` (in place, with an automatic pristine `track03.bin.bak`)
  for flycast or a real Dreamcast. Includes palette recolor-all (hue/sat/lum), swap color
  index N→M, copy / paste / PNG stickers, per-part layer ordering, frame & animation PNG
  export, the in-browser and Python-server bake paths, and a strict SH4-accurate validator.
  Everything runs locally; no game data is uploaded or shipped.

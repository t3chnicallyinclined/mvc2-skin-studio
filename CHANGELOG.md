# Changelog

All notable changes to MvC2 Skin Studio. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/); dates are `YYYY-MM-DD`.

## 2026-07-24 (later)

### Added — never lose your work: projects, versions & safe resets
- **Projects & version history** (new **🗂 projects** button) — your work now lives in named
  **projects** that **autosave** continuously and persist between launches (in the app / browser).
  Create, rename, switch, and delete projects to keep different skins separate, and **reopen right
  where you left off**. Each project keeps a rolling **version history** you can **roll back to**
  at any time. Backed by a small, unit-tested store (`web/projects.mjs`); a "state" is just the
  edits (palette diffs + painted parts + layer order), never sprite/ROM bytes, so keeping 30
  versions stays cheap. The old 💾/📂 buttons are now **export / import** of a portable project
  file (for backups or sharing) alongside the new in-app projects.
- **Reset is no longer destructive** — the biggest footgun (**↺ all px** used to wipe every painted
  part across every animation *and* clear the undo stack). Now every reset (all-pixels, frame
  pixels, and revert-palette) **confirms first**, **saves a version** you can restore, and the pixel
  resets are **undoable with Ctrl+Z**. So a lot of work across many animations can't vanish on a
  misclick.

### Added — load your ROM however you have it (desktop)
- **📂 load ROM** now accepts a **zipped GDI (`.zip`)**, a **`.gdi`**, a loose **`.iso`**, or
  **`track03.bin`** directly — it **auto-extracts** a zip and **finds the MvC2 data track for you**
  (validated by its ISO-9660 signature, preferring `track03.bin`), so there's no manual unzipping or
  hunting for the right file. Backed by a new Rust `rom_prepare` command (zip extraction happens
  once, to a sibling folder that's re-used next time).

## 2026-07-24

### Changed — UX pass (more intuitive layout)
- The always-on two-row option bar was a "junk drawer" showing every control for every tool. It's
  now a **contextual tool-options bar** that shows only the options for the active tool, with a
  separate **view bar** for persistent view state (zoom/fit/grid/onion/diff/flip/reference).
- Added a prominent **FG/BG colour chip** (index + hex) in the palette dock; **X** swaps them
  (view-flip moved to **Shift+X**).
- **File actions regrouped** into Project (save/open) · an **Export ▾ menu** (frame PNG / sheet /
  GIF / skin.json, consolidated from two places) · ROM (load / bake).
- **Decluttered around the canvas**: navigation + zoom sit in one compact toolbar above the canvas;
  the view toggles (grid / boxes / onion / diff / flip / reference) moved into a **👁 view ▾
  popover**; below the canvas is only the contextual options + a slim timeline — giving the pixel
  canvas much more vertical room.
- **Friendlier tool controls**: brush-size buttons now show the **actual pixel footprint** (a growing
  square) with the selected size highlighted; the cursor shows a **live brush outline** on the canvas
  (red when erasing) so you see exactly what you'll paint; a **symmetry axis guide** draws on the
  canvas when mirror drawing is on; and the shading-ink labels read "shade ↑ lighter / ↓ darker".

### Added — pro tools & preview
- **Pixel-perfect pencil** — drops the doubled corner pixels on diagonal freehand strokes.
- **Shading ink** — a pencil ink that steps each painted pixel one step lighter/darker along the
  palette (sorted by luminance), once per pixel per stroke.
- **Live preview panel** — a small always-on loop of the current animation (reflecting your edits)
  in the right dock, plus a **navigator minimap** (click/drag to pan when zoomed in).
- **Right-drag to pan** the canvas (in addition to space-drag and middle-drag).

### Added — cross-platform builds
- The desktop app builds for **Windows, macOS, and Linux** (Tauri). Frontend staging is a small
  cross-platform **Node** script (`scripts/stage-frontend.mjs`, run as Tauri's `beforeBuildCommand`)
  that copies `web/` minus the ROM-derived `test-atlas/` into `wwwroot/` — no Python needed, identical
  on every OS. `bundle.targets` is now `all` (each OS builds its native installers).
- **GitHub Actions release workflow** (`.github/workflows/release.yml`): pushing a `v*` tag builds
  all three platforms and drafts a Release with the installers attached (Windows `.msi`/`.exe`,
  macOS universal `.dmg`, Linux `.AppImage`/`.deb`).

### Added — Windows desktop app (Tauri)
- **Skin Studio now ships as a native Windows app** — no Python, no local server, no
  Chrome/Edge requirement. It reads your `track03.bin` directly, edits palettes + pixels with
  the same editor as the web build, and bakes **in place** with an automatic pristine
  **`track03.bin.bak`** made the first time (a real backup the browser build couldn't create
  on its own). Build with `cargo tauri build` → `.msi` + NSIS `-setup.exe`.
  - New `src-tauri/` Rust backend: four thin commands (`rom_size` / `rom_read` / `rom_write` /
    `rom_backup`) do **positioned range I/O** into the ROM, so the ~1.2 GB file is never read
    or rewritten whole.
  - New `web/platform.mjs` adapter presents those commands as a **File System Access–shaped**
    ROM handle, so `rom-reader.mjs` and `rom-bake.mjs` (the byte-faithful decode/bake) stay
    unchanged and the browser build keeps working. Picker chooses between the native Tauri
    dialog and `showOpenFilePicker` on `window.__TAURI__`.

### Fixed — desktop window fit & canvas size
- The desktop app now opens **centered** in a tall window and runs as a **full-window app shell** —
  the editor fills the window with no page scrolling; the onboarding cards, hint banner, and page
  header are hidden. (`?appshell` forces the same full-window layout in a browser.)
- The **canvas fills its whole container** and re-fits the sprite on resize (responsive), instead of
  a fixed 420×380 — so it's as big as the space it's in, and grows with the window / focus mode.
- **⤢ Focus mode** (view bar or `\`) collapses the palette + preview docks for even more canvas.

### Changed — editor UI redesign (Aseprite-style)
- The editor was reorganized from three crammed toolbar rows into a proper **app layout**: a
  top action bar (character + grouped file/ROM actions), a **left tool rail** (labeled
  DRAW / SHAPES / SELECT & STAMP / HISTORY sections), a **palette dock**, a **canvas column**
  with an animation-nav header, a two-row **context bar** (brush + layer options), and a
  **frame timeline**; a **right dock** for the parts/preview panels; and a **status bar**.
  Every control is preserved. Bake is now a highlighted primary button.

### Added — editor features
- **Redo** — the undo history is now two-way (Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z).
- **Keyboard shortcuts** — B pencil · E erase · G fill · I pick · H pan · V select · M copy ·
  N region · L line · R rect · O ellipse · P stamp · `[` `]` brush size · 1–4 sizes · `,` `.`
  step frames · `+` `-` zoom · X flip.
- **Shape tools** — line, rectangle, ellipse (outline or filled), with a live drag preview.
- **Symmetry drawing** — mirror every stroke across a vertical or horizontal axis.
- **Onion skin** — ghost the previous (red) / next (blue) animation frame under the current one.
- **Pixel grid** overlay at high zoom.
- **Frame timeline** — thumbnail-per-frame strip; click to jump.
- **Reference image overlay** — load any image and trace over it at adjustable opacity.
- **Settings / preferences** (⚙, persisted): canvas background (checker / dark / black), grid,
  onion, confirm-before-bake, remember last character, and (desktop) remember & reopen the last ROM.
- **Palette I/O** — export the 16 colours as `.hex` + a PNG strip; import a palette
  (`.hex` / `.gpl` / JASC `.pal` / PNG); **palette from image** (recolour to an image's scheme);
  and a **ramp** tool that interpolates a smooth shading gradient between two palette slots.
- **Navigation** — **scroll-wheel zoom** (toward the cursor), **Fit** / **1×** buttons + a live zoom
  readout, hold-**Space** or middle-drag to **pan** with any tool, and **Alt** to eyedrop from any tool.
- **Move & transform** — **arrow keys nudge** the active part; a copied stamp can be **flipped
  (H/V) and rotated (R)** before placing.
- **Fill modes** — the bucket can fill **solid**, **50% dither**, or a **dithered gradient**
  (vertical / horizontal) between the primary and a second colour.
- **Animated GIF export** (⤓ gif) — the whole animation as a looping GIF, using the character's
  palette with a transparent background and per-frame timing.
- **Onion range** (±1–4 frames), **playback-speed** control, a **diff view** (highlight only the
  pixels you changed), an **alt-costume** generator (hue-shift the whole palette), and a
  **keyboard-shortcut cheatsheet** (press `?`).

## 2026-06-16 (later)

### Fixed
- **Stylus could stop drawing mid-session** (clicking/tap still worked, hover still
  highlighted parts). Cause: a spurious pointer-capture loss (palm rejection / pen leaving
  range) ended the stroke while the pen was still down, and a stale `activePointerId` then
  blocked it from resuming. Fixes: pointer-id guards now only apply *while actively drawing*
  (a stale id can't block an idle/hovering pen); `lostpointercapture` no longer ends a stroke
  (only `pointerup` / `pointercancel` do); and switching tools/modes now hard-resets input
  state so nothing carries over stuck. (Reported by rob2d.)

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

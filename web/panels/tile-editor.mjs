// tile-editor.mjs — Skin Studio: palette recolor + a COMPOSITE FRAME pixel editor.
// Pick an animation, step its frames, paint on the FULLY ASSEMBLED sprite at full size,
// watch the animation play with your edits. Strokes are decomposed back to the individual
// parts (bundle orientation) and exported as skin.json for tools/bake_skin.py.
//
// Data: web/anim/PLxx.json · PLxx_asm.json (sprite_id→[{dx,dy,part,flip,flipy}]) ·
//       PLxx_edit.{png,json} (bake-faithful part atlas — tools/export_editor_bundle.py PLxx)
// Verified: bundle pixels + _asm composite to a correct right-side-up pose; painted parts
// (bundle orientation) bake byte-faithful via png_to_blob.

import * as rb from '../rom-bake.mjs?v=6';
import { RomReader } from '../rom-reader.mjs?v=6';
import { isTauri, pickRomHandle, backupRom, romHandleFromPath } from '../platform.mjs?v=2';

const HEX2 = (n) => n.toString(16).toUpperCase().padStart(2, '0');

// RGB(0-255) <-> HSV(0-1) for the "recolor all" palette transform.
function rgb2hsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d) { if (mx === r) h = ((g - b) / d) % 6; else if (mx === g) h = (b - r) / d + 2; else h = (r - g) / d + 4; h /= 6; if (h < 0) h += 1; }
  return [h, mx ? d / mx : 0, mx];
}
function hsv2rgb(h, s, v) {
  const i = Math.floor(h * 6), f = h * 6 - i, p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
  let r, g, b;
  switch (i % 6) { case 0: r = v; g = t; b = p; break; case 1: r = q; g = v; b = p; break; case 2: r = p; g = v; b = t; break; case 3: r = p; g = q; b = v; break; case 4: r = t; g = p; b = v; break; default: r = v; g = p; b = q; }
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

const CHARS = [
  ['00','Ryu'],['01','Zangief'],['02','Guile'],['03','Morrigan'],['04','Anakaris'],['05','Strider'],['06','Cyclops'],['07','Wolverine (metal)'],
  ['08','Psylocke'],['09','Iceman'],['0A','Rogue'],['0B','Captain America'],['0C','Spider-Man'],['0D','Hulk'],['0E','Venom'],['0F','Dr. Doom'],
  ['10','Tron'],['11','Jill'],['12','Hayato'],['13','Ruby Heart'],['14','SonSon'],['15','Amingo'],['16','Marrow'],['17','Cable'],
  ['18','Abyss1'],['19','Abyss2'],['1A','Abyss3'],['1B','Chun-Li'],['1C','Mega Man'],['1D','Roll'],['1E','Akuma'],['1F','B.B.Hood'],
  ['20','Felicia'],['21','Charlie'],['22','Sakura'],['23','Dan'],['24','Cammy'],['25','Dhalsim'],['26','M.Bison'],['27','Ken'],
  ['28','Gambit'],['29','Juggernaut'],['2A','Storm'],['2B','Sabretooth'],['2C','Magneto'],['2D','Shuma-Gorath'],['2E','War Machine'],['2F','Silver Samurai'],
  ['30','Omega Red'],['31','Spiral'],['32','Colossus'],['33','Iron Man'],['34','Sentinel'],['35','Blackheart'],['36','Thanos'],['37','Jin'],
  ['38','Captain Commando'],['39','Wolverine (bone)'],['3A','Servbot'],
];

export class SkinStudio {
  constructor(root, { atlasBase = './test-atlas/chars', animBase = './anim', palBase = './palnames' } = {}) {
    this.root = root; this.atlasBase = atlasBase; this.animBase = animBase; this.palBase = palBase;
    this.cid = null; this.bank = 0; this._bodyBank = 0;
    this._banks = null; this._palByBank = {}; this._palNames = null;           // all palette banks + per-bank edits + PalMod labels
    this.orig = []; this.cur = []; this._key2idx = null;                       // palette (current bank)
    this.bundle = null; this.bundleImg = null; this.bundleData = null;        // part atlas (RGBA pixels)
    this.anim = null; this.asm = null;
    this.cells = []; this.fi = 0; this.frame = null;                          // current animation + frame
    this._origPix = {}; this.painted = {};                                   // sel -> Uint8Array indices
    this.brush = 1; this.tool = 'select'; this._undoStack = []; this._redoStack = []; this._timer = null;
    this._sym = 'none'; this._shapeFill = false; this._grid = false; this._onion = false; this._shape = null;
    this._refImg = null; this._refOpacity = 0.45;
    this._brush2 = 0; this._fillMode = 'solid'; this._onionRange = 1; this._playMs = 120; this._diff = false; this._spaceDown = false;
    this._rmbPan = false; this._rmbMoved = false;
    this._pixelPerfect = false; this._ink = 'normal';
    this._canvasAspect = 9 / 16;   // canvas viewport width/height — portrait, to match the tall figures
    this.romReader = null; this._romHandle = null; this._romDir = null; this._romName = null; this._romCache = new Map();
    this._build();
  }

  _build() {
    if (isTauri || location.search.includes('appshell')) document.documentElement.classList.add('is-tauri');   // desktop app-shell layout (fills window); ?appshell forces it in a browser too
    this.root.innerHTML = `
      <div class="ss-app">

        <!-- ===================== TOP BAR ===================== -->
        <div class="ss-topbar">
          <label class="ss-field">character <select class="ss-char"></select></label>
          <span class="ss-topgroup" title="your reopenable work">
            <button class="ss-saveproj" title="save your work (palette + painted parts + layer order) to a project file you can reopen later or share">💾 save</button>
            <button class="ss-openproj" title="open a saved project file and keep editing">📂 open</button>
            <input class="ss-proj-file" type="file" accept="application/json,.json" style="display:none">
          </span>
          <span class="ss-topgroup ss-export-wrap" style="position:relative;">
            <button class="ss-export-btn" title="export the sprite, animation, or skin file">⤓ export ▾</button>
            <div class="ss-export-menu">
              <button class="ss-exp-frame" title="this assembled frame as a PNG">frame PNG</button>
              <button class="ss-exp-sheet" title="the whole animation as one sprite-sheet PNG">animation sheet</button>
              <button class="ss-exp-gif" title="the animation as an animated GIF">animated GIF</button>
              <button class="ss-export" title="a skin.json for the CLI bake (tools/bake_skin.py)">skin.json (CLI)</button>
            </div>
          </span>
          <span class="ss-topgroup" title="your ROM">
            <button class="ss-loadrom" title="load character data live from your track03.bin (and set it as the bake target)">📂 load track03.bin</button>
            <button class="ss-bakerom ss-primary" title="bake your edits into track03.bin">⬇ bake to ROM</button>
          </span>
          <span class="ss-topgroup">
            <button class="ss-settings" title="settings / preferences">⚙ settings</button>
            <button class="ss-shortcuts" title="keyboard shortcuts (press ?)">⌨</button>
          </span>
          <span class="ss-romsrc dim">loading…</span>
        </div>

        <!-- ===================== BODY ===================== -->
        <div class="ss-body">

          <!-- ---- TOOL RAIL ---- -->
          <div class="ss-rail ss-tools">
            <div class="ss-railsec">draw</div>
            <button data-t="select" class="on" title="select / inspect parts (default) — click a part to select it; no painting">🖱 select</button>
            <button data-t="pencil" title="pencil">✏ pencil</button>
            <button data-t="fill" title="flood fill a colour region">🪣 fill</button>
            <button data-t="pick" title="pick a colour off the sprite (I)">💧 pick</button>
            <button class="ss-erase-tool" title="erase to transparent (E)">✕ erase</button>
            <button data-t="pan" title="pan the canvas (H)">✋ pan</button>
            <div class="ss-railsec">shapes</div>
            <button data-t="line" title="draw a straight line — drag from start to end (L)">╱ line</button>
            <button data-t="rect" title="draw a rectangle — drag a box; hold to preview (R). Shift-drag or toggle fills it">▭ rect</button>
            <button data-t="ellipse" title="draw an ellipse — drag a box (O)">◯ ellipse</button>
            <div class="ss-railsec">select &amp; stamp</div>
            <button data-t="region" title="drag a box over a body region (e.g. the head) to SELECT its parts across the whole animation — then edit / propagate">▣ region</button>
            <button data-t="marquee" title="drag a rectangle to copy it — then stamp it elsewhere">⬚ copy</button>
            <button data-t="stamp" title="stamp the copied region / imported sticker (click to place; right-click or Esc to cancel)">📌 stamp</button>
            <button class="ss-sticker" title="import a PNG as a sticker to stamp (any size — quantized to this character's palette)">🖼 sticker…</button>
            <input class="ss-sticker-file" type="file" accept="image/*" style="display:none">
            <div class="ss-railsec">history</div>
            <button class="ss-undo" title="undo the last edit (Ctrl+Z)">↶ undo</button>
            <button class="ss-redo" title="redo (Ctrl+Y / Ctrl+Shift+Z)">↷ redo</button>
            <button class="ss-reset-frame" title="reset pixel edits for parts in this frame">↺ frame px</button>
            <button class="ss-reset-all-px" title="reset ALL painted parts">↺ all px</button>
          </div>

          <!-- ---- PALETTE DOCK ---- -->
          <div class="ss-paldock">
            <div class="ss-docktitle">palette <button class="ss-copyhex" title="copy all 16 colors as hex to the clipboard — paste into Aseprite / GIMP / any editor">⧉ hex</button></div>
            <div class="ss-fgbg">
              <div class="ss-chip ss-fg" title="foreground colour — you paint with this"><span></span></div>
              <button class="ss-swap-fgbg" title="swap foreground / background colour (X)">⇄</button>
              <div class="ss-chip ss-bg" title="background / 2nd colour — used by dither & gradient fill"><span></span></div>
            </div>
            <div class="dim ss-subtle">left-click a swatch = FG · right-click = edit colour live</div>
            <select class="ss-palbank" style="width:100%; font-size:11px; display:none;" title="which palette to edit: Main Color = the body; the rest are effect / projectile / super palettes (names from PalMod). Editing a palette applies everywhere the game uses it."></select>
            <div class="ss-palbank-hint dim" style="font-size:10px; margin:-2px 0 0; display:none; line-height:1.35;"></div>
            <div class="ss-brush"></div>
            <div class="ss-paltools" style="display:flex; flex-direction:column; gap:4px; font-size:10px;">
              <div class="ss-ctxlabel">recolor all</div>
              <label style="display:flex; justify-content:space-between; gap:4px;">hue<input class="ss-hue" type="range" min="-180" max="180" value="0" style="flex:1"></label>
              <label style="display:flex; justify-content:space-between; gap:4px;">sat<input class="ss-sat" type="range" min="-100" max="100" value="0" style="flex:1"></label>
              <label style="display:flex; justify-content:space-between; gap:4px;">lum<input class="ss-bri" type="range" min="-100" max="100" value="0" style="flex:1"></label>
              <div style="display:flex; gap:4px;">
                <button class="ss-pal-apply" style="font-size:10px; padding:2px 8px; flex:1" title="lock in this recolor as the new baseline">apply</button>
                <button class="ss-pal-reset-x" style="font-size:10px; padding:2px 8px;" title="reset the hue/sat/lum sliders">↺</button>
              </div>
              <div style="display:flex; align-items:center; gap:3px; margin-top:4px; flex-wrap:wrap;" title="repaint every pixel using the first color index to the second, across ALL parts of this character">
                <span class="dim">swap</span>
                <input class="ss-swap-from" type="number" min="1" max="15" value="1" style="width:30px; font-size:10px; padding:1px 2px;">
                <span class="dim">→</span>
                <input class="ss-swap-to" type="number" min="1" max="15" value="2" style="width:30px; font-size:10px; padding:1px 2px;">
                <button class="ss-swap-go" style="font-size:10px; padding:2px 6px;">go</button>
              </div>
            </div>
            <div class="ss-palio" style="display:flex; flex-direction:column; gap:4px; font-size:10px; border-top:1px solid #262a33; padding-top:8px;">
              <div class="ss-ctxlabel">palette I/O</div>
              <div style="display:flex; gap:4px; flex-wrap:wrap;">
                <button class="ss-pal-export" title="download these 16 colours as a .hex list + a PNG strip" style="font-size:10px; padding:2px 6px;">⤓ export</button>
                <button class="ss-pal-import" title="load a palette (.hex / .gpl / .pal / PNG) and recolour to it" style="font-size:10px; padding:2px 6px;">⤒ import</button>
                <input class="ss-pal-file" type="file" accept=".hex,.gpl,.pal,.txt,image/*" style="display:none">
              </div>
              <button class="ss-pal-fromimg" title="pull a colour scheme from any image and recolour the character to it" style="font-size:10px; padding:2px 6px;">🖼 palette from image</button>
              <input class="ss-pal-imgfile" type="file" accept="image/*" style="display:none">
              <button class="ss-altcostume" title="generate a hue-shifted alt costume (click to cycle variants; reset palette to undo)" style="font-size:10px; padding:2px 6px;">🎨 alt costume</button>
              <div style="display:flex; align-items:center; gap:3px; flex-wrap:wrap;" title="interpolate a smooth colour ramp between two palette slots (for shading)">
                <span class="dim">ramp</span>
                <input class="ss-ramp-from" type="number" min="1" max="15" value="1" style="width:30px; font-size:10px; padding:1px 2px;">
                <span class="dim">→</span>
                <input class="ss-ramp-to" type="number" min="1" max="15" value="8" style="width:30px; font-size:10px; padding:1px 2px;">
                <button class="ss-ramp-go" style="font-size:10px; padding:2px 6px;">go</button>
              </div>
            </div>
            <button class="ss-reset" title="revert ALL palette edits (every bank)">↺ reset palette</button>
          </div>

          <!-- ---- CANVAS COLUMN ---- -->
          <div class="ss-canvascol">
            <div class="ss-canvashead">
              <label class="ss-field">anim <select class="ss-grp" style="max-width:150px"></select></label>
              <select class="ss-sub"></select>
              <span class="ss-sep"></span>
              <button class="ss-prev-f" title="previous frame (,)">◀</button>
              <span class="ss-finfo">frame —</span>
              <button class="ss-next-f" title="next frame (.)">▶</button>
              <button class="ss-play" title="play / pause">▶</button>
              <label class="dim" style="font-size:11px" title="playback speed (ms per frame — lower is faster)">spd <input class="ss-playspd" type="range" min="30" max="400" value="120" style="width:58px"></label>
              <input class="ss-fr" type="range" min="0" value="0" style="width:84px" title="scrub frames">
              <span class="ss-sep"></span>
              <label class="dim" style="font-size:11px">zoom <input class="ss-zoom" type="range" min="1" max="24" value="4" style="width:92px"></label>
              <button class="ss-zfit" style="font-size:11px; padding:3px 7px;" title="fit sprite to view (F)">fit</button>
              <button class="ss-z1x" style="font-size:11px; padding:3px 7px;" title="zoom to 1× (pixel-perfect)">1×</button>
              <span class="ss-zpct dim" style="font-size:10px; min-width:26px;"></span>
              <span class="ss-view-wrap" style="position:relative;">
                <button class="ss-view-btn" title="view options — grid, part boxes, onion, diff, reference">👁 view ▾</button>
                <div class="ss-view-menu">
                  <button class="ss-flip" title="mirror the view (P1 ⇄ P2 facing) — display only (Shift+X)">⇄ flip view</button>
                  <label class="dim"><input class="ss-boxes" type="checkbox" checked> part boxes &nbsp;<span style="color:#ffaa46">▢</span><span style="color:#7fb0ff">▢</span></label>
                  <label class="dim" title="1px grid at high zoom"><input class="ss-grid" type="checkbox"> pixel grid</label>
                  <label class="dim" title="highlight only pixels you've changed"><input class="ss-diff" type="checkbox"> diff view</label>
                  <label class="dim" title="ghost neighbouring frames"><input class="ss-onion" type="checkbox"> onion skin</label>
                  <label class="dim">onion range ± <input class="ss-onionr" type="number" min="1" max="4" value="1" style="width:34px"></label>
                  <div class="ss-menu-sep"></div>
                  <button class="ss-refload" title="load a reference image to trace over">🖼 load reference…</button>
                  <input class="ss-ref-file" type="file" accept="image/*" style="display:none">
                  <label class="dim">ref opacity <input class="ss-refop" type="range" min="0" max="100" value="45" style="width:96px"></label>
                  <button class="ss-refclear" title="remove the reference image">✕ clear reference</button>
                </div>
              </span>
              <button class="ss-focus" style="margin-left:auto;" title="focus mode — hide the side panels for a bigger canvas (\\)">⤢ focus</button>
            </div>
            <div class="ss-animlinks dim" style="font-size:11px; display:flex; gap:6px; flex-wrap:wrap; align-items:center;"></div>
            <div class="ss-hint">Pick an animation, step with <b>◀ / ▶</b>, and paint. Left-click a swatch to paint · <b>right-click a swatch to edit that colour</b> live on the sprite.</div>
            <div class="ss-canvaswrap"><canvas class="ss-edit" width="420" height="380"></canvas></div>

            <!-- TOOL OPTIONS (contextual — change with the active tool) -->
            <div class="ss-toolopts">
              <span class="ss-topt-label ss-ctxlabel">options</span>
              <span class="ss-optgrp" data-tools="pencil">
                <span class="dim" style="font-size:11px">brush</span>
                <button class="ss-sz on" data-sz="1" title="1-pixel brush"><i class="ss-szbox" style="width:3px;height:3px"></i>1</button>
                <button class="ss-sz" data-sz="2" title="2-pixel brush"><i class="ss-szbox" style="width:6px;height:6px"></i>2</button>
                <button class="ss-sz" data-sz="4" title="4-pixel brush"><i class="ss-szbox" style="width:11px;height:11px"></i>4</button>
                <button class="ss-sz" data-sz="8" title="8-pixel brush"><i class="ss-szbox" style="width:18px;height:18px"></i>8</button>
              </span>
              <label class="ss-optgrp dim" data-tools="pencil" style="font-size:11px" title="drop the doubled corner pixels on diagonal freehand strokes"><input class="ss-pperf" type="checkbox"> pixel-perfect</label>
              <label class="ss-optgrp dim" data-tools="pencil" style="font-size:11px" title="shading ink — each painted pixel steps to the next lighter / darker colour in the palette (sorted by brightness) instead of the flat brush colour">ink <select class="ss-ink" style="font-size:11px"><option value="normal">normal paint</option><option value="lighten">shade ↑ lighter</option><option value="darken">shade ↓ darker</option></select></label>
              <label class="ss-optgrp dim" data-tools="pencil erase line rect ellipse" style="font-size:11px" title="mirror each stroke across an axis while you paint">sym <select class="ss-sym" style="font-size:11px"><option value="none">none</option><option value="v">vertical</option><option value="h">horizontal</option></select></label>
              <label class="ss-optgrp dim ss-shapefill-l" data-tools="line rect ellipse" style="font-size:11px"><input class="ss-shapefill" type="checkbox"> fill shape</label>
              <span class="ss-optgrp" data-tools="fill">
                <label class="dim" style="font-size:11px" title="solid, 50% dither of the two colours, or a dithered gradient (uses the BG colour)">fill <select class="ss-fillmode" style="font-size:11px"><option value="solid">solid</option><option value="dither">dither</option><option value="grad-v">grad ↓</option><option value="grad-h">grad →</option></select></label>
                <label class="dim" style="font-size:11px" title="second (BG) colour index for dither / gradient (0 = transparent)">2nd <input class="ss-brush2" type="number" min="0" max="15" value="0" style="width:32px"></label>
              </span>
              <span class="ss-optgrp" data-tools="stamp">
                <span class="dim" style="font-size:11px">stamp</span>
                <button class="ss-clip-h" title="flip stamp horizontally (H)">⇆</button>
                <button class="ss-clip-v" title="flip stamp vertically (V)">⇅</button>
                <button class="ss-clip-r" title="rotate stamp 90° (R)">⟳</button>
              </span>
              <span class="ss-optgrp" data-tools="select pencil erase fill line rect ellipse">
                <span class="dim" style="font-size:11px">layer</span>
                <select class="ss-layer" style="font-size:11px; max-width:150px" title="which part-layer to paint (brings it to front)"></select>
                <button class="ss-zback" title="send this part BEHIND (everywhere it's used)">⬇</button>
                <button class="ss-zfront" title="bring this part to the FRONT">⬆</button>
                <button class="ss-zreset" title="reset this part's layer order">○</button>
                <label class="dim" style="font-size:11px"><input class="ss-solo" type="checkbox"> solo</label>
              </span>
              <span class="ss-optgrp" data-tools="pencil erase fill line rect ellipse stamp">
                <label class="dim" style="font-size:11px" title="apply each edit to the SAME spot on EVERY frame of this animation"><input class="ss-allframes" type="checkbox"> ⟳ all frames</label>
                <label class="dim" style="font-size:11px" title="all-frames anchor: top-center (tracks a head as the body bobs)"><input class="ss-aftop" type="checkbox"> top-anchor</label>
              </span>
              <button class="ss-optgrp ss-propagate" data-tools="select region" title="apply the active part's edits to the other selected matching parts">↪ propagate</button>
              <span class="ss-topt-hint dim" style="font-size:11px; margin-left:auto;"></span>
            </div>
            <div class="ss-timeline"><span class="ss-tl-empty">frame timeline — pick an animation</span></div>
          </div>

          <!-- ---- RIGHT DOCK ---- -->
          <div class="ss-rightdock">
            <div class="ss-livepanel">
              <div class="ss-live-head"><b>▶ preview</b><button class="ss-live-toggle" title="collapse">–</button></div>
              <div class="ss-live-body">
                <canvas class="ss-live-canvas" width="184" height="150"></canvas>
                <label class="dim" style="font-size:11px"><input class="ss-live-play" type="checkbox" checked> loop animation</label>
                <div class="ss-mini-label dim">navigator</div>
                <canvas class="ss-mini-canvas" width="184" height="120" title="click / drag to pan"></canvas>
              </div>
            </div>
            <div class="ss-selpanel" style="display:none; flex-direction:column; gap:6px; width:196px; max-height:560px; overflow:auto; padding:8px; background:#0b0c10; border:1px solid #262a33; border-radius:8px;">
              <div style="display:flex; justify-content:space-between; align-items:center;">
                <b style="font-size:11px; color:#a0bde8;">SELECTED PARTS</b>
                <button class="ss-selclear" style="font-size:10px; padding:1px 6px;" title="clear selection">clear</button>
              </div>
              <div class="dim" style="font-size:10px; margin:-2px 0 2px;">click a part to edit it — changes apply to every animation that uses it</div>
              <div class="ss-sellist" style="display:flex; flex-direction:column; gap:8px;"></div>
            </div>
            <div class="ss-previewpanel" style="display:none; flex-direction:column; gap:6px; width:210px; max-height:420px; padding:8px; background:#0b0c10; border:1px solid #262a33; border-radius:8px;">
              <div style="display:flex; justify-content:space-between; align-items:center;">
                <b class="ss-pv-title" style="font-size:11px; color:#a0bde8;">preview</b>
                <button class="ss-pv-close" style="font-size:10px; padding:1px 6px;" title="close preview (keeps your place)">×</button>
              </div>
              <canvas class="ss-pv-canvas" width="188" height="300" style="image-rendering:pixelated; background:#15171d; border:1px solid #262a33; display:block;"></canvas>
              <div class="dim ss-pv-info" style="font-size:10px;"></div>
              <button class="ss-pv-edit" style="font-size:11px;" title="switch the editor to this animation">✎ edit this animation →</button>
            </div>
          </div>

        </div>

        <!-- ===================== STATUS BAR ===================== -->
        <div class="ss-statusbar"><div class="ss-bake"></div></div>
      </div>`;
    const $ = (s) => this.root.querySelector(s);
    this._loadSettings();
    this.selEl = $('.ss-char');
    this.grpEl = $('.ss-grp'); this.subEl = $('.ss-sub'); this.frEl = $('.ss-fr'); this.finfo = $('.ss-finfo'); this.linksEl = $('.ss-animlinks'); this.timelineEl = $('.ss-timeline');
    this.selpanelEl = $('.ss-selpanel'); this.sellistEl = $('.ss-sellist'); this._selSet = new Set();
    $('.ss-selclear').onclick = () => { this._selSet.clear(); this._activeLayer = null; if (this.layerEl) this.layerEl.value = ''; this._renderSelPanel(); this._drawFrame(); };
    this.previewEl = $('.ss-previewpanel'); this._pvCanvas = $('.ss-pv-canvas'); this._pvTitle = $('.ss-pv-title'); this._pvInfo = $('.ss-pv-info');
    $('.ss-pv-close').onclick = () => { this.previewEl.style.display = 'none'; this._stopPreview(); };
    $('.ss-pv-edit').onclick = () => { if (this._pvGroup != null) { this.previewEl.style.display = 'none'; this._stopPreview(); this.grpEl.value = this._pvGroup; this._populateSubs(); } };
    this.brushEl = $('.ss-brush'); this.editC = $('.ss-edit'); this.ectx = this.editC.getContext('2d'); this.ectx.imageSmoothingEnabled = false;
    // Stop the browser treating pen/touch drags on the canvas as scroll/zoom gestures (so a
    // stylus draws instead of panning the page).
    try { this.editC.style.touchAction = 'none'; } catch { /* older browsers */ }
    this.zoomEl = $('.ss-zoom'); this.bakeEl = $('.ss-bake'); this._romSrcEl = $('.ss-romsrc'); this._zpctEl = $('.ss-zpct');
    this.penSize = 1;

    for (const [hex, nm] of CHARS) { const o = document.createElement('option'); o.value = hex; o.textContent = `PL${hex} ${nm}`; this.selEl.append(o); }
    this.selEl.value = (this._settings.rememberChar && this._settings.lastChar) ? this._settings.lastChar : '17'; // default Cable, or last-used
    this.selEl.onchange = () => {
      if (this._settings.rememberChar) { this._settings.lastChar = this.selEl.value; this._saveSettings(); }
      this.loadChar(parseInt(this.selEl.value, 16));
    };
    this.palBankEl = $('.ss-palbank'); this.palBankHintEl = $('.ss-palbank-hint');
    this.palBankEl.onchange = () => this._setBank(+this.palBankEl.value);
    $('.ss-reset').onclick = () => {   // revert ALL palette edits (every bank)
      this._palByBank = {};
      this.cur = ((this._banks && this._banks[String(this.bank)]) || this.orig).map(c => c.slice());
      this._palBase = this.cur.map(c => c.slice()); this._resetPalSliders();
      this._populatePalBanks(); this._renderBrush(); this._render(); this._renderBake();
    };
    this.hueEl = $('.ss-hue'); this.satEl = $('.ss-sat'); this.briEl = $('.ss-bri');
    [this.hueEl, this.satEl, this.briEl].forEach(el => el.oninput = () => this._applyPalXform());
    $('.ss-copyhex').onclick = () => this._copyPaletteHex();
    $('.ss-pal-apply').onclick = () => { this._applyPalXform(); this._palBase = this.cur.map(c => c.slice()); this._resetPalSliders(); };   // lock in as new baseline
    $('.ss-pal-reset-x').onclick = () => { this._resetPalSliders(); this._applyPalXform(); };
    $('.ss-swap-go').onclick = () => this._swapIndex(+$('.ss-swap-from').value, +$('.ss-swap-to').value);
    $('.ss-pal-export').onclick = () => this._exportPalette();
    const palFile = $('.ss-pal-file');
    $('.ss-pal-import').onclick = () => palFile.click();
    palFile.onchange = (e) => { const f = e.target.files?.[0]; if (f) this._importPalette(f); e.target.value = ''; };
    const palImg = $('.ss-pal-imgfile');
    $('.ss-pal-fromimg').onclick = () => palImg.click();
    palImg.onchange = (e) => { const f = e.target.files?.[0]; if (f) this._paletteFromImage(f); e.target.value = ''; };
    $('.ss-ramp-go').onclick = () => this._rampPalette(+$('.ss-ramp-from').value, +$('.ss-ramp-to').value);
    $('.ss-altcostume').onclick = () => this._altCostume();
    $('.ss-exp-gif').onclick = () => this._exportGif();
    $('.ss-shortcuts').onclick = () => this._openShortcuts();
    $('.ss-playspd').oninput = (e) => { this._playMs = +e.target.value; if (this._timer) { this._stop(); this._togglePlay(this.root.querySelector('.ss-play')); } this._startLive(); };
    const liveToggle = $('.ss-live-toggle'), liveBody = $('.ss-live-body');
    if (liveToggle && liveBody) liveToggle.onclick = () => { const hidden = liveBody.style.display === 'none'; liveBody.style.display = hidden ? '' : 'none'; liveToggle.textContent = hidden ? '–' : '+'; };
    $('.ss-live-play').onchange = () => this._startLive();
    const mini = $('.ss-mini-canvas');
    if (mini) { mini.addEventListener('mousedown', (e) => this._miniPanTo(e)); mini.addEventListener('mousemove', (e) => { if (e.buttons === 1) this._miniPanTo(e); }); }
    $('.ss-fillmode').onchange = (e) => { this._fillMode = e.target.value; };
    $('.ss-brush2').onchange = (e) => { this._brush2 = Math.max(0, Math.min(15, +e.target.value || 0)); this._renderColorChip(); };
    $('.ss-zfit').onclick = () => { this._fitOnCenter = true; this._panX = null; this._render(); };
    $('.ss-z1x').onclick = () => { this.zoomEl.value = 1; this._panX = null; this._render(); };
    $('.ss-focus').onclick = () => this._toggleFocus();
    $('.ss-diff').onchange = (e) => { this._diff = e.target.checked; this._render(); };
    $('.ss-onionr').onchange = (e) => { this._onionRange = Math.max(1, Math.min(4, +e.target.value || 1)); if (this._onion) this._render(); };
    const stickerFile = $('.ss-sticker-file');
    $('.ss-sticker').onclick = () => stickerFile.click();
    stickerFile.onchange = (e) => { const f = e.target.files?.[0]; if (f) this._importSticker(f); e.target.value = ''; };
    $('.ss-loadrom').onclick = () => this._loadRom();
    $('.ss-export').onclick = () => this.exportSkin();
    const expBtn = $('.ss-export-btn'), expMenu = $('.ss-export-menu');
    if (expBtn && expMenu) {
      expBtn.onclick = (e) => { e.stopPropagation(); expMenu.style.display = expMenu.style.display === 'flex' ? 'none' : 'flex'; };
      expMenu.querySelectorAll('button').forEach(b => b.addEventListener('click', () => { expMenu.style.display = 'none'; }));
      document.addEventListener('click', () => { if (expMenu) expMenu.style.display = 'none'; });
    }
    const viewBtn = $('.ss-view-btn'), viewMenu = $('.ss-view-menu');
    if (viewBtn && viewMenu) {
      viewBtn.onclick = (e) => { e.stopPropagation(); viewMenu.style.display = viewMenu.style.display === 'flex' ? 'none' : 'flex'; };
      viewMenu.addEventListener('click', (e) => e.stopPropagation());   // keep open while toggling several
      document.addEventListener('click', () => { if (viewMenu) viewMenu.style.display = 'none'; });
    }
    $('.ss-saveproj').onclick = () => this._saveProject();
    const projFile = $('.ss-proj-file');
    $('.ss-openproj').onclick = () => projFile.click();
    projFile.onchange = (e) => { const f = e.target.files?.[0]; if (f) this._loadProject(f); e.target.value = ''; };
    $('.ss-bakerom').onclick = () => this.bakeToRom();
    $('.ss-settings').onclick = () => this._openSettings();
    $('.ss-undo').onclick = () => this._undo();
    $('.ss-redo').onclick = () => this._redo();
    this.root.querySelectorAll('.ss-tools button[data-t]').forEach(b => b.onclick = () => this._setTool(b.dataset.t));
    $('.ss-erase-tool').onclick = () => { this._setTool('pencil'); this.brush = 0; this._renderBrush(); };
    $('.ss-reset-frame').onclick = () => {
      if (!this.frame) return;
      for (const pb of this.frame.parts) { delete this.painted[pb.sel]; delete this._origPix[pb.sel]; }
      this._undoStack = []; this._redoStack = []; this._drawFrame(); this._renderBake();
    };
    $('.ss-reset-all-px').onclick = () => {
      if (!Object.keys(this.painted).length) return;
      this.painted = {}; this._origPix = {}; this._undoStack = []; this._redoStack = [];
      try { localStorage.removeItem(this._draftKey()); } catch {}
      this._drawFrame(); this._renderBake();
    };
    this.root.querySelectorAll('.ss-sz').forEach(b => b.onclick = () => { this.penSize = +b.dataset.sz; this.root.querySelectorAll('.ss-sz').forEach(x => x.classList.toggle('on', x === b)); });
    this.grpEl.onchange = () => this._populateSubs();
    this.subEl.onchange = () => this._selectAnim();
    $('.ss-play').onclick = (e) => this._togglePlay(e.target);
    $('.ss-prev-f').onclick = () => this._gotoFrame(this.fi - 1);
    $('.ss-next-f').onclick = () => this._gotoFrame(this.fi + 1);
    this.frEl.oninput = () => this._gotoFrame(+this.frEl.value);
    this.zoomEl.oninput = () => { this._panX = null; this._render(); };   // recenter on zoom
    $('.ss-boxes').onchange = (e) => { this._showBoxes = e.target.checked; this._render(); };
    $('.ss-grid').onchange = (e) => { this._grid = e.target.checked; this._settings.grid = this._grid; this._saveSettings(); this._render(); };
    $('.ss-onion').onchange = (e) => { this._onion = e.target.checked; this._settings.onion = this._onion; this._saveSettings(); this._render(); };
    $('.ss-sym').onchange = (e) => { this._sym = e.target.value; };
    $('.ss-shapefill').onchange = (e) => { this._shapeFill = e.target.checked; };
    $('.ss-pperf').onchange = (e) => { this._pixelPerfect = e.target.checked; };
    $('.ss-ink').onchange = (e) => { this._ink = e.target.value; };
    $('.ss-clip-h').onclick = () => this._flipClip('h');
    $('.ss-clip-v').onclick = () => this._flipClip('v');
    $('.ss-clip-r').onclick = () => this._rotateClip();
    $('.ss-swap-fgbg').onclick = () => this._swapColors();
    const refFile = $('.ss-ref-file');
    $('.ss-refload').onclick = () => refFile.click();
    refFile.onchange = (e) => { const file = e.target.files?.[0]; if (file) { const img = new Image(); img.onload = () => { this._refImg = img; this._render(); }; img.src = URL.createObjectURL(file); } e.target.value = ''; };
    $('.ss-refop').oninput = (e) => { this._refOpacity = (+e.target.value) / 100; if (this._refImg) this._render(); };
    $('.ss-refclear').onclick = () => { this._refImg = null; this._render(); };
    this._viewFlip = false;
    $('.ss-flip').onclick = (e) => { this._viewFlip = !this._viewFlip; e.target.classList.toggle('on', this._viewFlip); this.editC.style.transform = this._viewFlip ? 'scaleX(-1)' : ''; };
    this.layerEl = $('.ss-layer'); this._activeLayer = null; this._solo = false; this._zBias = {};
    this.layerEl.onchange = () => { const v = this.layerEl.value; this._activeLayer = v === '' ? null : +v; this._drawFrame(); };
    $('.ss-solo').onchange = (e) => { this._solo = e.target.checked; this._drawFrame(); };
    this._allFrames = false; this._afAnchor = 'abs';
    $('.ss-allframes').onchange = (e) => { this._allFrames = e.target.checked; this._clearFrameComps(); };
    $('.ss-aftop').onchange = (e) => { this._afAnchor = e.target.checked ? 'top' : 'abs'; this._clearFrameComps(); };
    $('.ss-propagate').onclick = () => this._propagateEdit();
    $('.ss-zback').onclick = () => this._biasLayer(-1);
    $('.ss-zfront').onclick = () => this._biasLayer(1);
    $('.ss-zreset').onclick = () => { if (this._activeLayer == null) return; delete this._zBias[this._activeLayer]; this._drawFrame(); this._renderBake(); };
    this._hoverSel = -1; this._showBoxes = true;
    $('.ss-exp-frame').onclick = () => this._exportFrame();
    $('.ss-exp-sheet').onclick = () => this._exportAnimSheet();
    this._editEvents();
    this._keyEvents();
    this._applySettings();     // reflect saved prefs (grid/onion/bg) into the controls
    // responsive canvas: fill its container and re-fit when the window / layout changes
    if (window.ResizeObserver && this.editC.parentElement) {
      this._ro = new ResizeObserver(() => { if (this._roRaf) cancelAnimationFrame(this._roRaf); this._roRaf = requestAnimationFrame(() => this._resizeCanvas()); });
      this._ro.observe(this.editC.parentElement);
    }
    window.addEventListener('resize', () => this._resizeCanvas());
    this._resizeCanvas();
    this._setTool('select');   // default to the pointer/select tool (clicking inspects, never paints)
    this.cid = parseInt(this.selEl.value, 16);
    this.loadChar(this.cid, { fresh: true });   // auto-load pre-generated data on open (falls back to empty + 📀 prompt)
  }

  // Load a character from the PRE-GENERATED bundle (tools/build_skin_studio_data.py output in
  // test-atlas/chars/) so the page shows sprites + animations with NO in-browser ROM pick.
  // Returns the same shape as RomReader.extractChar, or null if the files aren't present.
  async _loadCharFromFiles(cid) {
    if (isTauri) return null;   // desktop ships NO ROM data (BYOR) — always live-decode from the user's track03.bin
    const hx = HEX2(cid), base = this.atlasBase;
    const j = async (p) => { const r = await fetch(p); return r.ok ? r.json() : null; };
    const [lut, asm, edit] = await Promise.all([
      j(`${base}/PL${hx}_lut.json`), j(`${base}/PL${hx}_asm.json`), j(`${base}/PL${hx}_edit.json`),
    ]);
    if (!lut || !asm || !edit) return null;
    const r = await fetch(`${base}/PL${hx}_edit.png`); if (!r.ok) return null;
    const bundleImg = await createImageBitmap(await r.blob());
    const oc = new OffscreenCanvas(edit.w, edit.h), ox = oc.getContext('2d');
    ox.imageSmoothingEnabled = false; ox.drawImage(bundleImg, 0, 0);
    const bundleData = ox.getImageData(0, 0, edit.w, edit.h).data;
    let anim = null;
    try { anim = await j(`${this.animBase}/PL${hx}.json`); } catch { /* fallback handled in loadChar */ }
    return { lut, asm, bundle: { w: edit.w, h: edit.h, parts: edit.parts }, bundleImg, bundleData, anim };
  }

  async loadChar(cid, { fresh = false } = {}) {
    this._stop(); this._stopLive(); this.cid = cid; this.painted = {}; this._origPix = {}; this._zBias = {}; this.fi = 0;
    if (this._selSet) this._selSet.clear(); if (this.selpanelEl) this.selpanelEl.style.display = 'none';   // clear selection on char change
    this._stopPreview(); if (this.previewEl) this.previewEl.style.display = 'none';   // close any open preview
    this._undoStack = []; this._redoStack = []; this._oc = null;

    let data = null;
    try {
      if (this.romReader) {
        if (!this._romCache.has(cid)) this._romCache.set(cid, await this.romReader.extractChar(cid));
        data = this._romCache.get(cid);
      } else {
        data = await this._loadCharFromFiles(cid);   // pre-generated bundle — no ROM picker needed
      }
      if (data) {
        this._banks = data.lut.banks; this._bodyBank = data.lut.bodyBank || 0; this.bank = this._bodyBank; this._palByBank = {};
        this.orig = (this._banks[String(this.bank)] || []).map(c => c.slice());
        this.cur = this.orig.map(c => c.slice());
        this._palBase = this.cur.map(c => c.slice()); this._resetPalSliders();   // recolor-all baseline
        // _key2idx is built from the BODY bank (parts were decoded in body colors) — it must NOT
        // change when the user switches the displayed palette bank.
        this._key2idx = {}; (this._banks[String(this._bodyBank)] || []).forEach((c, i) => { if (c[3] > 0) this._key2idx[`${c[0]},${c[1]},${c[2]}`] = i; });
        this.asm = data.asm.assemblies;
        this.bundle = data.bundle; this.bundleImg = data.bundleImg; this.bundleData = data.bundleData;
        if (!this.romReader && this._romSrcEl) this._romSrcEl.textContent = `📦 PL${HEX2(cid)} (pre-generated) · ${isTauri ? '📂 load track03.bin to bake' : '📀 load ROM to bake in-browser'}`;
      } else {
        this.orig = []; this.cur = []; this.asm = null; this.bundle = null; this.bundleData = null; this._banks = null; this._palByBank = {};
        if (!this.romReader && this._romSrcEl) this._romSrcEl.textContent = isTauri ? '📂 click “load track03.bin” above to begin' : 'no data — run build_skin_studio_data.py, or 📀 load ROM';
      }
    } catch (e) {
      console.error('loadChar failed:', e);
      this.orig = []; this.cur = []; this.asm = null; this.bundle = null; this.bundleData = null; this._banks = null; this._palByBank = {};
      if (this.romReader && this._romSrcEl) this._romSrcEl.textContent = `❌ ${e.message}`;
    }

    // anim comes from ROM reader; fall back to server JSON if ROM didn't produce groups
    this.anim = (data?.anim && Object.keys(data.anim.groups).length) ? data.anim : null;
    if (!this.anim) {
      const bust = '?t=' + (this._t = (this._t || 1) + 1);
      try { this.anim = await (await fetch(`${this.animBase}/PL${HEX2(cid)}.json${bust}`)).json(); } catch { this.anim = null; }
    }
    // PalMod-derived palette names (public metadata; only ~33 chars are documented). Optional.
    this._palNames = null;
    try { this._palNames = await (await fetch(`${this.palBase}/PL${HEX2(cid)}.json?t=${this._t || 1}`)).json(); } catch { this._palNames = null; }
    if (!fresh) this._loadDraft();
    this._buildGrpSels();                                         // which parts each animation group uses (for the link map)
    this._populatePalBanks();
    this._renderBrush(); this._populateGroups(); this._renderBake();
  }

  // ---------- animation / frames ----------
  _populateGroups() {
    this.grpEl.innerHTML = ''; this.subEl.innerHTML = '';
    if (!this.anim) {
      // No catalog: synthesize a static default frame from the first available sprite_id
      if (this.asm && this.bundle) {
        const firstSid = Object.keys(this.asm).sort((a, b) => +a - +b)[0];
        if (firstSid !== undefined) {
          this.cells = [{ sprite_id: +firstSid }]; this.fi = 0;
          this.frEl.max = 0; this.frEl.value = 0;
          this._fitOnCenter = true; this._panX = null; this._drawFrame(); this._buildTimeline(); this._startLive();
          this.finfo.textContent = `static sid 0x${(+firstSid).toString(16)} · load anim catalog for animation`;
          return;
        }
      }
      this.cells = []; this._buildTimeline(); this._startLive(); this.finfo.textContent = this.bundle ? 'no anim catalog' : '📀 pick your ROM to start'; return;
    }
    for (const g of Object.keys(this.anim.groups).sort((a, b) => a - b)) { const grp = this.anim.groups[g]; const o = document.createElement('option'); o.value = g; o.textContent = `g${g} [${grp.kind || '?'}] ${grp.name}`; this.grpEl.append(o); }
    this._populateSubs();
  }
  _populateSubs() {
    this.subEl.innerHTML = ''; const grp = this.anim && this.anim.groups[this.grpEl.value]; if (!grp) { this._renderAnimLinks(); return; }
    grp.subanims.forEach((s, i) => { const o = document.createElement('option'); o.value = i; o.textContent = `#${i} (${s.cells.length} cells)`; this.subEl.append(o); });
    this._selectAnim();
    this._renderAnimLinks();
  }

  // Map of which OTHER animation groups share parts with the current one (so you can see
  // what an edit will also affect). Clickable → jump to that animation.
  _buildGrpSels() {
    this._grpSels = {}; this._selGroups = {};   // group→sels, and the inverse sel→groups (for the per-tile "in animations" list)
    if (!this.asm || !this.anim || !this.anim.groups) return;
    for (const [g, gd] of Object.entries(this.anim.groups)) {
      const set = new Set();
      for (const sa of (gd.subanims || [])) for (const c of (sa.cells || [])) {
        const recs = this.asm[String(c.sprite_id & 0x7fff)] || this.asm[String(c.sprite_id)];
        if (recs) for (const r of recs) set.add(r.part);
      }
      this._grpSels[g] = set;
      for (const sel of set) (this._selGroups[sel] ||= new Set()).add(g);
    }
  }

  // select-tool: click a part to (de)select it. Multi-select; selected parts are outlined on
  // EVERY frame/animation they appear in, and listed (thumbnail + usage) in the side panel.
  _selectPartAt(e) {
    const p = this._xy(e); const f = this.frame; if (!p || !f) return;
    const ci = p[1] * f.W + p[0];
    let sel = f.ownSel[ci]; if (sel < 0) sel = f.boxSel[ci];
    if (sel < 0) return;
    if (this._selSet.has(sel)) this._selSet.delete(sel); else this._selSet.add(sel);   // toggle
    this._activeLayer = this._selSet.has(sel) ? sel : (this._selSet.size ? [...this._selSet].pop() : null);
    if (this.layerEl) this.layerEl.value = this._activeLayer != null ? String(this._activeLayer) : '';
    this._renderSelPanel(); this._drawFrame();   // selected parts outlined; active brought to front
  }
  _drawPartThumb(canvas, sel) {
    const r = this.bundle && this.bundle.parts[sel]; if (!r) return;
    const ctx = canvas.getContext('2d'); ctx.imageSmoothingEnabled = false;
    const cw = canvas.width, ch = canvas.height; ctx.clearRect(0, 0, cw, ch);
    const px = this._partPix(sel), z = Math.max(1, Math.floor(Math.min(cw / r.w, ch / r.h)));
    const ox = (cw - r.w * z) >> 1, oy = (ch - r.h * z) >> 1;
    for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) { const i = px[y * r.w + x]; if (i === 0) continue; const c = this.cur[i] || [0, 0, 0]; ctx.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`; ctx.fillRect(ox + x * z, oy + y * z, z, z); }
  }
  // Find the first sprite_id in animation group `g` whose assembly uses part `sel`.
  // Returns {sid, subIdx, cellIdx, flip, flipy} (subIdx/cellIdx locate the frame for jump-to).
  _findSidInGroup(g, sel) {
    const gd = this.anim && this.anim.groups[g]; if (!gd) return null;
    const subs = gd.subanims || [];
    for (let si = 0; si < subs.length; si++) {
      const cells = subs[si].cells || [];
      for (let ci = 0; ci < cells.length; ci++) {
        const sid = cells[ci].sprite_id;
        const recs = this.asm[String(sid & 0x7fff)] || this.asm[String(sid)];
        if (!recs) continue;
        const r = recs.find(rr => rr.part === sel);
        if (r) return { sid, subIdx: si, cellIdx: ci, flip: !!r.flip, flipy: !!r.flipy };
      }
    }
    return null;
  }
  // Composite a full frame (sprite_id `sid`) scaled-to-fit into a thumbnail and OUTLINE part `sel`.
  // Uses the same placement + engine-z (reverse record order, re_kb finding:per_part_depth_zinvW)
  // as _composite so the thumbnail matches the editor exactly.
  _drawContextThumb(canvas, sid, sel) {
    const recs = (this.asm[String(sid & 0x7fff)] || this.asm[String(sid)]); if (!recs || !this.bundle) return;
    const pl = []; let minx = 1e9, miny = 1e9, maxx = -1e9, maxy = -1e9;
    for (const r of recs) {
      const pr = this.bundle.parts[r.part]; if (!pr) continue;
      const w = pr.w, h = pr.h, flip = !!r.flip, flipy = !!r.flipy;
      const x = -r.dx, y = flipy ? -(r.dy + h) : r.dy;
      pl.push({ sel: r.part, x, y, w, h, flip, flipy });
      minx = Math.min(minx, x); miny = Math.min(miny, y); maxx = Math.max(maxx, x + w); maxy = Math.max(maxy, y + h);
    }
    if (!pl.length) return;
    const W = maxx - minx, H = maxy - miny;
    const ctx = canvas.getContext('2d'); ctx.imageSmoothingEnabled = false;
    const cw = canvas.width, ch = canvas.height; ctx.clearRect(0, 0, cw, ch);
    const z = Math.min(cw / W, ch / H), ox = (cw - W * z) / 2, oy = (ch - H * z) / 2, pz = Math.max(1, Math.ceil(z));
    // engine z: first-submitted = front, so paint in REVERSE record order (record 0 ends on top)
    for (let i = pl.length - 1; i >= 0; i--) {
      const p = pl[i], pix = this._partPix(p.sel);
      for (let py = 0; py < p.h; py++) for (let px = 0; px < p.w; px++) {
        const sx = p.flip ? p.w - 1 - px : px, sy = p.flipy ? p.h - 1 - py : py;
        const idx = pix[sy * p.w + sx]; if (idx === 0) continue;
        const c = this.cur[idx] || [0, 0, 0]; ctx.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`;
        ctx.fillRect(ox + (p.x - minx + px) * z, oy + (p.y - miny + py) * z, pz, pz);
      }
    }
    for (const p of pl) if (p.sel === sel) {
      ctx.strokeStyle = '#ff5fd0'; ctx.lineWidth = 1.5;
      ctx.strokeRect(ox + (p.x - minx) * z, oy + (p.y - miny) * z, p.w * z, p.h * z);
    }
  }
  // Click-to-edit a part from the side panel: jump to a frame that shows it, SOLO it (so the
  // canvas shows just that part), arm the pencil. The change applies to every frame & animation
  // that uses this part (parts are shared). Untick "solo" to paint it in context.
  _editPart(sel) {
    let target = (this.cells || []).findIndex(c => {
      const recs = this.asm[String((c.sprite_id) & 0x7fff)] || this.asm[String(c.sprite_id)];
      return recs && recs.some(rr => rr.part === sel);
    });
    if (target < 0) {   // not in the current animation — jump to one that uses it
      const groups = this._selGroups && this._selGroups[sel];
      const g = groups && groups.size ? [...groups][0] : null;
      const found = g != null ? this._findSidInGroup(g, sel) : null;
      if (found) { this.grpEl.value = g; this._populateSubs(); this.subEl.value = found.subIdx; this._selectAnim(); this._renderAnimLinks(); target = found.cellIdx; }
    }
    this._activeLayer = sel; this._solo = true;
    const sc = this.root.querySelector('.ss-solo'); if (sc) sc.checked = true;
    this._setTool('pencil');
    if (target >= 0) this._gotoFrame(target); else this._drawFrame();
    if (this.layerEl) this.layerEl.value = String(sel);
    this._renderSelPanel();
    this.bakeEl.innerHTML = `<span class="dim">editing part ${sel} (soloed) — paint it; the change applies to EVERY frame &amp; animation that uses this part. Untick “solo” to see it in context.</span>`;
  }
  // Side panel: one card per selected part — clickable thumbnail (→ edit), dims, ✏ edit / × buttons,
  // and a context gallery (full-frame thumbnails of every animation the part appears in).
  _renderSelPanel() {
    if (!this.sellistEl) return;
    this.sellistEl.innerHTML = '';
    if (!this._selSet.size) { if (this.selpanelEl) this.selpanelEl.style.display = 'none'; return; }
    for (const sel of this._selSet) {
      const r = this.bundle && this.bundle.parts[sel];
      const row = document.createElement('div');
      row.style.cssText = `border:1px solid ${sel === this._activeLayer ? '#ff5fd0' : '#262a33'}; border-radius:5px; padding:5px; background:#15171d;`;
      const editing = sel === this._activeLayer;
      const tc = document.createElement('canvas'); tc.width = 56; tc.height = 56;
      tc.title = 'click to edit this part';
      tc.style.cssText = `image-rendering:pixelated; background:#0b0c10; border:1px solid ${editing ? '#ff5fd0' : '#262a33'}; display:block; margin:0 auto 4px; cursor:pointer;`;
      this._drawPartThumb(tc, sel); tc.onclick = () => this._editPart(sel); row.append(tc);
      const info = document.createElement('div');
      info.style.cssText = 'font-size:11px; color:#d7dae2; display:flex; justify-content:space-between; align-items:center; gap:4px;';
      const lab = document.createElement('span'); lab.innerHTML = `part <b>${sel}</b>${r ? ` ${r.w}×${r.h}` : ''}${editing ? ' <span style="color:#ff5fd0">✏</span>' : ''}`; info.append(lab);
      const btns = document.createElement('span'); btns.style.cssText = 'display:flex; gap:4px;';
      const edit = document.createElement('button'); edit.textContent = '✏ edit'; edit.title = 'edit this part (soloed) — applies to every animation that uses it';
      edit.style.cssText = `font-size:10px; padding:1px 6px; ${editing ? 'background:#3a2740; outline:1px solid #ff5fd0;' : ''}`;
      edit.onclick = () => this._editPart(sel);
      const rm = document.createElement('button'); rm.textContent = '×'; rm.title = 'deselect'; rm.style.cssText = 'font-size:11px; padding:0 6px;';
      rm.onclick = () => { this._selSet.delete(sel); if (this._activeLayer === sel) this._activeLayer = this._selSet.size ? [...this._selSet].pop() : null; this._renderSelPanel(); this._drawFrame(); };
      btns.append(edit, rm); info.append(btns); row.append(info);
      // CONTEXT GALLERY: one small full-frame thumbnail per animation this part appears in,
      // with the part outlined + a flip badge (⇄ X-mirror, ⇅ Y-mirror), so you can see HOW the
      // part is reused (position/flip) before editing. Click → jump to that animation/frame.
      const groups = this._selGroups && this._selGroups[sel];
      const cl = document.createElement('div'); cl.style.cssText = 'font-size:10px; color:#7f8593; margin-top:5px;';
      cl.textContent = `seen in ${groups ? groups.size : 0} animation${groups && groups.size === 1 ? '' : 's'}:`; row.append(cl);
      const gal = document.createElement('div'); gal.style.cssText = 'display:flex; flex-wrap:wrap; gap:4px; margin-top:3px;';
      if (groups) {
        const sorted = [...groups].sort((a, b) => +a - +b); const CAP = 12;
        for (let gi = 0; gi < sorted.length; gi++) {
          const g = sorted[gi];
          if (gi >= CAP) { const m = document.createElement('span'); m.style.cssText = 'font-size:10px; color:#7f8593; align-self:center;'; m.textContent = `+${sorted.length - CAP} more`; gal.append(m); break; }
          const found = this._findSidInGroup(g, sel); if (!found) continue;
          const wrap = document.createElement('div'); wrap.style.cssText = 'position:relative; cursor:pointer; line-height:0;';
          const grp = this.anim.groups[g];
          wrap.title = `g${g}${grp?.kind ? ' [' + grp.kind + ']' : ''}${grp?.name ? ' ' + grp.name : ''} — click to view`;
          const cc = document.createElement('canvas'); cc.width = 54; cc.height = 54;
          cc.style.cssText = 'image-rendering:pixelated; background:#0b0c10; border:1px solid #262a33; display:block;';
          this._drawContextThumb(cc, found.sid, sel); wrap.append(cc);
          const tag = document.createElement('span');
          tag.textContent = `g${g}${found.flip ? ' ⇄' : ''}${found.flipy ? ' ⇅' : ''}`;
          tag.style.cssText = 'position:absolute; left:0; bottom:0; font-size:9px; color:#d8ecff; background:rgba(0,0,0,.62); padding:0 3px; line-height:1.3;';
          wrap.append(tag);
          wrap.onclick = () => {
            this.grpEl.value = g; this._populateSubs();
            this.subEl.value = found.subIdx; this._selectAnim();
            this._gotoFrame(found.cellIdx);
          };
          gal.append(wrap);
        }
      }
      row.append(gal); this.sellistEl.append(row);
    }
    this.selpanelEl.style.display = 'flex';
  }
  // central tool switch: highlight the active tool button + set the canvas cursor.
  _setTool(t) {
    if (this._resetInput) this._resetInput();   // never carry a stuck stroke/pan/marquee across a mode switch
    this.tool = t;
    this.root.querySelectorAll('.ss-tools button[data-t]').forEach(x => x.classList.toggle('on', x.dataset.t === t));
    if (this.editC) this.editC.style.cursor = t === 'select' ? 'pointer' : t === 'pan' ? 'grab' : 'crosshair';
    this._renderToolOptions();
  }
  // Show only the option groups relevant to the active tool (contextual tool-options bar).
  _renderToolOptions() {
    const t = this.tool;
    this.root.querySelectorAll('.ss-optgrp').forEach(g => { g.style.display = (g.dataset.tools || '').split(' ').includes(t) ? '' : 'none'; });
    const hint = { select: 'click a part to inspect it / make it the active layer', pick: 'click the sprite to load that colour', pan: 'drag to pan (right-drag or hold Space works with any tool too)', marquee: 'drag a box to copy it, then switch to 📌 stamp', region: 'drag a box over a feature to select its parts across the whole animation', stamp: 'click to place · H/V flip · R rotate' };
    const h = this.root.querySelector('.ss-topt-hint'); if (h) h.textContent = hint[t] || '';
    const lbl = this.root.querySelector('.ss-topt-label'); if (lbl) lbl.textContent = (t === 'marquee' ? 'copy' : t) + ' options';
  }
  // true if part `sel` is used by any animation group OTHER than the one currently open —
  // i.e. editing it will affect another move. Drives the amber/blue box color in _render.
  _sharedSel(sel) {
    const groups = this._selGroups && this._selGroups[sel]; if (!groups) return false;
    const g = this.grpEl && this.grpEl.value;
    for (const og of groups) if (og !== g) return true;
    return false;
  }
  _renderAnimLinks() {
    if (!this.linksEl) return;
    this.linksEl.innerHTML = '';
    const g = this.grpEl && this.grpEl.value, cur = this._grpSels && this._grpSels[g];
    if (!cur || !cur.size) return;
    const links = [];
    for (const og in this._grpSels) {
      if (og === g) continue; let n = 0; for (const s of cur) if (this._grpSels[og].has(s)) n++;
      if (n > 0) links.push([og, n]);
    }
    if (!links.length) { this.linksEl.textContent = '✓ parts here are unique to this animation — safe to edit'; return; }
    links.sort((a, b) => b[1] - a[1]);
    const lab = document.createElement('span'); lab.innerHTML = '✎ <b style="color:#ffaa46">editing here also changes</b>:'; this.linksEl.append(lab);
    const top = links.slice(0, 12);
    for (const [og, n] of top) {
      const grp = this.anim.groups[og]; const chip = document.createElement('button');
      chip.textContent = `g${og}${grp?.kind ? ' [' + grp.kind + ']' : ''} ·${n}`;
      chip.title = `shares ${n} part(s) with the current animation — edits to those parts affect it too. Click to PREVIEW it (you keep your place).`;
      chip.style.cssText = 'font-size:11px; padding:2px 7px;';
      chip.onclick = () => this._previewAnim(og);
      this.linksEl.append(chip);
    }
    if (links.length > top.length) { const more = document.createElement('span'); more.textContent = `+${links.length - top.length} more`; this.linksEl.append(more); }
  }
  // Preview another animation in the side panel WITHOUT navigating away (keeps your edit place).
  // Auto-plays the group's first subanim; "✎ edit this animation" switches the editor to it.
  _previewAnim(g) {
    const grp = this.anim && this.anim.groups[g]; if (!grp || !this.previewEl) return;
    const sub = (grp.subanims || [])[0];
    this._pvCells = sub ? sub.cells : []; this._pvFi = 0; this._pvGroup = g;
    this._pvTitle.textContent = `g${g} ${grp.name || ''}`.trim();
    this._pvInfo.textContent = `${grp.kind || '?'} · ${this._pvCells.length} frame(s) — shared parts outlined elsewhere`;
    this.previewEl.style.display = 'flex';
    this._stopPreview();
    if (this._pvCells.length) {
      this._renderPreviewFrame();
      if (this._pvCells.length > 1) this._pvTimer = setInterval(() => { this._pvFi = (this._pvFi + 1) % this._pvCells.length; this._renderPreviewFrame(); }, 140);
    }
  }
  _stopPreview() { if (this._pvTimer) { clearInterval(this._pvTimer); this._pvTimer = null; } }
  _renderPreviewFrame() {
    const cv = this._pvCanvas, cell = this._pvCells && this._pvCells[this._pvFi]; if (!cv) return;
    const ctx = cv.getContext('2d'); ctx.imageSmoothingEnabled = false; ctx.clearRect(0, 0, cv.width, cv.height);
    const comp = cell && this._compositeCell(cell, false); if (!comp) return;
    const id = new ImageData(comp.W, comp.H), d = id.data;
    for (let i = 0; i < comp.W * comp.H; i++) { const idx = comp.out[i]; if (idx === 0) { d[i * 4 + 3] = 0; continue; } const c = this.cur[idx] || [0, 0, 0]; d[i * 4] = c[0]; d[i * 4 + 1] = c[1]; d[i * 4 + 2] = c[2]; d[i * 4 + 3] = 255; }
    const oc = new OffscreenCanvas(comp.W, comp.H); oc.getContext('2d').putImageData(id, 0, 0);
    const z = Math.min(cv.width / comp.W, cv.height / comp.H), ox = (cv.width - comp.W * z) / 2, oy = (cv.height - comp.H * z) / 2;
    ctx.drawImage(oc, 0, 0, comp.W, comp.H, ox, oy, comp.W * z, comp.H * z);
  }
  _selectAnim() {
    const grp = this.anim && this.anim.groups[this.grpEl.value]; const sub = grp && grp.subanims[+this.subEl.value];
    this.cells = sub ? sub.cells : []; this.fi = 0; this.frEl.max = Math.max(0, this.cells.length - 1); this.frEl.value = 0;
    this._fitOnCenter = true; this._panX = null; this._drawFrame();
    this._buildTimeline(); this._startLive();
    this._renderAnimLinks();   // refresh the "editing here also changes…" impact map for this animation
  }
  _gotoFrame(i) { if (!this.cells.length) return; this.fi = (i + this.cells.length) % this.cells.length; this.frEl.value = this.fi; this._drawFrame(); this._highlightTimeline(); }

  // ---------- frame timeline strip ----------
  _buildTimeline() {
    const el = this.timelineEl; if (!el) return;
    const cells = this.cells || [];
    if (!cells.length) { el.innerHTML = '<span class="ss-tl-empty">frame timeline — pick an animation</span>'; return; }
    el.innerHTML = ''; const TH = 34;
    cells.forEach((cell, i) => {
      const comp = (i === this.fi && this.frame) ? this.frame : this._compositeCell(cell, false);
      const cv = document.createElement('canvas');
      cv.width = comp ? Math.max(22, Math.min(72, Math.round(TH * comp.W / comp.H))) : 30;
      cv.height = TH;
      if (i === this.fi) cv.className = 'on';
      cv.title = `frame ${i + 1}`;
      cv.onclick = () => this._gotoFrame(i);
      if (comp) this._drawCompThumb(cv, comp);
      el.appendChild(cv);
    });
  }
  _drawCompThumb(cv, comp) {
    const ctx = cv.getContext('2d'); ctx.imageSmoothingEnabled = false; ctx.clearRect(0, 0, cv.width, cv.height);
    const id = new ImageData(comp.W, comp.H), d = id.data;
    for (let i = 0; i < comp.W * comp.H; i++) { const idx = comp.out[i]; if (idx === 0) { d[i * 4 + 3] = 0; continue; } const c = this.cur[idx] || [0, 0, 0]; d[i * 4] = c[0]; d[i * 4 + 1] = c[1]; d[i * 4 + 2] = c[2]; d[i * 4 + 3] = 255; }
    const oc = new OffscreenCanvas(comp.W, comp.H); oc.getContext('2d').putImageData(id, 0, 0);
    const z = Math.min(cv.width / comp.W, cv.height / comp.H), ox = (cv.width - comp.W * z) / 2, oy = (cv.height - comp.H * z) / 2;
    ctx.drawImage(oc, 0, 0, comp.W, comp.H, ox, oy, comp.W * z, comp.H * z);
  }
  _highlightTimeline() { if (this.timelineEl) this.timelineEl.querySelectorAll('canvas').forEach((c, i) => c.classList.toggle('on', i === this.fi)); }

  // ---------- live preview loop + navigator minimap ----------
  _stopLive() { if (this._liveTimer) { clearInterval(this._liveTimer); this._liveTimer = null; } }
  _startLive() {
    this._stopLive();
    this._liveFi = 0; this._drawLiveFrame();
    const play = this.root.querySelector('.ss-live-play');
    if (play && play.checked && this.cells && this.cells.length > 1)
      this._liveTimer = setInterval(() => { this._liveFi = (this._liveFi + 1) % this.cells.length; this._drawLiveFrame(); }, Math.max(30, this._playMs || 120));
  }
  _drawLiveFrame() {
    const cv = this.root.querySelector('.ss-live-canvas'); if (!cv) return;
    cv.getContext('2d').clearRect(0, 0, cv.width, cv.height);
    if (!this.cells || !this.cells.length) return;
    const comp = this._compositeCell(this.cells[(this._liveFi || 0) % this.cells.length], false);   // reflects current edits
    if (comp) this._drawCompThumb(cv, comp);
  }
  // minimap: whole current frame + a viewport rectangle for the visible/zoomed region
  _drawMinimap() {
    const cv = this.root.querySelector('.ss-mini-canvas'), f = this.frame; if (!cv) return;
    const ctx = cv.getContext('2d'); ctx.imageSmoothingEnabled = false; ctx.clearRect(0, 0, cv.width, cv.height);
    if (!f) { this._miniGeom = null; return; }
    const z = Math.min(cv.width / f.W, cv.height / f.H), ox = (cv.width - f.W * z) / 2, oy = (cv.height - f.H * z) / 2;
    const id = new ImageData(f.W, f.H), d = id.data;
    for (let i = 0; i < f.W * f.H; i++) { const idx = f.out[i]; if (idx === 0) { d[i * 4 + 3] = 0; continue; } const c = this.cur[idx] || [0, 0, 0]; d[i * 4] = c[0]; d[i * 4 + 1] = c[1]; d[i * 4 + 2] = c[2]; d[i * 4 + 3] = 255; }
    const oc = new OffscreenCanvas(f.W, f.H); oc.getContext('2d').putImageData(id, 0, 0);
    ctx.drawImage(oc, 0, 0, f.W, f.H, ox, oy, f.W * z, f.H * z);
    const ez = this._z || 1, vx = -this._ox / ez, vy = -this._oy / ez, vw = this.editC.width / ez, vh = this.editC.height / ez;
    ctx.strokeStyle = '#ffe878'; ctx.lineWidth = 1;
    ctx.strokeRect(ox + vx * z + 0.5, oy + vy * z + 0.5, Math.max(2, vw * z), Math.max(2, vh * z));
    this._miniGeom = { ox, oy, z };
  }
  _miniPanTo(e) {
    const cv = this.root.querySelector('.ss-mini-canvas'), g = this._miniGeom; if (!cv || !g || !this.frame) return;
    const r = cv.getBoundingClientRect();
    const mx = (e.clientX - r.left) * (cv.width / r.width), my = (e.clientY - r.top) * (cv.height / r.height);
    const cx = (mx - g.ox) / g.z, cy = (my - g.oy) / g.z, ez = this._z || 1;
    this._panX = this.editC.width / 2 - cx * ez; this._panY = this.editC.height / 2 - cy * ez;
    this._render();
  }
  _togglePlay(btn) { if (this._timer) { this._stop(); btn.textContent = '▶'; } else { btn.textContent = '⏸'; const tick = () => { this._gotoFrame(this.fi + 1); }; this._timer = setInterval(tick, this._playMs || 120); } }
  _stop() { if (this._timer) { clearInterval(this._timer); this._timer = null; const b = this.root.querySelector('.ss-play'); if (b) b.textContent = '▶'; } }

  // current pixels of a part (painted override, else decoded from the bundle once)
  _partPix(sel) {
    if (this.painted[sel]) return this.painted[sel];
    if (this._origPix[sel]) return this._origPix[sel];
    const r = this.bundle.parts[sel]; const px = new Uint8Array(r.w * r.h);
    for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) {
      const p = ((r.y + y) * this.bundle.w + (r.x + x)) * 4; const a = this.bundleData[p + 3];
      px[y * r.w + x] = a === 0 ? 0 : (this._key2idx[`${this.bundleData[p]},${this.bundleData[p + 1]},${this.bundleData[p + 2]}`] ?? 0);
    }
    this._origPix[sel] = px; return px;
  }

  _composite() { return this._compositeCell(this.cells[this.fi], true); }   // current frame (honors active-layer solo/front)
  // composite ANY cell's sprite into an index buffer + owner maps (for decompose / cross-frame paint).
  // applyActive=true applies the active-layer solo/front override (only meaningful for the live frame);
  // ax/ay in the result are the ABSOLUTE sprite origin so the same spot can be located across frames.
  _compositeCell(cell, applyActive) {
    if (!cell || !this.asm || !this.bundle) return null;
    const sid = cell.sprite_id; if (sid == null || sid === 0xFFFF) return null;
    const recs = this.asm[String(sid & 0x7fff)] || this.asm[String(sid)]; if (!recs) return null;
    const pl = [];
    let minx = 1e9, miny = 1e9, maxx = -1e9, maxy = -1e9;
    for (const r of recs) {
      const pr = this.bundle.parts[r.part]; if (!pr) continue;
      const w = pr.w, h = pr.h, flip = !!r.flip, flipy = !!r.flipy;
      // Placement VALIDATED vs whole-sprite ground truth across PL00/17/2C/2A (mean width-dev
      // 0.1-5.2px, sign-detect over 40 sids/char): part left edge = -dx (the _asm dx convention
      // is negated vs the facing-0 atlas), NO -w. The 0x4000 flip is a PIXEL mirror only — it
      // does NOT move the quad (flipMoves=true gave 38-101px error). flipy mirrors the rect in Y.
      const pdx = -r.dx, pdy = flipy ? -(r.dy + h) : r.dy;
      pl.push({ sel: r.part, x: pdx, y: pdy, w, h, flip, flipy });
      minx = Math.min(minx, pdx); miny = Math.min(miny, pdy); maxx = Math.max(maxx, pdx + w); maxy = Math.max(maxy, pdy + h);
    }
    if (!pl.length) return null;
    const W = maxx - minx, H = maxy - miny, N = W * H;
    const out = new Uint8Array(N), ownSel = new Int32Array(N).fill(-1), ownLoc = new Int32Array(N).fill(-1), boxSel = new Int32Array(N).fill(-1), boxLoc = new Int32Array(N).fill(-1);
    // layer switch: SOLO shows only the active layer; otherwise bring it to the front so its
    // pixels/box win — lets you paint a part that another part (e.g. a cape) is drawn over.
    const bias = this._zBias || {};
    // ENGINE TRUTH (re_kb finding:per_part_depth_zinvW): parts layer by Z=1/W — the FIRST-submitted
    // part is FRONT-most, the last is REAR-most. So paint in REVERSE record order (record 0 ends on top).
    let drawList = [...pl].reverse().sort((a, b) => (bias[a.sel] || 0) - (bias[b.sel] || 0));   // + manual z-bias, stable
    if (applyActive && this._activeLayer != null)
      drawList = this._solo ? drawList.filter(p => p.sel === this._activeLayer)
                            : [...drawList.filter(p => p.sel !== this._activeLayer), ...drawList.filter(p => p.sel === this._activeLayer)];
    for (const p of drawList) {
      const pix = this._partPix(p.sel);
      for (let py = 0; py < p.h; py++) for (let px = 0; px < p.w; px++) {
        const sx = p.flip ? p.w - 1 - px : px, sy = p.flipy ? p.h - 1 - py : py;
        const loc = sy * p.w + sx, idx = pix[loc];
        const ci = (p.y - miny + py) * W + (p.x - minx + px);
        boxSel[ci] = p.sel; boxLoc[ci] = loc;
        if (idx !== 0) { out[ci] = idx; ownSel[ci] = p.sel; ownLoc[ci] = loc; }
      }
    }
    const parts = pl.map(p => ({ sel: p.sel, x: p.x - minx, y: p.y - miny, w: p.w, h: p.h, flip: p.flip, flipy: p.flipy }));
    return { out, W, H, ownSel, ownLoc, boxSel, boxLoc, parts, ax: minx, ay: miny };
  }

  _drawFrame() { this.frame = this._composite(); this._oc = null; this._populateLayers(); this._render(); }   // recomposite + draw (frame/part change)

  // Size the canvas to fill its whole container (as big as the space it's in); re-fit the sprite.
  // Called on load + on window/layout resize.
  _resizeCanvas() {
    const wrap = this.editC && this.editC.parentElement; if (!wrap) return;
    const w = Math.max(200, Math.floor(wrap.clientWidth - 24)), h = Math.max(200, Math.floor(wrap.clientHeight - 24));
    if (this.editC.width === w && this.editC.height === h) return;
    this.editC.width = w; this.editC.height = h;
    this.ectx.imageSmoothingEnabled = false;   // resizing a canvas resets its 2D context state
    this._oc = null; this._panX = null; this._fitOnCenter = true;
    this._render();
  }

  // ---------- all-frames cascade (edit the same spot across the whole animation) ----------
  // Part placement is independent of painted pixels, so one base-composite per cell per stroke is
  // enough. _paintAcrossFrames maps an ABSOLUTE sprite coord into each other frame and paints there.
  _buildFrameComps() { this._frameComps = (this.cells || []).map(c => this._compositeCell(c, false)); }
  _clearFrameComps() { this._frameComps = null; }
  // px/py = current-frame-local composite coords. Two anchor modes:
  //  'abs'  — same ABSOLUTE sprite coord on every frame (good for fixed-position features).
  //  'top'  — same offset from each frame's TOP-CENTER (tracks a head as the body bobs).
  _paintAcrossFrames(px, py, value, undoMap) {
    if (!this._frameComps) this._buildFrameComps();
    const src = this.frame; if (!src) return;
    const top = this._afAnchor === 'top', absX = src.ax + px, absY = src.ay + py;
    for (let fi = 0; fi < this._frameComps.length; fi++) {
      if (fi === this.fi) continue;
      const comp = this._frameComps[fi]; if (!comp) continue;
      const lx = top ? px + ((comp.W - src.W) >> 1) : absX - comp.ax;
      const ly = top ? py : absY - comp.ay;
      if (lx < 0 || ly < 0 || lx >= comp.W || ly >= comp.H) continue;
      const ci = ly * comp.W + lx;
      let sel = comp.ownSel[ci], loc = comp.ownLoc[ci];
      if (sel < 0) { sel = comp.boxSel[ci]; loc = comp.boxLoc[ci]; }
      if (sel < 0) continue;
      if (undoMap && !undoMap.has(sel)) undoMap.set(sel, (this.painted[sel] || this._partPix(sel)).slice());
      if (!this.painted[sel]) this.painted[sel] = this._partPix(sel).slice();
      this.painted[sel][loc] = value;
    }
  }

  // Paint one composite pixel (px,py) → `value`, mapping to its owning part, recording that part's
  // before-state in `undoMap`. Honors the all-frames cascade and symmetry (mirrors the pixel once).
  // Shared by the pencil, the shape tools, and the gradient/dither fill.
  _setComposite(px, py, value, undoMap, mirror = true) {
    const f = this.frame; if (!f) return;
    if (px >= 0 && py >= 0 && px < f.W && py < f.H) {
      const ci = py * f.W + px;
      let sel = f.ownSel[ci], loc = f.ownLoc[ci];
      if (sel < 0) { sel = f.boxSel[ci]; loc = f.boxLoc[ci]; }
      if (sel >= 0) {
        if (undoMap && !undoMap.has(sel)) undoMap.set(sel, (this.painted[sel] || this._partPix(sel)).slice());
        if (!this.painted[sel]) this.painted[sel] = this._partPix(sel).slice();
        this.painted[sel][loc] = value;
        if (this._allFrames) this._paintAcrossFrames(px, py, value, undoMap);
      }
    }
    if (mirror && this._sym && this._sym !== 'none') {
      const mx = this._sym === 'v' ? (f.W - 1 - px) : px;
      const my = this._sym === 'h' ? (f.H - 1 - py) : py;
      if (mx !== px || my !== py) this._setComposite(mx, my, value, undoMap, false);
    }
  }
  // Revert one composite pixel to its pre-stroke value (pixel-perfect corner removal).
  _revertComposite(px, py, undoMap) {
    const f = this.frame; if (!f || px < 0 || py < 0 || px >= f.W || py >= f.H) return;
    const ci = py * f.W + px; let sel = f.ownSel[ci], loc = f.ownLoc[ci];
    if (sel < 0) { sel = f.boxSel[ci]; loc = f.boxLoc[ci]; } if (sel < 0) return;
    const before = undoMap && undoMap.get(sel);
    if (before && this.painted[sel]) this.painted[sel][loc] = before[loc];
  }
  // Shading ink: order the non-transparent palette by luminance and step an index one slot
  // lighter (dir +1) / darker (dir -1). Cached; invalidated in _renderBrush when colours change.
  _shadeIndex(idx, dir) {
    if (!this._lumOrder) {
      const arr = [];
      for (let i = 1; i < 16; i++) { const c = this.cur[i]; if (c && c[3] !== 0) arr.push([i, 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]]); }
      arr.sort((a, b) => a[1] - b[1]);
      this._lumOrder = arr.map(x => x[0]);
    }
    const pos = this._lumOrder.indexOf(idx); if (pos < 0) return idx;
    return this._lumOrder[Math.max(0, Math.min(this._lumOrder.length - 1, pos + dir))];
  }

  // Rasterize a shape (line / rect / ellipse) into composite pixel coords. rect/ellipse are outlined
  // unless _shapeFill is on. Bresenham line; scanline fill; parametric/scanline ellipse.
  _rasterShape(s) {
    const { x0, y0, x1, y1, tool } = s, pts = [];
    if (tool === 'line') {
      let x = x0, y = y0; const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
      const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1; let err = dx + dy;
      for (;;) { pts.push([x, y]); if (x === x1 && y === y1) break; const e2 = 2 * err; if (e2 >= dy) { err += dy; x += sx; } if (e2 <= dx) { err += dx; y += sy; } }
    } else {
      const xa = Math.min(x0, x1), xb = Math.max(x0, x1), ya = Math.min(y0, y1), yb = Math.max(y0, y1);
      if (tool === 'rect') {
        if (this._shapeFill) { for (let y = ya; y <= yb; y++) for (let x = xa; x <= xb; x++) pts.push([x, y]); }
        else { for (let x = xa; x <= xb; x++) { pts.push([x, ya], [x, yb]); } for (let y = ya; y <= yb; y++) { pts.push([xa, y], [xb, y]); } }
      } else if (tool === 'ellipse') {
        const cx = (xa + xb) / 2, cy = (ya + yb) / 2, rx = (xb - xa) / 2, ry = (yb - ya) / 2;
        const seen = new Set(), add = (x, y) => { const k = x + ',' + y; if (!seen.has(k)) { seen.add(k); pts.push([x, y]); } };
        if (rx < 0.5 || ry < 0.5) { for (let x = xa; x <= xb; x++) add(x, Math.round(cy)); }
        else if (this._shapeFill) {
          for (let y = ya; y <= yb; y++) { const t = (y - cy) / ry; if (Math.abs(t) > 1) continue; const hw = rx * Math.sqrt(1 - t * t); for (let x = Math.round(cx - hw); x <= Math.round(cx + hw); x++) add(x, y); }
        } else {
          const steps = Math.max(24, Math.ceil((rx + ry) * 4));
          for (let i = 0; i <= steps; i++) { const a = (i / steps) * Math.PI * 2; add(Math.round(cx + rx * Math.cos(a)), Math.round(cy + ry * Math.sin(a))); }
        }
      }
    }
    return pts;
  }
  // Commit a dragged shape: paint every rasterized pixel with the current brush, as ONE undo step.
  _commitShape(s) {
    if (!s || !this.frame) return;
    const pts = this._rasterShape(s); if (!pts.length) return;
    const undo = new Map();
    if (this._allFrames) this._buildFrameComps();
    for (const [px, py] of pts) this._setComposite(px, py, this.brush, undo);
    this._clearFrameComps();
    if (undo.size) this._pushUndo([...undo.entries()].map(([sel, pix]) => ({ sel, pix })));
    this._drawFrame(); this._renderBake();
  }

  // ---------- region box-select + propagate ----------
  // Drag-select: box a region of the assembled frame, then select every part that falls in the
  // SAME region across EVERY frame of the animation. The box is normalized to the current frame
  // and re-applied per frame, so a head at the top is caught even as the body bobs. (Use it like
  // the copy tool — drag over the head, then edit/propagate.)
  _selectRegionBox(x0, y0, x1, y1) {
    const f = this.frame; if (!f) return;
    const xa = Math.min(x0, x1), ya = Math.min(y0, y1), xb = Math.max(x0, x1), yb = Math.max(y0, y1);
    if (xb - xa < 2 || yb - ya < 2) return;   // ignore a click / tiny drag (keeps current selection)
    const nx0 = xa / f.W, ny0 = ya / f.H, nx1 = xb / f.W, ny1 = yb / f.H;
    const sels = new Set(), cells = this.cells || [];
    for (let i = 0; i < cells.length; i++) {
      const comp = (i === this.fi) ? f : this._compositeCell(cells[i], false); if (!comp) continue;
      const bx0 = nx0 * comp.W, by0 = ny0 * comp.H, bx1 = nx1 * comp.W, by1 = ny1 * comp.H;
      for (const pb of comp.parts) {
        const ox = Math.min(pb.x + pb.w, bx1) - Math.max(pb.x, bx0);
        const oy = Math.min(pb.y + pb.h, by1) - Math.max(pb.y, by0);
        const area = pb.w * pb.h;
        if (ox > 0 && oy > 0 && area > 0 && (ox * oy) / area >= 0.35) sels.add(pb.sel);   // ≥35% of the part inside
      }
    }
    this._selSet = sels; this._activeLayer = sels.size ? [...sels][0] : null;
    if (this.layerEl) this.layerEl.value = this._activeLayer != null ? String(this._activeLayer) : '';
    this._renderSelPanel(); this._drawFrame();
    this.bakeEl.innerHTML = sels.size
      ? `<span class="dim">selected ${sels.size} part(s) in this region across ${cells.length} frame(s) — pick ✏ pencil to edit (shared parts cascade), or ↪ propagate to the matches</span>`
      : '<span class="dim">no parts in that region — drag a tighter box over the feature</span>';
  }
  // Apply the ACTIVE part's pixel edits to the other SELECTED parts that match it (same size +
  // ≥60% identical original pixels). Deterministic; one undoable step. Skips mismatched parts.
  _propagateEdit() {
    const src = this._activeLayer;
    if (src == null) { this.bakeEl.innerHTML = '<span class="dim">select the part you edited (it becomes the active layer) first</span>'; return; }
    const srcPix = this.painted[src], srcOrig = this._origPix[src] || this._partPix(src);
    if (!srcPix) { this.bakeEl.innerHTML = '<span class="dim">the active part has no edits to propagate — paint it first</span>'; return; }
    const delta = []; for (let i = 0; i < srcPix.length; i++) if (srcPix[i] !== srcOrig[i]) delta.push(i);
    if (!delta.length) { this.bakeEl.innerHTML = '<span class="dim">no changes on the active part</span>'; return; }
    const sp = this.bundle.parts[src], targets = [...this._selSet].filter(s => s !== src);
    const undo = []; let applied = 0, skipped = 0;
    for (const t of targets) {
      const tp = this.bundle.parts[t]; if (!tp || tp.w !== sp.w || tp.h !== sp.h) { skipped++; continue; }
      const tOrig = this._origPix[t] || this._partPix(t);
      let same = 0; for (let i = 0; i < tOrig.length; i++) if (tOrig[i] === srcOrig[i]) same++;
      if (same / tOrig.length < 0.6) { skipped++; continue; }
      undo.push({ sel: t, pix: (this.painted[t] || tOrig).slice() });
      if (!this.painted[t]) this.painted[t] = tOrig.slice();
      for (const i of delta) this.painted[t][i] = srcPix[i];
      applied++;
    }
    if (applied) { this._pushUndo(undo); this._drawFrame(); }
    this.bakeEl.innerHTML = `<span class="dim">propagated to ${applied} matching part(s)${skipped ? ` · ${skipped} skipped (different size/shape — edit those by hand)` : ''}</span>`;
  }

  // populate the layer switch from the current frame's parts (back→front). Only rebuilds when the
  // parts set actually changes (so it survives paint strokes), and keeps the active selection.
  _populateLayers() {
    if (!this.layerEl) return;
    const f = this.frame, sig = f ? f.parts.map(p => p.sel).join(',') : '';
    if (sig === this._layerSig) return;
    this._layerSig = sig;
    const prev = this._activeLayer;
    this.layerEl.innerHTML = '<option value="">all layers</option>';
    if (f) f.parts.forEach((p, i) => { const o = document.createElement('option'); o.value = p.sel; o.textContent = `L${i} · sel ${p.sel} (${p.w}×${p.h})`; this.layerEl.append(o); });
    if (prev != null && f && f.parts.some(p => p.sel === prev)) this.layerEl.value = String(prev);
    else { this._activeLayer = null; this.layerEl.value = ''; }
  }
  // z-bias for the active part: send behind / bring in front. Keyed by sel, so it applies to
  // EVERY frame/animation that uses that part (e.g. send a cape behind once, it sticks).
  _biasLayer(dir) {
    if (this._activeLayer == null) return;
    const vals = Object.values(this._zBias);
    this._zBias[this._activeLayer] = dir < 0 ? Math.min(0, ...vals) - 1 : Math.max(0, ...vals) + 1;
    this._drawFrame(); this._renderBake();
  }
  _render() {                                                          // draw only (hover/zoom/palette change)
    const c = this.editC, ctx = this.ectx; ctx.clearRect(0, 0, c.width, c.height);
    const f = this.frame;
    const cell = this.cells[this.fi];
    this.finfo.textContent = this.cells.length ? `frame ${this.fi + 1}/${this.cells.length} · sid 0x${((cell?.sprite_id ?? 0) & 0x7fff).toString(16)}` + (f ? ` · ${f.W}×${f.H}` : ' · (blank)') : 'no animation';
    if (!f) { ctx.fillStyle = '#7f8593'; ctx.font = '12px monospace'; ctx.fillText('blank / no assembly for this frame', 8, 20); this._z = 0; return; }
    let z = Math.max(1, +this.zoomEl.value);
    if (this._panX == null) {
      if (this._fitOnCenter) { z = Math.max(1, Math.min(Math.floor(c.width / f.W), Math.floor(c.height / f.H))); this.zoomEl.value = z; this._fitOnCenter = false; }
      this._panX = Math.floor((c.width - f.W * z) / 2); this._panY = Math.floor((c.height - f.H * z) / 2);
    }
    this._z = z;
    if (this._zpctEl) this._zpctEl.textContent = z + '×';
    this._ox = this._panX; this._oy = this._panY;
    // Fast path: fill ImageData at 1:1, then scale once with drawImage.
    // Dramatically faster than per-pixel fillRect for large/zoomed sprites.
    if (!this._oc || this._oc.width !== f.W || this._oc.height !== f.H)
      { this._oc = new OffscreenCanvas(f.W, f.H); this._ocCtx = this._oc.getContext('2d'); }
    const id = new ImageData(f.W, f.H); const d = id.data;
    for (let i = 0, N = f.W * f.H; i < N; i++) {
      const idx = f.out[i]; const col = this.cur[idx] || [0,0,0,0]; const p = i << 2;
      if (idx === 0 || col[3] === 0) {
        if (this._canvasBg === 'black') { d[p]=d[p+1]=d[p+2]=0; }
        else if (this._canvasBg === 'dark') { d[p]=0x15; d[p+1]=0x17; d[p+2]=0x1d; }
        else { const ck = ((i % f.W + (i / f.W | 0)) & 1) ? 0x17 : 0x1d; d[p]=d[p+1]=d[p+2]=ck; }
        d[p+3]=255;
      }
      else { d[p]=col[0]; d[p+1]=col[1]; d[p+2]=col[2]; d[p+3]=255; }
    }
    this._ocCtx.putImageData(id, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this._oc, 0, 0, f.W, f.H, this._ox, this._oy, f.W * z, f.H * z);
    // onion skin: ghost ±N neighbouring frames (prev = red, next = blue), fading with distance
    if (this._onion && this.cells.length > 1) {
      const R = this._onionRange || 1, n = this.cells.length;
      for (let k = R; k >= 1; k--) {
        const a = 0.32 / k;
        this._drawGhost(ctx, this._compositeCell(this.cells[((this.fi - k) % n + n) % n], false), z, [255, 96, 96], a);
        this._drawGhost(ctx, this._compositeCell(this.cells[(this.fi + k) % n], false), z, [96, 168, 255], a);
      }
    }
    // diff view: tint pixels that differ from the original decoded part
    if (this._diff) {
      ctx.fillStyle = 'rgba(255,80,200,.55)';
      for (let i = 0, N = f.W * f.H; i < N; i++) {
        const sel = f.ownSel[i]; if (sel < 0 || !this.painted[sel]) continue;
        const orig = this._origPix[sel]; if (!orig) continue;
        if (this.painted[sel][f.ownLoc[i]] !== orig[f.ownLoc[i]]) ctx.fillRect(this._ox + (i % f.W) * z, this._oy + ((i / f.W) | 0) * z, z, z);
      }
    }
    // pixel grid at high zoom
    if (this._grid && z >= 4) {
      ctx.strokeStyle = 'rgba(255,255,255,.09)'; ctx.lineWidth = 1; ctx.beginPath();
      for (let gx = 0; gx <= f.W; gx++) { const X = this._ox + gx * z + 0.5; ctx.moveTo(X, this._oy); ctx.lineTo(X, this._oy + f.H * z); }
      for (let gy = 0; gy <= f.H; gy++) { const Y = this._oy + gy * z + 0.5; ctx.moveTo(this._ox, Y); ctx.lineTo(this._ox + f.W * z, Y); }
      ctx.stroke();
    }
    // reference-image overlay (trace target) — fit within the sprite box, centered
    if (this._refImg) {
      const iw = this._refImg.naturalWidth || this._refImg.width, ih = this._refImg.naturalHeight || this._refImg.height;
      if (iw && ih) {
        const boxW = f.W * z, boxH = f.H * z, sc = Math.min(boxW / iw, boxH / ih), dw = iw * sc, dh = ih * sc;
        ctx.globalAlpha = this._refOpacity; ctx.imageSmoothingEnabled = true;
        ctx.drawImage(this._refImg, this._ox + (boxW - dw) / 2, this._oy + (boxH - dh) / 2, dw, dh);
        ctx.globalAlpha = 1; ctx.imageSmoothingEnabled = false;
      }
    }
    // part outlines — every tile that makes up this frame; hovered/edited highlighted
    if (this._showBoxes !== false) {
      ctx.lineWidth = 1;
      for (const pb of f.parts) {
        const hot = pb.sel === this._hoverSel, edited = !!this.painted[pb.sel], active = (this._selSet && this._selSet.has(pb.sel)) || pb.sel === this._activeLayer;
        // IMPACT: amber box = this part is also used by OTHER animations (editing it changes them too);
        // dim-blue box = unique to this animation (safe). active/hover/edited still take priority.
        const shared = this._sharedSel(pb.sel);
        ctx.strokeStyle = active ? '#ff5fd0' : hot ? '#ffe878' : edited ? 'rgba(95,208,138,.85)'
                        : shared ? 'rgba(255,170,70,.6)' : 'rgba(127,176,255,.3)';
        ctx.lineWidth = active ? 2 : 1;
        ctx.strokeRect(this._ox + pb.x * z + 0.5, this._oy + pb.y * z + 0.5, pb.w * z - 1, pb.h * z - 1);
      }
    }
    // marquee (copy) rect while dragging
    if (this._marq) {
      const [a, b, c2, d2] = this._marq, mx = Math.min(a, c2), my = Math.min(b, d2), mw = Math.abs(c2 - a) + 1, mh = Math.abs(d2 - b) + 1;
      ctx.strokeStyle = '#ffe878'; ctx.setLineDash([4, 3]); ctx.lineWidth = 1;
      ctx.strokeRect(this._ox + mx * z + 0.5, this._oy + my * z + 0.5, mw * z - 1, mh * z - 1); ctx.setLineDash([]);
    }
    // shape preview (line / rect / ellipse) while dragging
    if (this._shape) {
      const s = this._shape, X = (v) => this._ox + v * z, Y = (v) => this._oy + v * z;
      ctx.strokeStyle = '#5fd08a'; ctx.setLineDash([3, 2]); ctx.lineWidth = 1;
      if (s.tool === 'line') { ctx.beginPath(); ctx.moveTo(X(s.x0) + z / 2, Y(s.y0) + z / 2); ctx.lineTo(X(s.x1) + z / 2, Y(s.y1) + z / 2); ctx.stroke(); }
      else {
        const xa = Math.min(s.x0, s.x1), ya = Math.min(s.y0, s.y1), w = Math.abs(s.x1 - s.x0) + 1, h = Math.abs(s.y1 - s.y0) + 1;
        if (s.tool === 'rect') ctx.strokeRect(X(xa) + 0.5, Y(ya) + 0.5, w * z - 1, h * z - 1);
        else { ctx.beginPath(); ctx.ellipse(X(xa) + w * z / 2, Y(ya) + h * z / 2, Math.max(0.5, w * z / 2), Math.max(0.5, h * z / 2), 0, 0, Math.PI * 2); ctx.stroke(); }
      }
      ctx.setLineDash([]);
    }
    // stamp ghost preview (clipboard at cursor, centered)
    if (this.tool === 'stamp' && this._clip && this._stampXY) {
      const clip = this._clip, gx = this._stampXY[0] - (clip.w >> 1), gy = this._stampXY[1] - (clip.h >> 1);
      ctx.globalAlpha = 0.62;
      for (let yy = 0; yy < clip.h; yy++) for (let xx = 0; xx < clip.w; xx++) {
        const v = clip.data[yy * clip.w + xx]; if (v === 0) continue; const cc = this.cur[v] || [0, 0, 0];
        ctx.fillStyle = `rgb(${cc[0]},${cc[1]},${cc[2]})`; ctx.fillRect(this._ox + (gx + xx) * z, this._oy + (gy + yy) * z, z, z);
      }
      ctx.globalAlpha = 1; ctx.strokeStyle = '#5fd08a'; ctx.lineWidth = 1;
      ctx.strokeRect(this._ox + gx * z + 0.5, this._oy + gy * z + 0.5, clip.w * z - 1, clip.h * z - 1);
    }
    // symmetry axis guide — shows where mirrored strokes land
    if (this._sym && this._sym !== 'none') {
      ctx.strokeStyle = 'rgba(255,95,208,.55)'; ctx.setLineDash([4, 4]); ctx.lineWidth = 1; ctx.beginPath();
      if (this._sym === 'v') { const ax = this._ox + (f.W / 2) * z; ctx.moveTo(ax, this._oy); ctx.lineTo(ax, this._oy + f.H * z); }
      else { const ay = this._oy + (f.H / 2) * z; ctx.moveTo(this._ox, ay); ctx.lineTo(this._ox + f.W * z, ay); }
      ctx.stroke(); ctx.setLineDash([]);
    }
    // brush footprint at the cursor — the "cursor IS the brush size" preview
    if (this._hoverXY && !this._marq && !this._shape) {
      const t = this.tool, erasing = t === 'pencil' && this.brush === 0;
      const sz = (t === 'pencil') ? (this.penSize || 1) : ((t === 'line' || t === 'rect' || t === 'ellipse' || t === 'pick' || t === 'fill') ? 1 : 0);
      if (sz > 0) {
        const half = Math.floor(sz / 2), bx = this._hoverXY[0] - half, by = this._hoverXY[1] - half, bc = this.cur[this.brush];
        if (!erasing && bc && bc[3] !== 0) { ctx.globalAlpha = 0.35; ctx.fillStyle = `rgb(${bc[0]},${bc[1]},${bc[2]})`; ctx.fillRect(this._ox + bx * z, this._oy + by * z, sz * z, sz * z); ctx.globalAlpha = 1; }
        ctx.strokeStyle = erasing ? 'rgba(255,110,110,.95)' : 'rgba(255,255,255,.9)'; ctx.lineWidth = 1;
        ctx.strokeRect(this._ox + bx * z + 0.5, this._oy + by * z + 0.5, sz * z - 1, sz * z - 1);
      }
    }
    this._drawMinimap();
  }

  // Flat-tinted ghost of another frame's composite, aligned by absolute sprite coords (for onion skin).
  _drawGhost(ctx, comp, z, tint, alpha) {
    const f = this.frame; if (!comp || !f) return;
    const id = new ImageData(comp.W, comp.H), d = id.data;
    for (let i = 0; i < comp.W * comp.H; i++) { if (comp.out[i] === 0) { d[i * 4 + 3] = 0; continue; } d[i * 4] = tint[0]; d[i * 4 + 1] = tint[1]; d[i * 4 + 2] = tint[2]; d[i * 4 + 3] = 255; }
    const oc = new OffscreenCanvas(comp.W, comp.H); oc.getContext('2d').putImageData(id, 0, 0);
    const dx = comp.ax - f.ax, dy = comp.ay - f.ay;
    ctx.imageSmoothingEnabled = false; ctx.globalAlpha = alpha;
    ctx.drawImage(oc, 0, 0, comp.W, comp.H, this._ox + dx * z, this._oy + dy * z, comp.W * z, comp.H * z);
    ctx.globalAlpha = 1;
  }

  // ---------- palette power tools ----------
  // Copy the 16 palette colors as a hex list to the clipboard (index 0 = transparent). Falls
  // back to printing the list inline if the clipboard API isn't available (non-secure context).
  _copyPaletteHex() {
    const lines = this.cur.map((c, i) => (i === 0 || !c || c[3] === 0)
      ? `${i}: (transparent)`
      : `${i}: #${c.slice(0, 3).map(v => v.toString(16).padStart(2, '0')).join('')}`);
    const text = lines.join('\n');
    const done = () => { this.bakeEl.innerHTML = `<span class="dim">copied ${this.cur.length} palette colors as hex to the clipboard</span>`; };
    const fallback = () => { this.bakeEl.innerHTML = `<div class="dim">copy failed — here they are:</div><pre style="margin:4px 0; white-space:pre-wrap; color:#cdd3df; font-size:11px;">${text}</pre>`; };
    try { (navigator.clipboard && navigator.clipboard.writeText(text) || Promise.reject()).then(done, fallback); }
    catch { fallback(); }
  }
  _download(name, blob) { if (!blob) return; const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); }
  // Apply [r,g,b] colours to palette slots 1.. (index 0 stays transparent). Folds into the recolor
  // baseline so it bakes like any manual swatch edit.
  _applyPaletteColors(cols) {
    if (!cols || !cols.length) return;
    for (let i = 1; i < 16 && i - 1 < cols.length; i++) {
      const c = cols[i - 1]; if (!c) continue;
      this.cur[i] = [c[0] & 255, c[1] & 255, c[2] & 255, 255];
      if (this._palBase) this._palBase[i] = this.cur[i].slice();
    }
    this._resetPalSliders(); this._renderBrush(); this._render(); this._renderBake();
  }
  _exportPalette() {
    const hex = [];
    for (let i = 1; i < 16; i++) { const c = this.cur[i]; if (c && c[3] !== 0) hex.push('#' + c.slice(0, 3).map(v => v.toString(16).padStart(2, '0')).join('')); }
    this._download(`PL${HEX2(this.cid)}_palette.hex`, new Blob([hex.join('\n')], { type: 'text/plain' }));
    const cv = document.createElement('canvas'); cv.width = 16; cv.height = 1; const cx = cv.getContext('2d');
    for (let i = 0; i < 16; i++) { const c = this.cur[i] || [0, 0, 0, 0]; if (i === 0 || !c || c[3] === 0) continue; cx.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`; cx.fillRect(i, 0, 1, 1); }
    cv.toBlob(b => this._download(`PL${HEX2(this.cid)}_palette.png`, b));
    this.bakeEl.innerHTML = '<span class="dim">exported palette (.hex + .png)</span>';
  }
  async _importPalette(file) {
    const name = (file.name || '').toLowerCase();
    try {
      let cols;
      if ((file.type && file.type.startsWith('image/')) || /\.(png|gif|bmp|jpe?g)$/.test(name)) cols = await this._colorsFromImage(file, false);
      else cols = this._parsePaletteText(await file.text());
      if (!cols || !cols.length) { this.bakeEl.innerHTML = '<span class="dim">no colours found in that palette file</span>'; return; }
      this._applyPaletteColors(cols);
      this.bakeEl.innerHTML = `<span class="dim">applied ${Math.min(15, cols.length)} colour(s) from ${file.name}</span>`;
    } catch (e) { this.bakeEl.innerHTML = `<span class="dim">couldn't read palette: ${e.message || e}</span>`; }
  }
  // Parse .hex (one #rrggbb per line), JASC .pal, or GIMP .gpl text into [[r,g,b],...].
  _parsePaletteText(txt) {
    const cols = [], lines = txt.split(/\r?\n/);
    if (/^JASC-PAL/i.test(txt)) { for (let i = 3; i < lines.length; i++) { const m = lines[i].trim().match(/^(\d+)\s+(\d+)\s+(\d+)/); if (m) cols.push([+m[1], +m[2], +m[3]]); } return cols; }
    for (const ln of lines) {
      const s = ln.trim(); if (!s || /^(GIMP|Name:|Columns:|#\s)/i.test(s)) continue;
      let m = s.match(/^#?([0-9a-f]{6})\b/i);
      if (m) { const h = m[1]; cols.push([parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]); continue; }
      m = s.match(/^(\d+)\s+(\d+)\s+(\d+)/); if (m) cols.push([+m[1], +m[2], +m[3]]);
    }
    return cols;
  }
  // Colours from an image: a small strip → left-to-right unique; otherwise the 15 most frequent
  // (quantized) colours, sorted dark→light so a shading ramp reads sensibly.
  async _colorsFromImage(file, forceQuantize) {
    const img = await createImageBitmap(file);
    if (!forceQuantize && img.width <= 64 && img.height <= 4) {
      const oc0 = new OffscreenCanvas(img.width, img.height), c0 = oc0.getContext('2d'); c0.drawImage(img, 0, 0);
      const dd = c0.getImageData(0, 0, img.width, img.height).data, seen = new Set(), cols = [];
      for (let x = 0; x < img.width; x++) { const p = x * 4; if (dd[p + 3] < 8) continue; const k = dd[p] + ',' + dd[p + 1] + ',' + dd[p + 2]; if (!seen.has(k)) { seen.add(k); cols.push([dd[p], dd[p + 1], dd[p + 2]]); } }
      if (cols.length) return cols.slice(0, 15);
    }
    const W = Math.min(img.width, 128), H = Math.min(img.height, 128);
    const oc = new OffscreenCanvas(W, H), cx = oc.getContext('2d'); cx.imageSmoothingEnabled = true; cx.drawImage(img, 0, 0, W, H);
    const d = cx.getImageData(0, 0, W, H).data, freq = new Map();
    for (let i = 0; i < d.length; i += 4) { if (d[i + 3] < 24) continue; const k = ((d[i] & 0xf0) << 16) | ((d[i + 1] & 0xf0) << 8) | (d[i + 2] & 0xf0); const e = freq.get(k); if (e) { e.n++; e.r += d[i]; e.g += d[i + 1]; e.b += d[i + 2]; } else freq.set(k, { n: 1, r: d[i], g: d[i + 1], b: d[i + 2] }); }
    const top = [...freq.values()].sort((a, b) => b.n - a.n).slice(0, 15).map(e => [Math.round(e.r / e.n), Math.round(e.g / e.n), Math.round(e.b / e.n)]);
    top.sort((a, b) => (a[0] + a[1] + a[2]) - (b[0] + b[1] + b[2]));
    return top;
  }
  async _paletteFromImage(file) {
    try {
      const cols = await this._colorsFromImage(file, true);
      if (!cols.length) { this.bakeEl.innerHTML = '<span class="dim">no colours found in that image</span>'; return; }
      this._applyPaletteColors(cols);
      this.bakeEl.innerHTML = `<span class="dim">recoloured to ${Math.min(15, cols.length)} colour(s) from ${file.name}</span>`;
    } catch (e) { this.bakeEl.innerHTML = `<span class="dim">couldn't read image: ${e.message || e}</span>`; }
  }
  // Interpolate a smooth RGB ramp across palette slots [a..b] inclusive (for shading).
  _rampPalette(a, b) {
    const lo = Math.max(1, Math.min(15, Math.min(a, b) | 0)), hi = Math.max(1, Math.min(15, Math.max(a, b) | 0));
    if (hi - lo < 2) { this.bakeEl.innerHTML = '<span class="dim">pick two slots at least 2 apart</span>'; return; }
    const c0 = this.cur[lo] || [0, 0, 0], c1 = this.cur[hi] || [255, 255, 255];
    for (let i = lo; i <= hi; i++) { const t = (i - lo) / (hi - lo), c = [0, 1, 2].map(k => Math.round(c0[k] + (c1[k] - c0[k]) * t)); this.cur[i] = [c[0], c[1], c[2], 255]; if (this._palBase) this._palBase[i] = this.cur[i].slice(); }
    this._resetPalSliders(); this._renderBrush(); this._render(); this._renderBake();
    this.bakeEl.innerHTML = `<span class="dim">ramped slots ${lo}→${hi}</span>`;
  }
  _resetPalSliders() { if (this.hueEl) { this.hueEl.value = 0; this.satEl.value = 0; this.briEl.value = 0; } }
  // Recolor ALL 16 colors at once: shift hue/sat/lum of the baseline palette into this.cur.
  // Index 0 (transparent) is left alone. Manual swatch edits fold into _palBase so they survive.
  _applyPalXform() {
    if (!this._palBase || !this._palBase.length) return;
    const dh = +this.hueEl.value / 360, sf = 1 + (+this.satEl.value) / 100, vf = 1 + (+this.briEl.value) / 100;
    for (let i = 1; i < 16; i++) {
      const base = this._palBase[i]; if (!base) continue;
      if (base[3] === 0) { this.cur[i] = base.slice(); continue; }
      let [h, s, v] = rgb2hsv(base[0], base[1], base[2]);
      h = (h + dh + 1) % 1; s = Math.max(0, Math.min(1, s * sf)); v = Math.max(0, Math.min(1, v * vf));
      const [r, g, b] = hsv2rgb(h, s, v);
      this.cur[i] = [r, g, b, base[3] ?? 255];
    }
    this._renderBrush(); this._render(); this._renderBake();
  }
  // Repaint every pixel using color index `from` to `to`, across ALL parts of this character.
  // One bulk pixel edit (undoable as a single step).
  _swapIndex(from, to) {
    if (!this.bundle || from === to || from < 1 || from > 15 || to < 0 || to > 15) return;
    const undo = []; let changed = 0;
    for (const selStr of Object.keys(this.bundle.parts)) {
      const sel = +selStr, px = this.painted[sel] || this._partPix(sel);
      let copy = null;
      for (let i = 0; i < px.length; i++) if (px[i] === from) { if (!copy) copy = px.slice(); copy[i] = to; }
      if (copy) { undo.push({ sel, pix: (this.painted[sel] || this._partPix(sel)).slice() }); this.painted[sel] = copy; changed++; }
    }
    if (!changed) { this.bakeEl.innerHTML = `<span class="dim">no pixels use color index ${from}</span>`; return; }
    this._pushUndo(undo);
    this._drawFrame(); this._renderBake();
    this.bakeEl.innerHTML = `<span class="dim">swapped index ${from}→${to} in ${changed} part(s)</span>`;
  }

  // ---------- undo / redo ----------
  // One history entry = [{sel, pix}] snapshots of parts BEFORE an edit. _pushUndo records it and
  // clears the redo branch (a new edit invalidates redo). _applyHistory swaps an entry against the
  // CURRENT pixels and returns the inverse, so undo and redo are the same operation, mirrored.
  _pushUndo(entry) {
    if (!entry || !entry.length) return;
    this._undoStack.push(entry);
    if (this._undoStack.length > 20) this._undoStack.shift();
    this._redoStack = [];                       // a fresh edit starts a new branch
  }
  _applyHistory(entry) {
    const inverse = [];
    for (const { sel, pix } of entry) {
      inverse.push({ sel, pix: (this.painted[sel] || this._partPix(sel)).slice() });
      this.painted[sel] = pix;
    }
    return inverse;
  }
  _undo() { if (!this._undoStack.length) return; this._redoStack.push(this._applyHistory(this._undoStack.pop())); this._drawFrame(); this._renderBake(); }
  _redo() { if (!this._redoStack.length) return; this._undoStack.push(this._applyHistory(this._redoStack.pop())); this._drawFrame(); this._renderBake(); }

  // ---------- brush / palette ----------
  // FG/BG chip: shows the paint colour (FG) and the dither/gradient colour (BG) with index + hex.
  _renderColorChip() {
    const set = (el, idx) => {
      if (!el) return;
      const c = (this.cur && this.cur[idx]) || [0, 0, 0, 0];
      const transp = idx === 0 || !c || c[3] === 0;
      el.style.backgroundColor = transp ? 'transparent' : `rgb(${c[0]},${c[1]},${c[2]})`;
      const sp = el.querySelector('span'); if (sp) sp.textContent = transp ? `${idx}·—` : `${idx}·#${c.slice(0, 3).map(v => v.toString(16).padStart(2, '0')).join('')}`;
    };
    set(this.root.querySelector('.ss-fg'), this.brush);
    set(this.root.querySelector('.ss-bg'), this._brush2 & 15);
  }
  _swapColors() {
    const t = this.brush; this.brush = this._brush2 & 15; this._brush2 = t & 15;
    const b2 = this.root.querySelector('.ss-brush2'); if (b2) b2.value = this._brush2;
    this._renderBrush(); this._render();
  }
  _renderBrush() {
    this._lumOrder = null;   // palette may have changed → rebuild the shading order lazily
    this._renderColorChip();
    const eb = this.root.querySelector('.ss-erase-tool'); if (eb) eb.classList.toggle('on', this.brush === 0);
    this.brushEl.innerHTML = '';
    for (let i = 0; i < 16; i++) {
      const c = this.cur[i] || [0, 0, 0, 0];
      const edited = i > 0 && JSON.stringify(c) !== JSON.stringify(this.orig[i] || [0,0,0,0]);
      const b = document.createElement('div');
      b.className = 'ss-bsw' + (i === this.brush ? ' on' : '') + (edited ? ' edited' : '');
      if (i === 0) {
        b.dataset.erase = '1';
        b.innerHTML = '<span style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:11px;color:#e07070;pointer-events:none">E</span>';
      } else {
        b.style.background = c[3] === 0 ? 'transparent' : `rgb(${c[0]},${c[1]},${c[2]})`;
        const lbl = document.createElement('span');
        lbl.style.cssText = 'position:absolute;bottom:1px;right:2px;font-size:8px;color:rgba(255,255,255,.55);pointer-events:none;line-height:1';
        lbl.textContent = i;
        b.appendChild(lbl);
        // hidden color input — triggered by right-click to keep left-click as brush-select
        const inp = document.createElement('input'); inp.type = 'color';
        inp.value = '#' + c.slice(0,3).map(v => v.toString(16).padStart(2,'0')).join('');
        inp.style.cssText = 'position:absolute;width:0;height:0;opacity:0;pointer-events:none;';
        inp.oninput = (e) => {
          const h = e.target.value;
          this.cur[i] = [parseInt(h.slice(1,3),16), parseInt(h.slice(3,5),16), parseInt(h.slice(5,7),16), 255];
          if (this._palBase) this._palBase[i] = this.cur[i].slice();   // fold manual edits into the recolor baseline
          this._renderBrush(); this._render(); this._renderBake();
        };
        b.appendChild(inp);
        b.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          this.brush = i; this._renderBrush();
          // after rebuild, click the new input at this slot
          this.brushEl.querySelectorAll('.ss-bsw')[i]?.querySelector('input[type=color]')?.click();
        });
      }
      const hx = (i === 0 || c[3] === 0) ? '' : '#' + c.slice(0, 3).map(v => v.toString(16).padStart(2, '0')).join('');
      b.title = i === 0 ? 'erase (transparent — index 0)' : `index ${i} · ${hx}${edited ? ' · edited' : ''} · left-click=paint, right-click=edit`;
      b.onclick = () => { this.brush = i; this._setTool('pencil'); this._renderBrush(); };
      this.brushEl.appendChild(b);
    }
  }
  // flip view = canvas is CSS-mirrored (scaleX(-1)); invert the X input so paint/hover hit the right pixel
  _cssX(e, r) { return this._viewFlip ? (r.right - e.clientX) : (e.clientX - r.left); }
  _xy(e) { const r = this.editC.getBoundingClientRect(); const z = this._z || 1; const x = Math.floor((this._cssX(e, r) * (this.editC.width / r.width) - this._ox) / z); const y = Math.floor(((e.clientY - r.top) * (this.editC.height / r.height) - this._oy) / z); const f = this.frame; return (f && x >= 0 && y >= 0 && x < f.W && y < f.H) ? [x, y] : null; }
  _editEvents() {
    let down = false;
    let activePointerId = null;
    let strokeUndo = new Map(); // before-state of each part first touched this stroke
    let ppPts = [], strokeCells = new Set();   // pixel-perfect point trail + shade-once-per-stroke guard
    const MAX_UNDO = 20;
    // Pointer-event helpers: support mouse + pen/stylus + touch under one path.
    const isPrimaryInput = (e) => !e.pointerType || e.isPrimary !== false;              // ignore extra multi-touch pointers
    const isRightClick = (e) => e.button === 2 || e.buttons === 2;
    const isStrokeContact = (e) => e.pointerType === 'pen'
      ? e.pressure > 0 || (e.buttons & 1) === 1                                          // pen: tip pressure or barrel-as-primary
      : e.buttons == null || (e.buttons & 1) === 1;
    const capturePointer = (e) => {
      if (e.pointerId == null) return;
      if (this.editC.setPointerCapture) { try { this.editC.setPointerCapture(e.pointerId); } catch {} }
      activePointerId = e.pointerId;
    };
    const releasePointer = (e) => {
      if (e.pointerId != null && this.editC.releasePointerCapture) { try { this.editC.releasePointerCapture(e.pointerId); } catch {} }
      if (e.pointerId == null || activePointerId === e.pointerId) activePointerId = null;
    };
    const paintAt = (cx, cy) => {
      const f = this.frame;
      // pick: single point, no pen-size
      if (this.tool === 'pick') {
        const ci = cy * f.W + cx; let sel = f.ownSel[ci], loc = f.ownLoc[ci];
        if (sel < 0) { sel = f.boxSel[ci]; loc = f.boxLoc[ci]; }
        if (sel >= 0) { this.brush = (this.painted[sel] || this._partPix(sel))[loc]; this._renderBrush(); }
        return;
      }
      // value to paint at a pixel: the flat brush, or (shading ink) one step lighter/darker along
      // the palette — once per pixel per stroke so a dwell doesn't run the ramp away.
      const inkVal = (px, py) => {
        if (this._ink === 'normal') return this.brush;
        if (px < 0 || py < 0 || px >= f.W || py >= f.H) return this.brush;
        const ci = py * f.W + px; let sel = f.ownSel[ci], loc = f.ownLoc[ci];
        if (sel < 0) { sel = f.boxSel[ci]; loc = f.boxLoc[ci]; } if (sel < 0) return this.brush;
        const cur = (this.painted[sel] || this._partPix(sel))[loc];
        if (strokeCells.has(ci)) return cur;
        strokeCells.add(ci);
        return this._shadeIndex(cur, this._ink === 'lighten' ? 1 : -1);
      };
      const sz = this.penSize || 1, half = Math.floor(sz / 2);
      // pixel-perfect (size-1 pencil): paint, then drop a redundant diagonal corner pixel
      if (sz === 1 && this._pixelPerfect && this.tool === 'pencil') {
        this._setComposite(cx, cy, inkVal(cx, cy), strokeUndo);
        ppPts.push([cx, cy]);
        if (ppPts.length >= 3) {
          const A = ppPts[ppPts.length - 3], B = ppPts[ppPts.length - 2], C = ppPts[ppPts.length - 1];
          if (Math.abs(A[0] - C[0]) === 1 && Math.abs(A[1] - C[1]) === 1 && ((B[0] === A[0] && B[1] === C[1]) || (B[0] === C[0] && B[1] === A[1]))) {
            this._revertComposite(B[0], B[1], strokeUndo);   // B is the L-corner between diagonal A,C
            ppPts.splice(ppPts.length - 2, 1);
          }
        }
        return;
      }
      for (let dy = 0; dy < sz; dy++) for (let dx = 0; dx < sz; dx++) {
        const px = cx - half + dx, py = cy - half + dy;
        this._setComposite(px, py, inkVal(px, py), strokeUndo);
      }
    };
    const apply = (e) => {
      const p = this._xy(e); if (!p) return; const [x, y] = p; const f = this.frame; if (!f) return;
      if (this.tool === 'fill') this._fillComposite(x, y, strokeUndo); else paintAt(x, y);
      this._drawFrame(); this._renderBake();
    };
    let panLast = null;
    const beginStroke = (e) => {
      if (!this.frame) return false;
      strokeUndo = new Map(); // fresh per-stroke before-state collection
      ppPts = []; strokeCells = new Set();
      if (this._allFrames) this._buildFrameComps();   // cache other frames for cross-frame cascade
      down = true; apply(e); return true;
    };
    const start = (e) => {
      if (!isPrimaryInput(e)) return;
      if (e.button === 2) { capturePointer(e); panLast = [e.clientX, e.clientY]; this._rmbPan = true; this._rmbMoved = false; e.preventDefault(); return; }   // right-drag = pan (right-click tap still cancels a stamp)
      if (isRightClick(e)) return;
      if (down || (activePointerId != null && e.pointerId !== activePointerId)) this._resetInput();   // clear any stuck/abandoned prior interaction
      e.preventDefault();
      capturePointer(e);
      if (e.altKey) { this._pickAt(e); return; }                                             // alt = eyedrop from any tool
      if (this._spaceDown || e.button === 1) { panLast = [e.clientX, e.clientY]; return; }    // hold space / middle-drag = pan
      if (this.tool === 'pan') { panLast = [e.clientX, e.clientY]; return; }
      if (this.tool === 'select') { this._selectPartAt(e); return; }   // select-only — never paints
      if (this.tool === 'marquee' || this.tool === 'region') { const p = this._xy(e); if (p) this._marq = [p[0], p[1], p[0], p[1]]; return; }
      if (this.tool === 'line' || this.tool === 'rect' || this.tool === 'ellipse') { const p = this._xy(e); if (p) this._shape = { x0: p[0], y0: p[1], x1: p[0], y1: p[1], tool: this.tool }; return; }
      if (this.tool === 'stamp') { this._stampAt(e); return; }   // click to place
      beginStroke(e);
    };
    const move = (e) => {
      // Only filter other pointers WHILE drawing (ignore a 2nd finger mid-stroke). When idle,
      // never filter — a stale activePointerId must not block the pen from hovering/resuming.
      if (down && activePointerId != null && e.pointerId !== activePointerId) return;
      if (panLast) { const r = this.editC.getBoundingClientRect(); this._panX += (this._viewFlip ? -1 : 1) * (e.clientX - panLast[0]) * (this.editC.width / r.width); this._panY += (e.clientY - panLast[1]) * (this.editC.height / r.height); panLast = [e.clientX, e.clientY]; if (this._rmbPan) this._rmbMoved = true; this._render(); return; }
      if (this._marq) { const p = this._xy(e); if (p) { this._marq[2] = p[0]; this._marq[3] = p[1]; this._render(); } return; }
      if (this._shape) { const p = this._xy(e); if (p) { this._shape.x1 = p[0]; this._shape.y1 = p[1]; this._render(); } return; }
      if (this.tool === 'stamp' && this._clip) { this._stampXY = this._xyRaw(e); this._render(); return; }
      // pen that begins moving with tip pressure before a pointerdown lands → start the stroke
      if (!down && this.tool === 'pencil' && e.pointerType === 'pen' && isStrokeContact(e)) { capturePointer(e); beginStroke(e); return; }
      if (down && this.tool === 'pencil') { apply(e); return; }
      const f = this.frame; if (!f) return; const p = this._xy(e); let s = -1;
      if (p) { const ci = p[1] * f.W + p[0]; s = f.ownSel[ci]; if (s < 0) s = f.boxSel[ci]; }
      const hx = p ? p[0] : -1, hy = p ? p[1] : -1;
      if (s !== this._hoverSel || hx !== this._hoverX || hy !== this._hoverY) { this._hoverSel = s; this._hoverX = hx; this._hoverY = hy; this._hoverXY = p; this._render(); }
    };
    const end = (e, force = false) => {
      if (!force && down && activePointerId != null && e.pointerId !== activePointerId) return;
      if (this._marq) { const [a, b, c2, d2] = this._marq; const wasRegion = this.tool === 'region'; this._marq = null; if (wasRegion) this._selectRegionBox(a, b, c2, d2); else this._copyRegion(a, b, c2, d2); }
      if (this._shape) { const s = this._shape; this._shape = null; this._commitShape(s); }
      if (down && strokeUndo.size > 0) {
        this._pushUndo([...strokeUndo.entries()].map(([s, p]) => ({ sel: s, pix: p })));
        strokeUndo = new Map();
      }
      this._clearFrameComps();
      down = false; panLast = null; this._rmbPan = false;
      if (force) activePointerId = null; else releasePointer(e);
    };
    // Hard reset of all transient input state — used on tool switch and to clear a stuck/abandoned
    // interaction (e.g. a pen stroke whose pointerup was lost). Commits any in-progress stroke to undo.
    this._resetInput = (commit = true) => {
      if (commit && down && strokeUndo.size > 0) {
        this._pushUndo([...strokeUndo.entries()].map(([s, p]) => ({ sel: s, pix: p })));
      }
      strokeUndo = new Map(); this._clearFrameComps();
      if (activePointerId != null && this.editC.releasePointerCapture) { try { this.editC.releasePointerCapture(activePointerId); } catch {} }
      down = false; panLast = null; this._marq = null; this._shape = null; this._rmbPan = false; activePointerId = null;
    };
    this.editC.addEventListener('mouseleave', () => { let dirty = false; if (this._hoverSel !== -1) { this._hoverSel = -1; dirty = true; } if (this._hoverXY) { this._hoverXY = null; this._hoverX = -1; this._hoverY = -1; dirty = true; } if (this._stampXY) { this._stampXY = null; dirty = true; } if (dirty) this._render(); });
    // right-click on the canvas while stamping cancels the clipboard
    this.editC.addEventListener('contextmenu', (e) => {
      e.preventDefault();                                        // canvas is a drawing surface — never show the OS menu
      if (this._rmbMoved) { this._rmbMoved = false; return; }    // that right-click was a pan drag — swallow it
      if ((this.tool === 'stamp' || this._clip) && this._clip) { this._clip = null; this._stampXY = null; this._render(); this.bakeEl.innerHTML = '<span class="dim">stamp cancelled</span>'; }
    });
    window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && this._clip) { this._clip = null; this._stampXY = null; this._render(); } });
    // scroll wheel = zoom toward the cursor (keeps the pixel under the pointer fixed)
    this.editC.addEventListener('wheel', (e) => {
      if (!this.frame) return;
      e.preventDefault();
      const r = this.editC.getBoundingClientRect();
      const cx = this._cssX(e, r) * (this.editC.width / r.width);
      const cy = (e.clientY - r.top) * (this.editC.height / r.height);
      const z = this._z || +this.zoomEl.value || 1;
      const wx = (cx - this._ox) / z, wy = (cy - this._oy) / z;   // composite coord under the cursor
      let z2 = e.deltaY < 0 ? Math.max(z + 1, Math.round(z * 1.2)) : Math.min(z - 1, Math.round(z / 1.2));
      z2 = Math.max(+this.zoomEl.min, Math.min(+this.zoomEl.max, z2));
      if (z2 === z) return;
      this.zoomEl.value = z2;
      this._panX = cx - wx * z2; this._panY = cy - wy * z2;       // hold that pixel under the cursor
      this._render();
    }, { passive: false });
    // Pointer Events unify mouse + pen/stylus + touch (with capture so strokes survive leaving
    // the canvas); fall back to mouse events on browsers without PointerEvent.
    if (window.PointerEvent) {
      this.editC.addEventListener('pointerdown', start);
      this.editC.addEventListener('pointermove', move);
      this.editC.addEventListener('pointerup', end);
      this.editC.addEventListener('pointercancel', end);
      // NOTE: deliberately NOT binding 'lostpointercapture' to end — some browsers drop pointer
      // capture spuriously mid-pen-stroke (palm rejection / pen leaving range), which would kill
      // the stroke even though the pen is still down. Capture loss alone shouldn't end drawing;
      // pointerup / pointercancel are the real terminators.
    } else {
      this.editC.addEventListener('mousedown', start);
      this.editC.addEventListener('mousemove', move);
      window.addEventListener('mouseup', end);
    }
  }
  _xyRaw(e) { const r = this.editC.getBoundingClientRect(); const z = this._z || 1; return [Math.floor((this._cssX(e, r) * (this.editC.width / r.width) - this._ox) / z), Math.floor(((e.clientY - r.top) * (this.editC.height / r.height) - this._oy) / z)]; }

  // ---------- keyboard shortcuts (Aseprite-ish) ----------
  _keyEvents() {
    const TOOL = { v: 'select', b: 'pencil', g: 'fill', i: 'pick', h: 'pan', m: 'marquee', n: 'region', l: 'line', r: 'rect', o: 'ellipse', p: 'stamp' };
    window.addEventListener('keydown', (e) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); e.shiftKey ? this._redo() : this._undo(); return; }
      if (mod && (e.key === 'y' || e.key === 'Y')) { e.preventDefault(); this._redo(); return; }
      if (mod) return;                                              // leave other Ctrl/Cmd combos alone
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      const k = e.key.toLowerCase();
      if (k === ' ') { this._spaceDown = true; e.preventDefault(); return; }                 // hold space to pan
      if (e.key === '?') { e.preventDefault(); this._openShortcuts(); return; }
      if (this._clip && this.tool === 'stamp') {                                             // transform the armed stamp
        if (k === 'h') { e.preventDefault(); this._flipClip('h'); return; }
        if (k === 'v') { e.preventDefault(); this._flipClip('v'); return; }
        if (k === 'r') { e.preventDefault(); this._rotateClip(); return; }
      }
      if (k.startsWith('arrow') && this._activeLayer != null) {                              // nudge the active part
        const d = { arrowleft: [-1, 0], arrowright: [1, 0], arrowup: [0, -1], arrowdown: [0, 1] }[k];
        if (d) { e.preventDefault(); this._nudgePart(d[0], d[1]); return; }
      }
      if (TOOL[k]) { e.preventDefault(); this._setTool(TOOL[k]); return; }
      if (k === 'e') { e.preventDefault(); this._setTool('pencil'); this.brush = 0; this._renderBrush(); return; }   // erase
      if (k === '[') { e.preventDefault(); this._cycleBrush(-1); return; }
      if (k === ']') { e.preventDefault(); this._cycleBrush(1); return; }
      if (k === 'x') { e.preventDefault(); if (e.shiftKey) this.root.querySelector('.ss-flip')?.click(); else this._swapColors(); return; }
      if (k === 'f') { e.preventDefault(); this._fitOnCenter = true; this._panX = null; this._render(); return; }
      if (e.key === '\\') { e.preventDefault(); this._toggleFocus(); return; }
      if (k === ',') { e.preventDefault(); this._gotoFrame(this.fi - 1); return; }
      if (k === '.') { e.preventDefault(); this._gotoFrame(this.fi + 1); return; }
      if (k === '+' || k === '=') { e.preventDefault(); this._nudgeZoom(1); return; }
      if (k === '-' || k === '_') { e.preventDefault(); this._nudgeZoom(-1); return; }
      if (k >= '1' && k <= '4') { this.penSize = { '1': 1, '2': 2, '3': 4, '4': 8 }[k]; this.root.querySelectorAll('.ss-sz').forEach(x => x.classList.toggle('on', +x.dataset.sz === this.penSize)); }
    });
    window.addEventListener('keyup', (e) => { if (e.key === ' ') this._spaceDown = false; });
  }
  _cycleBrush(dir) {
    const sizes = [1, 2, 4, 8]; let i = sizes.indexOf(this.penSize); if (i < 0) i = 0;
    this.penSize = sizes[Math.max(0, Math.min(sizes.length - 1, i + dir))];
    this.root.querySelectorAll('.ss-sz').forEach(x => x.classList.toggle('on', +x.dataset.sz === this.penSize));
  }
  _nudgeZoom(dir) {
    if (!this.zoomEl) return;
    this.zoomEl.value = Math.max(+this.zoomEl.min, Math.min(+this.zoomEl.max, (+this.zoomEl.value) + dir));
    this._panX = null; this._render();
  }
  // Focus mode: hide the palette + right dock so the canvas takes the full width (the grid's 1fr
  // canvas column expands into the collapsed auto columns). Toggled by the ⤢ button or `\`.
  _toggleFocus() {
    this._focus = !this._focus;
    const pd = this.root.querySelector('.ss-paldock'), rd = this.root.querySelector('.ss-rightdock');
    if (pd) pd.style.display = this._focus ? 'none' : '';
    if (rd) rd.style.display = this._focus ? 'none' : '';
    this.root.querySelector('.ss-focus')?.classList.toggle('on', this._focus);
    requestAnimationFrame(() => this._resizeCanvas());
  }

  // ---------- settings / preferences (persisted to localStorage) ----------
  _loadSettings() {
    const def = { canvasBg: 'checker', grid: false, onion: false, confirmBake: true, rememberChar: true, lastChar: '17', rememberRom: true, lastRom: '' };
    let s = {}; try { s = JSON.parse(localStorage.getItem('mvc2-sks-settings') || '{}'); } catch {}
    this._settings = { ...def, ...s };
    this._grid = !!this._settings.grid; this._onion = !!this._settings.onion; this._canvasBg = this._settings.canvasBg;
  }
  _saveSettings() { try { localStorage.setItem('mvc2-sks-settings', JSON.stringify(this._settings)); } catch {} }
  _applySettings() {
    const s = this._settings || {};
    this._grid = !!s.grid; this._onion = !!s.onion; this._canvasBg = s.canvasBg || 'checker';
    const g = this.root.querySelector('.ss-grid'); if (g) g.checked = !!s.grid;
    const o = this.root.querySelector('.ss-onion'); if (o) o.checked = !!s.onion;
  }
  _openSettings() {
    if (!this._setModal) this._buildSettingsModal();
    const s = this._settings, m = this._setModal;
    m.querySelector('.set-bg').value = s.canvasBg;
    m.querySelector('.set-grid').checked = !!s.grid;
    m.querySelector('.set-onion').checked = !!s.onion;
    m.querySelector('.set-confirm').checked = s.confirmBake !== false;
    m.querySelector('.set-remchar').checked = s.rememberChar !== false;
    m.querySelector('.set-remrom').checked = s.rememberRom !== false;
    m.querySelector('.set-lastrom').textContent = s.lastRom || '(none yet)';
    m.style.display = 'flex';
  }
  _buildSettingsModal() {
    const wrap = document.createElement('div');
    wrap.className = 'ss-modal';
    wrap.innerHTML = `
      <div class="ss-modal-card">
        <div class="ss-modal-head"><b>⚙ Settings</b><button class="ss-modal-x" title="close">×</button></div>
        <label class="ss-set-row">Canvas background
          <select class="set-bg"><option value="checker">checker</option><option value="dark">dark</option><option value="black">black</option></select></label>
        <label class="ss-set-row"><input type="checkbox" class="set-grid"> Pixel grid at high zoom</label>
        <label class="ss-set-row"><input type="checkbox" class="set-onion"> Onion skin (ghost neighbour frames)</label>
        <label class="ss-set-row"><input type="checkbox" class="set-confirm"> Confirm before baking to ROM</label>
        <label class="ss-set-row"><input type="checkbox" class="set-remchar"> Remember last character</label>
        <label class="ss-set-row ss-set-rom"><input type="checkbox" class="set-remrom"> Remember last ROM (reopen without the dialog)</label>
        <div class="ss-set-row ss-set-rom" style="font-size:10px; color:#7f8593;">last: <span class="set-lastrom" style="color:#a0bde8;">(none yet)</span> <button class="set-reopen" style="font-size:10px; padding:1px 7px; margin-left:4px;">reopen</button></div>
        <div class="dim" style="font-size:10px; margin-top:8px;">Preferences are saved in this ${isTauri ? 'app' : 'browser'}.</div>
      </div>`;
    this.root.appendChild(wrap);
    this._setModal = wrap;
    const s = this._settings, save = () => this._saveSettings();
    wrap.addEventListener('click', (e) => { if (e.target === wrap) wrap.style.display = 'none'; });
    wrap.querySelector('.ss-modal-x').onclick = () => { wrap.style.display = 'none'; };
    wrap.querySelector('.set-bg').onchange = (e) => { s.canvasBg = e.target.value; this._canvasBg = s.canvasBg; save(); this._render(); };
    wrap.querySelector('.set-grid').onchange = (e) => { s.grid = e.target.checked; this._grid = s.grid; const c = this.root.querySelector('.ss-grid'); if (c) c.checked = s.grid; save(); this._render(); };
    wrap.querySelector('.set-onion').onchange = (e) => { s.onion = e.target.checked; this._onion = s.onion; const c = this.root.querySelector('.ss-onion'); if (c) c.checked = s.onion; save(); this._render(); };
    wrap.querySelector('.set-confirm').onchange = (e) => { s.confirmBake = e.target.checked; save(); };
    wrap.querySelector('.set-remchar').onchange = (e) => { s.rememberChar = e.target.checked; save(); };
    wrap.querySelector('.set-remrom').onchange = (e) => { s.rememberRom = e.target.checked; save(); };
    wrap.querySelector('.set-reopen').onclick = () => { wrap.style.display = 'none'; this._reopenLastRom(); };
    if (!isTauri) wrap.querySelectorAll('.ss-set-rom').forEach(el => { el.style.display = 'none'; });   // desktop-only rows
  }
  async _reopenLastRom() {
    const p = this._settings && this._settings.lastRom;
    if (!isTauri || !p) { this._romSrcEl.textContent = 'no remembered ROM — use 📂 load track03.bin'; return; }
    this._romSrcEl.textContent = 'reopening track03.bin…';
    try {
      const handle = await romHandleFromPath(p);
      this.romReader = await RomReader.fromFile(await handle.getFile());
      this._romHandle = handle; this._romName = handle.name; this._romCache = new Map();
      this._romSrcEl.textContent = `📂 ${handle.name}`;
      await this.loadChar(this.cid, { fresh: true });
      this._warmRomCache(handle.name);
    } catch (e) { this.romReader = null; this._romHandle = null; this._romSrcEl.textContent = `❌ couldn't reopen: ${e.message || e}`; }
  }
  // Copy the rendered indices inside the marquee rect into the clipboard, then arm the stamp tool.
  _copyRegion(x0, y0, x1, y1) {
    const f = this.frame; if (!f) return;
    const xa = Math.max(0, Math.min(x0, x1)), ya = Math.max(0, Math.min(y0, y1));
    const xb = Math.min(f.W - 1, Math.max(x0, x1)), yb = Math.min(f.H - 1, Math.max(y0, y1));
    const w = xb - xa + 1, h = yb - ya + 1; if (w < 1 || h < 1) return;
    const data = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[y * w + x] = f.out[(ya + y) * f.W + (xa + x)];
    this._clip = { w, h, data }; this._setTool('stamp');
    this.bakeEl.innerHTML = `<span class="dim">copied ${w}×${h} — 📌 click to place · <b>H</b>/<b>V</b> flip · <b>R</b> rotate · right-click / Esc to cancel.</span>`;
    this._render();
  }
  // Stamp the clipboard (copied region or imported sticker), centered on the cursor. Transparent
  // (index 0) pixels are skipped so it overlays like a sticker. Writes into the parts under it.
  _stampAt(e) {
    const f = this.frame, clip = this._clip; if (!f || !clip) return;
    const [cx, cy] = this._xyRaw(e), ox = cx - (clip.w >> 1), oy = cy - (clip.h >> 1);
    const undo = new Map();
    if (this._allFrames) this._buildFrameComps();
    for (let y = 0; y < clip.h; y++) for (let x = 0; x < clip.w; x++) {
      const v = clip.data[y * clip.w + x]; if (v === 0) continue;
      const px = ox + x, py = oy + y; if (px < 0 || py < 0 || px >= f.W || py >= f.H) continue;
      const ci = py * f.W + px, sel = f.boxSel[ci], loc = f.boxLoc[ci]; if (sel < 0) continue;
      if (!undo.has(sel)) undo.set(sel, (this.painted[sel] || this._partPix(sel)).slice());
      if (!this.painted[sel]) this.painted[sel] = this._partPix(sel).slice();
      this.painted[sel][loc] = v;
      if (this._allFrames) this._paintAcrossFrames(px, py, v, undo);
    }
    if (this._allFrames) this._clearFrameComps();
    if (undo.size) this._pushUndo([...undo.entries()].map(([s, p]) => ({ sel: s, pix: p })));
    this._drawFrame(); this._renderBake();
  }
  // Import a PNG (any size) as a sticker: alpha<128 → transparent, else nearest palette index.
  async _importSticker(file) {
    if (!file || !this.cur.length) return;
    const bmp = await createImageBitmap(file);
    const oc = new OffscreenCanvas(bmp.width, bmp.height), ox = oc.getContext('2d'); ox.imageSmoothingEnabled = false; ox.drawImage(bmp, 0, 0);
    const d = ox.getImageData(0, 0, bmp.width, bmp.height).data, data = new Uint8Array(bmp.width * bmp.height);
    for (let i = 0; i < bmp.width * bmp.height; i++) { const p = i * 4; data[i] = d[p + 3] < 128 ? 0 : this._quantToIdx(d[p], d[p + 1], d[p + 2]); }
    this._clip = { w: bmp.width, h: bmp.height, data }; this._setTool('stamp');
    this.bakeEl.innerHTML = `<span class="dim">sticker ${bmp.width}×${bmp.height} loaded (quantized to this character's palette) — 📌 click to place.</span>`;
    this._render();
  }
  _quantToIdx(r, g, b) {
    let best = 1, bd = 1e18;
    for (let i = 1; i < 16; i++) { const c = this.cur[i]; if (!c || c[3] === 0) continue; const dr = c[0] - r, dg = c[1] - g, db = c[2] - b, dd = dr * dr + dg * dg + db * db; if (dd < bd) { bd = dd; best = i; } }
    return best;
  }
  _fillComposite(x, y, undoMap) {
    const f = this.frame; const from = f.out[y * f.W + x];
    const mode = this._fillMode || 'solid', primary = this.brush, secondary = this._brush2 & 15;
    if (mode === 'solid' && from === primary) return;
    if (this._allFrames) this._buildFrameComps();
    // 1) flood-collect the contiguous region of same-index cells (visited array, so we don't mutate
    //    f.out mid-collect — the gradient/dither pass needs original positions)
    const region = [], st = [[x, y]], visited = new Uint8Array(f.W * f.H);
    let minx = 1e9, miny = 1e9, maxx = -1e9, maxy = -1e9;
    while (st.length) {
      const [cx, cy] = st.pop(); if (cx < 0 || cy < 0 || cx >= f.W || cy >= f.H) continue;
      const ci = cy * f.W + cx; if (visited[ci] || f.out[ci] !== from) continue;
      visited[ci] = 1; region.push([cx, cy, ci]);
      if (cx < minx) minx = cx; if (cx > maxx) maxx = cx; if (cy < miny) miny = cy; if (cy > maxy) maxy = cy;
      st.push([cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]);
    }
    // 2) assign each cell a value per fill mode (solid / 50% dither / dithered gradient)
    const BAYER = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]];
    const span = mode === 'grad-h' ? Math.max(1, maxx - minx) : Math.max(1, maxy - miny);
    for (const [cx, cy, ci] of region) {
      let val = primary;
      if (mode === 'dither') val = ((cx + cy) & 1) ? secondary : primary;
      else if (mode === 'grad-v' || mode === 'grad-h') {
        const t = (mode === 'grad-h' ? cx - minx : cy - miny) / span;
        val = t > (BAYER[cy & 3][cx & 3] + 0.5) / 16 ? secondary : primary;
      }
      let sel = f.ownSel[ci], loc = f.ownLoc[ci]; if (sel < 0) { sel = f.boxSel[ci]; loc = f.boxLoc[ci]; }
      if (sel >= 0) {
        if (undoMap && !undoMap.has(sel)) undoMap.set(sel, (this.painted[sel] || this._partPix(sel)).slice());
        if (!this.painted[sel]) this.painted[sel] = this._partPix(sel).slice();
        this.painted[sel][loc] = val;
      }
      if (this._allFrames) this._paintAcrossFrames(cx, cy, val, undoMap);
      f.out[ci] = val;
    }
  }

  _pickAt(e) { const p = this._xy(e); const f = this.frame; if (!p || !f) return; const ci = p[1] * f.W + p[0]; let sel = f.ownSel[ci], loc = f.ownLoc[ci]; if (sel < 0) { sel = f.boxSel[ci]; loc = f.boxLoc[ci]; } if (sel >= 0) { this.brush = (this.painted[sel] || this._partPix(sel))[loc]; this._renderBrush(); } }

  // Move tool: shift the active part's pixels by (dx,dy) in its own pixel space (arrow keys). Vacated
  // edges become transparent. One undo step.
  _nudgePart(dx, dy) {
    const sel = this._activeLayer; if (sel == null || !this.bundle) return;
    const r = this.bundle.parts[sel]; if (!r) return;
    const src = (this.painted[sel] || this._partPix(sel)), out = new Uint8Array(r.w * r.h);
    for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) { const sx = x - dx, sy = y - dy; out[y * r.w + x] = (sx >= 0 && sy >= 0 && sx < r.w && sy < r.h) ? src[sy * r.w + sx] : 0; }
    this._pushUndo([{ sel, pix: src.slice() }]);
    this.painted[sel] = out; this._drawFrame(); this._renderBake();
  }
  // Transform the armed stamp clipboard before placing (H/V flip, R rotate 90°).
  _flipClip(axis) { const c = this._clip; if (!c) return; const out = new Uint8Array(c.w * c.h); for (let y = 0; y < c.h; y++) for (let x = 0; x < c.w; x++) { const sx = axis === 'h' ? c.w - 1 - x : x, sy = axis === 'v' ? c.h - 1 - y : y; out[y * c.w + x] = c.data[sy * c.w + sx]; } this._clip = { w: c.w, h: c.h, data: out }; this._render(); }
  _rotateClip() { const c = this._clip; if (!c) return; const nw = c.h, nh = c.w, out = new Uint8Array(nw * nh); for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) out[y * nw + x] = c.data[(nw - 1 - x) * c.w + y]; this._clip = { w: nw, h: nh, data: out }; this._render(); }

  // Alt-costume: rotate the whole palette's hue by a step each click (quick colour variants).
  _altCostume() {
    this._altStep = ((this._altStep || 0) + 40) % 360;
    if (!this._palBase) this._palBase = this.cur.map(c => c.slice());
    const dh = this._altStep / 360;
    for (let i = 1; i < 16; i++) { const base = this._palBase[i]; if (!base) continue; if (base[3] === 0) { this.cur[i] = base.slice(); continue; } let [h, s, v] = rgb2hsv(base[0], base[1], base[2]); h = (h + dh) % 1; const [r, g, b] = hsv2rgb(h, s, v); this.cur[i] = [r, g, b, base[3]]; }
    this._renderBrush(); this._render(); this._renderBake();
    this.bakeEl.innerHTML = `<span class="dim">alt costume — hue +${this._altStep}° (click to cycle · reset palette to revert)</span>`;
  }
  _openShortcuts() {
    if (!this._scModal) {
      const w = document.createElement('div'); w.className = 'ss-modal';
      w.innerHTML = `<div class="ss-modal-card" style="width:440px;">
        <div class="ss-modal-head"><b>⌨ Keyboard shortcuts</b><button class="ss-modal-x">×</button></div>
        <div style="font-size:12px; line-height:1.85; color:#cdd3df;">
          <b>Tools</b> — B pencil · E erase · G fill · I pick · H pan · V select · M copy · N region · P stamp<br>
          <b>Shapes</b> — L line · R rect · O ellipse<br>
          <b>Edit</b> — Ctrl+Z undo · Ctrl+Y / Ctrl+Shift+Z redo · [ ] brush size · 1–4 sizes<br>
          <b>View</b> — wheel = zoom · F fit · +/− zoom · Shift+X flip · , . step frames · <b>Alt</b> eyedrop<br>
          <b>Colour</b> — X swaps FG/BG · left-click swatch = FG · right-click swatch = edit<br>
          <b>Pan</b> — hold <b>Space</b> + drag, <b>right-drag</b>, or middle-drag (any tool)<br>
          <b>Active part</b> — Arrow keys nudge it<br>
          <b>Stamp (armed)</b> — H flip-x · V flip-y · R rotate<br>
          <b>?</b> — this help
        </div></div>`;
      this.root.appendChild(w); this._scModal = w;
      w.addEventListener('click', (e) => { if (e.target === w) w.style.display = 'none'; });
      w.querySelector('.ss-modal-x').onclick = () => { w.style.display = 'none'; };
    }
    this._scModal.style.display = 'flex';
  }

  // ---------- animated GIF export ----------
  _exportGif() {
    const cells = this.cells || []; if (!cells.length) { this.bakeEl.innerHTML = '<span class="dim">no animation to export</span>'; return; }
    const comps = cells.map(c => this._compositeCell(c, false));
    const valid = comps.filter(Boolean); if (!valid.length) { this.bakeEl.innerHTML = '<span class="dim">nothing to export</span>'; return; }
    let minx = 1e9, miny = 1e9, maxx = -1e9, maxy = -1e9;
    for (const c of valid) { minx = Math.min(minx, c.ax); miny = Math.min(miny, c.ay); maxx = Math.max(maxx, c.ax + c.W); maxy = Math.max(maxy, c.ay + c.H); }
    const W = maxx - minx, H = maxy - miny;
    const frames = cells.map((cell, i) => {
      const comp = comps[i], buf = new Uint8Array(W * H);   // 0 = transparent
      if (comp) for (let y = 0; y < comp.H; y++) for (let x = 0; x < comp.W; x++) { const v = comp.out[y * comp.W + x]; if (v) buf[(comp.ay - miny + y) * W + (comp.ax - minx + x)] = v; }
      return { buf, cs: Math.max(2, Math.round((cell.duration || 6) * 100 / 60)) };
    });
    const pal = []; for (let i = 0; i < 16; i++) { const c = this.cur[i] || [0, 0, 0]; pal.push(c[0] & 255, c[1] & 255, c[2] & 255); }
    this._download(`PL${HEX2(this.cid)}_anim.gif`, new Blob([this._encodeGif(W, H, pal, frames, 0)], { type: 'image/gif' }));
    this.bakeEl.innerHTML = `<span class="dim">exported ${frames.length}-frame GIF (${W}×${H})</span>`;
  }
  _encodeGif(W, H, pal, frames, tIdx) {
    const out = []; const push = (...b) => { for (const x of b) out.push(x & 255); }; const u16 = (v) => push(v, v >> 8);
    for (const ch of 'GIF89a') push(ch.charCodeAt(0));
    u16(W); u16(H); push(0xF0 | 3, 0, 0);                    // global table, 16 colours (2^(3+1))
    for (let i = 0; i < 48; i++) push(pal[i] || 0);
    push(0x21, 0xFF, 0x0B); for (const ch of 'NETSCAPE2.0') push(ch.charCodeAt(0)); push(0x03, 0x01, 0x00, 0x00, 0x00);   // loop forever
    for (const fr of frames) {
      push(0x21, 0xF9, 0x04, 0x01, fr.cs & 255, (fr.cs >> 8) & 255, tIdx & 255, 0x00);   // GCE: delay + transparent idx
      push(0x2C); u16(0); u16(0); u16(W); u16(H); push(0x00);                             // image descriptor
      push(4);                                                                            // LZW min code size
      const lzw = this._gifLZW(fr.buf, 4);
      for (let i = 0; i < lzw.length; i += 255) { const n = Math.min(255, lzw.length - i); push(n); for (let j = 0; j < n; j++) push(lzw[i + j]); }
      push(0x00);
    }
    push(0x3B);
    return Uint8Array.from(out);
  }
  // "Uncompressed" GIF LZW: fixed code width (minCodeSize+1) with a CLEAR re-emitted before the
  // decoder's dictionary could ever widen the code. No dictionary matching → provably correct and
  // trivially decodable; files are a bit larger but a sprite animation stays tiny. (Round-trip
  // verified in Node.)
  _gifLZW(data, minCodeSize) {
    const clear = 1 << minCodeSize, eoi = clear + 1, codeSize = minCodeSize + 1;
    const out = []; let cur = 0, curBits = 0;
    const emit = (code) => { cur |= code << curBits; curBits += codeSize; while (curBits >= 8) { out.push(cur & 255); cur >>= 8; curBits -= 8; } };
    emit(clear);
    let since = 0;
    for (let i = 0; i < data.length; i++) {
      emit(data[i] & (clear - 1));
      if (++since >= clear - 2) { emit(clear); since = 0; }   // reset the decoder's table before it grows the code width
    }
    emit(eoi);
    if (curBits > 0) out.push(cur & 255);
    return out;
  }

  // ---------- export ----------
  _partToDataURL(sel) {
    const px = this.painted[sel], r = this.bundle.parts[sel]; const bodyCur = this._bodyCur(); const oc = new OffscreenCanvas(r.w, r.h); const ox = oc.getContext('2d'); const id = ox.createImageData(r.w, r.h); const d = id.data;
    for (let p = 0; p < r.w * r.h; p++) { const c = bodyCur[px[p]] || [0, 0, 0, 0]; if (px[p] === 0 || c[3] === 0) d[p * 4 + 3] = 0; else { d[p * 4] = c[0]; d[p * 4 + 1] = c[1]; d[p * 4 + 2] = c[2]; d[p * 4 + 3] = 255; } }
    ox.putImageData(id, 0, 0); return oc.convertToBlob({ type: 'image/png' }).then(b => new Promise(res => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(b); }));
  }
  _diffPalette() { const o = {}; this.cur.forEach((c, i) => { if (JSON.stringify(c) !== JSON.stringify(this.orig[i])) o[i] = c; }); return o; }

  // ---------- multi-bank palette (body + effect/projectile/super palettes) ----------
  // The body's (edited) colors — what the part PNGs must be colored with for the bake, regardless
  // of which palette bank is currently selected for VIEWING.
  _bodyCur() {
    if (this.bank === this._bodyBank) return this.cur;
    return this._palByBank[this._bodyBank] || (this._banks && this._banks[String(this._bodyBank)]) || this.cur;
  }
  // Persist the current bank's working colors into _palByBank iff they differ from pristine.
  _flushBank() {
    if (!this._banks) return;
    const pristine = this._banks[String(this.bank)] || [];
    if (this.cur.some((c, i) => JSON.stringify(c) !== JSON.stringify(pristine[i]))) this._palByBank[this.bank] = this.cur.map(c => c.slice());
    else delete this._palByBank[this.bank];
  }
  // All palette edits across every bank → { bank: { index: [r,g,b,a] } } (what bake_skin expects).
  _diffPaletteAll() {
    this._flushBank();
    const out = {};
    for (const [bk, colors] of Object.entries(this._palByBank)) {
      const pristine = (this._banks && this._banks[String(bk)]) || [];
      const d = {};
      colors.forEach((c, i) => { if (JSON.stringify(c) !== JSON.stringify(pristine[i])) d[i] = c; });
      if (Object.keys(d).length) out[bk] = d;
    }
    return out;
  }
  // Switch the active palette bank: save the current one, load the new one (edited copy if any,
  // else pristine). The sprite re-renders in the new palette (a color-reference preview).
  _setBank(b) {
    if (!this._banks) return;
    this._flushBank();
    this.bank = b;
    const pristine = this._banks[String(b)] || [];
    this.cur = (this._palByBank[b] || pristine).map(c => c.slice());
    this.orig = pristine.map(c => c.slice());
    this._palBase = this.cur.map(c => c.slice()); this._resetPalSliders();
    this._populatePalBanks();
    this._renderBrush(); this._render(); this._renderBake();
  }
  _palBankLabel(b) {
    const nm = (this._palNames && this._palNames[b]) || (b === this._bodyBank ? 'Main Color (body)' : `bank ${b}`);
    const short = nm.length > 40 ? nm.slice(0, 39) + '…' : nm;
    return (this._palByBank[b] ? '● ' : '') + short;
  }
  // Fill the bank dropdown with the body bank + every PalMod-named palette (the meaningful ones;
  // the thousands of duplicate/unused banks stay hidden). Hidden entirely if there's only the body.
  _populatePalBanks() {
    if (!this.palBankEl) return;
    this._flushBank();
    this.palBankEl.innerHTML = '';
    if (!this._banks) { this.palBankEl.style.display = 'none'; this.palBankHintEl.style.display = 'none'; return; }
    const set = new Set([this._bodyBank]);
    for (const k of Object.keys(this._palNames || {})) set.add(+k);
    for (const k of Object.keys(this._palByBank)) set.add(+k);   // also expose any edited bank
    const banks = [...set].sort((a, b) => a - b);
    for (const b of banks) { const o = document.createElement('option'); o.value = b; o.textContent = this._palBankLabel(b); this.palBankEl.append(o); }
    this.palBankEl.value = String(this.bank);
    this.palBankEl.style.display = banks.length > 1 ? '' : 'none';
    this._updatePalBankHint();
  }
  _updatePalBankHint() {
    if (!this.palBankHintEl) return;
    if (this.bank === this._bodyBank || !this._banks) { this.palBankHintEl.style.display = 'none'; return; }
    const nm = (this._palNames && this._palNames[this.bank]) || `bank ${this.bank}`;
    this.palBankHintEl.innerHTML = `editing the <b>${nm}</b> palette — the sprite is shown in these colors for reference; the edit applies wherever the game uses this palette.`;
    this.palBankHintEl.style.display = '';
  }

  // ---------- frame / animation export ----------
  _download(blob, name) { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click(); URL.revokeObjectURL(a.href); }
  _animLabel() { const g = this.grpEl?.value ?? '0', s = this.subEl?.value ?? '0'; return `g${g}_a${s}`; }

  // placed parts of a cell in ABSOLUTE sprite coords (no per-frame min-shift, so frames align)
  _placedParts(cell) {
    const sid = cell && cell.sprite_id; if (sid == null || sid === 0xFFFF) return null;
    const recs = this.asm[String(sid & 0x7fff)] || this.asm[String(sid)]; if (!recs) return null;
    const pl = [];
    for (const r of recs) {
      const pr = this.bundle.parts[r.part]; if (!pr) continue;
      const w = pr.w, h = pr.h, flip = !!r.flip, flipy = !!r.flipy;
      pl.push({ sel: r.part, x: -r.dx, y: flipy ? -(r.dy + h) : r.dy, w, h, flip, flipy });
    }
    return pl.length ? pl : null;
  }

  // Export the current assembled frame as a PNG (reflects palette + pixel edits).
  async _exportFrame() {
    const f = this.frame; if (!f) { this.bakeEl.innerHTML = '<span class="dim">no frame to export — pick an animation</span>'; return; }
    const oc = new OffscreenCanvas(f.W, f.H), ctx = oc.getContext('2d'); const id = ctx.createImageData(f.W, f.H), d = id.data;
    for (let i = 0; i < f.W * f.H; i++) { const idx = f.out[i]; if (idx === 0) continue; const c = this.cur[idx] || [0, 0, 0]; d[i * 4] = c[0]; d[i * 4 + 1] = c[1]; d[i * 4 + 2] = c[2]; d[i * 4 + 3] = 255; }
    ctx.putImageData(id, 0, 0);
    this._download(await oc.convertToBlob({ type: 'image/png' }), `PL${HEX2(this.cid)}_${this._animLabel()}_f${String(this.fi).padStart(2, '0')}.png`);
  }

  // Export every frame of the current animation as ONE sprite-sheet PNG (horizontal strip,
  // all frames aligned to a shared bounding box so the character doesn't jitter).
  async _exportAnimSheet() {
    if (!this.cells.length || !this.asm || !this.bundle) { this.bakeEl.innerHTML = '<span class="dim">pick an animation first</span>'; return; }
    const placed = this.cells.map(c => this._placedParts(c));
    let minx = 1e9, miny = 1e9, maxx = -1e9, maxy = -1e9;
    for (const pl of placed) if (pl) for (const p of pl) { minx = Math.min(minx, p.x); miny = Math.min(miny, p.y); maxx = Math.max(maxx, p.x + p.w); maxy = Math.max(maxy, p.y + p.h); }
    if (maxx < minx) { this.bakeEl.innerHTML = '<span class="dim">this animation has no drawable frames</span>'; return; }
    const W = maxx - minx, H = maxy - miny, n = placed.length, SW = W * n;
    const oc = new OffscreenCanvas(SW, H), ctx = oc.getContext('2d'); const id = ctx.createImageData(SW, H), d = id.data;
    const bias = this._zBias || {};
    for (let fi = 0; fi < n; fi++) {
      const pl = placed[fi]; if (!pl) continue; const colX = fi * W;
      for (const p of [...pl].reverse().sort((a, b) => (bias[a.sel] || 0) - (bias[b.sel] || 0))) {   // reverse record order (engine Z=1/W) + bias
        const pix = this._partPix(p.sel);
        for (let py = 0; py < p.h; py++) for (let px = 0; px < p.w; px++) {
          const sx = p.flip ? p.w - 1 - px : px, sy = p.flipy ? p.h - 1 - py : py;
          const idx = pix[sy * p.w + sx]; if (idx === 0) continue; const c = this.cur[idx] || [0, 0, 0];
          const o = ((p.y - miny + py) * SW + (colX + p.x - minx + px)) * 4;
          d[o] = c[0]; d[o + 1] = c[1]; d[o + 2] = c[2]; d[o + 3] = 255;
        }
      }
    }
    ctx.putImageData(id, 0, 0);
    this._download(await oc.convertToBlob({ type: 'image/png' }), `PL${HEX2(this.cid)}_${this._animLabel()}_sheet_${n}f_${W}x${H}.png`);
  }

  // ---------- save / open a project file (portable, shareable, resume editing) ----------
  // A project = your editable state for EVERY character you've touched: per-char multi-bank
  // palette edits + painted parts (raw indices) + layer order, in ONE JSON file (no zip, no
  // linked files). It reuses the autosave drafts (the editor already persists each character's
  // work), so "save" gathers them and "open" scatters them back.
  //   { format, v:2, active:"PL17", chars:{ "PL17":{palette,painted,zBias}, ... } }
  _projHasEdits(d) { return d && ((d.painted && Object.keys(d.painted).length) || (d.palette && Object.keys(d.palette).length)); }
  _saveProject() {
    if (this.cid == null || !this.bundle) { this.bakeEl.innerHTML = '<span class="dim">load a character first</span>'; return; }
    this._saveDraft();   // flush the current character's edits to its draft first
    const chars = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i); if (!k || !k.startsWith('mvc2-sks-PL')) continue;
      try { const d = JSON.parse(localStorage.getItem(k)); if (this._projHasEdits(d)) chars[k.replace('mvc2-sks-', '')] = { palette: d.palette || {}, painted: d.painted || {}, zBias: d.zBias || {} }; } catch {}
    }
    const n = Object.keys(chars).length;
    if (!n) { this.bakeEl.innerHTML = '<span class="dim">nothing edited yet to save</span>'; return; }
    const proj = { format: 'mvc2-skin-studio-project', v: 2, active: `PL${HEX2(this.cid)}`, chars };
    const fname = n > 1 ? `mvc2_skin_project_${n}chars.json` : `${Object.keys(chars)[0]}_project.json`;
    this._download(new Blob([JSON.stringify(proj)], { type: 'application/json' }), fname);
    this.bakeEl.innerHTML = `<span class="dim">saved project — ${n} character(s) (${Object.keys(chars).join(', ')}). Reopen anytime with 📂 open project.</span>`;
  }
  async _loadProject(file) {
    let proj;
    try { proj = JSON.parse(await file.text()); } catch { this.bakeEl.innerHTML = '<span class="dim">not a valid JSON file</span>'; return; }
    if (!proj || proj.format !== 'mvc2-skin-studio-project') { this.bakeEl.innerHTML = '<span class="dim">not a Skin Studio project file (use 📂 load track03.bin for a ROM)</span>'; return; }
    // v2 = multi-character {chars:{...}}; v1 = single character {char, palette, painted, zBias}
    let chars = proj.chars;
    if (!chars) { const c = proj.char || `PL${HEX2(this.cid)}`; chars = { [c]: { palette: proj.palette || {}, painted: proj.painted || {}, zBias: proj.zBias || {} } }; proj.active = c; }
    // scatter each character's state into its autosave draft, so switching characters restores it
    for (const [c, st] of Object.entries(chars)) {
      try { localStorage.setItem(`mvc2-sks-${c}`, JSON.stringify({ palette: st.palette || {}, painted: st.painted || {}, zBias: st.zBias || {} })); } catch {}
    }
    const activeC = proj.active || Object.keys(chars)[0];
    const cid = parseInt(String(activeC).replace(/^PL/i, ''), 16);
    if (this.selEl) this.selEl.value = HEX2(cid);
    this._undoStack = []; this._redoStack = [];
    await this.loadChar(cid, { fresh: false });   // fresh:false → merges the draft we just wrote
    const n = Object.keys(chars).length;
    this.bakeEl.innerHTML = `<span class="dim">opened project — ${n} character(s) restored; now editing ${activeC}${n > 1 ? '. Switch characters to see the rest.' : '.'}</span>`;
  }
  // ---------- draft persistence (survives page refresh) ----------
  _draftKey() { return `mvc2-sks-PL${HEX2(this.cid)}`; }
  _saveDraft() {
    if (this.cid == null) return;
    // palette is now multi-bank { bank: { idx: rgba } }
    const draft = { palette: this._diffPaletteAll(), painted: {}, zBias: this._zBias || {} };
    for (const [s, px] of Object.entries(this.painted)) draft.painted[s] = Array.from(px);
    try { localStorage.setItem(this._draftKey(), JSON.stringify(draft)); } catch {}
  }
  _loadDraft() {
    try {
      const raw = localStorage.getItem(this._draftKey()); if (!raw) return false;
      const { palette = {}, painted = {}, zBias = {} } = JSON.parse(raw);
      const vals = Object.values(palette);
      if (vals.length && Array.isArray(vals[0])) {
        // OLD flat draft { idx: rgba } → applies to the (body) bank we're on
        for (const [i, c] of Object.entries(palette)) { const n = +i; if (n > 0 && n < this.cur.length) this.cur[n] = c; }
      } else {
        // NEW { bank: { idx: rgba } } → rebuild each edited bank's colors
        for (const [bk, d] of Object.entries(palette)) {
          const pristine = (this._banks && this._banks[String(bk)]) || [];
          const colors = pristine.map(c => c.slice());
          for (const [i, c] of Object.entries(d)) { const n = +i; if (n >= 0 && n < colors.length) colors[n] = c; }
          this._palByBank[+bk] = colors;
          if (+bk === this.bank) this.cur = colors.map(c => c.slice());
        }
      }
      for (const [s, arr] of Object.entries(painted)) this.painted[+s] = new Uint8Array(arr);
      this._zBias = {}; for (const [s, v] of Object.entries(zBias)) this._zBias[+s] = v;
      return Object.keys(palette).length > 0 || Object.keys(painted).length > 0;
    } catch { return false; }
  }

  _renderBake() {
    const palAll = this._diffPaletteAll(); const banks = Object.keys(palAll).length;
    const pe = Object.values(palAll).reduce((n, d) => n + Object.keys(d).length, 0), pp = Object.keys(this.painted).length;
    const palTxt = pe ? `<b>${pe}</b> color(s)${banks > 1 ? ` across ${banks} palettes` : ''}` : '<b>0</b> color(s)';
    const bakeHint = isTauri ? `Click <b>⬇ bake to ROM</b> to write it into your track03.bin.` : `Export, then:<br><code>python tools/bake_skin.py PL${HEX2(this.cid)}_skin.json</code>`;
    this.bakeEl.innerHTML = (pe || pp) ? `${palTxt}, <b>${pp}</b> painted part(s). ${bakeHint}` : `<span class="dim">recolor a swatch or paint the sprite for PL${HEX2(this.cid)}</span>`;
    this._saveDraft();
  }
  async _buildSkin() {
    const skin = { char: `PL${HEX2(this.cid)}` }; const pal = this._diffPaletteAll(); if (Object.keys(pal).length) skin.palette = pal;
    const sels = Object.keys(this.painted); if (sels.length) { skin.parts_png_b64 = {}; for (const s of sels) skin.parts_png_b64[s] = await this._partToDataURL(parseInt(s)); }
    return skin;
  }
  _hasEdits() { return Object.keys(this._diffPaletteAll()).length || Object.keys(this.painted).length; }
  async exportSkin() {
    const skin = await this._buildSkin();
    const blob = new Blob([JSON.stringify(skin)], { type: 'application/json' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `PL${HEX2(this.cid)}_skin.json`; a.click(); URL.revokeObjectURL(a.href);
  }
  // Build a Map<sel, twiddled-4bpp pixels> from the painted parts (display indices -> ROM format).
  _buildEdits() {
    const edits = new Map();
    for (const s of Object.keys(this.painted)) { const r = this.bundle.parts[s]; edits.set(+s, rb.paintedToBlobPixels(this.painted[s], r.w, r.h)); }
    const pal = this._diffPaletteAll(); const palEdits = Object.keys(pal).length ? pal : null;
    return { edits, palEdits };
  }
  async _loadRom() {
    // Pick track03.bin directly — loads character data live from the ROM and sets it as the
    // bake target. On desktop (Tauri) the bake also makes a real sibling .bak; in the browser
    // a handle can't, so backups come from the extract tool / server bake.
    let handle;
    try { handle = await pickRomHandle(); }
    catch { return; }      // picker error
    if (!handle) return;   // cancelled
    this._romSrcEl.textContent = 'reading track03.bin…';
    try {
      this.romReader = await RomReader.fromFile(await handle.getFile());   // throws if it isn't the CD001 data track
      this._romHandle = handle; this._romName = handle.name;
      if (isTauri && this._settings.rememberRom && handle._tauriPath) { this._settings.lastRom = handle._tauriPath; this._saveSettings(); }
      this._romCache = new Map();
      this._romSrcEl.textContent = `📂 ${handle.name}`;
      await this.loadChar(this.cid, { fresh: true });
      this._warmRomCache(handle.name);
    } catch (e) {
      this.romReader = null; this._romHandle = null;
      this._romSrcEl.textContent = `❌ ${e.message}`;
    }
  }

  async _warmRomCache(romName) {
    const reader = this.romReader; // snapshot — if user loads another ROM mid-warmup, bail
    let done = 0;
    for (const [hex] of CHARS) {
      if (this.romReader !== reader) return; // stale
      const cid = parseInt(hex, 16);
      if (!this._romCache.has(cid)) {
        try { this._romCache.set(cid, await reader.extractChar(cid)); }
        catch { /* skip broken chars silently */ }
      }
      done++;
      if (done % 5 === 0 || done === CHARS.length)
        this._romSrcEl.textContent = `📀 ${romName} (${done}/${CHARS.length})`;
      await new Promise(r => setTimeout(r, 0)); // yield to UI between chars
    }
    this._romSrcEl.textContent = `📀 ${romName} ✓ all ${CHARS.length} chars`;
  }
  async bakeToRom() {
    if (!this._hasEdits()) { this.bakeEl.innerHTML = '<span class="dim">nothing edited yet</span>'; return; }
    if (!isTauri && location.protocol === 'file:') {
      this.bakeEl.innerHTML = `❌ Don't open this file directly. Serve it: run <code>python tools/skin_server.py</code>, then open <b>http://localhost:8000/skin-studio.html</b> and bake again.`; return;
    }
    this.bakeEl.innerHTML = 'baking…';
    // 1) Browser build only: try the local Python server (if running) — edits IN PLACE after a
    //    one-time .bak, no file-picking. On desktop there's no server; skip straight to native.
    if (!isTauri) {
      try {
        const r = await fetch('./bake', { method: 'POST', body: JSON.stringify(await this._buildSkin()) });
        if (r.ok) {
          const j = await r.json();
          this.bakeEl.innerHTML = j.ok
            ? `✅ baked in place → <code>${j.path}</code><br><span class="dim">${j.info} · load it in flycast (a one-time .bak backup was made)</span>`
            : `❌ bake failed: ${j.error}`;
          return;
        }
      } catch { /* no /bake server — fall through */ }
      if (!rb.supportsFS()) { this.bakeEl.innerHTML = `❌ No bake server. Run <code>python tools/skin_server.py</code> and open <b>localhost:8000</b> from it (recommended), or use Chrome/Edge.`; return; }
    }
    // 2) Native bake straight into the ROM file — desktop (Tauri) or Chrome/Edge File System Access.
    let handle = this._romHandle, name = this._romName;
    if (!handle) {
      // Not loaded yet — pick track03.bin to bake into.
      try { handle = await pickRomHandle(); }
      catch { this.bakeEl.innerHTML = '<span class="dim">cancelled</span>'; return; }
      if (!handle) { this.bakeEl.innerHTML = '<span class="dim">cancelled</span>'; return; }
      name = handle.name; this._romHandle = handle; this._romName = name;
    }
    name = name || handle.name;
    const bakNote = isTauri
      ? `A pristine "${name}.bak" is made automatically the first time.`
      : `Make sure a backup exists first — the extract tool writes "${name}.bak" next to it, and the server bake makes one too.`;
    if (this._settings?.confirmBake !== false && !confirm(`Bake directly into "${name}"?\nThis edits it IN PLACE. ${bakNote}\nClose it in flycast before baking.`)) { this.bakeEl.innerHTML = '<span class="dim">cancelled</span>'; return; }
    this.bakeEl.innerHTML = 'baking into your ROM…';
    try {
      if (await handle.queryPermission({ mode: 'readwrite' }) !== 'granted' && await handle.requestPermission({ mode: 'readwrite' }) !== 'granted')
        throw new Error('write permission denied for that file');
      // Desktop makes a real sibling backup before touching the ROM (the browser can't).
      let bakMsg = '';
      if (isTauri) { const b = await backupRom(handle); if (b) bakMsg = b.created ? ` · 💾 ${b.name} created` : ` · ${b.name} already existed`; }
      const { edits, palEdits } = this._buildEdits();
      const res = await rb.bakeToTrack03(handle, `PL${HEX2(this.cid)}`, edits, palEdits);
      this.bakeEl.innerHTML = res.verified
        ? `✅ baked + verified into <code>${name}</code> — ${res.parts} part(s)${res.grew ? `, grew ${res.grew}B` : ''}${bakMsg}. Load it in flycast.`
        : `⚠ wrote but verification FAILED (${res.diff} bytes differ) — file likely open in flycast/locked. Close it and bake again (restore from ${name}.bak if needed).`;
    } catch (e) {
      const m = (e.name === 'NotAllowedError' || /not allowed/i.test(e.message || '')) ? 'browser blocked file access (open over http://localhost, not file://, in Chrome/Edge) — or use the Python server bake' : (e.message || e);
      this.bakeEl.innerHTML = `❌ ${m}`;
    }
  }
}

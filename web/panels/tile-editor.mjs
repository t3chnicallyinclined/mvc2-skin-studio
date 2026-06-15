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
  constructor(root, { atlasBase = './test-atlas/chars', animBase = './anim' } = {}) {
    this.root = root; this.atlasBase = atlasBase; this.animBase = animBase;
    this.cid = null; this.bank = 0;
    this.orig = []; this.cur = []; this._key2idx = null;                       // palette
    this.bundle = null; this.bundleImg = null; this.bundleData = null;        // part atlas (RGBA pixels)
    this.anim = null; this.asm = null;
    this.cells = []; this.fi = 0; this.frame = null;                          // current animation + frame
    this._origPix = {}; this.painted = {};                                   // sel -> Uint8Array indices
    this.brush = 1; this.tool = 'select'; this._undoStack = []; this._timer = null;
    this.romReader = null; this._romHandle = null; this._romDir = null; this._romName = null; this._romCache = new Map();
    this._build();
  }

  _build() {
    this.root.innerHTML = `
      <div class="ss-row">
        <label>character <select class="ss-char"></select></label>
        <button class="ss-reset" title="revert palette">reset palette</button>
        <button class="ss-export">export skin.json</button>
        <button class="ss-bakerom" title="bake into a patched GDI (needs skin_server.py)">⬇ bake to ROM</button>
        <button class="ss-loadrom" title="load character data live from your track03.bin (and set it as the in-browser bake target)">📂 load track03.bin</button>
        <span class="ss-romsrc dim" style="font-size:11px">loading…</span>
      </div>
      <div class="ss-row">
        <label>anim <select class="ss-grp"></select></label>
        <select class="ss-sub"></select>
      </div>
      <div class="ss-row ss-framenav">
        <button class="ss-prev-f" title="previous frame">◀ prev</button>
        <span class="ss-finfo">frame —</span>
        <button class="ss-next-f" title="next frame">next ▶</button>
        <button class="ss-play" title="play through the animation">▶ play</button>
        <input class="ss-fr" type="range" min="0" value="0" style="width:120px" title="scrub frames">
        <span class="ss-sep"></span>
        <button class="ss-exp-frame" title="export this assembled frame as a PNG">⤓ frame</button>
        <button class="ss-exp-sheet" title="export every frame of this animation as one sprite-sheet PNG">⤓ animation</button>
      </div>
      <div class="ss-hint">Pick an animation above, then use <b>◀ prev / next ▶</b> to step frame-by-frame. Paint this frame, advance, paint again. Left-click swatch to paint · <b>right-click to edit that color</b> live on the sprite.</div>
      <div class="ss-animlinks dim" style="font-size:11px; margin:-4px 0 10px; display:flex; gap:6px; flex-wrap:wrap; align-items:center;"></div>
      <div class="ss-paint">
        <div class="ss-pwrap">
          <div class="ss-tools">
            <button data-t="select" class="on" title="select / inspect parts (default) — click a part to select it; no painting">🖱 select</button>
            <button data-t="pencil">✏ pencil</button>
            <button data-t="fill">🪣 fill</button>
            <button data-t="pick">💧 pick</button>
            <button data-t="pan">✋ pan</button>
            <button data-t="marquee" title="drag a rectangle to copy it — then stamp it elsewhere">⬚ copy</button>
            <button data-t="stamp" title="stamp the copied region / imported sticker (click to place; right-click or Esc to cancel)">📌 stamp</button>
            <button class="ss-sticker" title="import a PNG as a sticker to stamp (any size — quantized to this character's palette)">🖼 sticker…</button>
            <input class="ss-sticker-file" type="file" accept="image/*" style="display:none">
            <button class="ss-erase-tool">✕ erase</button>
            <button class="ss-undo">↶ undo</button>
            <button class="ss-reset-frame" title="reset pixel edits for parts in this frame">↺ frame px</button>
            <button class="ss-reset-all-px" title="reset ALL painted parts">↺ all px</button>
            <span class="ss-sep"></span>
            <span class="dim" style="font-size:11px">size</span>
            <button class="ss-sz on" data-sz="1">1</button>
            <button class="ss-sz" data-sz="2">2</button>
            <button class="ss-sz" data-sz="4">4</button>
            <button class="ss-sz" data-sz="8">8</button>
            <label class="dim" style="font-size:11px">zoom <input class="ss-zoom" type="range" min="1" max="24" value="4"></label>
            <label class="dim" style="font-size:11px"><input class="ss-boxes" type="checkbox" checked> part boxes</label>
            <span class="dim" style="font-size:10px" title="amber = part is shared with other animations (editing affects them); blue = unique to this animation">box: <span style="color:#ffaa46">▢ shared</span> <span style="color:#7fb0ff">▢ this anim</span></span>
            <span class="ss-sep"></span>
            <label class="dim" style="font-size:11px">layer <select class="ss-layer" style="font-size:11px; max-width:170px" title="pick which part-layer to paint (brings it to front)"></select></label>
            <button class="ss-zback" title="send this part BEHIND — sticks for this part across every frame/animation that uses it">⬇ back</button>
            <button class="ss-zfront" title="bring this part to the FRONT (everywhere it's used)">⬆ front</button>
            <button class="ss-zreset" title="reset this part's layer order">○</button>
            <label class="dim" style="font-size:11px"><input class="ss-solo" type="checkbox"> solo</label>
            <span class="ss-sep"></span>
            <label class="dim" style="font-size:11px" title="apply each stroke / fill / stamp to the SAME on-screen spot on EVERY frame of this animation. Best for stationary features (a chest mark, a facial detail on an idle); approximate when the body moves a lot."><input class="ss-allframes" type="checkbox"> ⟳ all frames</label>
          </div>
          <div class="ss-canvas-row">
            <div class="ss-pal-side">
              <div class="dim ss-pal-label">palette · right-click to edit</div>
              <div class="ss-brush"></div>
              <div class="ss-paltools" style="margin-top:10px; display:flex; flex-direction:column; gap:4px; font-size:10px; width:124px;">
                <div class="dim" style="text-transform:uppercase; letter-spacing:1px;">recolor all</div>
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
            </div>
            <canvas class="ss-edit" width="420" height="380"></canvas>
            <div class="ss-selpanel" style="display:none; flex-direction:column; gap:6px; width:172px; max-height:380px; overflow:auto; padding:6px; background:#0b0c10; border:1px solid #262a33; border-radius:6px;">
              <div style="display:flex; justify-content:space-between; align-items:center;">
                <b style="font-size:11px; color:#a0bde8;">SELECTED PARTS</b>
                <button class="ss-selclear" style="font-size:10px; padding:1px 6px;" title="clear selection">clear</button>
              </div>
              <div class="ss-sellist" style="display:flex; flex-direction:column; gap:8px;"></div>
            </div>
            <div class="ss-previewpanel" style="display:none; flex-direction:column; gap:6px; width:200px; max-height:380px; padding:6px; background:#0b0c10; border:1px solid #262a33; border-radius:6px;">
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
      </div>
      <div class="ss-bake"></div>`;
    const $ = (s) => this.root.querySelector(s);
    this.selEl = $('.ss-char');
    this.grpEl = $('.ss-grp'); this.subEl = $('.ss-sub'); this.frEl = $('.ss-fr'); this.finfo = $('.ss-finfo'); this.linksEl = $('.ss-animlinks');
    this.selpanelEl = $('.ss-selpanel'); this.sellistEl = $('.ss-sellist'); this._selSet = new Set();
    $('.ss-selclear').onclick = () => { this._selSet.clear(); this._activeLayer = null; if (this.layerEl) this.layerEl.value = ''; this._renderSelPanel(); this._drawFrame(); };
    this.previewEl = $('.ss-previewpanel'); this._pvCanvas = $('.ss-pv-canvas'); this._pvTitle = $('.ss-pv-title'); this._pvInfo = $('.ss-pv-info');
    $('.ss-pv-close').onclick = () => { this.previewEl.style.display = 'none'; this._stopPreview(); };
    $('.ss-pv-edit').onclick = () => { if (this._pvGroup != null) { this.previewEl.style.display = 'none'; this._stopPreview(); this.grpEl.value = this._pvGroup; this._populateSubs(); } };
    this.brushEl = $('.ss-brush'); this.editC = $('.ss-edit'); this.ectx = this.editC.getContext('2d'); this.ectx.imageSmoothingEnabled = false;
    this.zoomEl = $('.ss-zoom'); this.bakeEl = $('.ss-bake'); this._romSrcEl = $('.ss-romsrc');
    this.penSize = 1;

    for (const [hex, nm] of CHARS) { const o = document.createElement('option'); o.value = hex; o.textContent = `PL${hex} ${nm}`; this.selEl.append(o); }
    this.selEl.value = '17'; // default to Cable (well-tested char with full atlas)
    this.selEl.onchange = () => this.loadChar(parseInt(this.selEl.value, 16));
    $('.ss-reset').onclick = () => { this.cur = this.orig.map(c => c.slice()); this._palBase = this.cur.map(c => c.slice()); this._resetPalSliders(); this._renderBrush(); this._render(); this._renderBake(); };
    this.hueEl = $('.ss-hue'); this.satEl = $('.ss-sat'); this.briEl = $('.ss-bri');
    [this.hueEl, this.satEl, this.briEl].forEach(el => el.oninput = () => this._applyPalXform());
    $('.ss-pal-apply').onclick = () => { this._applyPalXform(); this._palBase = this.cur.map(c => c.slice()); this._resetPalSliders(); };   // lock in as new baseline
    $('.ss-pal-reset-x').onclick = () => { this._resetPalSliders(); this._applyPalXform(); };
    $('.ss-swap-go').onclick = () => this._swapIndex(+$('.ss-swap-from').value, +$('.ss-swap-to').value);
    const stickerFile = $('.ss-sticker-file');
    $('.ss-sticker').onclick = () => stickerFile.click();
    stickerFile.onchange = (e) => { const f = e.target.files?.[0]; if (f) this._importSticker(f); e.target.value = ''; };
    $('.ss-loadrom').onclick = () => this._loadRom();
    $('.ss-export').onclick = () => this.exportSkin();
    $('.ss-bakerom').onclick = () => this.bakeToRom();
    $('.ss-undo').onclick = () => { if (!this._undoStack?.length) return; const entry = this._undoStack.pop(); for (const { sel, pix } of entry) this.painted[sel] = pix; this._drawFrame(); this._renderBake(); };
    this.root.querySelectorAll('.ss-tools button[data-t]').forEach(b => b.onclick = () => this._setTool(b.dataset.t));
    $('.ss-erase-tool').onclick = () => { this._setTool('pencil'); this.brush = 0; this._renderBrush(); };
    $('.ss-reset-frame').onclick = () => {
      if (!this.frame) return;
      for (const pb of this.frame.parts) { delete this.painted[pb.sel]; delete this._origPix[pb.sel]; }
      this._undoStack = []; this._drawFrame(); this._renderBake();
    };
    $('.ss-reset-all-px').onclick = () => {
      if (!Object.keys(this.painted).length) return;
      this.painted = {}; this._origPix = {}; this._undoStack = [];
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
    this.layerEl = $('.ss-layer'); this._activeLayer = null; this._solo = false; this._zBias = {};
    this.layerEl.onchange = () => { const v = this.layerEl.value; this._activeLayer = v === '' ? null : +v; this._drawFrame(); };
    $('.ss-solo').onchange = (e) => { this._solo = e.target.checked; this._drawFrame(); };
    this._allFrames = false;
    $('.ss-allframes').onchange = (e) => { this._allFrames = e.target.checked; this._clearFrameComps(); };
    $('.ss-zback').onclick = () => this._biasLayer(-1);
    $('.ss-zfront').onclick = () => this._biasLayer(1);
    $('.ss-zreset').onclick = () => { if (this._activeLayer == null) return; delete this._zBias[this._activeLayer]; this._drawFrame(); this._renderBake(); };
    this._hoverSel = -1; this._showBoxes = true;
    $('.ss-exp-frame').onclick = () => this._exportFrame();
    $('.ss-exp-sheet').onclick = () => this._exportAnimSheet();
    this._editEvents();
    this._setTool('select');   // default to the pointer/select tool (clicking inspects, never paints)
    this.cid = parseInt(this.selEl.value, 16);
    this.loadChar(this.cid, { fresh: true });   // auto-load pre-generated data on open (falls back to empty + 📀 prompt)
  }

  // Load a character from the PRE-GENERATED bundle (tools/build_skin_studio_data.py output in
  // test-atlas/chars/) so the page shows sprites + animations with NO in-browser ROM pick.
  // Returns the same shape as RomReader.extractChar, or null if the files aren't present.
  async _loadCharFromFiles(cid) {
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
    this._stop(); this.cid = cid; this.painted = {}; this._origPix = {}; this._zBias = {}; this.fi = 0;
    if (this._selSet) this._selSet.clear(); if (this.selpanelEl) this.selpanelEl.style.display = 'none';   // clear selection on char change
    this._stopPreview(); if (this.previewEl) this.previewEl.style.display = 'none';   // close any open preview
    this._undoStack = []; this._oc = null;

    let data = null;
    try {
      if (this.romReader) {
        if (!this._romCache.has(cid)) this._romCache.set(cid, await this.romReader.extractChar(cid));
        data = this._romCache.get(cid);
      } else {
        data = await this._loadCharFromFiles(cid);   // pre-generated bundle — no ROM picker needed
      }
      if (data) {
        this.bank = data.lut.bodyBank || 0;
        this.orig = (data.lut.banks[this.bank] || []).map(c => c.slice());
        this.cur = this.orig.map(c => c.slice());
        this._palBase = this.cur.map(c => c.slice()); this._resetPalSliders();   // recolor-all baseline
        this._key2idx = {}; this.orig.forEach((c, i) => { if (c[3] > 0) this._key2idx[`${c[0]},${c[1]},${c[2]}`] = i; });
        this.asm = data.asm.assemblies;
        this.bundle = data.bundle; this.bundleImg = data.bundleImg; this.bundleData = data.bundleData;
        if (!this.romReader && this._romSrcEl) this._romSrcEl.textContent = `📦 PL${HEX2(cid)} (pre-generated) · 📀 load ROM to bake in-browser`;
      } else {
        this.orig = []; this.cur = []; this.asm = null; this.bundle = null; this.bundleData = null;
        if (!this.romReader && this._romSrcEl) this._romSrcEl.textContent = 'no data — run build_skin_studio_data.py, or 📀 load ROM';
      }
    } catch (e) {
      console.error('loadChar failed:', e);
      this.orig = []; this.cur = []; this.asm = null; this.bundle = null; this.bundleData = null;
      if (this.romReader && this._romSrcEl) this._romSrcEl.textContent = `❌ ${e.message}`;
    }

    // anim comes from ROM reader; fall back to server JSON if ROM didn't produce groups
    this.anim = (data?.anim && Object.keys(data.anim.groups).length) ? data.anim : null;
    if (!this.anim) {
      const bust = '?t=' + (this._t = (this._t || 1) + 1);
      try { this.anim = await (await fetch(`${this.animBase}/PL${HEX2(cid)}.json${bust}`)).json(); } catch { this.anim = null; }
    }
    if (!fresh) this._loadDraft();
    this._buildGrpSels();                                         // which parts each animation group uses (for the link map)
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
          this._fitOnCenter = true; this._panX = null; this._drawFrame();
          this.finfo.textContent = `static sid 0x${(+firstSid).toString(16)} · load anim catalog for animation`;
          return;
        }
      }
      this.cells = []; this.finfo.textContent = this.bundle ? 'no anim catalog' : '📀 pick your ROM to start'; return;
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
  // Side panel: one card per selected part — thumbnail + dims + a context gallery (full-frame
  // thumbnails of every animation the part appears in, outlined + flip-badged, click to jump).
  _renderSelPanel() {
    if (!this.sellistEl) return;
    this.sellistEl.innerHTML = '';
    if (!this._selSet.size) { if (this.selpanelEl) this.selpanelEl.style.display = 'none'; return; }
    for (const sel of this._selSet) {
      const r = this.bundle && this.bundle.parts[sel];
      const row = document.createElement('div');
      row.style.cssText = `border:1px solid ${sel === this._activeLayer ? '#ff5fd0' : '#262a33'}; border-radius:5px; padding:5px; background:#15171d;`;
      const tc = document.createElement('canvas'); tc.width = 56; tc.height = 56;
      tc.style.cssText = 'image-rendering:pixelated; background:#0b0c10; border:1px solid #262a33; display:block; margin:0 auto 4px;';
      this._drawPartThumb(tc, sel); row.append(tc);
      const info = document.createElement('div');
      info.style.cssText = 'font-size:11px; color:#d7dae2; display:flex; justify-content:space-between; align-items:center;';
      const lab = document.createElement('span'); lab.innerHTML = `part <b>${sel}</b>${r ? ` ${r.w}×${r.h}` : ''}`; info.append(lab);
      const rm = document.createElement('button'); rm.textContent = '×'; rm.title = 'deselect'; rm.style.cssText = 'font-size:11px; padding:0 6px;';
      rm.onclick = () => { this._selSet.delete(sel); if (this._activeLayer === sel) this._activeLayer = this._selSet.size ? [...this._selSet].pop() : null; this._renderSelPanel(); this._drawFrame(); };
      info.append(rm); row.append(info);
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
    this.tool = t;
    this.root.querySelectorAll('.ss-tools button[data-t]').forEach(x => x.classList.toggle('on', x.dataset.t === t));
    if (this.editC) this.editC.style.cursor = t === 'select' ? 'pointer' : t === 'pan' ? 'grab' : 'crosshair';
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
    this._renderAnimLinks();   // refresh the "editing here also changes…" impact map for this animation
  }
  _gotoFrame(i) { if (!this.cells.length) return; this.fi = (i + this.cells.length) % this.cells.length; this.frEl.value = this.fi; this._drawFrame(); }
  _togglePlay(btn) { if (this._timer) { this._stop(); btn.textContent = '▶'; } else { btn.textContent = '⏸'; const tick = () => { this._gotoFrame(this.fi + 1); }; this._timer = setInterval(tick, 120); } }
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

  // ---------- all-frames cascade (edit the same spot across the whole animation) ----------
  // Part placement is independent of painted pixels, so one base-composite per cell per stroke is
  // enough. _paintAcrossFrames maps an ABSOLUTE sprite coord into each other frame and paints there.
  _buildFrameComps() { this._frameComps = (this.cells || []).map(c => this._compositeCell(c, false)); }
  _clearFrameComps() { this._frameComps = null; }
  _paintAcrossFrames(absX, absY, value, undoMap) {
    if (!this._frameComps) this._buildFrameComps();
    for (let fi = 0; fi < this._frameComps.length; fi++) {
      if (fi === this.fi) continue;
      const comp = this._frameComps[fi]; if (!comp) continue;
      const lx = absX - comp.ax, ly = absY - comp.ay;
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
    this._ox = this._panX; this._oy = this._panY;
    // Fast path: fill ImageData at 1:1, then scale once with drawImage.
    // Dramatically faster than per-pixel fillRect for large/zoomed sprites.
    if (!this._oc || this._oc.width !== f.W || this._oc.height !== f.H)
      { this._oc = new OffscreenCanvas(f.W, f.H); this._ocCtx = this._oc.getContext('2d'); }
    const id = new ImageData(f.W, f.H); const d = id.data;
    for (let i = 0, N = f.W * f.H; i < N; i++) {
      const idx = f.out[i]; const col = this.cur[idx] || [0,0,0,0]; const p = i << 2;
      if (idx === 0 || col[3] === 0) { const ck = ((i % f.W + (i / f.W | 0)) & 1) ? 0x17 : 0x1d; d[p]=d[p+1]=d[p+2]=ck; d[p+3]=255; }
      else { d[p]=col[0]; d[p+1]=col[1]; d[p+2]=col[2]; d[p+3]=255; }
    }
    this._ocCtx.putImageData(id, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this._oc, 0, 0, f.W, f.H, this._ox, this._oy, f.W * z, f.H * z);
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
  }

  // ---------- palette power tools ----------
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
    this._undoStack.push(undo); if (this._undoStack.length > 20) this._undoStack.shift();
    this._drawFrame(); this._renderBake();
    this.bakeEl.innerHTML = `<span class="dim">swapped index ${from}→${to} in ${changed} part(s)</span>`;
  }
  // ---------- brush / palette ----------
  _renderBrush() {
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
      b.title = i === 0 ? 'erase (transparent — index 0)' : `index ${i}${edited ? ' · edited' : ''} · right-click to edit color`;
      b.onclick = () => { this.brush = i; this._setTool('pencil'); this._renderBrush(); };
      this.brushEl.appendChild(b);
    }
  }
  _xy(e) { const r = this.editC.getBoundingClientRect(); const z = this._z || 1; const x = Math.floor(((e.clientX - r.left) * (this.editC.width / r.width) - this._ox) / z); const y = Math.floor(((e.clientY - r.top) * (this.editC.height / r.height) - this._oy) / z); const f = this.frame; return (f && x >= 0 && y >= 0 && x < f.W && y < f.H) ? [x, y] : null; }
  _editEvents() {
    let down = false;
    let strokeUndo = new Map(); // before-state of each part first touched this stroke
    const MAX_UNDO = 20;
    const paintAt = (cx, cy) => {
      const f = this.frame;
      // pick: single point, no pen-size
      if (this.tool === 'pick') {
        const ci = cy * f.W + cx; let sel = f.ownSel[ci], loc = f.ownLoc[ci];
        if (sel < 0) { sel = f.boxSel[ci]; loc = f.boxLoc[ci]; }
        if (sel >= 0) { this.brush = (this.painted[sel] || this._partPix(sel))[loc]; this._renderBrush(); }
        return;
      }
      // pencil / erase: paint a sz×sz square centered on the cursor
      const sz = this.penSize || 1, half = Math.floor(sz / 2);
      for (let dy = 0; dy < sz; dy++) for (let dx = 0; dx < sz; dx++) {
        const px = cx - half + dx, py = cy - half + dy;
        if (px < 0 || py < 0 || px >= f.W || py >= f.H) continue;
        const ci = py * f.W + px;
        let sel = f.ownSel[ci], loc = f.ownLoc[ci];
        if (sel < 0) { sel = f.boxSel[ci]; loc = f.boxLoc[ci]; }
        if (sel < 0) continue;
        if (!strokeUndo.has(sel)) strokeUndo.set(sel, (this.painted[sel] || this._partPix(sel)).slice());
        if (!this.painted[sel]) this.painted[sel] = this._partPix(sel).slice();
        this.painted[sel][loc] = this.brush;
        if (this._allFrames && this.frame) this._paintAcrossFrames(this.frame.ax + px, this.frame.ay + py, this.brush, strokeUndo);
      }
    };
    const apply = (e) => {
      const p = this._xy(e); if (!p) return; const [x, y] = p; const f = this.frame; if (!f) return;
      if (this.tool === 'fill') this._fillComposite(x, y, strokeUndo); else paintAt(x, y);
      this._drawFrame(); this._renderBake();
    };
    let panLast = null;
    this.editC.addEventListener('mousedown', (e) => {
      if (this.tool === 'pan') { panLast = [e.clientX, e.clientY]; return; }
      if (this.tool === 'select') { this._selectPartAt(e); return; }   // select-only — never paints
      if (this.tool === 'marquee') { const p = this._xy(e); if (p) this._marq = [p[0], p[1], p[0], p[1]]; return; }
      if (this.tool === 'stamp') { if (e.button === 2) return; this._stampAt(e); return; }   // click to place
      if (!this.frame) return;
      strokeUndo = new Map(); // fresh per-stroke before-state collection
      if (this._allFrames) this._buildFrameComps();   // cache other frames for cross-frame cascade
      down = true; apply(e);
    });
    this.editC.addEventListener('mousemove', (e) => {
      if (panLast) { const r = this.editC.getBoundingClientRect(); this._panX += (e.clientX - panLast[0]) * (this.editC.width / r.width); this._panY += (e.clientY - panLast[1]) * (this.editC.height / r.height); panLast = [e.clientX, e.clientY]; this._render(); return; }
      if (this._marq) { const p = this._xy(e); if (p) { this._marq[2] = p[0]; this._marq[3] = p[1]; this._render(); } return; }
      if (this.tool === 'stamp' && this._clip) { this._stampXY = this._xyRaw(e); this._render(); return; }
      if (down && this.tool === 'pencil') { apply(e); return; }
      const f = this.frame; if (!f) return; const p = this._xy(e); let s = -1;
      if (p) { const ci = p[1] * f.W + p[0]; s = f.ownSel[ci]; if (s < 0) s = f.boxSel[ci]; }
      if (s !== this._hoverSel) { this._hoverSel = s; this._render(); }
    });
    this.editC.addEventListener('mouseleave', () => { let dirty = false; if (this._hoverSel !== -1) { this._hoverSel = -1; dirty = true; } if (this._stampXY) { this._stampXY = null; dirty = true; } if (dirty) this._render(); });
    // right-click on the canvas while stamping cancels the clipboard
    this.editC.addEventListener('contextmenu', (e) => { if ((this.tool === 'stamp' || this._clip) && this._clip) { e.preventDefault(); this._clip = null; this._stampXY = null; this._render(); this.bakeEl.innerHTML = '<span class="dim">stamp cancelled</span>'; } });
    window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && this._clip) { this._clip = null; this._stampXY = null; this._render(); } });
    window.addEventListener('mouseup', () => {
      if (this._marq) { const [a, b, c2, d2] = this._marq; this._marq = null; this._copyRegion(a, b, c2, d2); }
      if (down && strokeUndo.size > 0) {
        this._undoStack.push([...strokeUndo.entries()].map(([s, p]) => ({ sel: s, pix: p })));
        if (this._undoStack.length > MAX_UNDO) this._undoStack.shift();
        strokeUndo = new Map();
      }
      this._clearFrameComps();
      down = false; panLast = null;
    });
  }
  _xyRaw(e) { const r = this.editC.getBoundingClientRect(); const z = this._z || 1; return [Math.floor(((e.clientX - r.left) * (this.editC.width / r.width) - this._ox) / z), Math.floor(((e.clientY - r.top) * (this.editC.height / r.height) - this._oy) / z)]; }
  // Copy the rendered indices inside the marquee rect into the clipboard, then arm the stamp tool.
  _copyRegion(x0, y0, x1, y1) {
    const f = this.frame; if (!f) return;
    const xa = Math.max(0, Math.min(x0, x1)), ya = Math.max(0, Math.min(y0, y1));
    const xb = Math.min(f.W - 1, Math.max(x0, x1)), yb = Math.min(f.H - 1, Math.max(y0, y1));
    const w = xb - xa + 1, h = yb - ya + 1; if (w < 1 || h < 1) return;
    const data = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[y * w + x] = f.out[(ya + y) * f.W + (xa + x)];
    this._clip = { w, h, data }; this._setTool('stamp');
    this.bakeEl.innerHTML = `<span class="dim">copied ${w}×${h} — 📌 stamp armed: click to place (centered on cursor). Right-click / Esc to cancel.</span>`;
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
      if (this._allFrames) this._paintAcrossFrames(f.ax + px, f.ay + py, v, undo);
    }
    if (this._allFrames) this._clearFrameComps();
    if (undo.size) { this._undoStack.push([...undo.entries()].map(([s, p]) => ({ sel: s, pix: p }))); if (this._undoStack.length > 20) this._undoStack.shift(); }
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
    const f = this.frame; const from = f.out[y * f.W + x]; if (from === this.brush) return;
    if (this._allFrames) this._buildFrameComps();
    const st = [[x, y]];
    while (st.length) {
      const [cx, cy] = st.pop(); if (cx < 0 || cy < 0 || cx >= f.W || cy >= f.H) continue;
      const ci = cy * f.W + cx; if (f.out[ci] !== from) continue;
      let sel = f.ownSel[ci], loc = f.ownLoc[ci]; if (sel < 0) { sel = f.boxSel[ci]; loc = f.boxLoc[ci]; }
      if (sel >= 0) {
        if (undoMap && !undoMap.has(sel)) undoMap.set(sel, (this.painted[sel] || this._partPix(sel)).slice());
        if (!this.painted[sel]) this.painted[sel] = this._partPix(sel).slice();
        this.painted[sel][loc] = this.brush;
      }
      if (this._allFrames) this._paintAcrossFrames(f.ax + cx, f.ay + cy, this.brush, undoMap);
      f.out[ci] = this.brush;   // mark visited
      st.push([cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]);
    }
  }

  // ---------- export ----------
  _partToDataURL(sel) {
    const px = this.painted[sel], r = this.bundle.parts[sel]; const oc = new OffscreenCanvas(r.w, r.h); const ox = oc.getContext('2d'); const id = ox.createImageData(r.w, r.h); const d = id.data;
    for (let p = 0; p < r.w * r.h; p++) { const c = this.cur[px[p]] || [0, 0, 0, 0]; if (px[p] === 0 || c[3] === 0) d[p * 4 + 3] = 0; else { d[p * 4] = c[0]; d[p * 4 + 1] = c[1]; d[p * 4 + 2] = c[2]; d[p * 4 + 3] = 255; } }
    ox.putImageData(id, 0, 0); return oc.convertToBlob({ type: 'image/png' }).then(b => new Promise(res => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(b); }));
  }
  _diffPalette() { const o = {}; this.cur.forEach((c, i) => { if (JSON.stringify(c) !== JSON.stringify(this.orig[i])) o[i] = c; }); return o; }

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

  // ---------- draft persistence (survives page refresh) ----------
  _draftKey() { return `mvc2-sks-PL${HEX2(this.cid)}`; }
  _saveDraft() {
    if (this.cid == null) return;
    const draft = { palette: this._diffPalette(), painted: {}, zBias: this._zBias || {} };
    for (const [s, px] of Object.entries(this.painted)) draft.painted[s] = Array.from(px);
    try { localStorage.setItem(this._draftKey(), JSON.stringify(draft)); } catch {}
  }
  _loadDraft() {
    try {
      const raw = localStorage.getItem(this._draftKey()); if (!raw) return false;
      const { palette = {}, painted = {}, zBias = {} } = JSON.parse(raw);
      for (const [i, c] of Object.entries(palette)) { const n = +i; if (n > 0 && n < this.cur.length) this.cur[n] = c; }
      for (const [s, arr] of Object.entries(painted)) this.painted[+s] = new Uint8Array(arr);
      this._zBias = {}; for (const [s, v] of Object.entries(zBias)) this._zBias[+s] = v;
      return Object.keys(palette).length > 0 || Object.keys(painted).length > 0;
    } catch { return false; }
  }

  _renderBake() {
    const pe = Object.keys(this._diffPalette()).length, pp = Object.keys(this.painted).length;
    this.bakeEl.innerHTML = (pe || pp) ? `<b>${pe}</b> color(s), <b>${pp}</b> painted part(s). Export, then:<br><code>python tools/bake_skin.py PL${HEX2(this.cid)}_skin.json</code>` : `<span class="dim">recolor a swatch or paint the sprite for PL${HEX2(this.cid)}</span>`;
    this._saveDraft();
  }
  async _buildSkin() {
    const skin = { char: `PL${HEX2(this.cid)}` }; const pe = this._diffPalette(); if (Object.keys(pe).length) skin.palette = { [this.bank]: pe };
    const sels = Object.keys(this.painted); if (sels.length) { skin.parts_png_b64 = {}; for (const s of sels) skin.parts_png_b64[s] = await this._partToDataURL(parseInt(s)); }
    return skin;
  }
  _hasEdits() { return Object.keys(this._diffPalette()).length || Object.keys(this.painted).length; }
  async exportSkin() {
    const skin = await this._buildSkin();
    const blob = new Blob([JSON.stringify(skin)], { type: 'application/json' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `PL${HEX2(this.cid)}_skin.json`; a.click(); URL.revokeObjectURL(a.href);
  }
  // Build a Map<sel, twiddled-4bpp pixels> from the painted parts (display indices -> ROM format).
  _buildEdits() {
    const edits = new Map();
    for (const s of Object.keys(this.painted)) { const r = this.bundle.parts[s]; edits.set(+s, rb.paintedToBlobPixels(this.painted[s], r.w, r.h)); }
    const pe = this._diffPalette(); const palEdits = Object.keys(pe).length ? { [this.bank]: pe } : null;
    return { edits, palEdits };
  }
  async _loadRom() {
    // Pick track03.bin directly — loads character data live from the ROM (alternative to the
    // pre-generated files) and sets it as the in-browser bake target. Backups are handled by
    // the extract tool / server bake (a file handle can't write a sibling .bak in the browser).
    let handle;
    try { [handle] = await window.showOpenFilePicker({ mode: 'readwrite', types: [{ description: 'GDI data track (track03.bin)', accept: { 'application/octet-stream': ['.bin'] } }] }); }
    catch { return; } // cancelled
    this._romSrcEl.textContent = 'reading track03.bin…';
    try {
      this.romReader = await RomReader.fromFile(await handle.getFile());   // throws if it isn't the CD001 data track
      this._romHandle = handle; this._romName = handle.name;
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
    if (location.protocol === 'file:') {
      this.bakeEl.innerHTML = `❌ Don't open this file directly. Serve it: run <code>python tools/skin_server.py</code>, then open <b>http://localhost:8000/skin-studio.html</b> and bake again.`; return;
    }
    this.bakeEl.innerHTML = 'baking…';
    // 1) Local Python server (if running): edits track03.bin IN PLACE after a one-time .bak. No file-picking.
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
    // 2) Browser-native (no server, Chrome/Edge over localhost): use already-held handle or pick.
    if (!rb.supportsFS()) { this.bakeEl.innerHTML = `❌ No bake server. Run <code>python tools/skin_server.py</code> and open <b>localhost:8000</b> from it (recommended), or use Chrome/Edge.`; return; }
    let handle = this._romHandle, name = this._romName;
    if (!handle) {
      // Not loaded yet — pick track03.bin to bake into.
      try { [handle] = await window.showOpenFilePicker({ mode: 'readwrite', types: [{ description: 'GDI data track (track03.bin)', accept: { 'application/octet-stream': ['.bin'] } }] }); name = handle.name; this._romHandle = handle; this._romName = name; }
      catch { this.bakeEl.innerHTML = '<span class="dim">cancelled</span>'; return; }
    }
    name = name || handle.name;
    if (!confirm(`Bake directly into "${name}"?\nThis edits it IN PLACE. Make sure a backup exists first — the extract tool writes "${name}.bak" next to it, and the server bake makes one too. Close it in flycast before baking.`)) { this.bakeEl.innerHTML = '<span class="dim">cancelled</span>'; return; }
    this.bakeEl.innerHTML = 'baking into your ROM…';
    try {
      if (await handle.queryPermission({ mode: 'readwrite' }) !== 'granted' && await handle.requestPermission({ mode: 'readwrite' }) !== 'granted')
        throw new Error('write permission denied for that file');
      const { edits, palEdits } = this._buildEdits();
      const res = await rb.bakeToTrack03(handle, `PL${HEX2(this.cid)}`, edits, palEdits);
      this.bakeEl.innerHTML = res.verified
        ? `✅ baked + verified into <code>${name}</code> — ${res.parts} part(s)${res.grew ? `, grew ${res.grew}B` : ''}. Load it in flycast.`
        : `⚠ wrote but verification FAILED (${res.diff} bytes differ) — file likely open in flycast/locked. Close it and bake again (restore from ${name}.bak if needed).`;
    } catch (e) {
      const m = (e.name === 'NotAllowedError' || /not allowed/i.test(e.message || '')) ? 'browser blocked file access (open over http://localhost, not file://, in Chrome/Edge) — or use the Python server bake' : (e.message || e);
      this.bakeEl.innerHTML = `❌ ${m}`;
    }
  }
}

# Graphify Evaluation — mvc2-skin-studio

**Date:** 2026-06-27  **Status:** Research / paused
**Tool:** [safishamsi/graphify](https://github.com/safishamsi/graphify) (MIT, by Safi Shamsi)

> One of 5 per-repo notes from the same research session. Siblings (same filename,
> `docs/research/graphify-evaluation.md`) live in: **GP2040-CE, maplecast-flycast,
> nobd-desktop, mvc2-oracle**. "Shared verdict" is identical across all five.

---

## What graphify is (1-paragraph)

CLI that turns folders of **code + docs + PDFs + data** into a queryable knowledge graph.
**AST tier** (tree-sitter, local, free) for code structure; **semantic tier** (LLM, your
API key, costs tokens) for doc/concept edges. Outputs `graph.json` (committable),
`graph.html`, `GRAPH_REPORT.md`, and an **MCP server**
(`python -m graphify.serve graph.json`). Edges tagged `EXTRACTED`/`INFERRED`/`AMBIGUOUS`.
Install: `uv tool install graphifyy` then `graphify install`.

---

## This repo's assessment

Part of the **MVC2 RE constellation** → graphify is **complement only; do not duplicate
`re_kb`** (the curated graph lives in mvc2-oracle / maplecast-flycast).

What's distinctive here: ~70% of the repo's *knowledge* (vs code) lives in **data +
embedded format specs + validation chains**, much of it NOT in `re_kb`:
- **Format specs buried in inline comments** across `tools/gfx1_lzss.py`,
  `tools/extract_gfx1_atlas.py`, `tools/rebuild_gfx1.py`, `tools/part_png.py`,
  `web/rom-bake.mjs`, `web/tile-editor.mjs` — the GFX1/GFX2/twiddle/LZSS/palette format,
  each validated against SH4 machine code (e.g. `loc_8c0354c0`).
- **Animation topology:** 56 `web/anim/PLxx.json` (~2.8MB) — groups → subanims → cells →
  sprite_id, sourced from the anotak corpus.
- **Palette bank labels:** `web/palnames/PLxx.json` (PalMod naming).
- **Cross-repo ingestion:** `build_anim_catalog.py` pulls from
  `../maplecast-flycast/tools/re_kb/ingest/cache/anotak`; palette names scraped from PalMod.

**Where graphify could help:** a docs/comment semantic graph could surface the
**shared format vocabulary** that's re-documented here AND in mvc2-skin-processor AND in
maplecast tools, with no link back to the canonical `re_kb` definition — useful for
keeping the duplicated format docs consistent. It would NOT replace `re_kb`.

Honest note: this repo is data-heavy (269 JSON, 60 PNG) and code-light (~15 core files).
The AST tier has little to chew on; the value is purely the semantic/doc layer over the
format-spec comments. **Scope** to `tools/`, `web/*.mjs`, `README.md`, `CHANGELOG.md`;
exclude the generated `web/test-atlas/` and per-ROM assets.

---

## Shared verdict (identical across all 5 repos)

| Constellation | Repos | Existing graph? | Verdict |
|---|---|---|---|
| **NOBD input-timing** | GP2040-CE, nobd-desktop, nobd-research, nobd-website, maplecast input-latch | **None** | **Strongest, cleanest win** |
| **MVC2 reverse-engineering** | mvc2-oracle, maplecast-flycast, **mvc2-skin-studio**, mvc2-skin-processor | **Yes — SurrealDB `re_kb`** | **Complement only — do NOT duplicate `re_kb`** |

**Risks:** yet-another-store risk; scale (exclude generated atlases); AST value minimal
here (data-heavy repo).

**Overall:** the NOBD constellation is where graphify earns adoption. Here, only the
docs/format-vocabulary layer is worth it, and only if a cross-MVC2-repo view is built.

---

## Where we left off / next steps

1. Pilot on **nobd-desktop** first.
2. GP2040-CE docs only.
3. Cross-repo **NOBD** graph + MCP ← unique-value artifact.
4. MVC2 docs-only, scoped — a cross-repo (skin-studio + skin-processor + maplecast)
   format-vocabulary graph is the only graphify play here; keep `re_kb` authoritative.
5. Decide MCP-first after steps 1–2.

**Nothing installed/run yet.** Prereqs: `uv` + Python 3.10+.

# MvC2 Skin Studio floorplan

A map of this repository for someone opening it cold: what the pieces are, how an edit travels from a
brush stroke into a game disc, and where to start reading.

Written against `master` at `b3380b7` (release `v0.1.0`). Every statement points at a file you can open.
The repository contains no sprite pixels, palettes or disc bytes; those are decoded from a disc image the
user supplies. The animation catalogs in `web/anim/` and the palette names in `web/palnames/` are shipped
metadata.

## 1. What this is

An editor for *Marvel vs. Capcom 2* character sprites. You recolour the palette or paint pixels on the
assembled sprite, and it writes the result back into your own Dreamcast disc image so it plays on an
emulator or a real console.

The whole editor is JavaScript. In Chrome or Edge it runs in a tab served from `localhost` and writes the
disc through the File System Access API. The desktop app is the same pages inside a window, with a small
Rust layer that removes the browser requirement, makes a real backup beside the disc, and accepts a zip or
a folder. Firefox and Safari can edit but need `tools/skin_server.py` to bake.

## 2. The floorplan

```mermaid
flowchart TB
  rom(["track03.bin<br/>the disc's data track,<br/>yours, never in the repo"])

  subgraph SHELL["src-tauri/ : desktop shell (Rust, Tauri v2)"]
    cmds["lib.rs<br/>rom_size, rom_read, rom_write,<br/>rom_backup, rom_prepare"]
  end

  subgraph WEB["web/ : the editor (plain ES modules, no build step)"]
    plat["platform.mjs<br/>one file handle, two back ends"]
    reader["rom-reader.mjs<br/>finds and decodes a character"]
    bake["rom-bake.mjs<br/>codecs + write back"]
    editor["panels/tile-editor.mjs<br/>palette + pixel editor"]
    proj["projects.mjs<br/>named projects, version history"]
    page["skin-studio.html"]
  end

  subgraph PY["tools/ : Python reference and dev tools"]
    ref["gfx1_lzss.py, rebuild_gfx1.py,<br/>part_png.py, bake_skin.py"]
    diag["diag_baked_rom.py"]
    srv["skin_server.py<br/>dev server + bake for<br/>other browsers"]
    data["build_skin_studio_data.py<br/>offline decode"]
  end

  stage["scripts/stage-frontend.mjs<br/>copies web/ into the bundle<br/>without local game data"]

  page --> editor
  editor --> reader
  editor --> bake
  editor --> proj
  editor --> plat
  reader --> bake
  plat -->|desktop| cmds
  plat -->|"browser: File System Access API"| rom
  cmds --> rom
  bake -.->|ported from, checked byte for byte| ref
  diag -.->|inspects| rom
  stage --> SHELL
```

## 3. The rooms

| Room | Path | Lines | What it holds |
|---|---|---|---|
| Editor | `web/panels/tile-editor.mjs` | 2,461 | The user interface (palette tools, the pixel canvas, animation playback, bulk edits, import and export) plus disc loading and the bake dispatch (`bakeToRom`). It paints on the assembled sprite and decomposes each stroke back to the individual parts. |
| Codecs and bake | `web/rom-bake.mjs` | 250 | The LZSS decoder and encoder (`decodeA`, `encodeA`), the texture twiddle and its inverse, the character file parser (`parseDAT`), the rebuild (`rebuildDat`) and `applyPalette` are pure functions over byte arrays. `bakeToTrack03` does the I/O through a file handle. |
| Reader | `web/rom-reader.mjs` | 190 | Finds a character's data file inside the disc's ISO 9660 file system and builds the in-memory structures the editor draws from. It imports its decoders from `rom-bake.mjs`, so there is one copy of each. |
| Platform | `web/platform.mjs` | 114 | Returns a file handle shaped like the browser's File System Access API. In a browser it is the real thing. In the desktop app the same shape is backed by the Rust commands. The reader and the bake never know which one they have. |
| Projects | `web/projects.mjs` | 100 | Named projects with up to 30 saved versions, stored in `localStorage`. A saved state holds only edits (palette changes, painted parts, layer order), never sprite or disc bytes. |
| Desktop shell | `src-tauri/src/lib.rs` | 183 | Five commands. Reads and writes are positioned (seek, then read or write a range), so the large file is never loaded or rewritten whole. `rom_prepare` takes a zip (which it extracts), the data track itself, or any file or folder beside it, and searches for the data track by its ISO signature. The `.gdi` file is not parsed. |
| Python tools | `tools/` | about 1,600 | The original implementation of the codecs and the bake, which the JavaScript was ported from. Also the development server, an offline decode, and the scripts that built the shipped animation catalogs and palette names. |
| Staging | `scripts/stage-frontend.mjs` | 22 | Copies `web/` into the app bundle and leaves out the folder where locally decoded game data lives, so an installer can never ship any. |
| Release | `.github/workflows/release.yml` | | A version tag builds Windows, macOS and Linux installers and drafts a release. |

## 4. How the game stores a character

Each character is one file on the disc. Its header is a table of section pointers. This tool uses four of
them (see the top of `web/rom-bake.mjs` and `_parseAnimGroups` in `web/rom-reader.mjs`):

- **GFX1**, the parts. A table of small images, each 4 bits per pixel, stored upside down in the console's
  twiddled texture order and compressed with the game's own LZSS variant.
- **GFX2**, the assembly. For each sprite, a list of 8-byte records: an offset, flip flags and a part
  number. Offsets are relative and are summed as the list is walked.
- **Palette**, the colours, in banks of 16 for the body, effects and projectiles.
- **Animation data**, which sprites make up each animation and for how long.

A sprite on screen is many parts placed by the assembly table and coloured by a palette. Parts are shared:
one part number can appear in many frames and many animations.

## 5. One edit, brush to disc

```mermaid
sequenceDiagram
  participant You
  participant Ed as tile-editor
  participant Rd as rom-reader
  participant Bk as rom-bake
  participant Disc as track03.bin

  You->>Ed: open the disc
  Ed->>Rd: extract this character
  Rd->>Disc: read only the sectors that hold its file
  Rd-->>Ed: parts, assembly, palettes
  You->>Ed: paint on the assembled sprite
  Ed-->>Ed: map the stroke back to the parts under it
  You->>Ed: bake
  Ed->>Bk: bakeToTrack03(handle, character, edits, palette edits)
  Bk->>Bk: re-encode the edited parts, rebuild the file
  Bk->>Disc: write the changed sectors in place
  Bk->>Disc: read them back and compare
  Bk-->>Ed: verified, or the number of bytes that differ
```

What `bakeToTrack03` in `web/rom-bake.mjs` does, in order:

1. Checks the file really is the data track by looking for the ISO 9660 signature, and stops if not. The
   sector arithmetic assumes a GDI `track03.bin`: raw 2352-byte sectors starting at LBA 45000.
2. Finds the character's file by name in the disc's root directory and reads only those sectors.
3. Applies palette edits, then rebuilds the parts section if any pixels changed. Edited parts are
   recompressed, untouched parts keep their original bytes, and the offset table is laid out again. If the
   result fits the old space it is padded and the file size does not change. If not, everything after it is
   shifted and the header pointers are updated.
4. If the rebuilt file is larger than the space its sectors allow, it refuses and says how many bytes over
   it is. It does not write a partial result.
5. Writes the user data of the changed sectors at their positions without truncating the file. If the size
   changed, it patches the size in the disc's directory entry in both byte orders the format requires. The
   sectors' error-correction bytes are not recomputed.
6. Reopens the file, reads the sectors back and compares every byte with what it meant to write. It
   returns `verified` and a difference count, and the editor shows a warning if they differ.

On the desktop, `rom_backup` in `src-tauri/src/lib.rs` makes a copy of the untouched track beside it before
the first bake, so there is always a way back. A bake through the browser's file API does not make one.

## 6. How it is checked

| Check | Where | What it covers |
|---|---|---|
| Port fidelity | `web/rom-bake.mjs` against `tools/gfx1_lzss.py`, `rebuild_gfx1.py`, `part_png.py`, `bake_skin.py` | The JavaScript codecs and bake are a port of the Python ones. The module header says they were validated byte for byte against them in Node; that comparison script is not in the repository. |
| Read back | `bakeToTrack03` | Every bake rereads what it wrote and compares it. |
| Strict diagnosis | `tools/diag_baked_rom.py` | Compares a baked track with its untouched backup and validates the edited file the strict way the game's own decoder reads it, to flag anything that would corrupt or crash on a console. |
| No game data in a build | `scripts/stage-frontend.mjs` | The bundle is staged from a copy that excludes locally decoded data. |

There is no automated test suite in the repository and the release workflow only builds. The read back
runs inside every bake and the staging runs in every build; the rest are run by hand, and the strict
diagnosis needs a disc image that cannot be committed.

## 7. Where to start reading

- The format and the codecs: `web/rom-bake.mjs`, top to bottom. It is 250 lines and has no dependencies.
- How a character is found on the disc: `web/rom-reader.mjs`.
- How one code base serves a browser and a desktop app: `web/platform.mjs`, then `src-tauri/src/lib.rs`.
- The editor itself: `web/panels/tile-editor.mjs`. Start from the import block at the top to see what it
  leans on.
- Using it rather than reading it: `README.md`.

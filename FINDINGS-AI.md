# AI format spike — Phase A findings

**Project:** Creatvise Canvas  
**Date:** 2026-10-13  
**Scope:** PDF-compatible `.ai` import/export (v1); browser-first; patch-original export rule (same as PSD).

---

## 1. Test assets (`public/`)

| File | Size | PDF | Creator (XMP) | Artboard (MediaBox) | PDF layers (OCG) |
|------|------|-----|---------------|---------------------|------------------|
| `sample.ai` | 61 KB | 1.5 | Adobe Illustrator **CS5** | 680×680 pt | **Yes** — `OCProperties` / `OCGs`, one named layer **"Layer 1"** |
| `DarkTech_Screen.ai` | 1.6 MB | 1.4 | Adobe Illustrator **24.0** (Windows) | 576×576 pt | **No** OCG in catalog — structure likely in **AIPrivateData** (24 references) |

Both files:

- Start with `%PDF-` (PDF-compatible `.ai` as required for v1).
- Contain **AIPrivateData** (Illustrator-native editing data).
- Are **single-page** (`numPages: 1` via pdf.js).
- Are **not** ReportLab/plain-PDF samples.

**Dev URLs (Vite):** `/sample.ai`, `/DarkTech_Screen.ai`

---

## 2. pdf.js read/render spike

**Library:** `pdfjs-dist` (spike tested with v4.10.x, Node + worker).

| Check | `sample.ai` | `DarkTech_Screen.ai` |
|-------|-------------|----------------------|
| `getDocument()` | OK | OK |
| Page count | 1 | 1 |
| Viewport @ scale 1 | 680×680 pt | 576×576 pt |

**Recommended for Phase C:**

- Add `pdfjs-dist` as a **dependency**.
- In browser: copy worker from `pdfjs-dist/build/pdf.worker.mjs` (or Vite `?url` import) — same pattern as Node spike.
- Render page 1 to `HTMLCanvasElement` → existing `Viewport` layer quads (same as PSD raster preview).
- Use `scale` to match doc pixel size (pt ≈ px at 72 dpi for display; align with PSD “1 unit = 1 px” convention in spike implementation).

**Optional content (layers):**

- `sample.ai` exposes PDF **Optional Content Groups** — pdf.js can drive visibility per OCG in render (`optionalContentConfig`) after mapping OCG → `Node` tree.
- `DarkTech_Screen.ai` has **no OCG** — layer panel for this file must come from **AIPrivate parsing (hard)** or **v1 fallback: single “Artwork” layer** + unsupported note.

---

## 3. PDF / Illustrator structure (summary)

```
.ai (PDF-compatible)
├── PDF Catalog (/Type/Catalog)
│   ├── /Pages → single Page (typical)
│   ├── /OCProperties → /OCGs[]   (optional; present in sample.ai only)
│   └── Metadata (XMP): CreatorTool, title, thumbnails
├── Page: /MediaBox, /Contents (PDF content stream — vector ops)
├── /PieceInfo, AIPrivateData streams (Illustrator editing model)
└── Embedded fonts, images, compressed streams (DarkTech larger)
```

**Implication:** What you **see** on canvas = PDF render. What Illustrator **edits** = often **AIPrivateData** + PDF. Export must **preserve** untouched bytes outside patched regions.

---

## 4. Patch strategy (export `.ai`)

Aligned with PSD: **patch `doc.original`, do not rebuild-only.**

| Tier | What | Risk | Phase |
|------|------|------|--------|
| **0** | Re-export **original bytes** unchanged | None | C/D smoke test |
| **1** | Patch **XMP metadata** (title, dates) in PDF Metadata stream | Low | D |
| **2** | Patch **OCG** name / default visibility (`sample.ai`) | Medium | D–E |
| **3** | Patch **page content** / transforms (move artwork in PDF space) | High — Illustrator may prefer AIPrivate | E+ |
| **4** | Patch **AIPrivateData** | Very high — binary, version-specific | Out of v1 unless spike proves safe |

**v1 recommendation:**

- **Import:** pdf.js render + OCG tree when present; else one synthetic layer.
- **Export:** start **Tier 0–1**; move to Tier 2 for renames/hide on OCG files; document Tier 3–4 as unsupported with data retained in file.
- Never silently drop AIPrivate or unknown streams.

**Tools:**

- **Read/render:** `pdfjs-dist`
- **Write/patch:** `pdf-lib` (incremental PDF edits) and/or targeted byte-range replace for Metadata XML — evaluate in Phase B/D spike on `sample.ai`.

---

## 5. Works / not supported (v1 target)

### Likely works (with Phase C–E)

| Feature | `sample.ai` (OCG) | `DarkTech_Screen.ai` (no OCG) |
|---------|-------------------|-------------------------------|
| Open `.ai`, show artboard | Yes | Yes |
| Canvas preview (page render) | Yes | Yes |
| Layer **names** from OCG | 1 layer | Fallback single layer |
| Visibility toggle (OCG) | Plausible (Tier 2) | Display-only / unsupported |
| Move / resize / rotate | PDF content patch hard | Same |
| Text / shape edit (Illustrator-native) | Needs AIPrivate | Needs AIPrivate |
| Export `.ai` download | Yes (Tier 0+) | Yes (Tier 0+) |
| Keep original unsupported data | Yes (patch-only) | Yes |

### Not supported v1 (list in UI — do not silent drop)

- Full **Illustrator layer tree** from AIPrivate only files (e.g. DarkTech multi-layer if not in OCG).
- **Live text** editing (font, glyph outlines) — treat as raster/vector preview unless AIPrivate spike succeeds.
- **Path point** editing, gradients, effects, symbols, charts.
- **Multi-artboard** (if file has multiple pages — these samples: 1 page).
- **Legacy** non-PDF `.ai` (PostScript/EPS header).
- **Blend modes / masks** — PDF render approximation only.
- Guaranteed **pixel-perfect** match to Illustrator after edit (same class of risk as PSD text re-render).

---

## 6. Architecture hooks (Phase B preview)

Current code is PSD-only (`Doc.psd`, `Node.src: ag-psd Layer`).

For AI without breaking PSD:

- `Doc`: keep `original: ArrayBuffer`; add `format: 'ai'` branch storage (e.g. `ai: { pdf?: ... }` or opaque handle).
- `Node.src`: union or wrapper — AI nodes keep link to OCG id / layer index / patch descriptor.
- `importAi` / `exportAi` parallel to `importPsd` / `exportPsd`.
- `main.ts`: open + export + IndexedDB by `doc.format`.

---

## 7. Illustrator manual checklist (Phase D sign-off)

Use after first `exportAi` implementation. **Not automated in CI.**

For each test file (`sample.ai`, `DarkTech_Screen.ai`):

1. [ ] Open original in **Adobe Illustrator** — document opens, no repair dialog.
2. [ ] Import in Creatvise — artboard matches roughly (size, content).
3. [ ] Export `*.edited.ai` **without edits** (Tier 0) — Illustrator opens export; compare to original (layers, appearance).
4. [ ] Repeat after **rename layer** / **toggle visibility** (when implemented).
5. [ ] Repeat after **move** (when implemented).
6. [ ] Note any “PDF modified” / missing font / missing linked image warnings.
7. [ ] Record: editable layers vs flattened / read-only.

**Pass criteria for assignment:** Export is valid `.ai`; supported edits remain editable where spike marked “works”; unsupported features still listed in app.

---

## 8. Phase A conclusion

| Question | Answer |
|----------|--------|
| Can we read `public/*.ai` in the browser? | **Yes** — PDF via pdf.js. |
| Layer panel like PSD for all files? | **Partial** — OCG yes (`sample.ai`); AIPrivate-only needs fallback or deep parse. |
| Export `.ai` feasible? | **Yes** — minimum unchanged bytes; progressive patch OCG/metadata. |
| Blockers before Phase B/C? | **None** — proceed with model refactor + `importAi` using pdf.js. |

**Next:** ~~Phase C~~ **Done** → ~~Phase D~~ **Done** → ~~Phase E (edits + OCG)~~ **Done** → INDD / deeper AIPrivate (future).

### Phase 2A — Opacity + panel caps (update)

- **`sample.ai` spike:** Page `/Contents` uses **`/GS0 gs`** → **object 11** `/Type/ExtGState` with `/ca` & `/CA` (Flate-encoded stream; no inline `/ca` in content). Patching object 11 is the correct path; content-stream `/ca` not required for this sample.
- **Import:** Render from a temp copy with ExtGState `/ca` forced to **1.0** so preview pixels stay full; layer slider holds file opacity (avoids double-dimming on re-import).
- **Export:** Post-patch **verify** `/ca` in output bytes; **throw** with clear message if patch/verify fails.

### Phase 2A — Opacity + panel caps

- Export: patch first PDF **ExtGState** `/ca` + `/CA` (e.g. `sample.ai`); re-import via `parseExtGStateOpacity`.
- `opacityExportsToFile(doc)`; Properties panel hints for .ai opacity behavior.
- `formatCaps` wired in panel (duplicate button, text/shape/replace sections).
- Export toast when `Export note:` warnings are added.

### Phase 1 — Common layer (PSD + AI)

- `src/formatCaps.ts` — export, duplicate, folder import, text/shape/replace flags per format.
- `src/formatImport.ts` — `importDocument(name, bytes, format)` for open + IndexedDB restore.
- `main.ts` / `formatExport.ts` / `sourceTree.ts` — use caps instead of scattered `format ===` checks.

### Phase E (completed)

- Per-OCG preview layers via pdf.js `OptionalContentConfig` (`ocg-0`, … keys).
- Export patches OCG **names** (variable length + xref fix) and **visibility** for single-OCG files (e.g. `sample.ai`).
- Rename, visibility, opacity, move/resize on canvas; IndexedDB restores transforms; export notes for canvas-only geometry.

### Phase C (completed)

- `src/ai.ts` — `importAi`, `fetchPublicAi`, pdf.js render, OCG name scan, `AiDocBacking` on `Doc`.
- Open `.ai` via file picker / drag-drop; **Sample AI** toggles `/sample.ai` and `/DarkTech_Screen.ai`.
- Layer panel: one preview layer (`Layer 1` or `Artwork`); unsupported + file warnings in props.
- IndexedDB restore for `format: 'ai'`; export via `exportAi` → `*.edited.ai` (Tier 0 + same-length OCG name patch).

### Phase B (completed)

- `src/sourceTree.ts` — native layer tree ops (`sourceSiblings`, `sourceInsert`, …) for PSD; no-op/null for AI until Phase C.
- `Doc.psd` optional; `Doc.ai?: AiDocBacking` placeholder on model.
- `src/formatExport.ts` — `exportDocument(doc)` dispatches by format.
- `main.ts` / `workspace.ts` — delete, duplicate, detach use `sourceTree` (no direct `doc.psd.children`).

---

## 9. Spike commands (repeat)

```bash
# pdf.js load test (from repo root, after npm install pdfjs-dist)
node --input-type=module -e "
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { pathToFileURL } from 'url';
import path from 'path';
import fs from 'fs';
GlobalWorkerOptions.workerSrc = pathToFileURL(path.join(process.cwd(), 'node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs')).href;
const data = new Uint8Array(fs.readFileSync('public/sample.ai'));
const doc = await getDocument({ data }).promise;
console.log('pages', doc.numPages);
"
```

Binary string scan (OCG / AIPrivate):

```bash
node -e "const t=require('fs').readFileSync('public/sample.ai','latin1'); console.log('OCG', t.includes('OCGs'), 'AIPrivate', (t.match(/AIPrivateData/g)||[]).length);"
```

# Adobe Illustrator (.ai) — Engine Specification & Deep Dive

> Comprehensive architectural reference for Adobe Illustrator (`.ai`) parsing, PDF stream extraction, OCG layer discovery, live text editing, vector shapes, and non-destructive patch export in Creatvise Canvas.

---

## 1. Executive Summary

Adobe Illustrator (`.ai`) documents saved with "Create PDF Compatible File" enabled are hybrid containers holding both a standard PDF stream and proprietary Adobe Illustrator private data streams (`AIPrivateData`).

Creatvise Canvas implements a **browser-first, non-destructive patch-original engine** for PDF-compatible `.ai` files:
- **Import Engine**: Renders artboard pages and extracts layer hierarchies using `pdfjs-dist`.
- **Optional Content Groups (OCG)**: Discovers and maps PDF OCG layers into the unified canvas layer tree, with automated alpha-mask generation for pixel-accurate hit testing.
- **Live Text Editing**: Scans PDF text streams (`Tj`, `TJ`), font decodings, and enables in-place text replacement.
- **Placed Image Replacement**: Detects embedded raster XObjects, allowing non-destructive image replacements while preserving canvas transforms.
- **Vector Shape Styling**: Detects vector rectangle paths and patches RGB fill/stroke operators (`rg`, `RG`) directly in the content stream.
- **Layer Duplication & Reordering**: Clones marked-content blocks (`/MCn BDC ... EMC`) and generates corresponding OCG entries in the PDF catalog.
- **Surgical Patch Export**: Modifies PDF transformation matrices (`cm`), opacity dictionaries (`/ExtGState`), and content streams using `pdf-lib` while leaving Illustrator-native `AIPrivateData` blocks completely intact.

---

## 2. Module Architecture (`src/ai/`)

All Illustrator-related logic is organized under `src/ai/`:

```
src/ai/
├── index.ts             # Public API barrel export
├── ai.ts                # Master AI import, export, and sample creation
├── aiPdfLib.ts          # Low-level PDF stream patching and export via pdf-lib
├── aiPdfText.ts         # Live text stream parsing and font extraction
├── aiPdfImages.ts       # Embedded PDF raster image extraction
├── aiVectorShapes.ts    # Vector path detection and shape color patching
├── aiOcgOrderImport.ts  # Illustrator Optional Content Groups (OCG) order resolver
├── aiGroupOps.ts        # AI-specific group and ungroup commands
├── aiReorder.ts         # Layer stack reordering in PDF content streams
├── aiLayerMeta.ts       # Layer metadata, duplicate validation & marked content handles
├── aiImageEdit.ts       # Placed image replacement and preview swap
├── aiImageExport.ts     # Placed image serialization into PDF XObjects
└── aiTextEdit.ts        # Live text edit synchronization and operator token patching
```

---

## 3. The Hybrid `.ai` Container Architecture

```
Adobe Illustrator (.ai) File
├── %PDF- Header (PDF 1.4 - 1.7)
│
├── PDF Document Catalog (/Type /Catalog)
│   ├── /Pages ──> Single Artboard Page (typical)
│   │   ├── /MediaBox [0 0 576 576] (Artboard Dimensions in Points)
│   │   ├── /Resources
│   │   │   ├── /ExtGState (Transparency & Opacity Dictionaries: /ca, /CA)
│   │   │   ├── /Font (Embedded Type 1, TrueType, or CFF Fonts)
│   │   │   └── /XObject (Embedded Images & Form XObjects)
│   │   └── /Contents (Vector Drawing Streams: cm, q, Q, re, m, l, c, f, s, Tj)
│   │
│   └── /OCProperties (Optional Content Properties)
│       └── /OCGs [ /OCG (Layer 1), /OCG (Background), ... ]
│
├── /PieceInfo & AIPrivateData Streams (Illustrator Native Data)
│   ├── AIPrivateData1 ... AIPrivateDataN (Hex / Flate-compressed binary)
│   ├── Artboard specifications, dynamic symbols, appearance attributes
│   └── Live effects, custom brushes, gradient meshes, compound paths
│
└── %%EOF
```

### The Creatvise Export Rule
When Adobe Illustrator opens an `.ai` file:
1. If `AIPrivateData` is valid, Illustrator loads its native object model from `AIPrivateData`, ignoring the PDF stream.
2. Third-party readers (Acrobat, macOS QuickLook, web browsers) render exclusively from the PDF content stream.

**The Golden Rule**: Creatvise Canvas updates the PDF content stream and `/ExtGState` dictionaries so web engines and PDF viewers immediately reflect edits, while keeping `AIPrivateData` intact so desktop Illustrator retains full native authoring capabilities upon re-opening.

---

## 4. Ingestion & OCG Layer Hierarchy (`src/ai/ai.ts`, `src/ai/aiOcgOrderImport.ts`)

1. **PDF Document Loading**: Loaded into `pdfjs-dist` to obtain page dimensions, viewport scale, and the root catalog.
2. **OCG Extraction**: Optional Content Groups (`/OCGs`) are inspected to build the named layer tree.
3. **Alpha Mask Generation**: Each layer is rendered to an offscreen canvas to compute an exact alpha mask for stage hit-testing.
4. **Model Mapping**: Nodes are added to the unified `Doc` tree (`src/core/model.ts`) with `kind: 'raster' | 'text' | 'shape' | 'group'`.

---

## 5. Live Text & Placed Images (`src/ai/aiTextEdit.ts`, `src/ai/aiImageEdit.ts`)

### Live Text Editing
- Scans marked-content stream chunks for `Tj` (show text) and `TJ` (show text with kerning) operators.
- Decodes character codes using embedded `/ToUnicode` CMap tables.
- Text edits on the canvas stage update the operator tokens within the content stream, preserving font definitions and font sizes.

### Placed Image Replacement
- Discovers raster `/XObject` references (`/Do /Im0`).
- Allows users to replace the image data with a new image upload directly in the browser.
- Automatically calculates aspect ratio, updates image dimensions, and patches the `/XObject` stream during export.

---

## 6. Vector Shapes & Color Styling (`src/ai/aiVectorShapes.ts`)

- Detects closed path rectangles and vector primitives defined by `re` (rectangle) or `m ... l ... h` (move-to, line-to, closepath).
- Reads and updates fill colors (`rg` for RGB, `k` for CMYK) and stroke colors (`RG`, `K`).
- Seamlessly integrates with the Property Inspector panel for live color picking.

---

## 7. Layer Duplication & Marked Content Cloning (`src/ai/aiLayerMeta.ts`)

- Layers in Illustrator PDF streams are enclosed within marked-content blocks:
  ```pdf
  /OC /MC0 BDC
    q 1 0 0 1 50 100 cm ... Q
  EMC
  ```
- Layer Duplication (`Ctrl+D`):
  1. Identifies the byte offset boundaries of `/MCn BDC ... EMC`.
  2. Clones the stream slice and assigns a new synthetic marked content tag (`/MC_dup_X`).
  3. Registers a new `/OCG` dictionary in the PDF catalog.
  4. Offsets the clone's position on stage by $+20\text{px}, +20\text{px}$.

---

## 8. Non-Destructive Patch Export (`src/ai/aiPdfLib.ts`)

On export (`exportAi`):
1. Loads the original document bytes using `pdf-lib`.
2. Patches the `/Contents` stream with new transform matrices (`cm`) for moved or rotated layers.
3. Updates `/ExtGState` transparency entries for adjusted opacity values.
4. Serializes modified marked-content blocks and placed image XObjects.
5. Emits a valid, fully backward-compatible `.ai` file.

---

## 9. Test Suites & Verification

Run all Illustrator regression suites:

```bash
# Run full AI test suite
npm run test:ai

# Test vector shape detection and stroke/fill color patching
npm run test:ai:shapes

# Test AI opacity and transform browser rendering
npm run test:ai:browser
```

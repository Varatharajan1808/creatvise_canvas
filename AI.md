# Adobe Illustrator (.ai) — Engine Specification & Deep Dive

> Comprehensive architectural reference for Adobe Illustrator (`.ai`) parsing, PDF stream extraction, layer hierarchy construction, vector transforms, and non-destructive patch export in Creatvise Canvas.

---

## 1. Executive Summary

Adobe Illustrator (`.ai`) files created with the standard "Create PDF Compatible File" option are hybrid documents containing both a valid PDF document stream and proprietary Adobe Illustrator private data streams (`AIPrivateData`).

Creatvise Canvas implements a **browser-first, non-destructive patch-original engine** for PDF-compatible `.ai` files:
- **Import Engine**: Renders artboard pages and extracts layer hierarchies using `pdfjs-dist`.
- **Layer Representation**: Discovers and maps PDF **Optional Content Groups (OCG)** into the canvas layer tree, with automated alpha-mask generation for pixel-accurate hit testing.
- **Surgical Patch Export**: Modifies PDF transformation matrices (`cm`), opacity dictionaries (`/ExtGState`), and marked-content streams using `pdf-lib` while leaving Illustrator-native `AIPrivateData` blocks untouched.
- **Layer Duplication**: Clones marked-content blocks (`/MCn BDC ... EMC`) and generates corresponding OCG entries in the PDF catalog upon export.

---

## 2. File Format Anatomy: The Hybrid `.ai` Structure

Modern `.ai` files (from Illustrator 9.0 through Creative Cloud 2026) are structured as dual-format hybrid containers:

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

### Key Discovery: Dual Model Interaction
When Adobe Illustrator opens a `.ai` file:
1. If `AIPrivateData` is valid, Illustrator loads its native object model directly from `AIPrivateData`, ignoring the PDF stream.
2. If `AIPrivateData` is stripped, corrupted, or invalidated, Illustrator falls back to parsing the PDF vector stream, converting PDF paths back into Illustrator objects.
3. Third-party readers (Acrobat, macOS QuickLook, web browsers) render exclusively from the PDF content stream.

**The Creatvise Canvas Export Rule**: Keep `AIPrivateData` untouched during export so desktop Illustrator retains full authoring data, while updating the PDF stream so PDF viewers and web engines immediately reflect canvas edits.

---

## 3. Test Assets in Repository (`public/`)

| File | Size | PDF Version | Creator Tool | Artboard Size | Layer Structure |
|---|---|---|---|---|---|
| `sample.ai` | 61 KB | PDF 1.5 | Adobe Illustrator **CS5** | 680 × 680 pt | **OCG Layers Present**: One named layer `"Layer 1"`, marked-content blocks. |
| `DarkTech_Screen.ai` | 1.6 MB | PDF 1.4 | Adobe Illustrator **24.0** | 576 × 576 pt | **No OCG Dictionary**: Structure stored inside 24 `AIPrivateData` references. |
| `fixtures/ai/simple-shapes.ai` | 1.2 KB | PDF 1.5 | Creatvise Synthetic | 400 × 300 pt | Marked-content rectangle vector paths with solid fill and stroke. |
| `fixtures/ai/live-text-synthetic.ai` | 1.8 KB | PDF 1.5 | Creatvise Synthetic | 500 × 200 pt | Marked-content text operators (`BT ... (Text) Tj ... ET`). |

---

## 4. Import Pipeline (`src/ai.ts`)

```
               ┌──────────────────────────────────────┐
               │         Load .ai ArrayBuffer         │
               └──────────────────┬───────────────────┘
                                  │
               ┌──────────────────▼───────────────────┐
               │      pdfjs-dist getDocument()        │
               │   Render Page 1 to HTML5 Canvas      │
               │        (Scale: 72 pt = 1 px)         │
               └──────────────────┬───────────────────┘
                                  │
               ┌──────────────────▼───────────────────┐
               │    Does PDF contain /OCProperties?   │
               └──────────┬───────────────────┬───────┘
                          │ Yes               │ No
             ┌────────────▼──────────┐ ┌──────▼─────────────┐
             │ Extract OCG Layers:   │ │ Fallback:          │
             │ - Parse names & refs  │ │ Create single flat │
             │ - Render per-OCG mask │ │ "Artwork" node     │
             │ - Map to Node tree    │ └────────────────────┘
             └────────────┬──────────┘
                          │
             ┌────────────▼───────────────────────────┐
             │ Populate Document in Three.js Viewport │
             │ Enable On-Canvas Hit-Testing & BBox    │
             └────────────────────────────────────────┘
```

### 1. Viewport & Unit Alignment
- In PDF, coordinates are expressed in points ($72\text{ pt} = 1\text{ inch}$).
- Creatvise Canvas standardizes on **$1\text{ canvas unit} = 1\text{ pixel}$**. At 72 DPI, 1 point maps directly to 1 pixel.
- Page dimensions from `/MediaBox` determine document width and height (`doc.width`, `doc.height`).

### 2. OCG Hierarchy Extraction
- When `/OCProperties` is present (as in `sample.ai`), `pdfjs-dist` queries individual OCG names and object IDs.
- For each layer, an offscreen alpha mask is extracted by rendering with `optionalContentConfig.setVisibility(ocgId, true)`.
- Layers without OCG metadata (e.g. `DarkTech_Screen.ai`) cleanly fall back to a single flat `"Artwork"` node without throwing errors.

---

## 5. Interactive Editing Operations

### 1. Canvas Transforms (Move, Resize, Rotate)
- Layer movements update the node's local transformation matrix.
- On export (`src/aiPdfLib.ts`), the engine patches the PDF transformation matrix operator (`cm`) wrapping the layer's marked-content stream:
  $$\begin{bmatrix} a & b & 0 \\ c & d & 0 \\ e & f & 1 \end{bmatrix}$$
  where $[a, b, c, d]$ represent scale and rotation, and $[e, f]$ represent translation in PDF coordinate space ($Y$-flipped).

### 2. Layer Visibility
- Layer visibility toggles update the `/OFF` array in the PDF Catalog's `/OCProperties` dictionary.
- Layers listed in `/OFF` are hidden in both PDF viewers and Illustrator layer panels.

### 3. Layer Opacity
- Non-destructive opacity updates are achieved by injecting or patching an `/ExtGState` dictionary with `/ca` (fill alpha) and `/CA` (stroke alpha) keys.
- Supported in both headless tests (`scripts/ai-opacity-export.test.ts`) and browser Playwright suites (`scripts/ai-opacity-browser.test.mjs`).

### 4. Layer Duplication (`Ctrl+D`)
- Available for files with marked-content blocks (`canDuplicateMarkedContent: true`).
- The export engine duplicates the `/MCn BDC ... EMC` stream block with an offset translation.
- Generates a new cloned OCG entry in `/OCGs` and appends it to `/OCProperties /D /Order`.
- Fully verified in `scripts/ai-duplicate-export.test.ts` (**19/19 passing checks**).

### 5. Vector Shape Fill & Stroke (`src/aiVectorShapes.ts`)
- Scans PDF content streams for rectangular path definitions (`re` operator).
- Patches fill color operators (`rg` for RGB, `g` for Grayscale, `k` for CMYK).
- Patches stroke color (`RG`) and line width (`w`).
- Verified in `scripts/ai-shape-export.test.ts` (**9/9 passing checks**).

---

## 6. Non-Destructive Export Pipeline (`src/aiPdfLib.ts`)

Export operates with surgical byte-level safety using `pdf-lib`:

```typescript
import { PDFDocument } from 'pdf-lib';

export async function exportAiWithPdfLib(
  originalBuffer: ArrayBuffer,
  doc: Doc,
  options?: AiExportOptions
): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.load(originalBuffer, {
    ignoreEncryption: true,
    updateMetadata: false,
  });

  // 1. Patch OCG visibility in /OCProperties
  patchOcgVisibility(pdfDoc, doc);

  // 2. Patch layer names
  patchOcgNames(pdfDoc, doc);

  // 3. Patch ExtGState opacities (/ca, /CA)
  patchLayerOpacities(pdfDoc, doc);

  // 4. Duplicate marked-content blocks if duplicated layers exist
  if (hasDuplicatedLayers(doc)) {
    duplicateMarkedContentBlocks(pdfDoc, doc);
  }

  // 5. Patch transformation matrices (cm) and shape colors
  patchContentStreams(pdfDoc, doc);

  // 6. Save PDF bytes while keeping raw AIPrivateData streams untouched
  return await pdfDoc.save({ useObjectStreams: false });
}
```

---

## 7. Automated Test Battery

The project maintains comprehensive regression tests specifically for Illustrator files:

```bash
# Run all core Illustrator tests (roundtrip, fidelity, selection, opacity, duplication, text)
npm run test:ai

# Test vector shape detection, stroke, and fill color patching
npm run test:ai:shapes

# Run headless Playwright browser test for AI opacity slider interaction
npm run test:ai:browser
```

### Test Coverage Breakdown
- `ai-export-roundtrip.test.ts`: Verifies exported `.ai` files re-open in `pdfjs-dist` with intact dimensions.
- `ai-export-fidelity.test.ts`: Validates OCG layer visibility, layer renaming, and structural preservation.
- `ai-selection-bounds.test.ts`: Tests canvas bounding box and handle transformations across zoom and rotation.
- `ai-opacity-export.test.ts`: Asserts `/ExtGState` dictionary updates and opacity attenuation.
- `ai-duplicate-export.test.ts`: 19 assertions verifying marked-content duplication, OCG catalog synchronization, and re-import fidelity.
- `ai-pdf-text.test.ts`: Verifies detection of PDF text operators (`BT ... Tj ... ET`).

---

## 8. Adobe Illustrator CC Desktop Verification Gate

While headless automated tests verify PDF specification compliance, final production sign-off requires testing exported files in native Adobe Illustrator CC desktop:

### Manual Verification Checklist
1. **Tier-0 (No-Op Pass-Through)**:
   - Export `sample.ai` and `DarkTech_Screen.ai` without edits.
   - Open in Adobe Illustrator CC.
   - **Expectation**: Opens cleanly without "The document has been damaged and will be repaired" warning.
2. **Transform & Move Verification**:
   - Move "Layer 1" in `sample.ai` by $+50\text{px}, +30\text{px}$, export, and reopen.
   - **Expectation**: Artwork renders at new position; Illustrator layers panel shows "Layer 1".
3. **Opacity & Visibility**:
   - Change layer opacity to $45\%$, hide sublayer, export, and reopen.
   - **Expectation**: Transparency panel reflects $45\%$ opacity; layer visibility matches.
4. **Layer Duplication**:
   - Duplicate layer (`Ctrl+D`), move duplicate, export, and reopen.
   - **Expectation**: Both original and duplicated layers appear as editable objects in Illustrator's layer panel.

---

## 9. Feature Status Matrix & Roadmap

| Feature | Status | Implementation Details |
|---|:---:|---|
| **File Open (Drag-Drop / Picker)** | **COMPLETE** | `src/formatImport.ts`, `src/ai.ts` |
| **Canvas WebGPU/WebGL2 Rendering** | **COMPLETE** | Renders high-resolution artboard quads in Three.js |
| **OCG Layer Tree Extraction** | **COMPLETE** | Maps `/OCProperties` to individual canvas nodes |
| **Non-OCG Artwork Fallback** | **COMPLETE** | Flat fallback for files without OCG dictionaries |
| **Interactive Canvas Move / Resize** | **COMPLETE** | Patches `cm` matrix in PDF stream |
| **Interactive Canvas Rotate** | **COMPLETE** | Patches rotation components in `cm` matrix |
| **Layer Visibility Toggle** | **COMPLETE** | Patches `/OFF` array in `/OCProperties` |
| **Layer Opacity Slider** | **COMPLETE** | Patches `/ExtGState` `/ca` and `/CA` values |
| **Layer Duplication (Ctrl+D)** | **COMPLETE** | Marked-content block cloning + OCG entry injection |
| **Rectangular Shape Fill / Stroke** | **COMPLETE** | Patches `rg`, `RG`, and `w` operators |
| **Layer Renaming** | **COMPLETE** | Patches OCG `/Name` string |
| **Undo / Redo History** | **COMPLETE** | Full transactional history stack |
| **Live Point Text Editing** | Roadmap | PDF text operator replacement (`Tj` / `TJ`) |
| **Arbitrary Bézier Path Editing** | Roadmap | Anchor point modification in PDF content stream |
| **Raster Image Replacement** | Roadmap | Swapping `/XObject` `/Subtype /Image` dictionaries |
| **Multi-Artboard Navigation** | Roadmap | Artboard switcher for multi-page documents |

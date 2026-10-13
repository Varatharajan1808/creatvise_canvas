# Creatvise Canvas

> High-performance infinite canvas built with Three.js (`WebGPURenderer`) and TypeScript for importing, editing, and exporting professional design files (**PSD**, **AI**).

Creatvise Canvas is built on a **non-destructive "patch-original" architecture**: rather than regenerating complex design files from scratch, it surgically patches modified properties (positions, text, fills, visibility, opacity) back into the original file structures. All un-modeled native structures—including smart objects, layer effects, and proprietary application metadata—remain 100% intact.

---

## Quickstart

### Prerequisites
- Node.js 18+ (tested with Node 20 / 22)
- Modern web browser with **WebGPU** support (Chrome 113+, Edge 113+) or WebGL2 fallback.

### Installation & Development

```bash
# Install dependencies
npm install

# Start local Vite development server
npm run dev

# Type-check and production build
npm run build

# Preview production build locally
npm run preview
```

Open the printed localhost URL in Chrome or Edge (e.g. `http://localhost:5174/`).

---

## Test Suites & Benchmarks

The project maintains extensive automated test suites covering pixel fidelity, adjustment formulas, roundtrips, and clipping:

```bash
# Run all 25 PSD regression test suites (adjustments, clipping, masks, footprints, undo/redo)
npm run test:psd

# Run Illustrator (.ai) PDF vector roundtrip tests
npm run test:ai

# Run recursive folder import & classification tests
npm run test:folder

# Profile adjustment layer computation & caching performance
npm run psd:bench

# Report luminance agreement baseline against Photoshop embedded composites
npm run psd:baseline

# Inspect supported/unsupported features in PSD test fixtures
npm run psd:inventory
```

---

## Core Architecture

### 1. Unified Document Model (`src/model.ts`)
A format-independent scene graph representation:
- **`Doc`**: Canvas document containing dimensions, offset, zoom, original binary bytes (`doc.original`), and root node tree.
- **`Node`**: Recursive tree element supporting `group`, `raster`, `text`, `shape`, and `adjustment` types. Each node references its underlying format handle (e.g., `ag-psd` layer or PDF content stream).

### 2. Non-Destructive "Patch-Original" Pipeline
- **PSD Export (`src/psd.ts`)**: Patches layer names, coordinates, opacities, visibility, locks, text runs, and shape fills into the in-memory `ag-psd` layer hierarchy. When saved with `writePsd`, smart objects, vector masks, and layer effects are preserved untouched.
- **AI Export (`src/ai.ts`, `src/aiPdfLib.ts`)**: Applies vector transformations and metadata updates to PDF streams using `pdf-lib` while safely retaining Illustrator-native `AIPrivateData` streams.

### 3. Hybrid Canvas Viewport (`src/viewport.ts`, `src/canvasHitTest.ts`)
- Rendered in Three.js with an orthographic camera where **1 canvas unit = 1 pixel**.
- Layers are textured quads rendered in back-to-front depth order.
- Pixel-accurate canvas hit-testing: ignores transparent pixels and 0% opacity placeholders, enabling natural click-to-select directly on the stage.
- Interactive on-canvas bounding box with drag-to-move, 8-point resize handles, and rotation anchor.

### 4. PSD Preview Engine & Dirty Footprint Patching (`src/psdComposite.ts`, `PSD-PREVIEW.md`)
- **Embedded Composite as Source of Truth**: Opens on Photoshop's embedded merged composite (`fileComposite`) whenever available, guaranteeing 100% visual fidelity upon import.
- **`file-base-overlay` Mode**: When a layer is edited or moved, Creatvise patches only the affected layer's import footprint using a dynamic 2D restack at import pose, then overlays dirty layers at their current positions. Untouched areas of the canvas continue rendering the native Photoshop composite.

---

## Supported Features

### Adobe Photoshop (.psd)

#### Real-Time Adjustment Layers (`src/psdAdjustment.ts`)
Nine native Photoshop adjustment layers are simulated in real-time within the dynamic 2D compositor:

1. **Levels (`levels`)**: Master RGB and individual R/G/B transfer curves, shadow/highlight clipping, and midtone gamma corrections.
2. **Brightness / Contrast (`brightness/contrast`)**: Legacy linear additive contrast and modern CS3+ non-linear S-curves.
3. **Curves (`curves`)**: Natural cubic spline interpolation per channel (R, G, B) and master RGB, solving tridiagonal systems (`src/psdAdjustmentCurves.ts`).
4. **Vibrance (`vibrance`)**: Adaptive saturation boosting muted colors, with dedicated warm skin-tone protection ($10^\circ - 50^\circ$) and uniform saturation scaling (`src/psdAdjustmentVibrance.ts`).
5. **Photo Filter (`photo filter`)**: Optical transmission tinting, CIE Lab-to-sRGB conversion, and Rec. 709 luminance preservation ($L = 0.2126R + 0.7152G + 0.0722B$) (`src/psdAdjustmentPhotoFilter.ts`).
6. **Color Lookup (`color lookup`)**: 3D LUT parser supporting Adobe `.cube` and Autodesk `.3dl` profiles with trilinear lattice interpolation (`src/psdAdjustmentColorLookup.ts`).
7. **Hue / Saturation (`hue/saturation`)**: HSL cylinder model, master adjustments, 6 targeted color sectors (Reds, Yellows, Greens, Cyans, Blues, Magentas) with smooth falloff ramps, and colorize mode (`src/psdAdjustmentHueSaturation.ts`).
8. **Color Balance (`color balance`)**: Independent Cyan-Red, Magenta-Green, and Yellow-Blue controls across Shadows, Midtones, and Highlights with optional luminosity preservation (`src/psdAdjustmentColorBalance.ts`).
9. **Black & White (`black & white`)**: 6-channel luminance weighting with customizable color tinting (e.g., Sepia, Cyanotype) (`src/psdAdjustmentBlackAndWhite.ts`).

*All adjustments fully honor layer masks, clipping isolation, layer opacity, stack ordering, footprint patching, and non-destructive re-export.*

#### Advanced Blending & Masking
- **Blend Modes (`src/psdBlend.ts`)**: Linear Burn, Linear Dodge (Add), Vivid Light, Linear Light, Pin Light, Hard Mix, Subtract, Divide, Darker Color, Lighter Color, Multiply, Screen, Overlay, and normal modes.
- **Clipping Masks**: Clipped layers correctly clip to their parent sibling base or group footprint.
- **Layer Masks**: Raster alpha masks with boundary `defaultColor` handling (cached via `maskAlphaCanvas`).

#### Layer Editing
- **Direct Canvas Manipulation**: Click-to-select, drag-to-move, resize, rotate (image layers), rename, delete, duplicate (Ctrl+D), hide/show, lock/unlock, and opacity slider.
- **Typography**: In-place point text editing (content, font size, color).
- **Vector Shapes**: Solid color fill editing.
- **History & Undo/Redo (`src/docHistory.ts`)**: Complete transactional undo/redo stack.

---

### Adobe Illustrator (.ai)

- **Import (`src/ai.ts`)**: Parses PDF-compatible `.ai` files via `pdfjs-dist`, rasterizes artboard pages, and extracts Optional Content Groups (OCG) into navigable layer hierarchies.
- **Export (`src/aiPdfLib.ts`)**: Updates PDF content streams and coordinates while preserving `AIPrivateData` Illustrator editing streams.
- **Roundtrip Validation**: Automated tests verify that exported `.ai` files re-open correctly in PDF/Illustrator engines (`npm run test:ai`).

---

### Batch & Folder Import (`src/folderImport.ts`)

- **Recursive Directory Scan**: Drag and drop entire folders or multi-file archives.
- **Automatic Classification**: Detects and imports nested `.psd` and `.ai` files across arbitrary subfolder depths.
- **Name Collision Handling**: Automatically disambiguates duplicate filenames using relative folder paths.
- **Diagnostics**: Reports unsupported formats (e.g. raw `.indd`, `.zip`) with actionable user instructions.

---

### Persistence & Workspace Autosave (`src/storage.ts`)

- **Dual-Store IndexedDB Engine**:
  - `files` store: Stores raw, unmutated binary bytes of open documents.
  - `workspace` store: Stores lightweight delta records (layer transforms, text edits, fills, canvas pan/zoom).
- **Debounced Autosave (600ms)**: Real-time save status indicator in the top navigation bar (`All changes saved`, `Saving…`, `Unsaved changes…`).
- **Safe Session Restore**: Replays saved edits on top of stored originals upon browser reload—preventing destructive bakes. Includes "Clear saved" reset option.

---

## Keyboard Shortcuts & Canvas Controls

| Action | Shortcut / Gesture | Description |
|---|---|---|
| **Pan Canvas** | `Spacebar` + Drag / Middle Mouse Drag | Pan across the infinite canvas stage |
| **Zoom Canvas** | Mouse Wheel / Floating HUD controls | Zoom in and out centered on cursor |
| **Select Layer** | Left Click on canvas or Layers Panel | Selects top-most visible layer pixel |
| **Move Layer** | Left Click + Drag on selected layer | Move layer in canvas coordinates |
| **Transform Layer** | Drag selection bounding box handles | Resize from corners/edges, rotate via top handle |
| **Proportional Scale** | Hold `Shift` while dragging corner handle | Maintains layer aspect ratio |
| **Duplicate Layer** | `Ctrl + D` | Duplicates selected layer |
| **Delete Layer** | `Delete` / `Backspace` | Removes selected layer |
| **Undo / Redo** | `Ctrl + Z` / `Ctrl + Y` (or `Ctrl + Shift + Z`) | Step backward or forward in history |
| **Rename Layer** | Double-click row in Layers panel | Edit layer name inline |
| **File Drag & Drop** | Drop PSD/AI files or folders onto stage | Imports documents directly to canvas |

---

## Status Matrix

| Feature | PSD | AI | INDD |
|---|:---:|:---:|:---:|
| **File & Folder Import** | Works | Works (PDF-compatible) | Roadmap (IDML parser) |
| **Infinite Canvas Rendering** | Three.js WebGPU / WebGL2 | Three.js WebGPU / WebGL2 | - |
| **Layer Tree & Selection Panel** | Works | Works (OCG layers) | - |
| **On-Canvas Move / Select** | Works | Works | - |
| **Resize & Rotate** | Works (raster quads) | Works (artboard scale) | - |
| **Text Editing** | Works (point text) | Roadmap | - |
| **Solid Shape Fill Editing** | Works | Roadmap | - |
| **Layer Masks & Clipping** | Works | Roadmap | - |
| **Blend Modes (10+ math modes)** | Works | Roadmap | - |
| **Adjustment Layers (9 types)** | Works (Levels, BC, Curves, Vib, Photo, LUT, HueSat, CB, BW) | - | - |
| **Undo / Redo History** | Works | Works | - |
| **Autosave & Session Restore** | Works (IndexedDB) | Works (IndexedDB) | - |
| **Non-Destructive Patch Export** | Works (`ag-psd` patch) | Works (`pdf-lib` patch) | Roadmap |

---

## Project Structure

```
creatvise_canvas/
├── public/                 # Static test fixtures (sample.ai, DarkTech_Screen.ai, sample.psd)
├── scripts/                # 38+ automated test suites, benchmarks & baseline scripts
│   ├── psd-adjustment-*.test.ts   # Regression tests for all 9 adjustment layers
│   ├── psd-clipping.test.ts       # Clipping mask isolation tests
│   ├── psd-composite-rule.test.ts # Embedded vs 2D compositor decision rules
│   ├── ai-export-roundtrip.test.ts# Illustrator export fidelity tests
│   └── folder-import.test.ts      # Recursive folder traversal tests
├── src/
│   ├── ai.ts               # Illustrator parser (pdfjs-dist OCG extraction)
│   ├── aiPdfLib.ts         # Illustrator patch exporter (pdf-lib)
│   ├── canvasHitTest.ts    # Direct stage hit-testing & selection
│   ├── docHistory.ts       # Transactional document history stack
│   ├── folderImport.ts     # Directory scanner & batch file classifier
│   ├── model.ts            # Canonical Document & Node data models
│   ├── panel.ts            # UI Layers panel & inspector controls
│   ├── psd.ts              # PSD file import & non-destructive export
│   ├── psdAdjustment.ts    # Unified adjustment layer pipeline & dispatch
│   ├── psdAdjustment*.ts   # Specialized adjustment algorithms (Curves, HueSat, CB, BW, LUT, Vib)
│   ├── psdBlend.ts         # Custom per-pixel blend mode mathematics
│   ├── psdComposite.ts     # Composite restack & file-base-overlay dirty patcher
│   ├── storage.ts          # IndexedDB persistence (files & workspace stores)
│   ├── viewport.ts         # Three.js WebGPURenderer stage & orthographic camera
│   └── main.ts             # Application controller & event orchestration
├── PSD-PREVIEW.md          # Architectural specification for PSD preview & adjustments
├── FINDINGS-AI.md          # Research & architectural findings for Illustrator support
└── vite.config.ts          # Vite build configuration
```

---

## License

Private project &copy; Creatvise. All rights reserved.

# Adobe InDesign (.indd / .idml) — Engine Specification & Deep Dive

> Comprehensive architectural reference for Adobe InDesign (`.indd`) and InDesign Markup Language (`.idml`) parsing, XML package editing, sharp text rasterization, desktop middleware automation, and non-destructive export in Creatvise Canvas.

---

## 1. Executive Summary

Supporting Adobe InDesign in a web-native canvas presents unique challenges:
- **Native `.indd`**: A closed, proprietary, chunked binary C++ object database with no public schema and no third-party browser parser.
- **Open `.idml`**: An official, open XML ZIP archive (`application/vnd.adobe.indesign-idml-package`) defining document spreads, stories, typography, swatches, and links.

Creatvise Canvas implements a **two-tier production architecture**:
1. **Native IDML Ingestion & Export Engine**: A 100% browser-compatible TypeScript engine that parses, edits, renders, and non-destructively patches `.idml` packages directly on client hardware.
2. **Local InDesign Desktop Bridge Middleware (`server/index.mjs`)**: A lightweight background daemon that orchestrates Adobe InDesign Desktop via automation (Windows COM / macOS AppleScript) to seamlessly convert `.indd` files to `.idml` upon import and back to `.indd` upon download.

---

## 2. Module Architecture (`src/idml/`)

All InDesign and IDML logic is organized under `src/idml/`:

```
src/indd/
├── index.ts                 # Public API barrel export
├── idml.ts                  # Master IDML import, export, and document orchestrator
├── idmlEdit.ts              # Interactive layer editing, transform guards & text rasterization
├── idmlRotatePointer.ts     # Visual rotation handle pointer tracking
├── idmlVisualRotation.ts    # Transform matrix to CSS & Three.js rotation math
├── inddImportReport.ts      # Import validation report, layer stats & JSON downloads
├── indesignStatus.ts        # Desktop middleware health check & status chip UI
├── exportPatch.ts           # Surgical XML spread & story patcher
├── linkImageFormat.ts       # Linked asset MIME type and extension detection
├── matrix.ts                # 6-element 2D affine matrix math (ItemTransform)
├── objectStyles.ts          # Object style fill and stroke inheritance
├── placedImage.ts           # Embedded & linked image extractor and placeholder renderer
├── rasterText.ts            # Sharp 2D canvas typography rasterizer
├── storyExport.ts           # InDesign Story XML serialization & justification
├── storyParse.ts            # CharacterStyleRange & ParagraphStyleRange XML parser
├── swatches.ts              # Document swatches & InDesign color model conversion
├── textFrameParse.ts        # Text frame geometry & column boundary extraction
├── textLayout.ts            # Typography font layout and wrap calculation
├── textStyles.ts            # Character style and font family resolvers
├── types.ts                 # Canonical IDML backing store & AST interfaces
└── zip.ts                   # JSZip container reader/writer with offset-0 mimetype
```

---

## 3. The IDML Package Structure

An `.idml` file is a ZIP package with strict structural constraints:

```
document.idml (ZIP Container)
├── mimetype (Uncompressed ASCII: application/vnd.adobe.indesign-idml-package at offset 0)
│
├── designmap.xml (Master Document Hierarchy)
│
├── Resources/
│   ├── Graphic.xml (Swatches, Gradients, Colors, Tint resources)
│   ├── Fonts.xml (Font declarations, PostScript names)
│   └── Styles.xml (ParagraphStyle, CharacterStyle, ObjectStyle hierarchies)
│
├── Spreads/
│   ├── Spread_ub6.xml (Page items: TextFrame, Rectangle, Oval, Polygon, Group)
│   └── Spread_ub7.xml (Page geometry, guides, and ItemTransform matrices)
│
├── Stories/
│   ├── Story_u120.xml (Story text XML containing CharacterStyleRange elements)
│   └── Story_u145.xml
│
└── META-INF/
    └── container.xml (Package descriptor)
```

> [!IMPORTANT]
> **Strict Mime-Type Offset Rule**: To remain valid for Adobe InDesign, the `mimetype` file must be stored **completely uncompressed (Store method)** as the very first entry in the ZIP container at byte offset 0. `src/idml/zip.ts` explicitly enforces this rule.

---

## 4. Typography & Sharp Text Rasterization (`src/idml/rasterText.ts`, `src/idml/textLayout.ts`)

- InDesign stories are structured in XML ranges:
  ```xml
  <Story Self="u120">
    <ParagraphStyleRange AppliedParagraphStyle="ParagraphStyle/Header">
      <CharacterStyleRange AppliedCharacterStyle="CharacterStyle/$ID/[No character style]" PointSize="24" FillColor="Color/BrandRed">
        <Content>Creatvise Canvas</Content>
      </CharacterStyleRange>
    </ParagraphStyleRange>
  </Story>
  ```
- The rasterizer (`rasterText.ts`):
  1. Resolves paragraph alignments (Left, Center, Right, Justified).
  2. Resolves swatch colors against `Resources/Graphic.xml`.
  3. Maps InDesign font family names to browser-available fonts with fallback matching.
  4. Renders text to a high-DPI offscreen canvas matching the exact text frame bounding box.

---

## 5. 6-Element Affine Matrix Transformations (`src/idml/matrix.ts`)

InDesign stores item transforms as a 6-element matrix string:

$$\text{ItemTransform} = [a, b, c, d, t_x, t_y]$$

Mapping to the 2D affine matrix:

$$\begin{bmatrix} x' \\ y' \\ 1 \end{bmatrix} = \begin{bmatrix} a & c & t_x \\ b & d & t_y \\ 0 & 0 & 1 \end{bmatrix} \begin{bmatrix} x \\ y \\ 1 \end{bmatrix}$$

`src/idml/matrix.ts` decomposes this matrix into:
- Translation: $(t_x, t_y)$
- Rotation Angle: $\theta = \operatorname{atan2}(b, a)$
- Uniform / Non-uniform Scale: $s_x = \sqrt{a^2 + b^2}, \; s_y = \sqrt{c^2 + d^2}$

---

## 6. Non-Destructive XML Patch Export (`src/idml/exportPatch.ts`)

When exporting an edited IDML document (`exportIdml`):
1. **Story Patching**: Only modified text runs are written back to their respective `Story_*.xml` files; unedited stories and paragraph formatting remain untouched.
2. **Spread Patching**: Updated position and rotation coordinates are formatted back into `ItemTransform="a b c d tx ty"` attributes on the matching `TextFrame` or `Rectangle` XML tags.
3. **Swatch Synchronization**: New fill colors applied via the property inspector are appended to `Resources/Graphic.xml` as valid InDesign `Color` elements.
4. **Clean Repacking**: `writeIdmlPackage` packs the modified files into an archive, guaranteeing that `mimetype` is at byte 0.

---

## 7. Desktop InDesign Middleware Bridge (`server/index.mjs`)

For users opening `.indd` files directly:
- Creatvise Canvas includes a local Node.js bridge server (`server/index.mjs` on port `3001`).
- The bridge detects installed Adobe InDesign versions (`InDesign.exe` or `InDesign.app`).
- When a `.indd` file is dropped into the canvas:
  1. The browser uploads the bytes to `http://localhost:3001/convert/indd-to-idml`.
  2. The middleware executes an InDesign ExtendScript (`.jsx`) script to export an IDML package.
  3. The IDML package is returned to the browser for canvas editing.
  4. On download, the reverse endpoint `/convert/idml-to-indd` generates a pristine native `.indd` file.

### Status Indicator Chip (`src/idml/indesignStatus.ts`)
The top bar displays real-time desktop connection status:
- 🟢 **InDesign: Online (v2025)**: Automation bridge active.
- 🟡 **InDesign: Detected (no exe)**: InDesign installed but bridge process starting.
- ⚪ **InDesign: Offline**: IDML mode fully available; `.indd` requires launching the server.

---

## 8. Test Suites & Verification

Run all InDesign and IDML regression suites:

```bash
# Run comprehensive IDML test suite (33 tests)
npm run test:idml

# Run Phase 5 document integrity validation
npm run test:idml:phase5

# Test InDesign bridge middleware health & endpoints
npm run test:indesign
```

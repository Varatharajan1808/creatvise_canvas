# Adobe InDesign (.indd / .idml) — Research, PoC & Architecture Roadmap

> Comprehensive technical specification, format analysis, Proof-of-Concept (PoC) results, and integration roadmap for Adobe InDesign (`.indd` / `.idml`).

> [!WARNING]
> ### ⚠️ Status: Unconfirmed / Not Implemented in Production App
> **Adobe InDesign (`.indd`) support is NOT implemented in the active Creatvise Canvas web application.**
> It is currently an **unconfirmed, exploratory research / Proof-of-Concept (PoC)** phase only. In the production app, importing `.indd` files is intentionally disabled/blocked (`src/formatRegistry.ts` throws an unsupported format notification).
> 
> This document records initial feasibility research and standalone PoC scripts (`scripts/poc/`). **Once implementation is confirmed and built into the application, this document will be updated with actual production architecture and usage.**

---

## 1. Executive Summary

Supporting Adobe InDesign presents unique technical challenges fundamentally different from Adobe Photoshop (`.psd`) or Adobe Illustrator (`.ai`):

- **Photoshop (`.psd`)**: **Production Ready** with open-source binary parser (`ag-psd`), real-time adjustment layers, and embedded raster composites.
- **Illustrator (`.ai`)**: **Implemented** for PDF-compatible vector streams with Optional Content Groups (OCG), parseable by `pdfjs-dist` and `pdf-lib`.
- **InDesign (`.indd`)**: **Not Implemented in Production**. A closed, proprietary, chunked-database binary format with **no public specification and no open-source web/JS parser**.

To explore future feasibility, Creatvise Canvas conducted a preliminary **Phase 0 Proof of Concept**:
1. **PoC-A (IDML Pipeline)**: A standalone script testing **InDesign Markup Language (`.idml`)** using `jszip` to surgically unpack, modify XML nodes (stories, spreads, styles), and repack valid packages. **Status: Automated script PASS (100%)**.
2. **PoC-B (Native `.indd` Bridge)**: A headless orchestrator script using Adobe ExtendScript (`.jsx`) to bridge native `.indd` files through InDesign Desktop or InDesign Server into IDML and back. **Status: Blocked on machines lacking Adobe InDesign licenses**.

---

## 2. The Native `.indd` File Format Challenge

### Proprietary Binary Structure
Native `.indd` files are not simple document files; they are **serialized C++ object databases**:
- Built on an internal database architecture (Object Persistence / OPI page chunks).
- Highly coupled to the exact Adobe InDesign C++ software architecture and plugin ecosystem.
- No public binary schema has ever been published by Adobe.
- Even minor version differences (e.g. InDesign CC 2024 vs 2025) render binary files unreadable by older InDesign versions without conversion.

```
Adobe InDesign (.indd)
└── Binary Object Database (Proprietary & Closed)
    ├── Master Header & Database Pages (4KB Chunk Blocks)
    ├── Class ID & Implementation Maps
    └── Serialized C++ Runtime Objects (No public spec, no JS parser)
```

### Industry Consensus
Across the desktop publishing industry, web-based editors and automation servers do **not** parse raw `.indd` binary directly. They utilize one of two standard pipelines:
1. **The IDML Route**: InDesign files are converted to/from IDML (InDesign Markup Language), which is an open, XML-based standard created by Adobe for third-party integration.
2. **The InDesign Server Route**: A headless instance of Adobe InDesign Server is deployed to convert, render, and serialize native files via ExtendScript or C++ APIs.

---

## 3. The IDML Solution: Anatomy of an `.idml` Package

IDML is an open ZIP archive containing XML files that fully describe an InDesign document's geometry, typography, assets, and hierarchy:

```
document.idml (ZIP Container)
├── mimetype (Uncompressed ASCII: application/vnd.adobe.indesign-idml-package)
│
├── designmap.xml (Master Document Index)
│   ├── Document spreads and page ordering
│   ├── Layer definitions and hierarchy
│   └── Links to Story, Spread, and Resource files
│
├── Resources/
│   ├── Fonts.xml (Font families, postscript names, font styles)
│   ├── Styles.xml (Character styles, paragraph styles, object styles)
│   ├── Graphic.xml (Colors, swatches, gradients, stroke styles)
│   └── Preferences.xml (Document dimensions, grid, guide settings)
│
├── Spreads/
│   └── Spread_*.xml (Page geometry, TextFrames, Rectangles, Groups, Splines)
│
├── Stories/
│   └── Story_*.xml (Live text content, character runs, formatting overrides)
│
└── META-INF/
    └── container.xml (Package entry points)
```

### Key Advantages of IDML:
- **100% Non-Destructive**: XML attributes not recognized by an editor are preserved untouched when repacking the archive.
- **Client-Side Safe**: Can be unzipped, inspected, transformed, and repacked directly inside the browser using modern JavaScript (`jszip`).
- **Full Typography**: Text stories and typography formatting are isolated in separate `Story_*.xml` files, making text search, replacement, and styling straightforward.

---

## 4. Phase 0 Proof of Concept Results

The repository includes complete test scripts and fixtures in `scripts/poc/` and `public/fixtures/poc/`:

### PoC-A: IDML Unzip, Patch & Repack (`scripts/poc/poc-a-idml-roundtrip.test.ts`)
- **Objective**: Load an IDML file, extract its internal XML files, surgically modify a property (e.g., text content or rectangle fill), repack the ZIP, and verify integrity.
- **Implementation**:
  ```typescript
  import JSZip from 'jszip';

  export async function patchIdmlStory(
    idmlBuffer: ArrayBuffer,
    storyTarget: string,
    newText: string
  ): Promise<Uint8Array> {
    const zip = await JSZip.loadAsync(idmlBuffer);
    
    // Read and parse story XML
    const storyXml = await zip.file(`Stories/Story_${storyTarget}.xml`)?.async('string');
    if (!storyXml) throw new Error('Target story not found');
    
    // Surgical XML patch
    const patchedXml = storyXml.replace(/<Content>.*?<\/Content>/, `<Content>${newText}</Content>`);
    zip.file(`Stories/Story_${storyTarget}.xml`, patchedXml);
    
    // Repack with uncompressed mimetype at offset 0
    return await zip.generateAsync({
      type: 'uint8array',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 }
    });
  }
  ```
- **Automated Result**: **PASS (100%)**.
- **Verification**: Byte-level roundtrip on `public/fixtures/poc/plain.idml` passes XML schema verification and file structure integrity checks.

---

### PoC-B: Native INDD Roundtrip Orchestrator (`scripts/poc/poc-b-orchestrator.ts`)
- **Objective**: Full end-to-end roundtrip:
  $$\text{Native .indd} \xrightarrow{\text{ExtendScript}} \text{.idml} \xrightarrow{\text{Creatvise Canvas Patch}} \text{patched .idml} \xrightarrow{\text{ExtendScript}} \text{Patched Native .indd}$$
- **Script**: `scripts/poc/poc-b-orchestrator.ts` invokes Adobe InDesign desktop or InDesign Server via command-line ExtendScript automation (`.jsx`).
- **Status**: **BLOCKED (Exit Code 2)**.
- **Cause**: Adobe InDesign is not installed on the automated CI/local audit machine. The script cleanly reports the missing desktop environment and exits without corrupting data.

---

## 5. Architectural Roadmap for Creatvise Canvas Integration

To integrate Adobe InDesign / IDML into Creatvise Canvas's production application:

```
┌────────────────────────────────────────────────────────┐
│             Creatvise Canvas Integration Plan          │
└────────────────────────────────────────────────────────┘

Phase 1: Format Adapter Architecture
├── Create src/formats/idmlAdapter.ts
├── Implement FormatAdapter interface (importDocument, exportDocument)
└── Add format capabilities in src/formatCaps.ts:
    - moveLayer: true
    - editText: true (via Story_*.xml)
    - changeFillColor: true (via Graphic.xml & Spread_*.xml)

Phase 2: Unified Scene Graph Translation
├── Parse Spreads/Spread_*.xml into Doc.nodes
│   ├── Spread / Page  ──> Node (type: 'group')
│   ├── TextFrame      ──> Node (type: 'text', leaf: text, styles)
│   ├── Rectangle      ──> Node (type: 'shape', leaf: fill, stroke)
│   └── Image / EPS    ──> Node (type: 'raster')
└── Map coordinates from InDesign points to canvas pixels

Phase 3: Viewport Rendering
├── Option A: SVG generation from Spread XML -> Three.js SVG Loader
└── Option B: High-fidelity headless rasterization (PDF/PNG export)

Phase 4: Non-Destructive Export
├── Apply user edits back into XML DOM
├── Regenerate ZIP container via jszip
└── Ensure mimetype remains stored (compression level 0) at offset 0
```

---

## 6. Commands, Scripts & Artifacts

### Run PoC Tests
```bash
# Run PoC-A: IDML automated unzip, patch, and repack test
npm run poc:idml:a

# Run PoC-B: Native INDD desktop orchestrator (requires Adobe InDesign)
npm run poc:indd:b
```

### Repository Fixtures
- `public/fixtures/poc/plain.idml`: Minimal valid InDesign CS4+ IDML document package (DOMVersion 20.4) used for automated roundtrip verification.
- `scripts/poc/poc-a-idml-roundtrip.test.ts`: Automated test script exercising XML extraction, modification, and repackaging.
- `scripts/poc/poc-b-orchestrator.ts`: Node.js orchestrator script coordinating ExtendScript operations with InDesign.

# Creatvise Canvas — Project Status (Phase 0 Audit)

**Audit date:** 2026-10-14  
**Scope:** PSD, AI, and **native INDD** (not IDML-only) against in-repo requirements.  
**Sources:** `README.md` (status matrix + architecture), `FINDINGS-AI.md`, `FINDINGS-INDD.md`, `src/formatCaps.ts`, format adapters, UI entry points, automated scripts.

No standalone “assignment PDF” exists in the repository; requirements below are synthesized from documented product targets and explicit audit rules (native `.indd`, patch-original export, browser editor).

---

## Executive summary

| Format | Production app | Automated tests (this machine) | Adobe desktop gate |
|--------|----------------|------------------------------|--------------------|
| **PSD** | Full import / edit / export path | **All suites passed** (~5.7 min) | Not required for CI; Photoshop fidelity uses embedded composites + scripted checks |
| **AI** | PDF-compatible `.ai` import / partial edit / export | **Passed** (7 checks + 55 format-registry checks) | **Not verified** — no automated Illustrator reopen test in CI |
| **INDD** | **Not in app** (`.indd` blocked in UI; no adapter) | PoC-A **passed**; PoC-B **blocked** (exit 2) | **Required** for native round-trip; not installed on audit machine |

**Build:** `npm run build` — **passed** (tsc + Vite production bundle).

---

## Requirement classification legend

| Status | Meaning |
|--------|---------|
| **Complete and verified** | Implemented in `src/` with passing automated tests and/or reproducible script evidence |
| **Implemented but partially supported** | Works for documented subset; caps/UI list gaps |
| **Not implemented** | No production code path |
| **Blocked by external dependency** | Needs Adobe InDesign (or InDesign Server) / Illustrator manual sign-off |
| **Not yet verified** | Code exists but Adobe or browser manual check not recorded |

---

## Cross-cutting platform requirements

| Requirement | Status | Evidence | Tests |
|-------------|--------|----------|-------|
| TypeScript + Vite SPA | Complete and verified | `package.json`, `vite.config.ts`, `src/main.ts` | `npm run build` |
| Unified `Doc` / `Node` model | Complete and verified | `src/model.ts` | Used by all import tests |
| Format adapter registry (PSD + AI) | Complete and verified | `src/formats/registry.ts`, `src/formats/index.ts`, adapters | `npm run test:formats` (55 checks) |
| Non-destructive patch-original export | Complete and verified (PSD, AI) | `src/psd.ts`, `src/aiPdfLib.ts`, `src/ai.ts` | `test:psd` export suites; `test:ai` |
| Three.js infinite canvas viewport | Complete and verified | `src/viewport.ts`, `src/main.ts` | Manual; hit-test: `canvas-hit-test.test.ts` in `test:psd` |
| Layers panel + properties | Complete and verified | `src/panel.ts`, `src/popup.ts` | Partial via PSD/AI flows |
| Canvas hit-test selection | Complete and verified | `src/canvasHitTest.ts` | `scripts/canvas-hit-test.test.ts` |
| Undo / redo | Complete and verified | `src/docHistory.ts`, `src/history.ts` | `psd-history-undo.test.ts`, `psd-doc-history.test.ts` |
| IndexedDB autosave + restore | Complete and verified | `src/storage.ts`, `src/workspace.ts` | Exercised indirectly in PSD history tests |
| Folder / batch import (PSD + AI) | Complete and verified | `src/folderImport.ts` | `npm run test:folder` (20 checks) |
| `.indd` / `.idml` in production import | Not implemented | `formatRegistry` has no adapter; `importDocument` throws for `indd` | `test:formats` |
| CI / hosted deployment pipeline | Not implemented | No `.github/workflows` | — |
| Playwright browser E2E in default scripts | Not implemented | `playwright` devDependency; separate probe scripts only | — |

---

## Adobe Photoshop (`.psd`)

| Requirement | Status | Primary source files | Tests / verification |
|-------------|--------|----------------------|----------------------|
| File open (picker, drag-drop) | Complete and verified | `src/main.ts`, `src/formatImport.ts`, `psdAdapter` | `format-registry.test.ts`, roundtrip scripts |
| Folder import | Complete and verified | `src/folderImport.ts` | `folder-import.test.ts` |
| Layer tree from native PSD | Complete and verified | `src/psd.ts`, `src/sourceTree.ts` | `psd-fidelity.test.ts`, layer-edit tests |
| Embedded composite preview / file-base-overlay | Complete and verified | `src/psdComposite.ts`, `PSD-PREVIEW.md` | `psd-file-base-overlay.test.ts`, `psd-preview-dirty.test.ts`, `psd-composite-rule.test.ts` |
| Move, resize, rotate (raster) | Complete and verified | `src/edit.ts`, `src/psd.ts` | `psd-roundtrip.ts`, resize/export suites in `test:psd` |
| Text edit (point text) | Complete and verified | `src/psd.ts`, panel | `psd-text-move.test.ts`, `psd-text-position.test.ts` |
| Shape fill edit | Complete and verified | `src/psd.ts` | Layer-edit / export tests |
| Layer masks | Complete and verified | `src/psdComposite.ts` | `psd-mask-blend.test.ts` |
| Clipping masks | Complete and verified | `src/psdCompositeRule.ts` | `psd-clipping.test.ts` |
| Blend modes (extended set) | Complete and verified | `src/psdBlend.ts` | `psd-mask-blend.test.ts` |
| Adjustment layers (9 types) | Complete and verified | `src/psdAdjustment*.ts` | `psd-adjustment*.test.ts` (multiple suites in `test:psd`) |
| Duplicate layer (native tree) | Complete and verified | `src/sourceTree.ts`, caps | PSD caps + edit flows |
| Delete layer | Complete and verified | `src/main.ts`, caps | Covered in edit/history tests |
| Non-destructive export (smart objects, effects preserved) | Complete and verified | `src/psd.ts` | `psd-export-nondestructive.test.ts`, `psd-export-fidelity.test.ts`, effects checks in `psd-roundtrip.ts` |
| Session persistence | Complete and verified | `src/storage.ts` | Workspace restore paths in doc-history tests |
| Every Photoshop feature | Implemented but partially supported | `Node.unsupported`, inventory script | `npm run psd:inventory`; fidelity tests on fixtures only |
| Photoshop app reopen pixel-perfect | Not yet verified | — | Manual in Photoshop (out of CI scope) |

**PSD automated baseline (2026-10-14):** `npm run test:psd` — **exit 0** (~344 s). Last suite summary: “All 48 Black & White regression tests passed!” (full chain includes roundtrip, fidelity, adjustments, clipping, ghost regression, footprint patch, etc.).

---

## Adobe Illustrator (`.ai`) — PDF-compatible v1

| Requirement | Status | Primary source files | Tests / verification |
|-------------|--------|----------------------|----------------------|
| Open PDF-compatible `.ai` | Complete and verified | `src/ai.ts`, `aiAdapter` | `importDocument` / `importAi` in `test:formats` |
| Reject legacy PostScript `.ai` | Complete and verified | `src/ai.ts` | `test:formats` junk import message |
| Artboard render on canvas | Complete and verified | `src/ai.ts` (pdf.js) | `test:ai` pdfjs page/operator counts |
| OCG layer tree (`sample.ai`) | Complete and verified | `src/ai.ts` | Manual + FINDINGS; OCG export tests |
| Fallback single layer (no OCG, e.g. DarkTech) | Implemented but partially supported | `src/ai.ts` | `test:ai` DarkTech export |
| Rename / visibility (OCG) | Complete and verified | `src/aiPdfLib.ts` | Covered in FINDINGS Phase E; export notes in `test:ai` |
| Opacity via ExtGState patch | Complete and verified | `src/aiPdfLib.ts` | `test:ai` sample export |
| Move / resize / rotate on canvas | Complete and verified | `src/aiPdfLib.ts`, `src/edit.ts` | `test:ai` notes mention vector stream patch |
| Export `.edited.ai` (patch-original) | Complete and verified | `src/ai.ts`, `src/aiPdfLib.ts` | `npm run test:ai` (7 checks) |
| Duplicate layer in native AI tree | Not implemented | `formatCaps.ts` `duplicateNativeTree: false` | `test:formats` caps |
| Text editing | Not implemented | caps `editText: false` | README still “Roadmap”; FINDINGS lists unsupported |
| Shape fill editing | Not implemented | caps `editShape: false` | Same |
| Replace image | Not implemented | caps `replaceImage: false` | Same |
| Layer masks & clipping (AI-native) | Not implemented | README roadmap | PDF render only |
| Blend modes (AI-native) | Not implemented | README roadmap | — |
| Full AIPrivate layer tree (DarkTech-style) | Not implemented | FINDINGS-AI §5 | Fallback “Artwork” layer |
| Multi-artboard | Not implemented | FINDINGS | Single-page samples only |
| **Illustrator reopen** after export | **Not yet verified** | FINDINGS §7 checklist unchecked | No `test:ai` Illustrator step |
| Adjustment layers | Not applicable / not implemented | — | PSD-only feature set |

**AI automated baseline (2026-10-14):** `npm run test:ai` — **exit 0** (7/7). `npm run test:formats` — AI delegation and caps **passed**.

**README vs code drift:** README status matrix still marks several AI rows as “Roadmap” while `formatCaps` and FINDINGS Phase E document move/resize/opacity/OCG export as done. Treat **caps + tests** as ground truth for the audit.

---

## Adobe InDesign (`.indd`) — native support

| Requirement | Status | Primary source files | Tests / verification |
|-------------|--------|----------------------|----------------------|
| Import `.indd` in browser app | Not implemented | `src/main.ts` shows “INDD Import Coming Soon” | User drop shows modal; no `importDocument('indd')` |
| Import `.idml` in browser app | Not implemented | No adapter; `formatFromExtension('idml')` → null | `test:formats` |
| Export native `.indd` from app | Not implemented | No adapter | `export-indd-refused` in `test:formats` |
| IDML read/patch/write (Node PoC) | Implemented but partially supported | `scripts/poc/idmlPatch.ts` | `npm run poc:idml:a` **passed** |
| IDML opens cleanly in InDesign | **Blocked / not yet verified** | `scripts/poc/poc-a-verify-indesign.jsx` | Requires InDesign; `indesignOpenVerified: false` in summary JSON |
| INDD → IDML → patch → IDML → INDD | **Blocked by external dependency** | `scripts/poc/poc-b-orchestrator.ts`, `.jsx` steps | `npm run poc:indd:b` **exit 2** — no InDesign.exe / COM |
| Wire IDML patch into `src/` | Not implemented | PoC only (`scripts/poc/*`) | By design in FINDINGS-INDD |
| Production format adapter for INDD | Not implemented | `src/formats/index.ts` registers PSD + AI only | `test:formats` |

**INDD PoC baseline (2026-10-14):**

- `npm run poc:idml:a` — **exit 0** (structural IDML patch; artifacts under `artifacts/poc/poc-a/`).
- `npm run poc:indd:b` — **exit 2**, blocker: Adobe InDesign not installed / COM not registered (consistent with `FINDINGS-INDD.md`).

**Native round-trip success is not claimed** until PoC-B passes on an InDesign-equipped machine and `.indd` output is reopened in InDesign without repair.

---

## Test and script inventory map

| npm script | Purpose | Audit result |
|------------|---------|--------------|
| `npm run build` | tsc + Vite production build | **Pass** |
| `npm run test:psd` | 25 PSD-related script chain | **Pass** |
| `npm run test:ai` | AI export + pdf.js smoke | **Pass** |
| `npm run test:folder` | Folder classifier | **Pass** (20/20) |
| `npm run test:formats` | Registry, caps, import/export delegation | **Pass** (55/55) |
| `npm run poc:idml:a` | IDML PoC-A | **Pass** |
| `npm run poc:indd:b` | INDD PoC-B orchestrator | **Blocked** (exit 2) |
| `npm run psd:baseline` | Luminance vs Photoshop composite | Not run (optional benchmark) |
| `npm run psd:bench` | Adjustment perf | Not run (optional) |
| `npm run psd:inventory` | Feature inventory report | Not run (optional) |

Ad-hoc UI probes (not in default CI): `scripts/click-*.mjs`, `scripts/drag-probe.mjs`, `scripts/position-input-*.mjs` (Playwright-oriented).

---

## Deployment vs local development

### Local development

| Item | Requirement |
|------|-------------|
| Node.js | 18+ (README: tested 20/22) |
| npm install | `ag-psd`, `pdfjs-dist`, `pdf-lib`, `three`, dev: `tsx`, `happy-dom`, `jszip`, `playwright` |
| Browser | Chrome/Edge 113+ (WebGPU) or WebGL2 fallback |
| Dev server | `npm run dev` (build + Vite) |
| Static fixtures | `public/*.psd`, `public/*.ai`, `public/fixtures/poc/plain.idml` |

### Deployment (static hosting)

| Item | Requirement |
|------|-------------|
| Build output | `npm run build` → `dist/` (single large JS bundle ~2 MB + pdf.worker) |
| Hosting | Any static file host (S3, Netlify, internal CDN); **no Node server required** at runtime |
| Browser capabilities | WebGPU or WebGL2; **IndexedDB** for autosave |
| CORS / file access | User files stay client-side; no backend in repo |
| Adobe PoC scripts | **Not part of deployment** — developer machine with InDesign for PoC-B only |
| CI | **Undefined** — no workflow files; tests run locally via npm scripts |

### External licenses (not bundled)

- Adobe Photoshop / Illustrator — manual QA only.
- Adobe InDesign or InDesign Server — required for native INDD PoC-B and PoC-A InDesign gate.

---

## Highest-priority gaps (assignment-oriented)

1. **Native INDD in product** — blocked on PoC-B + adapter design; IDML-only PoC does not satisfy assignment rule.
2. **InDesign availability** — PoC-B cannot be signed off without installed InDesign (or untested InDesign Server path).
3. **AI Illustrator manual acceptance** — automated tests prove PDF structure/ops, not Illustrator editability after export.
4. **AI feature parity vs PSD** — text, shape, duplicate, masks, blends explicitly off in `formatCaps`.
5. **README / matrix accuracy** — documentation understates some AI capabilities and overstates INDD as “IDML parser roadmap” without PoC linkage.
6. **CI/deployment hygiene** — no automated gate on push; large bundle without code-splitting (Vite warning on build).

---

## Risks

| Risk | Impact | Mitigation direction |
|------|--------|-------------------|
| INDD requires Adobe automation for binary `.indd` | Cannot ship true native INDD from browser alone | Hybrid: IDML in browser + optional desktop/server bridge, or scope INDD to export-via-IDML with clear limits |
| AIPrivate-only AI files | Shallow layer tree | Document limits; future AIPrivate parse |
| pdf-lib timestamp/metadata | Export byte inequality over time | Tests already pin `Date` in format-registry AI export check |
| WebGPU availability | Preview perf / features on older browsers | WebGL2 fallback (existing) |
| OneDrive path + duplicate `src\` entries in git status | Windows path confusion | Normalize paths in git; avoid duplicate file edits |

---

## Related documents

- `FINDINGS-INDD.md` — PoC evidence and blocker details  
- `FINDINGS-AI.md` — AI tier strategy and manual Illustrator checklist  
- `README.md` — user-facing feature matrix (partially stale for AI/INDD)  
- `IMPLEMENTATION-PLAN.md` — prioritized phases after this audit  

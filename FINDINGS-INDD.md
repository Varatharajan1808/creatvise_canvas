# INDD / IDML — Phase 0 Proof of Concept

**Project:** Creatvise Canvas  
**Date:** 2026-10-14  
**Scope:** PoC scripts only (`scripts/poc/*`). Production PSD/AI pipelines unchanged.

---

## Executive summary

| PoC | Goal | Automated result (this machine) | Adobe InDesign gate |
|-----|------|--------------------------------|---------------------|
| **PoC-A** | IDML → patch one property → IDML | **PASS** | **NOT VERIFIED** — InDesign not installed |
| **PoC-B** | INDD → IDML → patch → IDML → INDD | **BLOCKED** | **NOT RUN** — InDesign not installed |

**Native `.indd` support is not claimed.** PoC-B did not complete; only an **IDML-only** automated proof (PoC-A) ran successfully.

---

## Required software

### Always (PoC-A)

| Item | Version / notes |
|------|-----------------|
| Node.js | 18+ (run used Node via project `npm` scripts) |
| npm dependencies | `jszip` (devDependency), `tsx` (dev) |
| Fixture | `public/fixtures/poc/plain.idml` |

### PoC-A sign-off (manual)

| Item | Notes |
|------|--------|
| **Adobe InDesign** | Any IDML-capable build (CS4+; fixture DOMVersion 20.4) |
| License | Valid Adobe InDesign or Creative Cloud subscription (not included in repo) |

### PoC-B (full INDD round trip)

| Item | Notes |
|------|--------|
| **Adobe InDesign** (desktop) | Used by ExtendScript `.jsx` steps and orchestrator |
| **InDesign Server** | Optional alternative to desktop for headless automation (not tested here; same scripting API) |
| License | InDesign desktop (CC) or **InDesign Server** subscription — separate product |

---

## Dependencies added (PoC only)

```json
"devDependencies": {
  "jszip": "^3.x"
}
```

No changes to production `src/` import/export paths.

---

## Fixture files

| Path | Description |
|------|-------------|
| `public/fixtures/poc/plain.idml` | Minimal valid IDML from [dimelords/idmllib testdata](https://github.com/dimelords/idmllib/blob/main/testdata/plain.idml) (~33 KB) |
| `public/fixtures/poc/README.md` | Provenance |

**Patch target (PoC):** `TextFrame` `Self="uf3"` in `Spreads/Spread_ud3.xml`, property **`ItemTransform`** (6-number affine matrix). Translation delta: **+20** pt X, **+15** pt Y.

---

## Commands

From repository root:

```bash
# Install deps (includes jszip)
npm install

# PoC-A — automated IDML patch + structure checks
npm run poc:idml:a

# PoC-B — full INDD round trip (requires InDesign installed)
npm run poc:indd:b
```

### PoC-A — Adobe manual verification (when InDesign is available)

1. Run `npm run poc:idml:a` (creates `artifacts/poc/poc-a/plain.edited.idml`).
2. Copy `scripts/poc/poc-a-verify-indesign.jsx` into InDesign **Scripts Panel → User**, or run from `scripts/poc/`.
3. Open the script from InDesign after the npm step.
4. Inspect `artifacts/poc/poc-a/indesign-open-result.txt` for `INDESIGN_OPEN_RESULT=PASS` or `FAIL_*`.

### PoC-B — flow when InDesign is available

Orchestrator (`npm run poc:indd:b`):

1. **Step 1** (`poc-b-step1-indd-to-idml.jsx`): Open `plain.idml` or existing `plain.indd` → save/use INDD → export `step1-exported.idml`.
2. **Step 2** (Node): Patch `ItemTransform` → `step2-edited.idml`.
3. **Step 3** (`poc-b-step3-idml-to-indd.jsx`): Open edited IDML → save `step3-roundtrip.indd` → re-export `step3-reexport.idml`.

Logs: `artifacts/poc/poc-b/poc-b-step1.log`, `poc-b-step3.log`. Summary: `artifacts/poc/poc-b/poc-b-summary.json`.

---

## Evidence — PoC-A (2026-10-14, Windows)

**Command:** `npm run poc:idml:a`  
**Exit code:** `0`

```
OK: fixture-present — ...\public\fixtures\poc\plain.idml
OK: fixture-zip-magic — bytes=33154
OK: fixture-structure — spreads=1
OK: patch-item-transform — uf3 1 0 0 1 250.8661417322835 -259.3700787401575 → 1 0 0 1 270.8661417322835 -244.3700787401575
OK: write-artifacts — ...\artifacts\poc\poc-a\plain.edited.idml
OK: edited-structure — spreads=1
OK: bytes-changed — original=33154 edited=33713
```

**Machine-readable summary:** `artifacts/poc/poc-a/poc-a-summary.json` ( `"pass": true`, `"indesignOpenVerified": false` ).

**What was verified without Adobe:**

- ZIP / IDML package structure (`mimetype`, `designmap.xml`, `Spreads/*.xml`).
- Exactly one bounded edit applied to the intended TextFrame.
- Re-packed IDML passes the same structural validator.

**What was not verified:**

- InDesign opens `plain.edited.idml` without repair dialog (no InDesign on runner).

**PoC-A Adobe gate:** **PENDING / BLOCKED on CI runner** — treat as **IDML-only PoC complete**, full PoC-A **incomplete** until `poc-a-verify-indesign.jsx` reports `PASS`.

---

## Evidence — PoC-B (2026-10-14, Windows)

**Command:** `npm run poc:indd:b`  
**Exit code:** `2` (blocked)

```
FAIL: indesign-exe — InDesign.exe not found under Program Files or PATH
FAIL: indesign-com — Retrieving the COM class factory for component with CLSID {00000000-0000-0000-0000-000000000000} failed due to the following error: 80040154 Class not registered (Exception from HRESULT: 0x80040154 (REGDB_E_CLASSNOTREG)).
PoC-B BLOCKED: Adobe InDesign not installed or not COM-automation accessible on this machine
```

**Checks performed:**

- Scan `Program Files`, `Program Files (x86)`, `%LOCALAPPDATA%\Adobe` for `Adobe InDesign */InDesign.exe` — **none**.
- `where.exe InDesign.exe` — **not found**.
- Windows COM `InDesign.Application` — **REGDB_E_CLASSNOTREG** (class not registered).

**Machine-readable summary:** `artifacts/poc/poc-b/poc-b-summary.json` — `"nativeInddSupported": false`, `"blocker"` set.

**PoC-B result:** **NOT PASSED** — no INDD → IDML → INDD round trip was executed.

---

## Implementation map (PoC-only)

| File | Role |
|------|------|
| `scripts/poc/idmlPatch.ts` | Load IDML (ZIP), patch `ItemTransform`, re-pack with stored `mimetype` |
| `scripts/poc/poc-a-idml-roundtrip.test.ts` | PoC-A automated runner |
| `scripts/poc/poc-a-verify-indesign.jsx` | PoC-A InDesign open check |
| `scripts/poc/poc-b-step1-indd-to-idml.jsx` | Adobe: INDD + export IDML |
| `scripts/poc/poc-b-step3-idml-to-indd.jsx` | Adobe: save INDD from edited IDML |
| `scripts/poc/poc-b-orchestrator.ts` | PoC-B Node driver |
| `scripts/poc/findIndesign.ts` | Locate InDesign / COM probe |

Artifacts under `artifacts/poc/` are gitignored; re-run npm scripts to regenerate.

---

## Conclusions for product direction

1. **IDML edit loop in Node/browser is plausible** — PoC-A automated path succeeded on a real fixture.
2. **Native INDD import/export cannot be validated without Adobe** — PoC-B blocked on this environment.
3. **Do not enable `.indd` in production UI** until PoC-B passes on a machine with InDesign (or licensed InDesign Server) and manual/visual sign-off is recorded.
4. **Recommended next step when Adobe is available:** Re-run `npm run poc:indd:b`, then `poc-a-verify-indesign.jsx`, append results to this document with InDesign version and screenshots or log excerpts.

---

## Licensing notes (informational)

- **Adobe InDesign / InDesign Server:** Commercial Adobe licenses; not redistributable with this repo.
- **Fixture `plain.idml`:** Third-party test data; confirm license in [idmllib](https://github.com/dimelords/idmllib) before redistribution beyond current test use.

# Preparing a real Illustrator live-text fixture

Use this file when validating **AI live-text import, edit, and export** against a genuine Adobe Illustrator document.  
The synthetic file `live-text-synthetic.ai` exercises the code path only; it does **not** prove Illustrator or AIPrivateData compatibility.

## Save steps (Adobe Illustrator)

1. Create a small artboard (e.g. 400×300 pt).
2. Add **point text** with the Type tool (single line of **Latin** characters, e.g. `Hello Fixture`).
3. Set a **solid fill** (avoid gradients/patterns on the text).
4. Do **not** use **Create Outlines** — text must stay live.
5. Optional but helpful: one named layer (creates PDF optional content groups in many saves).
6. **File → Save As → Illustrator (.ai)**.
7. Enable **Create PDF Compatible File** (required for this editor).
8. Save as:

   `public/fixtures/ai/illustrator-live-text.ai`

9. Run the audit:

   ```bash
   npx tsx scripts/ai-live-text-fixture-audit.ts
   ```

   Look for `fixtureClass: "illustrator-live-text-ready"` and `supportedLiveRuns` ≥ 1.

## Parser requirements (current implementation)

The importer reads **page 1** only, decompresses the page **Contents** stream, and detects live text as follows.

### Required for detection (Phase A)

| Requirement | Detail |
|-------------|--------|
| PDF header | File must start with `%PDF-` (PDF-compatible `.ai`). |
| Live text operators | `BT` … `ET` block containing `Tf`, `Tm` and/or `Td`, and `(…) Tj` or `[…] TJ`. |
| Marked content | Prefer `/OC /MCn BDC` … `EMC`. If the file has **no** MC blocks but has `BT`, the whole stream is treated as MC index `0`. |
| Text-only block | The MC body must **not** also contain path paint (`re`, `f`, `S`, `m`, `l`, `c`, …), images (`Do`), or Bézier curves. Mixed blocks are **rejected** (no editable runs). |
| Outlined text | Path-only artwork with **no** `BT` is **not** live text (common in `sample.ai`). |

### Supported for editing + export (Phases B–C)

| Supported | Not supported (preview-only or blocked) |
|-----------|----------------------------------------|
| Literal string show: `(Hello) Tj` | Hex strings: `<48656C6C6F> Tj` (export blocked) |
| Content edits + re-export via pdf-lib | `TJ` kerning arrays (export blocked) |
| Non-stroking fill: `r g b rg` in the same text block | Font/size/bold/italic/alignment changes in PDF (`Tf` not patched) |
| WinAnsi literal characters in exported strings | Code points outside 8-bit literal range |
| Multiple horizontal runs in one text-only MC (overlay preview) | Rotated/skewed text matrix (editable; overlay preview) |

### What the audit script checks

- **`synthetic`**: Built by tests (`live-text-synthetic.ai`, `simple-shapes.ai`) — not Illustrator proof.
- **`illustrator-pdf`**: PDF-compatible `.ai` with Illustrator/AIPrivate signals but **zero** supported live runs on page 1 (e.g. outlined text).
- **`illustrator-live-text-ready`**: Non-synthetic file with ≥ 1 supported live run on page 1 — candidate for real round-trip validation.

Passing the audit does **not** guarantee Illustrator desktop will match the PDF stream (AIPrivateData may differ). Desktop visual check is a separate step.

## Verification checklist (after adding the file)

1. `npx tsx scripts/ai-live-text-fixture-audit.ts` → `illustrator-live-text-ready`.
2. Import in the app → properties panel shows **Text Properties** (not “not available for .ai”).
3. Edit string → export → decompress stream contains the new `(…) Tj` literal.
4. Re-import exported file → parser reads the edited string from the stream.
5. Optionally open the exported `.ai` in Illustrator and compare text vs unrelated artwork (manual).

Do not commit a hand-built PDF renamed to `.ai` as a substitute for Illustrator output.

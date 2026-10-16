# Phase 6f — Nested OCG Order spike

Generated: 2026-10-15T12:22:55.454Z

## Programmatic readback

| Check | Result |
|-------|--------|
| Nested `/Order` shape | `group(RedSquare,GreenSquare);BlueSquare` |
| OCG catalog (names/refs) | RedSquare, GreenSquare, BlueSquare — refs 5 0 R, 6 0 R, 7 0 R |
| MC block count | 3 (unchanged: true) |
| Content stream identical | true |

## Test assertions

- PASS **baseline-three-ocgs**: RedSquare,GreenSquare,BlueSquare
- PASS **baseline-mc-count**: 3
- PASS **baseline-mc-max**: 2
- PASS **baseline-ocg-refs-unique**: 5 0 R,6 0 R,7 0 R
- PASS **nested-order-shape**: group(RedSquare,GreenSquare);BlueSquare
- PASS **ocg-catalog-unchanged**: names RedSquare,GreenSquare,BlueSquare refs 5 0 R,6 0 R,7 0 R
- PASS **ocg-refs-still-unique**: 5 0 R,6 0 R,7 0 R
- PASS **mc-count-unchanged**: 3
- PASS **mc-max-unchanged**: 2
- PASS **content-stream-byte-identical**: 196 vs 196
- PASS **mc-identifiers-present**: 
- PASS **mc-block-0-unchanged**: MC0
- PASS **mc-block-1-unchanged**: MC1
- PASS **mc-block-2-unchanged**: MC2
- PASS **properties-mc-refs-unchanged**: 5 0 R,6 0 R,7 0 R vs 5 0 R,6 0 R,7 0 R

## External applications

- **Adobe Illustrator:** not detected on this machine
- **Adobe Acrobat:** not detected on this machine
- **Nested sample file:** `scripts\poc\output\three-ocg-nested-order.ai`
- **External UI verification:** not performed (apps missing, `SKIP_ADOBE_OPEN=1`, or launch failed). Do not infer Illustrator/Acrobat compatibility from pdf-lib readback alone.

## Recommendation (Phase 6g)

**Proceed to Phase 6g (import)** with the scope limited to PDF OCG `/Order` hierarchy: programmatic round-trip shows pdf-lib can write nested `/Order` arrays while leaving MC streams and `/OCGs` refs intact. Production import must parse nested `/Order` into model `kind: 'group'` nodes; export must patch `/Order` only (same constraint as this spike). Illustrator/Acrobat layer-panel parity remains **unverified** until manual Optional Content / Layers checks pass on `scripts\poc\output\three-ocg-nested-order.ai`.


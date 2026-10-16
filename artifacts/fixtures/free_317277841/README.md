# Magazine cover regression fixture (`free_317277841`)

Real-world InDesign document used to catch IDML fill/swatches/group import bugs.

## Files

- `free_317277841.indd` — source (open in InDesign).
- `free_317277841.idml` — exported via the local conversion API / `server/indesignRunner.mjs` (`indd-to-idml`).

## Regenerate IDML

With InDesign available:

```bash
node scripts/_convert-magazine-idml.mjs
```

(or use the server conversion endpoint used by the INDD adapter).

## Import note

The template has **5 pages** across **3 spreads** (Section length 5 in `designmap.xml`). Import stacks pages **vertically** in one document (595×4209 pt): each page keeps its own spread/page origin via `offsetY`, and spread items are assigned to pages by **overlap** of item spread bounds with each page rect (not center-point only). Story typography comes from `Resources/Styles.xml` (paragraph/character styles + BasedOn), e.g. cover title **60 pt** / Color 1, body **9–10 pt**.

## Tests

`npm run test:idml` runs magazine regression, transform, and composite checks against the IDML here.

Optional preview PNG (same composite as tests):

```bash
npx tsx scripts/idml-render-magazine-fixture.mjs
```

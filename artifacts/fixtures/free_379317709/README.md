# Fixture: `free_379317709.idml`

Place these files here for regression comparison (not committed if large):

- `free_379317709.idml` — original download
- `free_379317709.edited.idml` — exported from Creatvise Canvas

Then run:

```bash
npx tsx scripts/idml-package-compare.mjs artifacts/fixtures/free_379317709/free_379317709.idml "artifacts/fixtures/free_379317709/free_379317709.edited (2).idml"
```

Open both in Adobe InDesign (IDML directly, no INDD step) to confirm layout after export.

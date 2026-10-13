# PSD canvas preview (layer edits)

## Embedded composite as source of truth

When Photoshop provides a flattened document canvas (`ag-psd` read with composite), Creatvise keeps an **immutable copy** in `doc.fileComposite` and shows it while no layer differs from import state (`importOpacity`, `importVisible`, original bounds).

After a supported position/opacity/visibility edit, preview mode becomes **`file-base-overlay`**: draw the unchanged embedded composite, **patch each edited leaf’s import footprint** with a 2D re-stack that omits those leaves (masked, no transparent holes), then paint **dirty** layers at their **current** bounds.

Footprint patches redraw the stack at **import pose** only, copied through one clip path made of the edited leaves’ import rectangles (limited to their clip base’s rectangle for clipped layers). Layers clipped to an edited base are redrawn too. Patches do not re-run adjustment layers or layer effects; inside the patched region the preview may differ slightly from Photoshop’s bake, while the rest of the document stays on the embedded composite.

## Choosing the opening preview

`analyzePsdPreview` (`src/psdComposite.ts`, rule in `src/psdCompositeRule.ts`) lists the visible features the 2D stack cannot redraw exactly: adjustment layers, layer effects, soft light / hue / saturation / color / luminosity / dissolve, fill opacity, isolated group blending and group opacity, group masks, clipped groups, clipping-group base opacity/blend, knockout, Blend If, mask density/feather, vector masks without a fill, and non-8-bit or non-RGB documents. If that list is non-empty **and** the embedded composite is usable, the document opens on **`file-composite`**. Otherwise it opens on the 2D stack (`composite` or `layers`).

The embedded composite is not usable when it is missing, when `versionInfo.hasRealMergedData` is false, or when it is blank (fully transparent, or one flat color while the layer stack is not).

`compositeAgreement` / `agreementLooksStale` measure luminance correlation between the embedded composite and the 2D stack (whole image and weakest of 4×4 tiles at 1/8 scale; provisional thresholds 0.85 / 0.3). They are **diagnostic only**: no document switches away from its embedded composite because of them. `npm run psd:baseline` reports them per fixture.

## Masks, clipping, and blend modes in the 2D stack

- Layer masks are applied as gray alpha from a cached copy (`maskAlphaCanvas`); the decoded mask canvas is never changed. Outside the mask rectangle, `defaultColor` decides whether the layer is shown or hidden. Masks keep their import position when a layer moves (export does not move them either).
- A clipped layer is clipped to the nearest non-clipped sibling below it in the same group. A hidden, 0% opacity, or empty base hides its clipped layers; a group base clips to the group’s combined pixels.
- Linear burn, linear dodge, vivid/linear/pin light, hard mix, subtract, divide, darker color, and lighter color are blended per pixel (`src/psdBlend.ts`); other supported modes use canvas composite operations.

## Preview dirty tracking (S4)

Preview-affecting state includes geometry, opacity (including live slider scrub), visibility, and pixel/text edits (`previewContentEpoch`, `textEdited`). While any leaf differs from import, `getDocPreviewCanvas` will not return a stale static embedded composite even if `psdStaticComposite` was not yet reconciled.

## Known visual limitation

Inside a patched footprint (especially a large move), colors match the **flat leaf stack** without adjustment re-simulation, not necessarily every pixel of the embedded bake. Unrelated regions still use `fileComposite`. `fileComposite` itself stays immutable. Alpha-only erasure experiments remain in `scripts/psd-ghost-erase-experiment.ts` (not production).

## Layers excluded from pick and overlay

- **0% opacity** placeholders (e.g. smart-object “Place your portrait here”) are excluded from hit-testing and from overlay compositing.
- Full-document background fills do not steal clicks from upper layers.

## Undo / redo

When all layers match import state again, `reconcilePsdPreviewMode` restores **`file-composite`** and returns the original `fileComposite` canvas reference for preview.

## Export

For documents previewed from their embedded composite, export writes the **on-canvas preview** as the PSD’s composite image: the original `fileComposite` when nothing changed, otherwise the `file-base-overlay` result. Re-importing the export therefore shows the same composition. Layer data (positions, masks, clipping, blend modes, adjustments, effects, smart objects) is patched in place and written by `ag-psd`. Other documents keep the flattened `renderComposite` image.

## Adjustment layer rendering (Phase 2 — Milestones 2A, 2B & 2C)

Nine adjustment types are now rendered in the dynamic 2D stack (`src/psdAdjustment.ts`):
1. **Levels (`levels`):** Master RGB and individual R/G/B transfer curves with shadow/highlight clipping and midtone gamma curves.
2. **Brightness/Contrast (`brightness/contrast`):** Legacy additive linear contrast and modern CS3+ non-linear S-curves.
3. **Curves (`curves`):** Natural cubic spline interpolation solving tridiagonal systems per-channel (R, G, B) and master RGB (`src/psdAdjustmentCurves.ts`).
4. **Vibrance (`vibrance`):** Adaptive saturation boosting less-saturated colors proportionally, with warm skin-tone protection ($10^\circ - 50^\circ$) and uniform saturation scaling (`src/psdAdjustmentVibrance.ts`).
5. **Photo Filter (`photo filter`):** Optical lens transmission tinting, CIE Lab-to-sRGB conversion, and `preserveLuminosity` compensation matching Rec. 709 luminance ($L = 0.2126R + 0.7152G + 0.0722B$) (`src/psdAdjustmentPhotoFilter.ts`).
6. **Color Lookup (`color lookup`):** 3D Look-Up Table support parsing Adobe `.cube` and Autodesk `.3dl` files, with full 3D lattice trilinear interpolation (`src/psdAdjustmentColorLookup.ts`).
7. **Hue/Saturation (`hue/saturation`):** HSL cylinder model, master adjustments, 6 targeted color ranges (Reds, Yellows, Greens, Cyans, Blues, Magentas) with soft falloff ramp transitions, and colorize mode (`src/psdAdjustmentHueSaturation.ts`).
8. **Color Balance (`color balance`):** Independent Shadows, Midtones, and Highlights adjustments across Cyan-Red, Magenta-Green, and Yellow-Blue axes, with optional luminosity preservation (`src/psdAdjustmentColorBalance.ts`).
9. **Black & White (`black & white`):** 6-channel weighting (Reds, Yellows, Greens, Cyans, Blues, Magentas) with customizable tinting (Sepia, Cyanotype, custom) (`src/psdAdjustmentBlackAndWhite.ts`).

- **Stack order:** Adjustments affect layers beneath them in paint order; layers above are not affected.
- **Clipping isolation:** A clipped adjustment layer modifies only its base layer; pixels outside the base's alpha mask remain 100% untouched.
- **Layer masks & Opacity:** Raster masks attenuate adjustment intensity per pixel; outside the mask rectangle follows `defaultColor` (0 hides, 255 reveals); layer opacity performs linear interpolation between unadjusted and adjusted color.
- **Footprint patches:** `file-base-overlay` footprint patches re-run supported adjustments at import pose, matching Photoshop's bake closely instead of leaving patched regions unadjusted.
- **Embedded composite preserved:** Documents with embedded composites preserve `doc.fileComposite` on import; automatic switching away from `file-composite` does not occur solely because an adjustment type is recognized.
- **Export & Undo/Redo:** Export preserves all native adjustment parameters in `ag-psd` structures non-destructively; Undo/Redo is completely deterministic.

## Remaining unsimulated features (deferred to future milestones)

- **Remaining unsupported adjustments:** Exposure, Channel Mixer, Invert, Posterize, Threshold, Gradient Map, Selective Color.
- **Photoshop layer effects (explicitly out of scope in this patch):** Drop Shadow, Inner Shadow, Outer Glow, Inner Glow, Bevel and Emboss, Satin, Color Overlay, Gradient Overlay, Pattern Overlay, Stroke.
- **Other unsimulated PSD features:** Soft light / hue / saturation / color / luminosity blend modes, isolated group blending with non-normal blend modes, fill opacity, knockout, Blend If, combined vector/pixel masks, and 16/32-bit color.

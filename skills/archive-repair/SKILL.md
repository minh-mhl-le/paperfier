---
name: archive-repair
description: Repair a specific extraction, artifact quality, or layout failure in an existing article archive bundle while preserving its source content. Use with a fidelity report or affected block IDs; do not use for unrequested rewriting or site collection.
---

# Repair an archive

Read the sibling [archive contract](../archive-article/references/archive-contract.md). Start with the saved bundle, affected block IDs, observed failure, prior attempts, and required success condition. If evidence is missing, inspect the existing PDF and canonical source before changing anything.

## Choose the narrowest repair

- **Missing or duplicated content:** Trace the block to its source locator. Inspect rendered visibility, lazy loading, accordions, responsive variants, and the extraction boundary. Repair the mapping or derived extraction; retain the original snapshot and record any new capture separately.
- **Soft figure or table:** Measure effective resolution at the actual PDF placement. Find the original asset or a complete vector representation before recapturing. Capture at the required resolution with an available supported API. A larger bitmap made from the same blurry pixels is not a repair.
- **Incomplete visual export:** Inspect the whole artifact, including text outside SVG/canvas geometry, legends, captions, and referenced states. Recapture or export the complete artifact boundary instead of reconstructing its meaning from isolated paths.
- **Capture contamination:** Recheck stable loaded state, fonts, sticky overlays, clipping, and transient tooltips. Preserve the intended source appearance and capture settings in the record.
- **Bad pagination or fitting:** Adjust placement, size, page breaks, or template behavior around the preserved content. Keep caption relationships and reading order intact. Do not shorten, rewrite, stretch, or silently drop content to make it fit.

Keep a backup of derived outputs before replacing them. Use `node bin/archive-article.mjs rebuild DIR` to render only from saved inputs, then inspect the new PDF. Do not invent commands or install a replacement rendering stack without establishing that the existing stack is insufficient.

## Reverify

Rebuild the PDF and inspect every affected page and artifact. Recheck the relevant text/block mappings and resolution; broaden the review when a template or shared layout change can affect other pages. Record the remedy, evidence, and any remaining limitation in the fidelity report. Run `node bin/archive-article.mjs verify DIR --visual-review passed` only after the final PDF has received the required visual review; a rebuild changes the PDF checksum and resets that review.

Use bounded, distinct attempts. Stop repeating a remedy that does not improve the evidence. Return a draft and a precise exception when no available source or capture route can meet the success condition. Ask for a user decision only when choosing omitted content, accepting a fidelity limitation, or changing the agreed scope is necessary.

Return the updated bundle, the affected block IDs, before/after evidence, and the check results. Do not mark the whole archive complete solely because this repair succeeded; its remaining report items still apply.

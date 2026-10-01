# Archive contract

This contract describes the accepted behavior for a single-article archive. It is a workflow specification, not a claim that a harness CLI or automated validator has been implemented.

## Source and presentation

- Preserve source wording, order, heading hierarchy, equations, code, references, and artifact content. Normalize presentation whitespace where needed, retaining meaningful code indentation and mathematical notation.
- Retain source attribution and date when available; distinguish the capture date. Describe the result as an archival study copy, without implying new authorship, publication, or peer review.
- Apply paper typography and pagination to the surrounding document. Preserve original figure and table appearance, proportions, labels, legends, and color encoding. Do not invent an abstract, research sections, conclusions, or captions to make an article look more academic.
- Use original captions. When a source has no caption, any navigation label or provenance note added by the converter must be recognizable as converter metadata.
- Whole-site docs collection is out of scope. A bounded article or deliberately supplied files are the input.

## Capture record

Record the input URL or file paths, capture time, original content checksums, relevant assets, and reading order. For browser captures, record viewport, capture scale, theme, and any selected figure states that affect appearance.

Each content block needs an ID, kind, source locator, and corresponding document location. Record deliberate exclusions of site UI separately from unresolved omissions of article content. Keep canonical snapshots immutable; derived crops, conversions, and layout changes get their own files and provenance.

The bundle should contain original source snapshots, required assets, editable document source, the capture/content manifest, fidelity report, and build instructions with renderer/template versions. Save enough dependencies and configuration to rebuild the document from captured material without visiting the live article. A bundled renderer binary is not required; disclose any remaining build dependencies.

## Artifact sharpness

Prefer original vector assets or exports that preserve the complete visible artifact. Verify fonts, external references, and geometry survive the export. A CSS chart with HTML labels needs those labels in its preserved artifact.

For raster artifacts, calculate effective resolution from actual pixels and physical placement:

`effective DPI = pixel width / placed width in inches`

Check height as well when the layout constrains height. The initial target for text-heavy charts and tables is at least 300 effective DPI, followed by a readability check at the final PDF size. For example, a figure placed at 6.5 inches wide requires at least 1,950 pixels to meet that target.

Use a sharp, lossless capture for charts when the available capture tool supports it. Avoid lossy intermediate conversions and repeated resampling. Enlarging a low-resolution image or changing its DPI metadata does not recover detail. Do not use generative redrawing to repair an original artifact. If the source itself has no sharper representation, record that limitation for review.

Preserve aspect ratio and all content within the artifact boundary. Avoid sticky navigation overlays, clipped axes, missing legends, transient loading states, and tooltip overlays unless the tooltip is deliberately captured as a referenced state. The PDF may scale the artifact to fit; scaling must still satisfy readability and resolution checks.

## Interactive sources

Capture the default figure view and alternate views explicitly discussed in the source. Record each selected state and preserve the link to the original interactive content. Flag static captures that omit information needed to interpret the article. Exhaustive capture of every possible interaction state is not the default.

## Verification evidence

- **Coverage:** Every inventoried article block is mapped into the output or has an explicit unresolved exception. Check order, heading relationships, references, captions, and artifact counts against the canonical capture.
- **Text:** Compare source text with editable document text and PDF extraction where applicable. Allow presentation whitespace changes; investigate missing, duplicated, altered, or reordered material. OCR can assist inspection but is not proof of faithful wording.
- **Artifacts:** Check complete labels and legends, captured states, dimensions, effective resolution, and aspect ratio. Do not claim coverage based only on downloaded image counts; some figures are composed from HTML or multiple elements.
- **Layout:** Inspect rendered PDF pages containing every preserved artifact and every changed or flagged region. Check remaining representative prose, code, equations, and title pages for clipping, overlays, bad page breaks, excessive whitespace, and legibility at reading size.
- **Rebuild:** Verify the documented build can use the saved sources and assets. Identify dependencies and checks that remain unverified.

The report records evidence, repairs performed, and unresolved issues. Successful compilation alone is insufficient. Do not mark the conversion complete while known missing content, altered meaning, unreadable artifacts, or serious layout defects remain unresolved. Provide an inspectable draft and specific exceptions when a decision or unavailable source prevents completion.

## Generated material

Generated explanations, glossaries, connections, or questions require an enrichment request. Keep source content intact and identify generated material and its supporting evidence. Its destination follows the user's chosen companion, appendix, or annotation mode. Enrichment does not satisfy missing-source coverage or repair an unreadable original figure.

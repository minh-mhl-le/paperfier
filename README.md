# Paperfier

**A good article deserves a good paper copy.**

I love reading good articles on paper. I can annotate, follow a figure, and return to an idea without keeping another browser tab alive. Paperfier gives favorite web writing a clean, printable, arXiv-inspired home.

<p align="center">
  <img src="docs/images/corma-cover.png" width="760" alt="A page from the curated Corma article preview, rendered from the Paperfier PDF" />
</p>

<p align="center"><sub>Curated preview from <a href="https://corma.ai/blog/defensive-gap-research">Corma’s article on the defensive gap</a>. This is a real page from the converted PDF; the full article archive stays local.</sub></p>

## What it does

Paperfier takes one article URL or a local Markdown document and produces:

- a printable US Letter PDF, using landscape pages where a wide figure needs room;
- an editable Quarto source document and a bundle of captured source files and images;
- a fidelity report with text witnesses, paper dimensions, image resolution, and items that need review.

It keeps the source wording and reading order where it can extract them. Web figures, image-built tables, diagrams, and styled panels are captured as high-resolution images so their visual relationships stay together. The PDF remains ordinary paper output: review the page images at print size before treating an archive as finished.

## Try the sample

The checked-in [sample PDF](examples/paperfier-demo.pdf) is generated from an original design note and diagram in [`examples/reading-on-paper/`](examples/reading-on-paper/). It demonstrates the print layout without presenting invented results as research.

To rebuild it locally:

```sh
node bin/archive-article.mjs archive examples/reading-on-paper/reading-on-paper.md --output .paperfier-work/demo
open .paperfier-work/demo/archive.pdf
```

## Corma preview

These selected pages come from a real conversion of [Corma’s defensive-gap article](https://corma.ai/blog/defensive-gap-research). The screenshots were rendered from the checked PDF at 300 DPI and selected to show how a wide graphic and a dense table land on Letter paper.

<p align="center">
  <img src="docs/images/corma-metrics.png" width="760" alt="Landscape Letter page showing Corma’s four original metric cards, captured together" />
</p>
<p align="center"><sub>Page 3 · The four source metric cards remain one visual panel.</sub></p>

<p align="center">
  <img src="docs/images/corma-engagement-table.png" width="760" alt="Landscape Letter page with the source engagement log and all column headers visible" />
</p>
<p align="center"><sub>Appendix preview · The complete table header and sample rows are visible at print size.</sub></p>

The complete Corma PDF and its captured article source are local smoke-test files and are not included in this repository. The public previews are attributed excerpts of the source article. This 20-page stress test preserves all 11 captured artifacts at about 303 DPI and passes every source-text witness, but the tall network topology spans two landscape pages and leaves one sparse page. Those visible layout issues are part of the work still ahead.

## Run Paperfier

Requirements:

- Node.js 22 or newer;
- Quarto 1.7 or newer;
- Google Chrome or Chromium for capturing a web page.

No npm install step is needed. The command-line tool uses Node built-ins. Quarto, the arXiv-style Typst extension, and its required fonts render the PDF.

```sh
# Capture one article URL
node bin/archive-article.mjs archive "https://example.com/article" --output ./paper-copy

# Or archive a local Markdown document
node bin/archive-article.mjs archive ./article.md --output ./paper-copy

# Rebuild from saved files without revisiting the source
node bin/archive-article.mjs rebuild ./paper-copy

# Run automated checks, inspect every page, then record the visual review
node bin/archive-article.mjs verify ./paper-copy
node bin/archive-article.mjs verify ./paper-copy --visual-review passed
```

If Quarto is outside `PATH`, set `QUARTO_BIN` or pass `--quarto /path/to/quarto`. A URL capture uses the page’s loaded default state; it does not crawl a documentation site or step through interactive tabs. The report stays in draft status until automated checks pass and a reviewer records the PDF checksum after looking at every page.

## Agent workflows

Point agents at the focused skills under [`skills/`](skills/):

- [`archive-article`](skills/archive-article/SKILL.md) captures and assembles one article;
- [`archive-repair`](skills/archive-repair/SKILL.md) fixes a reported extraction, image, or layout problem;
- [`archive-enrich`](skills/archive-enrich/SKILL.md) creates requested study notes as a separate, source-grounded companion.

The shared [archive contract](skills/archive-article/references/archive-contract.md) defines fidelity, print, and review expectations.

## Development

```sh
npm test
```

The fixture covers math, a Markdown table, code that must remain inert, a footnote, and a vector image. URL capture needs a browser and a live source; rebuilding needs only the saved files and Quarto.

## License and credits

Paperfier’s original code, skills, and sample are MIT licensed; see [LICENSE](LICENSE). The bundled Typst template and fonts retain their upstream licenses and notices in [`licenses/`](licenses/) and [`template/_extensions/arxiv/UPSTREAM.md`](template/_extensions/arxiv/UPSTREAM.md). See [NOTICES.md](NOTICES.md) for third-party components and attribution.

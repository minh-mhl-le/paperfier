import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { findPdfTool, run } from './paths.mjs';

export function parseImages(output) {
  const rows = [];
  for (const line of output.split(/\r?\n/)) {
    const cells = line.trim().split(/\s+/);
    if (cells.length < 14 || cells[2] !== 'image') continue;
    const [page, index, , width, height] = cells;
    const xDpi = Number(cells[12]);
    const yDpi = Number(cells[13]);
    if (!Number.isFinite(xDpi) || !Number.isFinite(yDpi)) continue;
    rows.push({ page: Number(page), index: Number(index), width: Number(width), height: Number(height), xDpi, yDpi });
  }
  return rows;
}

function normalized(value) {
  return String(value ?? '').normalize('NFKC').toLocaleLowerCase()
    .replace(/[\u00ad\u2010-\u2015]/g, '-')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
}

function textWitness(block, pdfText) {
  if (!block.text || ['table','figure','svg','canvas','accessible-figure','styled-grid'].includes(block.kind)) return null;
  const tokens = normalized(block.text).split(' ').filter(Boolean);
  if (tokens.length < 3) return null;
  const anchorTokens = tokens.slice(0, Math.min(5, tokens.length));
  const escapeRegex = token => token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(?:^| )${anchorTokens.map(escapeRegex).join('(?: [\\p{L}\\p{N}]+){0,5} ')}(?: |$)`, 'u');
  const present = pattern.test(pdfText);
  return { id: block.id, kind: block.kind, tokenCount: tokens.length, anchor: anchorTokens.join(' '), present };
}

export function inspectPaperSize(info, pageCount) {
  const rawPages = [];
  const first = info.match(/^Page size:\s*([\d.]+) x ([\d.]+) pts/im);
  if (first) rawPages.push([Number(first[1]), Number(first[2])]);
  const multi = [...info.matchAll(/^Page\s+\d+\s+size:\s*([\d.]+) x ([\d.]+) pts/img)];
  if (multi.length) {
    rawPages.length = 0;
    rawPages.push(...multi.map(match => [Number(match[1]), Number(match[2])]));
  }
  const standard = rawPages.every(([width, height]) =>
    (Math.abs(width - 612) < 1 && Math.abs(height - 792) < 1)
    || (Math.abs(width - 792) < 1 && Math.abs(height - 612) < 1));
  return { pages: pageCount, uniquePageSizesPt: rawPages, printableLetter: Boolean(rawPages.length) && standard };
}

export async function verifyPdf({ outDir, manifest, quartoResult = null, capturedAssets = [] }) {
  const issues = [...(manifest.issues ?? [])];
  const pdfPath = path.join(outDir, 'archive.pdf');
  const summaries = { pdf: 'archive.pdf', checks: [], results: [] };
  const toolNames = ['pdfinfo', 'pdftotext', 'pdfimages'];
  const tools = Object.fromEntries(toolNames.map(name => [name, findPdfTool(name)]));
  const missing = toolNames.filter(name => !tools[name]);
  if (missing.length) {
    issues.push({ severity: 'review', code: 'pdf-inspection-unavailable', message: `Install Poppler tools to inspect the rendered PDF: ${missing.join(', ')}.` });
    summaries.results.push({ check: 'poppler-tools', passed: false, available: toolNames.filter(name => tools[name]) });
    return { issues, verification: summaries };
  }

  const infoResult = run(tools.pdfinfo, [pdfPath]);
  if (infoResult.status !== 0) {
    issues.push({ severity: 'blocking', code: 'pdf-inspection-failed', message: (infoResult.stderr || '').slice(0, 1000) });
    summaries.results.push({ check: 'pdfinfo', passed: false });
    return { issues, verification: summaries };
  }
  const pageCount = Number(infoResult.stdout.match(/^Pages:\s*(\d+)/im)?.[1] ?? 0);
  const pageInfoResult = pageCount
    ? run(tools.pdfinfo, ['-f', '1', '-l', String(pageCount), pdfPath])
    : infoResult;
  const paper = inspectPaperSize(`${infoResult.stdout}\n${pageInfoResult.stdout}`, pageCount);
  summaries.pageCount = pageCount;
  summaries.pageGeometry = paper;
  summaries.results.push({ check: 'printable-paper-size', passed: paper.printableLetter, details: paper });
  if (!paper.printableLetter) issues.push({ severity: 'blocking', code: 'page-size-not-printable-letter', message: 'Every page must fit standard US Letter sheet proportions, portrait or landscape.' });
  if (!pageCount) issues.push({ severity: 'blocking', code: 'empty-pdf', message: 'The PDF contains no pages.' });

  const textResult = run(tools.pdftotext, ['-layout', pdfPath, '-']);
  if (textResult.status !== 0) {
    issues.push({ severity: 'blocking', code: 'pdf-text-extraction-failed', message: (textResult.stderr || '').slice(0, 1000) });
    summaries.results.push({ check: 'pdf-text-readable', passed: false });
  } else {
    const documentPath = path.join(outDir, manifest.document);
    const documentText = await readFile(documentPath, 'utf8');
    const pdfText = normalized(textResult.stdout);
    const sourceBlocks = manifest.blocks?.blocks ?? manifest.blocks?.sourceWitnesses ?? [];
    const witnesses = sourceBlocks.map(block => textWitness(block, pdfText)).filter(Boolean);
    // For Markdown, source block text is not separately represented by the browser inventory.
    const missingBlocks = witnesses.filter(witness => !witness.present);
    const witnessPercent = witnesses.length
      ? Number(((witnesses.length - missingBlocks.length) / witnesses.length * 100).toFixed(1))
      : 100;
    const unrepresented = (manifest.issues ?? []).filter(issue => issue.code === 'unresolved-image').length;
    summaries.textWitnesses = { checkedBlocks: witnesses.length, presentBlocks: witnesses.length - missingBlocks.length,
      missingBlocks: missingBlocks.map(({ id, kind, anchor }) => ({ id, kind, anchor })), coveragePercent: witnessPercent };
    summaries.documentWordCount = normalized(documentText).split(' ').filter(Boolean).length;
    summaries.pdfExtractedWordCount = pdfText.split(' ').filter(Boolean).length;
    const textPassed = missingBlocks.length === 0 && summaries.pdfExtractedWordCount > 20;
    summaries.results.push({ check: 'source-text-witnesses', passed: textPassed,
      checkedBlocks: witnesses.length, presentBlocks: witnesses.length - missingBlocks.length, unresolvedImages: unrepresented });
    if (!textPassed) issues.push({ severity: 'blocking', code: 'source-text-witness-missing', message: `${missingBlocks.length} source text anchor(s) were not found in the PDF text layer.` });
  }

  const imageResult = run(tools.pdfimages, ['-list', pdfPath]);
  if (imageResult.status !== 0) {
    issues.push({ severity: 'review', code: 'pdf-image-resolution-unavailable', message: (imageResult.stderr || '').slice(0, 1000) });
    summaries.results.push({ check: 'embedded-image-resolution', passed: false });
  } else {
    const images = parseImages(imageResult.stdout);
    summaries.embeddedRasterImages = images;
    const minimumDpi = capturedAssets.length
      ? Math.min(...capturedAssets.map(asset => asset.targetDpi ?? (['table','figure','svg','canvas','accessible-figure','styled-grid'].includes(asset.kind) ? 300 : 150)))
      : 0;
    // Match the capture artifacts in document order; check large/source figures at
    // actual PDF size, not just the pixel dimensions recorded in their files.
    const rasterSources = capturedAssets.filter(asset => asset.file?.endsWith('.png'));
    const rasterMatches = images.slice(0, rasterSources.length).map((image, index) => ({
      id: rasterSources[index]?.id ?? `pdf-image-${index + 1}`,
      page: image.page,
      xDpi: image.xDpi,
      yDpi: image.yDpi,
      targetDpi: rasterSources[index]?.targetDpi ?? (['table','figure','svg','canvas','accessible-figure','styled-grid'].includes(rasterSources[index]?.kind) ? 300 : 150),
    }));
    const lowResolution = rasterMatches.filter(image => Math.min(image.xDpi, image.yDpi) < image.targetDpi);
    summaries.rasterResolution = { minimumTargetDpi: minimumDpi || null,
      checked: rasterMatches.length, matches: rasterMatches, lowResolution };
    const resolutionPassed = rasterMatches.length === rasterSources.length && lowResolution.length === 0;
    summaries.results.push({ check: 'printed-image-resolution', passed: resolutionPassed,
      checked: rasterMatches.length, imagesInDocument: rasterSources.length });
    if (!resolutionPassed) issues.push({ severity: 'blocking', code: 'printed-image-resolution-low',
      message: 'At least one placed raster image falls below its target resolution at its printed size.' });
  }

  if (quartoResult) summaries.quarto = quartoResult;
  summaries.checks = summaries.results.filter(result => result.passed).map(result => result.check);
  return { issues, verification: summaries };
}

export async function writeHumanReport(outDir, manifest) {
  const verification = manifest.verification ?? {};
  manifest.issues ??= [];
  const blockers = manifest.issues.filter(issue => issue.severity === 'blocking');
  const reviews = manifest.issues.filter(issue => issue.severity === 'review');
  const status = blockers.length || reviews.length ? 'DRAFT — FIDELITY ISSUE(S) NEED REVIEW' : 'COMPLETE — CHECKED';
  manifest.status = status.startsWith('COMPLETE') ? 'complete' : 'draft';
  const lines = [
    '# Archive fidelity report',
    '',
    `**Status:** ${status}`,
    `**Source:** ${manifest.source.url ?? manifest.source.sourceName ?? manifest.source.captureTitle ?? 'user-supplied source'}`,
    `**Title:** ${manifest.title}`,
    `**Captured:** ${manifest.capturedAt}`,
    '',
    '## PDF',
    '',
    `- Paper: US Letter, portrait or landscape; checked: ${verification.results?.find(item => item.check === 'printable-paper-size')?.passed ? 'yes' : 'no'}`,
    `- Pages: ${verification.pageCount ?? 'not verified'}`,
    `- Text blocks checked: ${verification.textWitnesses?.presentBlocks ?? 0} of ${verification.textWitnesses?.checkedBlocks ?? 0}`,
    `- Raster artifacts checked at printed size: ${verification.rasterResolution?.checked ?? 0}`,
    `- All pages standard US Letter: ${verification.results?.find(item => item.check === 'printable-paper-size')?.passed ? 'yes' : 'no'}`,
    `- Layouts: ${(manifest.blocks?.artifacts ?? []).map(item => `${item.id} ${item.orientation}, ${item.placedWidthIn} in`).join('; ') || 'no captured web artifacts'}`,
    `- Visual inspection: ${manifest.visualReview?.status === 'passed' ? `passed (${manifest.visualReview.reviewedAt})` : 'required; inspect every page at print size'}`,
    '',
    '## Fidelity issues',
    '',
    ...(manifest.issues.length ? manifest.issues.map((issue, index) =>
      `${index + 1}. **${issue.severity.toUpperCase()} — ${issue.code}**${issue.blockId ? ` (${issue.blockId})` : ''}: ${issue.message}`)
      : ['No known extraction, capture, or render issues were found by the recorded checks.']),
    '',
    '## Rebuild',
    '',
    'Run `quarto render archive.qmd --to arxiv-typst --output archive.pdf` from this bundle directory. The Markdown source, page capture, needed image assets, and the arXiv Typst extension are saved alongside the document. Then run `node bin/archive-article.mjs verify .` if the harness is available.',
    '',
    'A successful build does not prove that every visual state on a live page was captured. See `source/inventory.json` and `manifest.json` for captured blocks, locators, and page states.',
    '',
  ];
  await writeFile(path.join(outDir, 'fidelity-report.md'), lines.join('\n'));
  await writeFile(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

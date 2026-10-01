import { spawnSync } from 'node:child_process';
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

function digest(data) { return createHash('sha256').update(data).digest('hex'); }

function quoteYaml(value) {
  return JSON.stringify(String(value ?? ''));
}

function titleFromFilename(filename) {
  const stem = path.basename(filename, path.extname(filename));
  return stem.replace(/[_-]+/g, ' ').replace(/\b\w/g, character => character.toUpperCase()) || 'Archived article';
}

export function parseSimpleFrontmatter(text) {
  if (!text.startsWith('---\n') && !text.startsWith('---\r\n')) return { metadata: {}, body: text };
  const lines = text.split(/\r?\n/);
  const end = lines.findIndex((line, index) => index > 0 && ['---', '...'].includes(line.trim()));
  if (end < 0) return { metadata: {}, body: text };
  const metadata = {};
  for (const line of lines.slice(1, end)) {
    const match = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*?)\s*$/);
    if (!match || !['title', 'author', 'date', 'subtitle', 'description'].includes(match[1])) continue;
    metadata[match[1]] = scalar(match[2]);
  }
  return { metadata, body: lines.slice(end + 1).join('\n') };
}

export function markdownTextWitnesses(markdown) {
  const { body } = parseSimpleFrontmatter(markdown);
  const blocks = [];
  let current = [];
  let fenced = false;
  let kind = 'paragraph';
  const flush = () => {
    const text = current.join('\n').trim();
    if (text) blocks.push({ id: `source-block-${String(blocks.length + 1).padStart(4, '0')}`, kind, text });
    current = [];
    kind = 'paragraph';
  };
  for (const line of body.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) {
      if (!fenced) { flush(); fenced = true; kind = 'code'; }
      else { fenced = false; flush(); }
      continue;
    }
    if (fenced) { current.push(line); continue; }
    if (/^\s*\|?\s*:?-{3,}/.test(line)) continue;
    if (/^\s*\|/.test(line)) {
      if (kind !== 'table') { flush(); kind = 'table'; }
      current.push(line.replaceAll('|', ' '));
      continue;
    }
    if (!line.trim()) { flush(); continue; }
    if (/^\s{0,3}#{1,6}\s/.test(line)) {
      flush(); kind = 'heading'; current.push(line.replace(/^\s{0,3}#{1,6}\s+/, '')); flush(); continue;
    }
    current.push(line);
  }
  flush();
  return blocks.map(block => ({ ...block,
    text: block.text.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[*_`~]/g, '')
      .replace(/\[\^([^\]]+)\]/g, '$1').replace(/<[^>]+>/g, '').trim() }))
    .filter(block => block.text.split(/\s+/).filter(Boolean).length >= 3);
}

function scalar(value) {
  if (!value) return '';
  if (value.startsWith('"')) {
    try { return JSON.parse(value); } catch {}
  }
  if (value.startsWith("'")) return value.slice(1, value.endsWith("'") ? -1 : undefined).replaceAll("''", "'");
  return value.replace(/\s+#.*$/, '').trim();
}

function escapeForMarkdownImagePath(value) {
  return value.replace(/[\\()\s]/g, character => `\\${character}`);
}

function fileExtensionForImage(buffer, source) {
  if (buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return '.png';
  if (buffer.subarray(0, 3).equals(Buffer.from([255,216,255]))) return '.jpg';
  if (buffer.subarray(0, 6).toString('ascii').startsWith('GIF8')) return '.gif';
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return '.webp';
  if (buffer.toString('utf8', 0, Math.min(buffer.length, 512)).includes('<svg')) return '.svg';
  return path.extname(source.split(/[?#]/)[0]).toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 8) || '.bin';
}

function svgPlaceholder(label) {
  const text = String(label || 'Source image could not be captured').slice(0, 160);
  const escape = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="900" height="300" viewBox="0 0 900 300"><rect width="900" height="300" fill="#fff6e6" stroke="#9a4b00" stroke-width="4"/><text x="32" y="96" font-family="sans-serif" font-size="32" font-weight="bold" fill="#703600">Archive exception: image unavailable</text><text x="32" y="158" font-family="sans-serif" font-size="22" fill="#332211">${escape(text)}</text><text x="32" y="218" font-family="sans-serif" font-size="18" fill="#332211">The fidelity report records the missing source file.</text></svg>`, 'utf8');
}

async function copyMarkdownAssets(body, sourcePath, outputDir, { allowNetwork = true } = {}) {
  const assetsDir = path.join(outputDir, 'assets');
  await mkdir(assetsDir, { recursive: true });
  const entries = [];
  const expression = /!\[([^\]]*)\]\(<?([^\s)>]+)>?(?:\s+["'][^"']*["'])?\)/g;
  const replacements = [];
  let match;
  while ((match = expression.exec(body)) !== null) {
    const original = match[2];
    if (/^(?:mailto:|#)/i.test(original)) {
      entries.push({ source: original, status: 'not-localized', reason: 'Embedded or non-file image reference.' });
      continue;
    }
    let bytes;
    let source = original;
    let resolvedFrom;
    try {
      if (/^data:image\/(?:png|jpe?g|gif|webp|svg\+xml);base64,/i.test(original)) {
        bytes = Buffer.from(original.slice(original.indexOf(',') + 1), 'base64');
        if (bytes.length > 25_000_000) throw new Error('Embedded image exceeds the 25 MB asset limit.');
        source = 'embedded data URI';
      } else if (/^https?:\/\//i.test(original)) {
        if (!allowNetwork) throw new Error('Network capture is disabled.');
        const response = await fetch(original, { signal: AbortSignal.timeout(20000), redirect: 'follow' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const contentLength = Number(response.headers.get('content-length') ?? 0);
        if (contentLength > 25_000_000) throw new Error('Image exceeds the 25 MB asset limit.');
        bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.length > 25_000_000) throw new Error('Image exceeds the 25 MB asset limit.');
        source = response.url;
      } else {
        const rawPath = decodeURIComponent(original.split(/[?#]/)[0]);
        const assetPath = path.resolve(path.dirname(sourcePath), rawPath);
        const filePath = await realpath(assetPath);
        const info = await stat(filePath);
        if (!info.isFile()) throw new Error('Image path does not name a file.');
        if (info.size > 100_000_000) throw new Error('Image exceeds the 100 MB local asset limit.');
        bytes = await readFile(filePath);
        resolvedFrom = path.relative(path.dirname(sourcePath), filePath) || path.basename(filePath);
      }
      const sha256 = digest(bytes);
      const filename = `${sha256.slice(0, 20)}${fileExtensionForImage(bytes, source)}`;
      await writeFile(path.join(assetsDir, filename), bytes, { flag: 'wx' }).catch(error => {
        if (error.code !== 'EEXIST') throw error;
      });
      replacements.push({ start: match.index, end: match.index + match[0].length, value: `![${match[1]}](${escapeForMarkdownImagePath(`assets/${filename}`)})` });
      entries.push({ source: original, savedAs: `assets/${filename}`, sha256, sizeBytes: bytes.length, ...(resolvedFrom ? { resolvedFrom } : {}) });
    } catch (error) {
      const filename = `missing-image-${String(entries.length + 1).padStart(3, '0')}.svg`;
      const placeholder = svgPlaceholder(original);
      await writeFile(path.join(assetsDir, filename), placeholder);
      replacements.push({ start: match.index, end: match.index + match[0].length,
        value: `![Archive exception: original image unavailable, see fidelity report](assets/${filename})` });
      entries.push({ source: original, savedAs: `assets/${filename}`, status: 'unresolved', reason: error.message,
        sha256: digest(placeholder), sizeBytes: placeholder.length });
    }
  }
  let result = body;
  for (const replacement of replacements.reverse()) {
    result = result.slice(0, replacement.start) + replacement.value + result.slice(replacement.end);
  }
  return { body: result, assets: entries };
}

function firstHeading(text) {
  return text.match(/^\s{0,3}#\s+(.+?)\s*#*\s*$/m)?.[1]?.trim() ?? '';
}

export function stripRepeatedTitle(text, title) {
  const lines = text.split('\n');
  const index = lines.findIndex(line => line.trim());
  if (index < 0) return text;
  const match = lines[index].match(/^\s{0,3}#\s+(.+?)\s*#*\s*$/);
  if (match && match[1].trim().toLocaleLowerCase() === title.trim().toLocaleLowerCase()) {
    lines.splice(index, 1);
    return lines.join('\n').replace(/^\s*\n/, '');
  }
  for (let end = index + 1; end < Math.min(lines.length, index + 5); end++) {
    if (!/^\s*(?:-{3,}|={3,})\s*$/.test(lines[end])) continue;
    const heading = lines.slice(index, end).map(line => line.replace(/\\\s*$/, '').trim()).filter(Boolean).join(' ');
    if (heading.toLocaleLowerCase() !== title.trim().toLocaleLowerCase()) return text;
    lines.splice(index, end - index + 1);
    return lines.join('\n').replace(/^\s*\n/, '');
  }
  return text;
}

export function joinSplitDropCaps(markdown) {
  // Some article builders expose a decorative initial as its own paragraph.
  // Join it only when the following paragraph begins with lowercase prose.
  return markdown.replace(/(^|\n{2,})([A-Z])\n{2,}(?=[a-z])/g, '$1$2');
}

export function joinSplitDropCapBlocks(blocks) {
  const normalized = [];
  for (let index = 0; index < blocks.length; index++) {
    const initial = blocks[index];
    const next = blocks[index + 1];
    const letter = String(initial.text ?? '').trim();
    if (next && /^[A-Z]$/.test(letter) && /^[a-z]/.test(String(next.text ?? '').trim())) {
      normalized.push({ ...next, text: letter + String(next.text).trim(), mergedFrom: [initial.id, next.id] });
      index++;
    } else {
      normalized.push(initial);
    }
  }
  return normalized;
}

function makeCodeFencesInert(text) {
  // A Quarto executable chunk and a Markdown fence have different meanings.
  // Keep the source snapshot byte-for-byte, but render chunk bodies as code.
  return text.replace(/^(\s*`{3,})\{([A-Za-z][\w-]*)(?:,[^}]*)?\}\s*$/gm, '$1$2');
}

function makeDocument({ title, author, date, body, sourceName, sourceUrl, capturedAt }) {
  const frontmatter = [
    '---',
    `title: ${quoteYaml(title)}`,
    ...(author ? [`author: ${quoteYaml(author)}`] : []),
    ...(date ? [`date: ${quoteYaml(date)}`] : []),
    'format:',
    '  arxiv-typst:',
    '    toc: false',
    '    number-sections: false',
    'execute:',
    '  enabled: false',
    '---',
    '',
  ].join('\n');
  const source = sourceUrl ? `[${sourceUrl}](${sourceUrl})` : `\`${sourceName}\``;
  const note = `\n\n---\n\n*Archived from ${source}. Capture date: ${capturedAt.slice(0, 10)}.*\n`;
  return frontmatter + body.trimStart() + note;
}

function pandocMarkdown(html, quartoPath) {
  const result = spawnSync(quartoPath, [
    'pandoc', '--from=html+tex_math_dollars', '--to=gfm+tex_math_dollars', '--wrap=none',
  ], { input: html, encoding: 'utf8', maxBuffer: 50_000_000, windowsHide: true });
  if (result.error) throw new Error(`Could not run Quarto's Pandoc reader: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`Pandoc could not convert the captured article HTML: ${(result.stderr || '').trim()}`);
  return result.stdout;
}

export async function buildMarkdownInput({ inputPath, outDir, capturedAt = new Date().toISOString(), allowNetwork = true }) {
  const sourcePath = path.resolve(inputPath);
  const original = await readFile(sourcePath);
  if (original.length > 100_000_000) throw new Error('The Markdown source exceeds the 100 MB input limit.');
  const originalText = original.toString('utf8');
  const { metadata, body: sourceBody } = parseSimpleFrontmatter(originalText);
  const title = metadata.title || firstHeading(sourceBody) || titleFromFilename(sourcePath);
  const copied = await copyMarkdownAssets(sourceBody, sourcePath, outDir, { allowNetwork });
  const normalizedBody = makeCodeFencesInert(stripRepeatedTitle(copied.body, title));
  const qmd = makeDocument({ title, author: metadata.author, date: metadata.date, body: normalizedBody,
    sourceName: path.basename(sourcePath), capturedAt });
  const docDir = outDir;
  await mkdir(docDir, { recursive: true });
  await writeFile(path.join(outDir, 'source.md'), original);
  await writeFile(path.join(docDir, 'archive.qmd'), qmd);
  const wordCount = normalizedBody.trim().split(/\s+/).filter(Boolean).length;
  const blocks = {
    title,
    content: [{ id: 'block-0001', kind: 'markdown-document', sourceLocator: path.basename(sourcePath),
      outputLocator: 'archive.qmd', sourceSha256: digest(original), wordCount }],
    sourceWitnesses: markdownTextWitnesses(originalText),
    assets: copied.assets,
  };
  const issues = copied.assets.filter(asset => asset.status === 'unresolved').map(asset => ({
    severity: 'blocking', code: 'unresolved-image', source: asset.source, message: asset.reason,
  }));
  return { title, author: metadata.author || '', source: { kind: 'markdown', sourceName: path.basename(sourcePath), sha256: digest(original), sizeBytes: original.length },
    capturedAt, blocks, issues, sourceSnapshot: 'source.md', document: 'archive.qmd' };
}

export function artifactLayout(asset) {
  const width = Math.max(1, asset.cssWidth || 1);
  const height = Math.max(1, asset.cssHeight || 1);
  const minPx = asset.minVisibleTextPx;
  const available = {
    portrait: { width: 6.5, height: 8.1 },
    landscape: { width: 10.2, height: 6.9 },
  };
  const printedFont = box => minPx == null ? null : Number((minPx * Math.min(box.width / width, box.height / height) * 72).toFixed(1));
  const portraitPt = printedFont(available.portrait);
  const landscapePt = printedFont(available.landscape);
  const aspect = width / height;
  if (asset.tileCount > 1) {
    const placedWidthIn = Math.min(available.landscape.width, available.landscape.height * aspect);
    return { orientation: 'landscape', mode: 'dedicated-page', placedWidthIn: Number(placedWidthIn.toFixed(2)),
      effectiveDpi: Number((asset.width / placedWidthIn).toFixed(1)), minVisibleTextPx: minPx,
      estimatedMinimumPrintedTextPt: printedFont(available.landscape), targetDpi: 300,
      sourceEffectiveDpi: asset.sourceDimensions.some(size => size.width > 0)
        ? Number((Math.min(...asset.sourceDimensions.map(size => size.width).filter(Boolean)) / placedWidthIn).toFixed(1))
        : null };
  }
  if (asset.kind === 'inline-image') {
    const placedWidthIn = Math.min(width / 96, 6.5, 8.1 * aspect);
    const effectiveDpi = Number((asset.width / placedWidthIn).toFixed(1));
    return { orientation: 'portrait', mode: 'inline', placedWidthIn: Number(placedWidthIn.toFixed(3)),
      effectiveDpi, minVisibleTextPx: null, estimatedMinimumPrintedTextPt: null, targetDpi: 300,
      sourceEffectiveDpi: asset.sourceDimensions.some(size => size.width > 0)
        ? Number((Math.min(...asset.sourceDimensions.map(size => size.pixelWidth ?? size.width).filter(Boolean)) / placedWidthIn).toFixed(1))
        : null };
  }
  let orientation = 'portrait';
  let mode = 'inline';
  if (portraitPt != null && portraitPt < 8 && landscapePt != null && landscapePt >= 8) {
    orientation = 'landscape';
    mode = 'dedicated-page';
  } else if (aspect > 1.65 || (height / width) * 6.5 > 8.1) {
    orientation = landscapePt != null && (portraitPt == null || landscapePt > portraitPt) ? 'landscape' : 'portrait';
    mode = 'dedicated-page';
  }
  const box = available[orientation];
  const placedWidthIn = Math.min(box.width, box.height * aspect);
  const effectiveDpi = Number((asset.width / placedWidthIn).toFixed(1));
  const printedTextPt = orientation === 'landscape' ? landscapePt : portraitPt;
  return { orientation, mode, placedWidthIn: Number(placedWidthIn.toFixed(2)), effectiveDpi,
    minVisibleTextPx: minPx, estimatedMinimumPrintedTextPt: printedTextPt,
    targetDpi: minPx == null && asset.kind !== 'svg' ? 150 : 300,
    sourceEffectiveDpi: asset.sourceDimensions.some(size => size.width > 0)
      ? Number((Math.min(...asset.sourceDimensions.map(size => size.pixelWidth ?? size.width).filter(Boolean)) / placedWidthIn).toFixed(1))
      : null };
}

function replaceArtifactMarkdown(markdown, assets, layouts) {
  let result = markdown;
  const groups = new Map();
  for (const asset of assets) {
    const parentId = asset.parentArtifactId ?? asset.id;
    groups.set(parentId, [...(groups.get(parentId) ?? []), asset]);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const first = group[0];
    const reference = new RegExp('^.*assets/' + first.id + '\\.png.*$', 'm');
    if (reference.test(result)) result = result.replace(reference, group.map(tile => '![](' + tile.file + ')').join('\n\n'));
  }
  for (const asset of assets) {
    const layout = layouts.get(asset.id);
    if (asset.kind === 'inline-image') {
      const image = new RegExp(`!\\[[^\\]]*\\]\\((?:<)?assets/${asset.id}\\.png(?:>)?(?:\\s+[^)]*)?\\)`);
      const widthPt = Number((layout.placedWidthIn * 72).toFixed(2));
      result = result.replace(image, match => `${match}{width=${widthPt}pt}`);
      continue;
    }
    const reference = new RegExp(`^.*assets/${asset.id}\\.png.*$`, 'm');
    if (!reference.test(result)) continue;
    const file = `assets/${asset.id}.png`;
    let block;
    if (layout.mode === 'inline') {
      block = `\`\`\`{=typst}\n#image("${file}", width: 100%, fit: "contain")\n\`\`\``;
    } else {
      const landscape = layout.orientation === 'landscape';
      const flip = landscape ? ', flipped: true' : '';
      const width = landscape ? '10.2in' : '6.5in';
      const height = landscape ? '6.9in' : '8.1in';
      const margin = landscape ? '(x: 0.4in, y: 0.35in)' : '(x: 1in, y: 0.7in)';
      block = `\`\`\`{=typst}\n#page("us-letter"${flip}, margin: ${margin})[\n#align(center)[#image("${file}", width: ${width}, height: ${height}, fit: "contain")]\n]\n\`\`\``;
    }
    result = result.replace(reference, block);
  }
  return result;
}

export async function buildWebInput({ capture, outDir, quartoPath }) {
  const { pageData } = capture;
  let articleHtml = pageData.articleHtml;
  const capturedIds = new Set(capture.assets.map(asset => asset.parentArtifactId ?? asset.id));
  const missingArtifacts = (pageData.artifacts || []).filter(artifact => !capturedIds.has(artifact.id));
  for (const artifact of missingArtifacts) {
    const placeholderName = `${artifact.id}-missing.svg`;
    articleHtml = articleHtml.replaceAll(`assets/${artifact.id}.missing.png`, `assets/${placeholderName}`);
    await mkdir(path.join(outDir, 'assets'), { recursive: true });
    await writeFile(path.join(outDir, 'assets', placeholderName), svgPlaceholder(`Missing source artifact at ${artifact.selector || artifact.id}`));
  }
  const html = `<!doctype html><html><body>${articleHtml}</body></html>`;
  let markdown = joinSplitDropCaps(stripRepeatedTitle(pandocMarkdown(html, quartoPath), pageData.title));
  const sourceUrl = capture.sourceUrl;
  const docDir = outDir;
  await mkdir(path.join(outDir, 'assets'), { recursive: true });
  await mkdir(docDir, { recursive: true });
  const savedAssets = [];
  for (const asset of capture.assets) {
    const data = Buffer.from(asset.png, 'base64');
    await writeFile(path.join(outDir, 'assets', asset.filename), data);
    savedAssets.push({ id: asset.id, file: `assets/${asset.filename}`, kind: asset.source.kind,
      parentArtifactId: asset.parentArtifactId ?? asset.id, tileIndex: asset.tileIndex, tileCount: asset.tileCount,
      selector: asset.source.selector, label: asset.source.label, sourceText: asset.source.sourceText,
      width: asset.width, height: asset.height,
      cssWidth: asset.source.pageBox.width, cssHeight: asset.cssHeight ?? asset.source.pageBox.height,
      captureScale: asset.scale, minVisibleTextPx: asset.source.minVisibleTextPx,
      sourceDimensions: asset.source.imageNaturalSize });
  }
  const blockDir = path.join(outDir, 'source');
  await mkdir(blockDir, { recursive: true });
  await writeFile(path.join(blockDir, 'page.html'), capture.rawHtml);
  await writeFile(path.join(blockDir, 'rendered-article.html'), html);
  const layouts = new Map(savedAssets.map(asset => [asset.id, artifactLayout(asset)]));
  const images = savedAssets.map(asset => ({ ...asset, ...layouts.get(asset.id) }));
  markdown = replaceArtifactMarkdown(markdown, savedAssets, layouts);
  const finalQmd = makeDocument({ title: pageData.title, author: pageData.author, date: pageData.date, body: markdown,
    sourceName: sourceUrl, sourceUrl, capturedAt: pageData.capturedAt });
  await writeFile(path.join(docDir, 'archive.qmd'), finalQmd);
  const issues = [...capture.exceptions];
  for (const image of images) {
    if (image.effectiveDpi < image.targetDpi) issues.push({ severity: 'blocking', code: 'capture-resolution-low', blockId: image.id,
      effectiveDpi: image.effectiveDpi, targetDpi: image.targetDpi, message: `The artifact is below its ${image.targetDpi} effective-DPI target at its selected print size.` });
    if (image.estimatedMinimumPrintedTextPt != null && image.estimatedMinimumPrintedTextPt < 8) issues.push({ severity: 'blocking', code: 'artifact-labels-too-small', blockId: image.id,
      estimatedPointSize: image.estimatedMinimumPrintedTextPt, message: 'Source labels remain smaller than 8 pt at the largest standard Letter orientation; a readable continuation view is needed.' });
    if (image.sourceEffectiveDpi != null && image.sourceEffectiveDpi < image.targetDpi) issues.push({ severity: 'review', code: 'source-image-limits-detail', blockId: image.id,
      effectiveDpi: image.sourceEffectiveDpi, message: 'The source embeds a lower-resolution raster image; the capture preserves its visible appearance but cannot restore its original detail.' });
  }
  const unsupportedMedia = (capture.pageData.blocks || []).filter(block => ['video','iframe','audio'].includes(block.tag));
  for (const media of unsupportedMedia) issues.push({ severity: 'blocking', code: 'dynamic-media', blockId: media.id,
    sourceLocator: media.selector, message: `Article ${media.tag} content requires a captured default state or review.` });
  if ((pageData.tabs || []).length > 1) issues.push({ severity: 'review', code: 'alternate-tab-states-not-captured',
    message: 'The source contains tab or radio-controlled views. Only the loaded default state is captured; inspect whether the article discusses alternate states.' });
  const inventory = {
    title: pageData.title,
    sourceTextCharacters: pageData.bodyText.length,
    blocks: joinSplitDropCapBlocks(pageData.blocks),
    articleSelector: pageData.articleSelector,
    articleTag: pageData.articleTag,
    articleHeight: pageData.articleHeight,
    viewport: pageData.captureViewport,
    screenshotScale: 3,
    artifacts: [...images, ...missingArtifacts.map(artifact => ({ id: artifact.id, kind: artifact.kind,
      label: artifact.label, selector: artifact.selector, status: 'missing',
      cssWidth: artifact.pageBox.width, cssHeight: artifact.pageBox.height }))],
    tabs: pageData.tabs || [],
  };
  await writeFile(path.join(blockDir, 'inventory.json'), JSON.stringify(inventory, null, 2) + '\n');
  await writeFile(path.join(blockDir, 'body.txt'), pageData.bodyText);
  return { title: pageData.title, author: pageData.author, source: { kind: 'web', url: sourceUrl, captureTitle: pageData.pageTitle },
    capturedAt: pageData.capturedAt, blocks: inventory, issues, sourceSnapshot: 'source/page.html',
    document: 'archive.qmd' };
}

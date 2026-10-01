import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { artifactLayout, joinSplitDropCapBlocks, joinSplitDropCaps, markdownTextWitnesses, parseSimpleFrontmatter, stripRepeatedTitle } from '../src/document.mjs';
import { inspectPaperSize, parseImages } from '../src/verify.mjs';
import { writeSourceBundle } from '../src/zip.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const node = process.execPath;

test('reads only supported scalar metadata and keeps original body', () => {
  const input = '---\ntitle: "An Article"\nauthor: One Author\nkeywords: [ignored]\n---\n\nBody stays here.';
  const parsed = parseSimpleFrontmatter(input);
  assert.equal(parsed.metadata.title, 'An Article');
  assert.equal(parsed.metadata.author, 'One Author');
  assert.equal(parsed.body, '\nBody stays here.');
});

test('strips a repeated title written as a continued setext heading', () => {
  const title = 'Measuring the AI offense–defense gap on a live network';
  const markdown = 'Measuring the AI offense–defense\\\ngap on a live network\n---------------------------------\n\nPublished\n';
  assert.equal(stripRepeatedTitle(markdown, title), 'Published\n');
  assert.equal(stripRepeatedTitle('# Keep this different title\n\nBody', title), '# Keep this different title\n\nBody');
});

test('joins an isolated decorative initial to the following sentence', () => {
  const markdown = '## Abstract\n\nT\n\nhere is the opening sentence.\n\nA\n\nNew section.';
  assert.equal(joinSplitDropCaps(markdown), '## Abstract\n\nThere is the opening sentence.\n\nA\n\nNew section.');
  const blocks = joinSplitDropCapBlocks([
    { id: 'block-01', tag: 'p', text: 'T' },
    { id: 'block-02', tag: 'p', text: 'here is the opening sentence.' },
    { id: 'block-03', tag: 'p', text: 'New section.' },
  ]);
  assert.deepEqual(blocks.map(({ id, text }) => ({ id, text })), [
    { id: 'block-02', text: 'There is the opening sentence.' },
    { id: 'block-03', text: 'New section.' },
  ]);
});

test('creates text witnesses for prose, math, table rows, code, and footnotes', async () => {
  const markdown = await readFile(path.join(root, 'tests/fixtures/math-code-footnotes.md'), 'utf8');
  const witnesses = markdownTextWitnesses(markdown);
  const text = witnesses.map(block => block.text).join('\n');
  assert.match(text, /measurement is defined by/);
  assert.match(text, /Trial.*Input.*Output/s);
  assert.match(text, /writeLines/);
  assert.match(text, /complete source footnote/);
});

test('chooses landscape for wide chart labels and distinguishes source detail from capture detail', () => {
  const layout = artifactLayout({
    cssWidth: 1500, cssHeight: 620, width: 4500, height: 1860,
    minVisibleTextPx: 18,
    sourceDimensions: [{ width: 668, height: 498 }],
  });
  assert.equal(layout.orientation, 'landscape');
  assert.equal(layout.mode, 'dedicated-page');
  assert.ok(layout.estimatedMinimumPrintedTextPt >= 8);
  assert.ok(layout.effectiveDpi >= 300);
  assert.ok(layout.sourceEffectiveDpi < 150);
});

test('requires a draft exception when the source labels cannot fit on Letter paper', () => {
  const layout = artifactLayout({ cssWidth: 2400, cssHeight: 1400, width: 7200, height: 4200,
    minVisibleTextPx: 9, sourceDimensions: [] });
  assert.ok(layout.estimatedMinimumPrintedTextPt < 8);
});

test('places tiled continuations at readable size on landscape Letter pages', () => {
  const layout = artifactLayout({ cssWidth: 675, cssHeight: 448.5, width: 3060, height: 2033,
    minVisibleTextPx: 8, tileIndex: 1, tileCount: 2, sourceDimensions: [] });
  assert.equal(layout.orientation, 'landscape');
  assert.equal(layout.mode, 'dedicated-page');
  assert.ok(layout.estimatedMinimumPrintedTextPt >= 8);
  assert.ok(layout.effectiveDpi >= 300);
});

test('uses the selected responsive image pixel width for source fidelity checks', () => {
  const layout = artifactLayout({ kind: 'inline-image', cssWidth: 675, cssHeight: 400, width: 1950, height: 1156,
    sourceDimensions: [{ width: 675, height: 449, pixelWidth: 2048, pixelHeight: 1362 }] });
  assert.equal(layout.targetDpi, 300);
  assert.ok(layout.effectiveDpi >= 300);
  assert.ok(layout.sourceEffectiveDpi >= 300);
});

test('verifier reads Poppler image DPI columns and recognizes both Letter orientations', () => {
  const listing = [
    'page num type width height color comp bpc enc interp object ID x-ppi y-ppi size ratio',
    '1 0 image 2400 1600 rgb 3 8 image no 12 0 320 320 1.2M 4.0%',
  ].join('\n');
  assert.deepEqual(parseImages(listing), [{ page: 1, index: 0, width: 2400, height: 1600, xDpi: 320, yDpi: 320 }]);
  assert.equal(inspectPaperSize('Page 1 size: 612 x 792 pts (letter)', 1).printableLetter, true);
  assert.equal(inspectPaperSize('Page 1 size: 792 x 612 pts (letter)', 1).printableLetter, true);
  assert.equal(inspectPaperSize('Page 1 size: 720 x 1000 pts', 1).printableLetter, false);
});

test('source bundle is a valid offline ZIP and does not include itself', async t => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'archive-zip-test-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  await import('node:fs/promises').then(({ writeFile }) => writeFile(path.join(scratch, 'source.md'), '# Saved source\n'));
  const zip = path.join(scratch, 'source-bundle.zip');
  const summary = await writeSourceBundle(scratch, zip);
  assert.equal(summary.files, 1);
  const check = spawnSync('/usr/bin/unzip', ['-Z1', zip], { encoding: 'utf8' });
  assert.equal(check.status, 0);
  assert.equal(check.stdout.trim(), 'source.md');
});

test('Markdown archive renders, keeps code inert, and rebuilds without the live source', {
  skip: !process.env.QUARTO_BIN && 'Set QUARTO_BIN to include the local Quarto integration run.',
}, async t => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'archive-integration-'));
  const output = path.join(scratch, 'article');
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const cli = path.join(root, 'bin/archive-article.mjs');
  const fixture = path.join(root, 'tests/fixtures/math-code-footnotes.md');
  const env = { ...process.env };
  const archived = spawnSync(node, [cli, 'archive', fixture, '--output', output], { env, encoding: 'utf8', timeout: 300000 });
  assert.equal(archived.status, 0, archived.stderr || archived.stdout);
  await stat(path.join(output, 'archive.pdf'));
  assert.equal(await readFile(path.join(output, 'archive.qmd'), 'utf8').then(text => text.includes('```r')), true);
  assert.equal(await import('node:fs/promises').then(({ access }) => access(path.join(output, 'should-not-create.txt')).then(() => true, () => false)), false);
  const rebuilt = spawnSync(node, [cli, 'rebuild', output], { env, encoding: 'utf8', timeout: 300000 });
  assert.equal(rebuilt.status, 0, rebuilt.stderr || rebuilt.stdout);
  const manifest = JSON.parse(await readFile(path.join(output, 'manifest.json'), 'utf8'));
  assert.equal(manifest.verification.pageGeometry.printableLetter, true);
  assert.equal(manifest.issues.some(issue => issue.code === 'visual-review-required'), true);
  const zipCheck = spawnSync('/usr/bin/unzip', ['-t', path.join(output, 'source-bundle.zip')], { encoding: 'utf8' });
  assert.equal(zipCheck.status, 0, zipCheck.stderr || zipCheck.stdout);
});

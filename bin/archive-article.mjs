#!/usr/bin/env node

import { access, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { captureArticle } from '../src/cdp.mjs';
import { buildMarkdownInput, buildWebInput } from '../src/document.mjs';
import { checkEmptyOutput, copyTemplate, findQuarto, run } from '../src/paths.mjs';
import { verifyPdf, writeHumanReport } from '../src/verify.mjs';
import { writeSourceBundle } from '../src/zip.mjs';

const HELP = `Article archive harness

Usage:
  archive-article archive <url|article.md> --output DIR [--quarto PATH] [--browser PATH]
  archive-article rebuild DIR [--quarto PATH]
  archive-article verify DIR [--visual-review passed]

archive captures one article or supplied Markdown, renders a US Letter PDF,
and saves the source capture, editable Quarto document, bundle, and fidelity report.
rebuild works only from saved files; it never revisits the live source.
  verify checks the existing PDF and refreshes its fidelity report. Record a passed
  visual review only after inspecting every page at printed size.

Set QUARTO_BIN to select Quarto when it is not on PATH. Google Chrome or Chromium
is required for URL capture. Draft PDFs retain unresolved exceptions in the report.
`;

function parseArgs(args) {
  const positionals = [];
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const value = args[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`Expected a value after ${arg}.`);
      options[key] = value;
      index++;
    } else positionals.push(arg);
  }
  return { positionals, options };
}

function sourceKind(value) {
  try {
    const url = new URL(value);
    if (['http:', 'https:'].includes(url.protocol)) return 'web';
  } catch {}
  return 'markdown';
}

function quartoVersion(quartoPath) {
  const result = run(quartoPath, ['--version'], { timeout: 15000 });
  if (result.status !== 0) throw new Error(`Could not read Quarto version: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

async function writeBuildInstructions(outDir, version) {
  const text = `# Rebuild this archive\n\nQuarto version used: ${version}.\n\nRun this command from the directory containing this file:\n\n\`\`\`sh\nquarto render archive.qmd --to arxiv-typst --output archive.pdf\n\`\`\`\n\nThe arXiv Typst extension and its fonts are bundled under \`_extensions/arxiv\`. Rendering uses only the saved Markdown, HTML snapshot, and local assets; it does not revisit the live article. Quarto code execution and caching are disabled in \`_quarto.yml\` and \`archive.qmd\`. A compatible Quarto 1.7+ installation is still required.\n`;
  await writeFile(path.join(outDir, 'BUILD.md'), text);
}

async function render(quartoPath, outDir) {
  const result = run(quartoPath, ['render', 'archive.qmd', '--to', 'arxiv-typst', '--output', 'archive.pdf'],
    { cwd: outDir, timeout: 300000, maxBuffer: 30_000_000 });
  await writeFile(path.join(outDir, 'build.log'), [result.stdout, result.stderr].filter(Boolean).join('\n').slice(-200_000));
  return { status: result.status, signal: result.signal, stdout: result.stdout.slice(-20_000), stderr: result.stderr.slice(-20_000) };
}

async function loadManifest(outDir) {
  return JSON.parse(await readFile(path.join(outDir, 'manifest.json'), 'utf8'));
}

function withoutTransientBuildIssues(issues = []) {
  return issues.filter(issue => !['quarto-build-failed'].includes(issue.code));
}

async function saveChecks(outDir, manifest, quartoResult = null) {
  manifest.issues = [...(manifest.captureIssues ?? withoutTransientBuildIssues(manifest.issues))];
  if (quartoResult && quartoResult.status !== 0) manifest.issues.push({
    severity: 'blocking', code: 'quarto-build-failed',
    message: `Quarto exited with status ${quartoResult.status ?? 'unknown'}. See build.log for diagnostics.`,
  });
  const verified = await verifyPdf({ outDir, manifest, quartoResult,
    capturedAssets: manifest.blocks?.artifacts ?? [] });
  manifest.issues = verified.issues;
  manifest.verification = verified.verification;
  try {
    const pdf = await readFile(path.join(outDir, 'archive.pdf'));
    const pdfSha256 = createHash('sha256').update(pdf).digest('hex');
    if (manifest.visualReview?.status === 'passed' && manifest.visualReview.pdfSha256 !== pdfSha256) {
      manifest.visualReview = { status: 'required', reason: 'The PDF changed after the recorded visual inspection.' };
    }
    manifest.visualReview ??= { status: 'required' };
    if (manifest.visualReview.status !== 'passed') manifest.issues.push({ severity: 'review', code: 'visual-review-required',
      message: 'Inspect every PDF page at printed size, including all artifact pages. Then run verify with --visual-review passed to record the reviewed PDF checksum.' });
  } catch {
    manifest.visualReview = { status: 'required' };
  }
  await writeHumanReport(outDir, manifest);
  const bundle = await writeSourceBundle(outDir, path.join(outDir, 'source-bundle.zip'));
  return { manifest, bundle };
}

function statusFor(manifest) {
  return manifest.status === 'complete' ? 'complete' : 'draft';
}

async function archive(input, options) {
  const quartoPath = findQuarto(options.quarto);
  if (!quartoPath) throw new Error('Quarto 1.7 or newer is required. Pass --quarto PATH or set QUARTO_BIN.');
  const version = quartoVersion(quartoPath);
  if (Number(version.split('.')[0]) < 1 || (Number(version.split('.')[0]) === 1 && Number(version.split('.')[1]) < 7)) {
    throw new Error(`Quarto ${version} is too old; version 1.7 or newer is required.`);
  }
  if (!options.output) throw new Error('archive requires --output DIR so the saved source bundle has a clear destination.');
  const outDir = path.resolve(options.output);
  await checkEmptyOutput(outDir);
  await copyTemplate(outDir);
  const capturedAt = new Date().toISOString();
  const built = sourceKind(input) === 'web'
    ? await buildWebInput({ capture: await captureArticle(input, { browserPath: options.browser }), outDir, quartoPath })
    : await buildMarkdownInput({ inputPath: input, outDir, capturedAt });
  const manifest = {
    schemaVersion: 1,
    harnessVersion: '0.1.0',
    title: built.title,
    author: built.author,
    source: built.source,
    capturedAt: built.capturedAt ?? capturedAt,
    visualReview: { status: 'required' },
    renderer: { name: 'Quarto + arXiv Typst format', quartoPath, quartoVersion: version,
      browserPath: sourceKind(input) === 'web' ? options.browser ?? null : null },
    blocks: built.blocks,
    issues: built.issues ?? [],
    captureIssues: built.issues ?? [],
    sourceSnapshot: built.sourceSnapshot,
    document: built.document,
  };
  await writeBuildInstructions(outDir, version);
  await writeFile(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  const quartoResult = await render(quartoPath, outDir);
  const result = await saveChecks(outDir, manifest, quartoResult);
  printResult(outDir, result.manifest, result.bundle);
  return quartoResult.status === 0 ? 0 : 1;
}

async function rebuild(directory, options) {
  const outDir = path.resolve(directory);
  const manifest = await loadManifest(outDir);
  const quartoPath = findQuarto(options.quarto) || findQuarto() || findQuarto(manifest.renderer?.quartoPath);
  if (!quartoPath) throw new Error('Quarto is required to rebuild this bundle. Pass --quarto PATH or set QUARTO_BIN.');
  const version = quartoVersion(quartoPath);
  manifest.visualReview = { status: 'required', reason: 'A rebuild creates a new PDF that needs visual inspection.' };
  manifest.renderer = { ...manifest.renderer, quartoPath, quartoVersion: version };
  await writeBuildInstructions(outDir, version);
  const quartoResult = await render(quartoPath, outDir);
  const result = await saveChecks(outDir, manifest, quartoResult);
  printResult(outDir, result.manifest, result.bundle);
  return quartoResult.status === 0 ? 0 : 1;
}

async function verify(directory, options) {
  const outDir = path.resolve(directory);
  const manifest = await loadManifest(outDir);
  await access(path.join(outDir, manifest.document));
  if (options['visual-review'] === 'passed') {
    const pdf = await readFile(path.join(outDir, 'archive.pdf'));
    manifest.visualReview = { status: 'passed', reviewedAt: new Date().toISOString(),
      pdfSha256: createHash('sha256').update(pdf).digest('hex') };
    manifest.captureIssues = manifest.captureIssues ?? withoutTransientBuildIssues(manifest.issues);
  }
  const result = await saveChecks(outDir, manifest);
  printResult(outDir, result.manifest, result.bundle);
  return statusFor(result.manifest) === 'complete' ? 0 : 2;
}

function printResult(outDir, manifest, bundle) {
  process.stdout.write(`${JSON.stringify({
    status: statusFor(manifest),
    title: manifest.title,
    pdf: path.join(outDir, 'archive.pdf'),
    editableSource: path.join(outDir, manifest.document),
    fidelityReport: path.join(outDir, 'fidelity-report.md'),
    sourceBundle: bundle.path,
    capturedArtifacts: manifest.blocks?.artifacts?.length ?? 0,
    pages: manifest.verification?.pageCount ?? null,
    issues: manifest.issues.map(({ severity, code, message }) => ({ severity, code, message })),
  }, null, 2)}\n`);
}

async function main() {
  const { positionals, options } = parseArgs(process.argv.slice(2));
  if (options.help || positionals.length === 0) {
    process.stdout.write(HELP);
    return 0;
  }
  const [command, input] = positionals;
  if (command === 'archive' && input) return archive(input, options);
  if (command === 'rebuild' && input) return rebuild(input, options);
  if (command === 'verify' && input) return verify(input, options);
  process.stderr.write(HELP);
  throw new Error(`Unknown command or missing input: ${positionals.join(' ')}`);
}

main().then(code => { process.exitCode = code; }).catch(error => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});

import { cp, mkdir, readdir, writeFile } from 'node:fs/promises';
import { constants, accessSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function executableOnPath(name) {
  const candidates = [
    process.env[name.toUpperCase().replaceAll('-', '_')],
    ...String(process.env.PATH ?? '').split(path.delimiter).map(directory => path.join(directory, name)),
  ].filter(Boolean);
  for (const candidate of candidates) {
    const result = spawnSync(candidate, ['--version'], { encoding: 'utf8', timeout: 8000, windowsHide: true });
    if (result.status === 0) return candidate;
  }
  return '';
}

export function findQuarto(explicitPath) {
  if (explicitPath) return explicitPath;
  const fromEnv = process.env.QUARTO_BIN || process.env.QUARTO_PATH;
  if (fromEnv) return fromEnv;
  return executableOnPath('quarto');
}

export function findPdfTool(name) {
  const commonPaths = process.platform === 'darwin'
    ? [`/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`, `/usr/bin/${name}`]
    : [`/usr/bin/${name}`, `/usr/local/bin/${name}`];
  const pathValue = process.env.PATH ?? '';
  const options = [...commonPaths, ...pathValue.split(path.delimiter).map(directory => path.join(directory, name))];
  for (const option of [...new Set(options)]) {
    try { accessSync(option, constants.X_OK); return option; } catch {}
  }
  return '';
}

export async function checkEmptyOutput(outDir) {
  await mkdir(outDir, { recursive: true });
  const files = await readdir(outDir);
  if (files.length > 0) throw new Error(`Output folder ${outDir} is not empty. Choose a fresh folder to preserve existing work.`);
}

export async function copyTemplate(outDir) {
  const source = path.join(PROJECT_ROOT, 'template', '_extensions', 'arxiv');
  const targetRoot = path.join(outDir, '_extensions', 'arxiv');
  await mkdir(path.dirname(targetRoot), { recursive: true });
  await cp(source, targetRoot, { recursive: true, errorOnExist: true, force: false });
  const config = [
    'project:',
    '  output-dir: .',
    'execute:',
    '  enabled: false',
    '  cache: false',
    '',
  ].join('\n');
  await writeFile(path.join(outDir, '_quarto.yml'), config);
}

export function run(command, args, { cwd, timeout = 180000, maxBuffer = 15_000_000 } = {}) {
  const result = spawnSync(command, args, { cwd, timeout, maxBuffer, encoding: 'utf8', windowsHide: true });
  if (result.error) throw new Error(`${path.basename(command)} could not run: ${result.error.message}`);
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', signal: result.signal };
}

import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = path.join(packageRoot, 'src');
const vitestCli = path.join(packageRoot, 'node_modules', 'vitest', 'vitest.mjs');
const commonArgs = [
  vitestCli,
  'run',
  '--exclude',
  '**/*.runtime.test.ts',
  '--reporter=verbose',
  '--no-file-parallelism',
];

const run = (args, stdio) => spawnSync(process.execPath, args, {
  cwd: packageRoot,
  maxBuffer: 16 * 1024 * 1024,
  stdio,
});

const findTests = (directory) => readdirSync(directory, { withFileTypes: true })
  .flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return findTests(absolute);
    if (!entry.isFile() || !entry.name.endsWith('.test.ts') || entry.name.endsWith('.runtime.test.ts')) {
      return [];
    }
    return [path.relative(packageRoot, absolute).split(path.sep).join('/')];
  });

const testFiles = findTests(sourceRoot).sort();
const fullSuite = run(commonArgs, 'pipe');
if (fullSuite.status === 0) {
  process.stdout.write(fullSuite.stdout ?? Buffer.alloc(0));
  process.stderr.write(fullSuite.stderr ?? Buffer.alloc(0));
  process.exit(0);
}

let diagnosticRuns = 0;
const diagnosticBudget = 24;
const fails = (files) => {
  if (diagnosticRuns >= diagnosticBudget) return false;
  diagnosticRuns += 1;
  return run([
    vitestCli,
    'run',
    ...files,
    '--reporter=dot',
    '--no-file-parallelism',
  ], 'ignore').status !== 0;
};

const partition = (items, count) => {
  const chunks = [];
  for (let index = 0; index < count; index += 1) {
    const start = Math.floor((index * items.length) / count);
    const end = Math.floor(((index + 1) * items.length) / count);
    if (start < end) chunks.push(items.slice(start, end));
  }
  return chunks;
};

let minimal = [...testFiles];
let granularity = 2;
while (minimal.length >= 2 && diagnosticRuns < diagnosticBudget) {
  const chunks = partition(minimal, granularity);
  let reduced = false;

  for (const chunk of chunks) {
    if (fails(chunk)) {
      minimal = chunk;
      granularity = 2;
      reduced = true;
      break;
    }
  }
  if (reduced) continue;

  for (const chunk of chunks) {
    const excluded = new Set(chunk);
    const complement = minimal.filter((file) => !excluded.has(file));
    if (complement.length > 0 && fails(complement)) {
      minimal = complement;
      granularity = Math.max(2, granularity - 1);
      reduced = true;
      break;
    }
  }
  if (reduced) continue;

  if (granularity >= minimal.length) break;
  granularity = Math.min(minimal.length, granularity * 2);
}

// The controlled runner records byte count and SHA-256, not raw stderr. A
// deterministic list lets maintainers recover the subset from the known test
// inventory without exposing arbitrary test output or turning the gate green.
process.stderr.write(`[vitest-minimal-subset runs=${diagnosticRuns}]\n${minimal.join('\n')}\n`);
process.exit(91);

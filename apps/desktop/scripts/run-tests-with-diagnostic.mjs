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
  stdio,
});

const fullSuite = run(commonArgs, 'inherit');
if (fullSuite.status === 0) process.exit(0);

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
for (const [index, testFile] of testFiles.entries()) {
  const isolated = run([
    vitestCli,
    'run',
    testFile,
    '--reporter=verbose',
    '--no-file-parallelism',
  ], 'ignore');
  if (isolated.status !== 0) {
    const diagnosticExitCode = 10 + index;
    console.error(`[vitest-diagnostic] exit=${diagnosticExitCode} file=${testFile}`);
    process.exit(diagnosticExitCode);
  }
}

// The full suite failed while every file passed alone, which proves a
// cross-file interaction without allowing the validation to turn green.
console.error('[vitest-diagnostic] exit=90 cross-file-interaction');
process.exit(90);

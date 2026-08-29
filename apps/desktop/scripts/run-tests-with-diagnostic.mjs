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
  '--reporter=json',
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
const classifyFailure = (messages) => {
  const combined = messages.join('\n');
  if (/\bEPERM\b/.test(combined)) return 'EPERM';
  if (/\bEBUSY\b/.test(combined)) return 'EBUSY';
  if (/\bEACCES\b/.test(combined)) return 'EACCES';
  if (/\bENOTEMPTY\b/.test(combined)) return 'ENOTEMPTY';
  if (/\bENOENT\b/.test(combined)) return 'ENOENT';
  if (/Hook timed out/i.test(combined)) return 'HOOK_TIMEOUT';
  if (/Test timed out/i.test(combined)) return 'TEST_TIMEOUT';
  if (/AssertionError|expected .* to |expected .* not to /i.test(combined)) return 'ASSERTION';
  if (/Unhandled (?:Error|Rejection)/i.test(combined)) return 'UNHANDLED';
  return 'ERROR';
};

const diagnosticExitCodes = {
  EPERM: 101,
  EBUSY: 102,
  EACCES: 103,
  ENOTEMPTY: 104,
  ENOENT: 105,
  HOOK_TIMEOUT: 106,
  TEST_TIMEOUT: 107,
  ASSERTION: 108,
  UNHANDLED: 109,
  ERROR: 110,
  REPORT_MISSING: 111,
  REPORT_INVALID: 112,
};

let report;
try {
  report = JSON.parse((fullSuite.stdout ?? Buffer.alloc(0)).toString('utf8'));
} catch {
  process.stderr.write('[vitest-report-missing]\n');
  process.exit(diagnosticExitCodes.REPORT_MISSING);
}
if (!report || !Array.isArray(report.testResults)) {
  process.stderr.write('[vitest-report-invalid]\n');
  process.exit(diagnosticExitCodes.REPORT_INVALID);
}
if (fullSuite.status === 0) {
  if (report.success !== true || Number(report.numFailedTests) !== 0) {
    process.stderr.write('[vitest-report-invalid]\n');
    process.exit(diagnosticExitCodes.REPORT_INVALID);
  }
  process.stdout.write(
    `[vitest-summary files=${report.testResults.length} tests=${Number(report.numPassedTests)}]\n`,
  );
  process.exit(0);
}

const failures = [];
for (const result of report.testResults) {
  const relativeName = typeof result?.name === 'string'
    ? path.relative(packageRoot, result.name).split(path.sep).join('/')
    : '';
  const safeName = testFiles.includes(relativeName) ? relativeName : 'unknown-test-file';
  const assertions = Array.isArray(result?.assertionResults) ? result.assertionResults : [];
  const failedAssertions = assertions
    .map((assertion, index) => ({ assertion, index }))
    .filter(({ assertion }) => assertion?.status === 'failed');
  if (failedAssertions.length === 0 && result?.status === 'failed') {
    failures.push({
      category: classifyFailure([typeof result.message === 'string' ? result.message : '']),
      index: 'suite',
      name: safeName,
    });
    continue;
  }
  for (const { assertion, index } of failedAssertions) {
    failures.push({
      category: classifyFailure(Array.isArray(assertion.failureMessages) ? assertion.failureMessages : []),
      index,
      name: safeName,
    });
  }
}
if (failures.length === 0) {
  process.stderr.write('[vitest-report-no-failure]\n');
  process.exit(diagnosticExitCodes.REPORT_INVALID);
}

const categories = [...new Set(failures.map((failure) => failure.category))];
const category = categories.length === 1 ? categories[0] : 'ERROR';
const marker = `[vitest-original-failures category=${category}]\n${failures
  .map((failure) => `${failure.name}#${failure.index}`)
  .join('\n')}\n`;

// The controlled runner records only byte counts and SHA-256 values. Emit
// repository-owned file/assertion identifiers plus a bounded category from the
// original run, avoiding raw errors and false positives caused by reruns.
process.stderr.write(marker);
process.exit(diagnosticExitCodes[category]);

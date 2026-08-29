#!/usr/bin/env node

import { spawnSync } from 'node:child_process';

const candidates = process.platform === 'win32' ? ['python', 'python3'] : ['python3', 'python'];
const command = candidates.find((candidate) => {
  const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8', windowsHide: true });
  return probe.status === 0;
});

if (!command) {
  process.stderr.write('Python is required to validate the learned media sidecar contract.\n');
  process.exit(1);
}

const result = spawnSync(
  command,
  ['-m', 'unittest', 'discover', '-s', 'runtime/tests', '-p', 'test_*.py', '-v'],
  { stdio: 'inherit', windowsHide: true },
);
process.exit(result.status ?? 1);

#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const contractPath = path.join(repoRoot, 'contracts/developer-surface.json');
const contract = JSON.parse(await readFile(contractPath, 'utf8'));
const failures = [];

for (const capability of contract.capabilities || []) {
  for (const check of capability.checks || []) {
    let source = '';
    try {
      source = await readFile(path.join(repoRoot, check.file), 'utf8');
    } catch (error) {
      failures.push(`${capability.id}: missing file ${check.file} (${error.message})`);
      continue;
    }
    for (const token of check.tokens || []) {
      if (!source.includes(token)) failures.push(`${capability.id}: ${check.file} is missing token ${JSON.stringify(token)}`);
    }
  }
}

const baseIndex = process.argv.indexOf('--base');
const base = baseIndex >= 0 ? process.argv[baseIndex + 1] : '';
if (base) verifyChangedControllerSync(base);

if (failures.length) {
  console.error(`Developer surface verification failed:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}

console.log(`Developer surface verified: ${contract.capabilities.length} capability groups.`);

function verifyChangedControllerSync(baseRef) {
  const diff = spawnSync('git', ['diff', '--name-only', `${baseRef}...HEAD`], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (diff.status !== 0) {
    failures.push(`could not inspect developer-surface diff from ${baseRef}: ${diff.stderr.trim()}`);
    return;
  }
  const changed = diff.stdout.split(/\r?\n/).filter(Boolean);
  const changedDeveloperController = changed.some((file) =>
    file.startsWith('services/gateway/src/modules/') && file.endsWith('controller.ts'));
  if (!changedDeveloperController) return;

  for (const required of [
    'contracts/developer-surface.json',
    'packages/sdk/src/index.ts',
    'packages/cli/src/index.ts',
    'docs/CLI_USAGE.md',
  ]) {
    if (!changed.includes(required)) {
      failures.push(`gateway controller changed without synchronized ${required}`);
    }
  }
}

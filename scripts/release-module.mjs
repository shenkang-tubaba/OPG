#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const modules = {
  system: {
    label: 'OPG distribution',
    packagePath: 'package.json',
    workspace: null,
    tagPrefix: 'opg-system',
    commitScope: 'release',
    verify: ['npm run web:build', 'npm run gateway:build'],
    release: 'Docker images: opg-system, opg-system-gateway, opg-system-web',
  },
  gateway: {
    label: 'Gateway API',
    packagePath: 'services/gateway/package.json',
    workspace: 'services/gateway',
    tagPrefix: 'opg-gateway',
    commitScope: 'gateway',
    verify: ['npm run gateway:build'],
    release: 'Docker image: opg-system-gateway',
  },
  web: {
    label: 'Platform Web',
    packagePath: 'apps/web/package.json',
    workspace: 'apps/web',
    tagPrefix: 'opg-web',
    commitScope: 'web',
    verify: ['npm run web:build'],
    release: 'Docker image: opg-system-web',
  },
  sdk: {
    label: 'Developer SDK',
    packagePath: 'packages/sdk/package.json',
    workspace: 'packages/sdk',
    tagPrefix: 'opg-sdk',
    commitScope: 'sdk',
    verify: ['npm run sdk:test', 'npm run developer:surface:verify', 'cd packages/sdk && npm pack --dry-run'],
    release: 'npm package: opg-sdk',
  },
  cli: {
    label: 'CLI and MCP bridge',
    packagePath: 'packages/cli/package.json',
    workspace: 'packages/cli',
    tagPrefix: 'opg-cli',
    commitScope: 'cli',
    verify: ['npm run cli:test', 'npm run developer:surface:verify', 'cd packages/cli && npm pack --dry-run'],
    release: 'npm package: @jamba/opg-cli',
  },
};

const allowedBumps = new Set(['patch', 'minor', 'major', 'prepatch', 'preminor', 'premajor', 'prerelease']);

function usage(exitCode = 0) {
  const moduleList = Object.keys(modules).join('|');
  console.log(`Usage:
  npm run release:bump -- <${moduleList}> <patch|minor|major|x.y.z> [--skip-verify] [--allow-dirty]

Examples:
  npm run release:bump -- system minor
  npm run release:bump -- gateway patch
  npm run release:bump -- cli 0.1.7

After the script succeeds:
  git add <changed package files>
  git commit -m "chore(<scope>): release <version>"
  git tag <tag-prefix>/v<version>
  git push origin main <tag-prefix>/v<version>
`);
  process.exit(exitCode);
}

function run(command, args, options = {}) {
  const printable = [command, ...args].join(' ');
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    throw new Error(output || `Command failed: ${printable}`);
  }
  return result.stdout || '';
}

function readPackageVersion(packagePath) {
  const absolutePath = resolve(process.cwd(), packagePath);
  const raw = readFileSync(absolutePath, 'utf8');
  const parsed = JSON.parse(raw);
  return String(parsed.version || '');
}

function ensureCleanGitState(allowDirty) {
  if (allowDirty) return;
  const status = run('git', ['status', '--porcelain'], { capture: true }).trim();
  if (!status) return;
  throw new Error(
    [
      'Release bump requires a clean worktree so the version commit stays atomic.',
      'Commit or stash current changes first, or pass --allow-dirty only for local rehearsal.',
      '',
      status,
    ].join('\n'),
  );
}

function isExplicitVersion(value) {
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value);
}

function parseArgs(argv) {
  if (argv.includes('--help') || argv.includes('-h')) usage(0);
  const options = {
    skipVerify: argv.includes('--skip-verify'),
    allowDirty: argv.includes('--allow-dirty'),
  };
  const positional = argv.filter((arg) => !arg.startsWith('--'));
  const [moduleName, bump] = positional;
  if (!moduleName || !bump) usage(1);
  const module = modules[moduleName];
  if (!module) throw new Error(`Unknown release module: ${moduleName}`);
  if (!allowedBumps.has(bump) && !isExplicitVersion(bump)) {
    throw new Error(`Invalid version bump: ${bump}`);
  }
  return { moduleName, module, bump, options };
}

function bumpVersion(moduleName, module, bump) {
  const packageFile = resolve(process.cwd(), module.packagePath);
  const packageJson = JSON.parse(readFileSync(packageFile, 'utf8'));
  const nextVersion = isExplicitVersion(bump) ? bump : resolveNextVersion(String(packageJson.version || ''), bump);
  packageJson.version = nextVersion;
  if (moduleName === 'cli') {
    packageJson.dependencies = packageJson.dependencies || {};
    packageJson.dependencies['opg-sdk'] = readPackageVersion(modules.sdk.packagePath);
  }
  writeJson(packageFile, packageJson);

  const lockFile = resolve(process.cwd(), 'package-lock.json');
  if (existsSync(lockFile)) {
    const lock = JSON.parse(readFileSync(lockFile, 'utf8'));
    const workspaceEntry = module.workspace ? lock.packages?.[module.workspace] : lock.packages?.[''];
    if (!workspaceEntry) throw new Error(`package-lock.json is missing workspace entry ${module.workspace || '<root>'}`);
    workspaceEntry.version = nextVersion;
    if (moduleName === 'cli') {
      workspaceEntry.dependencies = workspaceEntry.dependencies || {};
      workspaceEntry.dependencies['opg-sdk'] = packageJson.dependencies['opg-sdk'];
    }
    writeJson(lockFile, lock);
  }
}

function resolveNextVersion(current, bump) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(current);
  if (!match) throw new Error(`Cannot bump invalid semantic version: ${current}`);
  let major = Number(match[1]);
  let minor = Number(match[2]);
  let patch = Number(match[3]);
  const prerelease = match[4] || '';
  if (bump === 'major') return `${major + 1}.0.0`;
  if (bump === 'minor') return `${major}.${minor + 1}.0`;
  if (bump === 'patch') return `${major}.${minor}.${patch + 1}`;
  if (bump === 'premajor') return `${major + 1}.0.0-0`;
  if (bump === 'preminor') return `${major}.${minor + 1}.0-0`;
  if (bump === 'prepatch') return `${major}.${minor}.${patch + 1}-0`;
  if (bump === 'prerelease') {
    if (!prerelease) return `${major}.${minor}.${patch + 1}-0`;
    const parts = prerelease.split('.');
    const last = parts.at(-1) || '';
    if (/^\d+$/.test(last)) parts[parts.length - 1] = String(Number(last) + 1);
    else parts.push('0');
    return `${major}.${minor}.${patch}-${parts.join('.')}`;
  }
  throw new Error(`Unsupported version bump: ${bump}`);
}

function writeJson(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function runVerification(module, skipVerify) {
  if (skipVerify) return;
  for (const command of module.verify) {
    run('sh', ['-lc', command]);
  }
}

function buildGitAddFiles(module) {
  const candidates = [
    module.packagePath,
    'package-lock.json',
    module.workspace ? `${module.workspace}/package-lock.json` : null,
  ].filter(Boolean);
  return [...new Set(candidates)].filter((file) => existsSync(resolve(process.cwd(), file)));
}

try {
  const { moduleName, module, bump, options } = parseArgs(process.argv.slice(2));
  ensureCleanGitState(options.allowDirty);

  const before = readPackageVersion(module.packagePath);
  console.log(`Preparing ${module.label} release from ${before} with bump "${bump}".`);
  bumpVersion(moduleName, module, bump);
  const after = readPackageVersion(module.packagePath);
  runVerification(module, options.skipVerify);

  console.log('');
  console.log(`Release bump prepared: ${moduleName} ${before} -> ${after}`);
  console.log(`Release target: ${module.release}`);
  console.log('');
  console.log('Next commands:');
  console.log('  git status --short');
  console.log(`  git add ${buildGitAddFiles(module).join(' ')}`);
  console.log(`  git commit -m "chore(${module.commitScope}): release ${after}"`);
  console.log(`  git tag ${module.tagPrefix}/v${after}`);
  console.log(`  git push origin main ${module.tagPrefix}/v${after}`);
  if (moduleName === 'sdk' || moduleName === 'cli') {
    console.log(`  # The pushed tag triggers .github/workflows/npm-release.yml for ${module.release}.`);
    console.log(`  npm view ${moduleName === 'sdk' ? 'opg-sdk' : '@jamba/opg-cli'}@${after} version --registry=https://registry.npmjs.org/`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

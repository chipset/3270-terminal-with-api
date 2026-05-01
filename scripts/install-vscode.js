'use strict';

const { existsSync } = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const pkg = require('../package.json');

const root = path.resolve(__dirname, '..');
const vsix = path.join(root, `${pkg.name}-${pkg.version}.vsix`);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit',
    shell: false
  });

  if (result.error || result.status !== 0) {
    const detail = result.error ? result.error.message : (result.stderr || result.stdout || '').trim();
    throw new Error(`${command} ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`);
  }

  return result.stdout ? result.stdout.trim() : '';
}

function resolveCodeCommand() {
  const candidates = [
    process.env.VSCODE_BIN,
    'code',
    'code-insiders',
    '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code',
    '/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code'
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (candidate.includes(path.sep) && !existsSync(candidate)) {
      continue;
    }

    const result = spawnSync(candidate, ['--version'], {
      encoding: 'utf8',
      stdio: 'pipe',
      shell: false
    });
    if (!result.error && result.status === 0) {
      return candidate;
    }
  }

  throw new Error('Could not find the VS Code CLI. Install the "code" shell command, or set VSCODE_BIN=/path/to/code.');
}

console.log(`Packaging ${pkg.name}@${pkg.version}...`);
run(process.execPath, [path.join(root, 'node_modules', '@vscode', 'vsce', 'vsce'), 'package', '--out', vsix]);

const code = resolveCodeCommand();
console.log(`Installing ${path.basename(vsix)} with ${code}...`);
run(code, ['--install-extension', vsix, '--force']);

console.log(`Installed ${pkg.publisher}.${pkg.name}@${pkg.version}. Reload VS Code if the old extension is still active.`);

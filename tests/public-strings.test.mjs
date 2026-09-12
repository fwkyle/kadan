import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const source = fileURLToPath(new URL('..', import.meta.url));
const personal = ['', 'Users', 'fixture', 'private-note'].join('/');
const env = {...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null'};
function run(cwd, command, args, options = {}) {
  return spawnSync(command, args, {cwd, env, encoding: 'utf8', timeout: 30000, ...options});
}
function git(cwd, ...args) {
  const result = run(cwd, 'git', args);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
function write(root, name, value) {
  const file = path.join(root, name);
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, value);
}
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-public-check-'));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Public check fixture');
  git(root, 'config', 'user.email', 'fixture@example.test');
  for (const name of ['scripts/check-public-strings.mjs', 'scripts/install-git-hooks.mjs', '.githooks/pre-commit', '.githooks/pre-push']) {
    write(root, name, fs.readFileSync(path.join(source, name)));
    if (name.startsWith('.githooks/')) fs.chmodSync(path.join(root, name), 0o755);
  }
  write(root, '.gitignore', 'docs/daily/\nAGENTS.md\nCLAUDE.md\n.trash/\n');
  git(root, 'add', 'scripts', '.githooks', '.gitignore');
  git(root, 'commit', '-m', 'safe baseline');
  return root;
}
const check = (root, ...args) => run(root, process.execPath, ['scripts/check-public-strings.mjs', ...args]);
function hooks(root) {
  const result = run(root, process.execPath, ['scripts/install-git-hooks.mjs']);
  assert.equal(result.status, 0, result.stderr);
}

test('public check scans new paths and hidden configuration while ignoring private local notes', () => {
  const root = fixture();
  write(root, 'docs/daily/note.md', personal);
  write(root, 'CLAUDE.md', personal);
  write(root, 'extra/review.md', personal);
  let result = check(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /extra\/review.md/);
  assert.ok(!result.stderr.includes(personal), 'private contents must not be echoed');
  write(root, 'extra/review.md', 'safe');
  write(root, '.github/workflows/new.yml', personal);
  assert.equal(check(root).status, 1);
  write(root, '.github/workflows/new.yml', 'safe');
  assert.equal(check(root).status, 0);
});

test('commit hook inspects staged blobs rather than cleaner working copies', () => {
  const root = fixture();
  hooks(root);
  write(root, 'note.md', personal);
  git(root, 'add', 'note.md');
  write(root, 'note.md', 'safe working copy');
  assert.equal(check(root).status, 0);
  assert.equal(check(root, '--staged').status, 1);
  const before = git(root, 'rev-parse', 'HEAD');
  assert.notEqual(run(root, 'git', ['commit', '-m', 'must not commit']).status, 0);
  assert.equal(git(root, 'rev-parse', 'HEAD'), before);
  git(root, 'add', 'note.md');
  write(root, 'note.md', personal);
  assert.equal(check(root, '--staged').status, 0, 'unstaged private edits are not in the commit');
  git(root, 'commit', '-m', 'safe staged contents');
});

test('forced private files, gitlinks and external symlinks are rejected without following links', () => {
  const root = fixture();
  for (const name of ['docs/daily/note.md', 'AGENTS.md', 'CLAUDE.md']) {
    write(root, name, 'no known private identifier needed');
    git(root, 'add', '-f', name);
    assert.equal(check(root, '--staged').status, 1, name);
    git(root, 'update-index', '--force-remove', name);
  }
  const oid = git(root, 'rev-parse', 'HEAD');
  git(root, 'update-index', '--add', '--cacheinfo', `160000,${oid},private-module`);
  assert.equal(check(root, '--staged').status, 1);
  git(root, 'update-index', '--force-remove', 'private-module');
  fs.symlinkSync('../private-outside', path.join(root, 'external-link'));
  git(root, 'add', 'external-link');
  assert.equal(check(root, '--staged').status, 1);
  git(root, 'update-index', '--force-remove', 'external-link');
  fs.symlinkSync('docs/daily/note.md', path.join(root, 'private-link'));
  git(root, 'add', 'private-link');
  assert.equal(check(root, '--staged').status, 1);
  git(root, 'update-index', '--force-remove', 'private-link');
  fs.symlinkSync('.gitignore', path.join(root, 'public-link'));
  git(root, 'add', 'public-link');
  assert.equal(check(root, '--staged').status, 0);
});

test('push hook blocks a new branch with private intermediate history even after removal at its tip', () => {
  const root = fixture();
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-public-remote-'));
  git(remote, 'init', '--bare');
  git(root, 'push', remote, 'HEAD:refs/heads/main');
  const base = git(root, 'rev-parse', 'HEAD');
  write(root, 'temporary.md', personal);
  git(root, 'add', 'temporary.md');
  git(root, 'commit', '-m', 'private intermediate commit');
  // Keep the fixture on disk but remove it from the outgoing tree.
  git(root, 'rm', '--cached', 'temporary.md');
  git(root, 'commit', '-m', 'remove from tree');
  assert.equal(check(root, '--staged').status, 0);
  assert.equal(check(root, '--range', base, 'HEAD').status, 1);
  hooks(root);
  const result = run(root, 'git', ['push', remote, 'HEAD:refs/heads/new-branch']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /private identifier/);
  assert.equal(git(root, 'ls-remote', remote, 'refs/heads/new-branch'), '');
  assert.equal(git(remote, 'rev-parse', 'refs/heads/main'), base);
  git(root, 'branch', 'leaky', 'HEAD~1');
  assert.notEqual(run(root, 'git', ['push', remote, 'refs/heads/leaky:refs/heads/leaky']).status, 0);
  assert.equal(git(root, 'ls-remote', remote, 'refs/heads/leaky'), '');
});

test('push hook checks the requested ref, permits safe pushes and fails closed on unknown destinations', () => {
  const root = fixture();
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-public-safe-remote-'));
  git(remote, 'init', '--bare');
  hooks(root);
  git(root, 'push', remote, 'HEAD:refs/heads/main');
  const base = git(root, 'rev-parse', 'HEAD');
  write(root, 'new folder/safe.txt', 'safe');
  git(root, 'add', 'new folder/safe.txt');
  git(root, 'commit', '-m', 'safe new commit');
  assert.equal(check(root, '--range', base, 'HEAD').status, 0);
  git(root, 'push', remote, 'HEAD:refs/heads/new-branch');
  assert.equal(git(remote, 'rev-parse', 'refs/heads/new-branch'), git(root, 'rev-parse', 'HEAD'));
  const sha = git(root, 'rev-parse', 'HEAD');
  const missing = run(root, process.execPath, ['scripts/check-public-strings.mjs', '--pre-push', path.join(root, 'missing-remote')], {
    input: `refs/heads/main ${sha} refs/heads/main ${'0'.repeat(40)}\n`,
  });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Git ls-remote failed/);
  assert.equal(check(root, '--range', 'missing-ref', 'HEAD').status, 1);
});

test('hook installer preserves an existing custom hook directory', () => {
  const root = fixture();
  git(root, 'config', 'core.hooksPath', 'custom-hooks');
  const result = run(root, process.execPath, ['scripts/install-git-hooks.mjs']);
  assert.equal(result.status, 1);
  assert.equal(git(root, 'config', '--get', 'core.hooksPath'), 'custom-hooks');
});

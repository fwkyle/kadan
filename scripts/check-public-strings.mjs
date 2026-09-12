#!/usr/bin/env node
// Check working files, the Git index, or outgoing commits before publication.
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

// Split private identifiers so this file and the test fixtures can also be scanned.
const privateNames = [
  ['fw', 'm1'].join('_'), ['kyle', 'hub'].join('-'), 'modu' + 'certi',
  'secure' + 'net', 'wonseong' + 'jang', ['kyle', 'control', 'plane'].join('-'),
  ['Kyle', 'Brain'].join('-'), ['kyle', 'agent', 'skills'].join('-'),
];
const banned = [/\/Users\//, /docs\/daily\/[0-9]/, ...privateNames.map(s => new RegExp(s, 'i'))];
const privatePath = /(^|\/)(AGENTS\.md|CLAUDE\.md|\.trash|\.staging|\.omo|\.rottie)(\/|$)|^docs\/(daily|plans)(\/|$)|^docs\/TODO\.md$/i;
const zero = /^0+$/;
const seen = new Set();
let hits = 0, checked = 0;

function git(args, options = {}) {
  const result = spawnSync('git', args, {encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options});
  if (result.error || result.status !== 0) throw new Error(`Git ${args[0]} failed; public check stopped`);
  return result.stdout;
}
function reject(file, reason) {
  hits++;
  // Never print matched contents: they may themselves be private.
  console.error(`${JSON.stringify(file)}: ${reason}`);
}
function inspect(file, mode, read, identity) {
  const key = `${file}\0${identity}`;
  if (seen.has(key)) return;
  seen.add(key);
  checked++;
  if (privatePath.test(file)) return reject(file, 'private workspace path');
  if (mode === '160000') return reject(file, 'nested repository must not be published');
  if (banned.some(re => re.test(file))) reject(file, 'private identifier in filename');
  const contents = read();
  if (mode === '120000') {
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), contents));
    if (path.posix.isAbsolute(contents) || target === '..' || target.startsWith('../') || privatePath.test(target)) {
      reject(file, 'link points outside public files');
    }
  }
  contents.split('\n').forEach((line, i) => {
    if (banned.some(re => re.test(line))) reject(file, `private identifier at line ${i + 1}`);
  });
}
function index() {
  for (const row of git(['ls-files', '--stage', '-z']).split('\0').filter(Boolean)) {
    const [, mode, oid, stage, file] = row.match(/^(\d+) ([a-f0-9]+) (\d)\t([\s\S]+)$/) ?? [];
    if (!file || stage !== '0') throw new Error('Unmerged or invalid Git index; public check stopped');
    inspect(file, mode, () => git(['cat-file', 'blob', oid]), oid);
  }
}
function tree(ref) {
  for (const row of git(['ls-tree', '-r', '-z', '--full-tree', ref]).split('\0').filter(Boolean)) {
    const [, mode, , oid, file] = row.match(/^(\d+) (blob|commit) ([a-f0-9]+)\t([\s\S]+)$/) ?? [];
    if (!file) throw new Error('Invalid Git tree; public check stopped');
    inspect(file, mode, () => git(['cat-file', 'blob', oid]), oid);
  }
}
function commit(ref) {
  return git(['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]).trim();
}
function history(tip, bases) {
  tree(tip);
  const commits = git(['rev-list', tip, '--not', ...bases]).trim().split('\n').filter(Boolean);
  for (const sha of commits) tree(sha);
}
function prePush(remote) {
  if (!remote) throw new Error('Missing push destination');
  const updates = fs.readFileSync(0, 'utf8').trim().split('\n').filter(Boolean).map(line => {
    const fields = line.split(' ');
    if (fields.length !== 4 || !/^[a-f0-9]{40,64}$/.test(fields[1]) || !/^[a-f0-9]{40,64}$/.test(fields[3])) {
      throw new Error('Invalid pre-push input');
    }
    return fields;
  }).filter(([, local]) => !zero.test(local));
  if (!updates.length) return;
  // Use the destination's actual refs, not stale local remote-tracking refs.
  // Unknown objects cannot exclude history; the conservative result is more scanning.
  const bases = [];
  for (const row of git(['ls-remote', '--refs', '--', remote]).trim().split('\n').filter(Boolean)) {
    const oid = row.split('\t')[0];
    if (!/^[a-f0-9]{40,64}$/.test(oid)) throw new Error('Invalid remote object');
    const result = spawnSync('git', ['rev-parse', '--verify', '--quiet', `${oid}^{commit}`], {encoding: 'utf8'});
    if (result.status === 0) bases.push(result.stdout.trim());
  }
  for (const [, local] of updates) history(commit(local), bases);
}
function workingFiles() {
  const files = new Set(git(['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean));
  for (const file of files) {
    const stat = fs.lstatSync(file);
    const mode = stat.isSymbolicLink() ? '120000' : stat.isDirectory() ? '160000' : '100644';
    inspect(file, mode, () => stat.isSymbolicLink() ? fs.readlinkSync(file) : fs.readFileSync(file, 'utf8'), 'working');
  }
}
try {
  process.chdir(git(['rev-parse', '--show-toplevel']).trim());
  const [mode, first, second, ...extra] = process.argv.slice(2);
  if (!mode) workingFiles();
  else if (mode === '--staged' && !first) index();
  else if (mode === '--pre-push' && first && !second) prePush(first);
  else if (mode === '--range' && first && second && !extra.length) history(commit(second), zero.test(first) ? [] : [commit(first)]);
  else throw new Error('Usage: check-public-strings.mjs [--staged | --pre-push remote | --range base head]');
  console.log(`Public check: ${checked} file versions, ${hits} issue(s)`);
  process.exitCode = hits ? 1 : 0;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

#!/usr/bin/env node
import {spawnSync} from 'node:child_process';

const current = spawnSync('git', ['config', '--get', 'core.hooksPath'], {encoding: 'utf8'});
if (current.error || ![0, 1].includes(current.status)) throw new Error('Cannot read Git hook configuration');
if (current.stdout.trim() && current.stdout.trim() !== '.githooks') {
  throw new Error('An existing core.hooksPath is configured; integrate the public checks there before changing it');
}
const result = spawnSync('git', ['config', '--local', 'core.hooksPath', '.githooks'], {stdio: 'inherit'});
if (result.error || result.status !== 0) throw new Error('Cannot install Git hooks');
console.log('Public checks enabled before commits and pushes in this clone.');

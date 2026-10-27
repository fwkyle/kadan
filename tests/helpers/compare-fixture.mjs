import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {appendLedger} from '../../src/ledger.mjs';
import {DEFAULT_FAMILIES, readSettings} from '../../src/runner-settings.mjs';

export const choice = (model, effort = 'medium') => ({runner: 'codex', model, effort});
export function compareFixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kadan-compare-'));
  const models = ['gpt-one', 'gpt-two', 'gpt-6.1-terra', 'claude-one', 'claude-two'];
  const pairs = [[0, 3], [1, 3], [2, 3], [3, 0], [3, 2]];
  const settings = {version: 1, revision: 1, activePreset: 'A', families: DEFAULT_FAMILIES,
    runners: {codex: {spawn: 'codex --model {model} --effort {effort}',
      models: models.map(model => ({model, efforts: ['medium', 'high']}))}},
    presets: Object.fromEntries(pairs.map(([w, r], i) => [String.fromCharCode(65 + i), {
      roles: {worker: choice(models[w]), reviewer: choice(models[r], 'high')},
      fallback: {worker: [choice('gpt-two')], reviewer: [choice('claude-two', 'high')]},
    }]))};
  const file = path.join(home, 'runner-settings.json');
  const save = value => fs.writeFileSync(file, JSON.stringify(value));
  save(settings);
  const record = entry => appendLedger(entry, home);
  const meta = () => ({revision: readSettings(home).revision, reason: '격리 시험', by: 'test', record});
  return {home, file, settings, save, record, meta};
}

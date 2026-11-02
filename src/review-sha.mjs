// 검수한 커밋(SHA) 기록의 바닥 규칙: 형식 검사와, 그 카드 이름으로 빌린 검수 자리 임차 기록에서 SHA 찾기.
// 표시용 기록이다. 머지를 막는 관문이 아니다. GitHub는 부르지 않는다.
import fs from 'node:fs';
import path from 'node:path';
import {mainRepo} from './review-slots.mjs';

const SHA_PATTERN = /^[0-9a-f]{7,40}$/i;

// 7~40자리 16진만 SHA로 본다. 아니면 null.
export const normalizeSha = value => (typeof value === 'string' && SHA_PATTERN.test(value.trim()) ? value.trim().toLowerCase() : null);

// 짧은 쪽이 7자리 이상이고 긴 쪽의 앞부분과 같으면 같은 커밋이다.
export function sameCommit(a, b) {
  const [x, y] = [normalizeSha(a), normalizeSha(b)];
  if (!x || !y) return false;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return long.startsWith(short);
}

const readJson = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };

// `$KADAN_HOME/review-slots/<저장소>/*.lease.json` 중, 카드의 원본 저장소(repoPath → 검수 자리와 같은 원본 저장소 판정)의
// 자리 묶음에서 이 카드 이름(키 또는 id)으로 빌린 가장 최근 임차의 SHA. 다른 저장소의 같은 id 임차는 보지 않는다.
// 원본 저장소를 정할 수 없으면 null.
export function leaseShaFor(home, card) {
  let repo;
  try { repo = mainRepo(card.repoPath); } catch { return null; }
  const real = p => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
  const names = new Set([card.key, card.id].filter(Boolean));
  const root = path.join(home, 'review-slots');
  let pools;
  try { pools = fs.readdirSync(root); } catch { return null; }
  const found = [];
  for (const pool of pools) {
    const poolRepo = readJson(path.join(root, pool, 'repo.json'))?.repo;
    if (typeof poolRepo !== 'string' || real(poolRepo) !== repo) continue;
    let files;
    try { files = fs.readdirSync(path.join(root, pool)).filter(n => n.endsWith('.lease.json')); } catch { continue; }
    for (const name of files) {
      const lease = readJson(path.join(root, pool, name));
      const sha = normalizeSha(lease?.sha);
      if (sha && names.has(lease.for)) found.push({sha, at: Date.parse(lease.at) || 0});
    }
  }
  found.sort((a, b) => b.at - a.at);
  return found[0]?.sha ?? null;
}

// 옛 JSONL 저장소를 일부러 시험하는 홈에 표시 파일(backend:'jsonl')을 먼저 둔다.
// 표시 파일이 없는 새 홈은 첫 쓰기에서 SQLite로 시작하므로, JSONL 파일을 직접 만지는 시험은 이것으로 JSONL을 명시한다.
// JSONL 백엔드를 지울 때(PR-2) 이 도우미를 쓰는 시험도 함께 지운다.
import fs from 'node:fs';
import path from 'node:path';

export function markJsonl(home) {
  fs.mkdirSync(home, {recursive: true});
  fs.writeFileSync(path.join(home, 'storage.json'), JSON.stringify({version: 1, backend: 'jsonl'}) + '\n');
  return home;
}

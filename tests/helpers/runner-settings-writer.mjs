import fs from 'node:fs';
import path from 'node:path';
import {setFavorites, setFallback} from '../../src/runner-settings.mjs';

const [home, writer] = process.argv.slice(2);
const file = path.join(home, 'runner-settings.json');
const release = path.join(home, 'release');
const read = fs.readFileSync;
const mkdir = fs.mkdirSync;
let observed = false;
const wait = () => {
  const end = Date.now() + 10000;
  while (!fs.existsSync(release)) {
    if (Date.now() > end) throw new Error('시험 장벽 시간 초과');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
};
// 두 프로세스의 읽기/쓰기 사이를 겹친다. 잠금이 있으면 두 번째 프로세스는 읽기 전 대기한다.
fs.readFileSync = function (target, ...args) {
  const value = read.call(this, target, ...args);
  if (target === file && !observed) {
    observed = true;
    fs.writeFileSync(path.join(home, `${writer}-read`), 'ready');
    wait();
  }
  return value;
};
fs.mkdirSync = function (target, ...args) {
  try { return mkdir.call(this, target, ...args); }
  catch (error) {
    if (writer === 'b' && error.code === 'EEXIST' && target === path.join(home, '.runner-settings-lock')) {
      fs.writeFileSync(path.join(home, 'b-waiting'), 'ready');
    }
    throw error;
  }
};
const options = {
  revision: 1, by: writer, reason: '동시 저장 시험',
  record: entry => fs.writeFileSync(path.join(home, `event-${writer}.json`), JSON.stringify(entry)),
};
try {
  const result = writer === 'a'
    ? setFavorites(home, {...options, items: [{runner: 'demo', model: 'a'}]})
    : setFallback(home, {...options, role: 'worker', items: [{runner: 'demo', model: 'b'}]});
  console.log(JSON.stringify({revision: result.revision}));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

// 큰 배열의 참조를 끊은 직후, 다음 큰 읽기 전에 메모리 수거를 한 번 일으킨다.
// Why: node는 힙 한도에 여유가 있으면 죽은 객체를 거두지 않고 힙을 키운다. 그래서 참조만 끊어서는 명령의 최대 메모리가
// 줄지 않는다(2026-11-13 실측, 원장 12만 건: 한 번 읽기 446MB, 놓고 다시 읽기 666MB, 놓고 수거한 뒤 다시 읽기 441MB).
// 수거 시간은 살아 있는 객체 양에 비례한다(위 측정에서 3~6ms). 판정·출력은 바꾸지 않는다.
// node를 --expose-gc 없이 띄워도 되게 수거 함수를 실행 중에 한 번 얻는다. 얻지 못하면 아무것도 하지 않는다.
import v8 from 'node:v8';
import vm from 'node:vm';

let collect;
export function collectGarbage() {
  if (collect === undefined) {
    collect = typeof globalThis.gc === 'function' ? globalThis.gc : null;
    if (!collect) {
      try {
        v8.setFlagsFromString('--expose-gc');
        collect = vm.runInNewContext('gc');
        v8.setFlagsFromString('--no-expose-gc');
      } catch { collect = null; }
    }
  }
  try { collect?.(); } catch { /* 수거는 선택이다 */ }
}

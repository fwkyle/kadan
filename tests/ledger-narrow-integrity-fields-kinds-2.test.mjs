// 칸 변형 시험 — 갈래(2/2): 다른 줄의 종류로 바꾸기. 고정 원장·변형 만들기·판정은 tests/helpers/ledger-integrity-fields.mjs에 있다.
// 갈래별로 파일을 나눈 것은 변형이 수천 개라 한 파일에 두면 오래 걸려서다(파일끼리는 함께 돈다).
import './helpers/isolated-home.mjs';
import test from 'node:test';
import {runFieldFamily} from './helpers/ledger-integrity-fields.mjs';

test('칸 변형 2/2(다른 줄의 종류로 바꾸기): 모델 안 변형에서 전체 읽기가 거절하면 좁은 읽기도 같은 문구로 거절하고, 받으면 결과가 같다', t => {
  runFieldFamily(t, ['kinds'], {part: 1, of: 2});
});

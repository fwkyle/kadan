// 줄 변형 시험(3/3) — 제품이 쓰는 사건 종류를 모두 담은 큰 고정 원장에서 줄 하나 빼기·순번 겹치기(모든 줄 짝)·이웃 순번 맞바꾸기.
// 고정 원장·판정은 tests/helpers/ledger-integrity-fields.mjs, 변형 만들기는 tests/helpers/ledger-integrity-rig.mjs에 있다.
// 작은 고정 원장의 같은 변형은 tests/ledger-narrow-integrity.test.mjs가 돌린다. 변형이 많아 세 파일로 나눴다.
import './helpers/isolated-home.mjs';
import test from 'node:test';
import {runFieldFamily} from './helpers/ledger-integrity-fields.mjs';

test('줄 변형 3/3(빼기·순번 겹치기·맞바꾸기): 전체 읽기가 거절하면 좁은 읽기도 같은 문구로 거절하고, 받으면 결과가 같다', t => {
  runFieldFamily(t, ['rows'], {part: 2, of: 3});
});

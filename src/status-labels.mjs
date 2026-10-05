// 카드 상태 이름과 세 묶음(진행 전·진행 중·끝)의 한 곳 정의 (2026-10-05 [kyle]).
// 같은 상태가 화면마다 다른 이름(발령 가능·실행 전, 보관·과거 자료 등)으로 보여 헷갈렸다.
// 저장 코드(draft·ready·assigned…)는 원장·시험·CLI·스킬 문서가 기대므로 바꾸지 않고 화면 낱말만 여기서 정한다.
export const STATUS_LABELS={
 // 진행 전
 draft:'초안',ready:'설계완료',archived:'보류',
 // 진행 중 — 결과 대기(waiting)는 요약에서 작업중으로 센다. 기다리는 이유는 상세에서만 붙인다.
 assigned:'작업대기',running:'작업중',waiting:'작업중',hold:'일시정지',
 // 끝
 done:'완료',cancelled:'취소',superseded:'대체',
 // 실행 기록으로 계산한 상태. 사람이 확인할 신호라 묶음과 별도로 둔다.
 unconfirmed:'발령됨',orphaned:'세션 확인 필요',failed:'실패','needs-check':'확인 필요',unknown:'확인 필요',
 // 판 전체가 아직 시작 전일 때 쓰는 판 상태
 planned:'진행 전'
};
const bucketOf={draft:'before',ready:'before',archived:'before',planned:'before',assigned:'active',running:'active',waiting:'active',hold:'active',done:'end',cancelled:'end',superseded:'end'};
export const statusLabel=state=>STATUS_LABELS[state]??state;
// 묶음: before(진행 전)·active(진행 중)·end(끝)·check(확인 필요). 모르는 상태와 실행 확인 상태는 check로 보낸다. 끝난 것처럼 숨기지 않는다.
export const statusBucket=state=>bucketOf[state]??'check';
// 보류(archived)는 끝이 아니다. 시작 전에 미뤄 둔 카드라 완료·취소·대체만 끝으로 센다.
export const isEnded=state=>statusBucket(state)==='end';
// 상태 필터·상태 변경 이력처럼 저장 코드를 하나씩 구분해야 하는 곳에서만 쓴다. 작업중 두 칸이 같은 글자로 보이지 않게 한다.
export const exactStatusLabel=state=>state==='waiting'?'작업중 · 기다림':statusLabel(state);

// `kadan mail`이 실패할 때 "받는 쪽에 갔을 수 있는가"를 종료 코드로 넘기는 약속(2026-11-10, Autopilot Wingman 판정).
// 오류 문구를 맞춰 보지 않으려고 만든 기계용 값이다. 켜는 쪽(환경변수 KADAN_MAIL_DELIVERY_EXIT=1)만 받고,
// 켜지 않은 다른 호출자는 지금처럼 실패를 error.exitCode || 1로 받는다.
//   0  전달(또는 보관) 성공
//   3  확실히 안 감(not-sent) — 바닥이 not-sent로 표시한 실패, 또는 전송 함수를 부르기 전에 난 실패
//   4  전달됨·기록 실패(sent) — 창에 붙여넣은 뒤 원장 기록만 실패
//   5  불명확(unknown) — 붙여넣는 중에 실패했거나 전달 상태 표시가 없는 실패
// 읽는 쪽은 3만 "안 감"으로 본다. 1을 비롯한 그 밖의 코드는 붙여넣기 뒤의 일반 오류일 수 있어 불명확이다.
export const MAIL_DELIVERY_EXIT_ENV = 'KADAN_MAIL_DELIVERY_EXIT';
export const MAIL_EXIT_NOT_SENT = 3;
export const MAIL_EXIT_SENT = 4;
export const MAIL_EXIT_UNKNOWN = 5;

// send.mjs의 실패 종료 코드. beforeSend: 전송 함수(guardedSend)를 부르기 전에 난 실패면 true(위치상 안 감).
// 켜지 않았으면 예전 그대로(error.exitCode || 1)다.
export function mailFailureExitCode(error, env = process.env, {beforeSend = false} = {}) {
  if (env?.[MAIL_DELIVERY_EXIT_ENV] !== '1') return error?.exitCode || 1;
  if (error?.delivery === 'sent') return MAIL_EXIT_SENT;
  if (error?.delivery === 'not-sent' || (beforeSend && error?.delivery == null)) return MAIL_EXIT_NOT_SENT;
  return MAIL_EXIT_UNKNOWN;
}

// 자식 프로세스 결과(spawnSync) → 전달 상태. 3만 not-sent, 0은 ok, 4는 sent, 그 밖(1·5·모르는 코드·시간 초과·신호)은 unknown.
export function mailDeliveryOf({status, signal, error}) {
  if (error || signal || status == null) return 'unknown';
  if (status === 0) return 'ok';
  if (status === MAIL_EXIT_NOT_SENT) return 'not-sent';
  if (status === MAIL_EXIT_SENT) return 'sent';
  return 'unknown';
}

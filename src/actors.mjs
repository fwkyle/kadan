// 사용자(사람)로 인정하는 행위자 이름. 원장 by 값은 스스로 밝힌 신분이라 인증이 아니다.
// 기본은 '사람'·'사용자'·'@user'이고, 기계마다 추가 이름은 KADAN_USER_NAMES(쉼표 구분)로 준다.
export function userActorNames(env=process.env){
 const extra=String(env.KADAN_USER_NAMES||'').split(',').map(s=>s.trim()).filter(Boolean);
 return ['사람','사용자','@user',...extra];
}
export function isUserActor(by,env=process.env){return userActorNames(env).includes(by);}
// 슈퍼감독 역할 이름(…슈퍼감독, …슈퍼감독-2). 결정 요청 작성과 나이트 모드 명령이 같은 규칙을 쓴다. 인증이 아니라 스스로 밝힌 이름이다.
export function isSupervisorActor(by){return typeof by==='string'&&/(^|-)슈퍼감독(?:-\d+)?$/.test(by);}
// 디코 다리(kadan discord watch --to-mail)가 저장하는 우편의 보낸이. 받는이는 우편마다 다르다(비서 또는 레포 슈퍼). 원장의 by로만 판별한다(본문 문자열 금지).
export const DISCORD_BY='디코';
// 설명 AI(explain-ai.mjs)가 brief 줄에 남기는 쓴 사람. 사용자 행위자(isUserActor)가 아니므로 알림·사람 판단으로 읽히지 않는다.
export const EXPLAIN_BY='설명AI';

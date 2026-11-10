// 시험용 세대별 출력 기록 경로. 실제 형식(…/out/<세션>/<만든 시각>-<UUID>/manifest.json)과 같은 꼴이고 n마다 다른 값이다.
export const generationLog = (session, n) =>
  `/fixture/out/${session}/2026-11-10T00-00-00-000Z-00000000-0000-4000-8000-${String(n).padStart(12, '0')}/manifest.json`;
// 세대별 폴더 방식 이전의 고정 경로: 세션 이름으로만 정해진다.
export const legacyLog = session => `/fixture/out/${session}.log.gz`;

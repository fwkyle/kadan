// 시험 파일 목록을 조각으로 나눈다(npm test -- --shard=1/2). CI 우분투 잡이 조각마다 한 잡씩 동시에 돈다.
// 이름순 목록에서 번호를 돌려 가며 나눈다: 손으로 유지하는 목록이 없어, 새 파일은 이름 자리에 따라 저절로 한 조각에 들어간다.

// "1/2" 꼴만 받는다. 0/2, 3/2, 형식 오류는 이유를 적어 던진다.
export function parseShard(text) {
  const match = /^(\d+)\/(\d+)$/.exec(String(text).trim());
  if (!match) throw new Error(`조각 인자는 "번호/전체" 꼴이어야 합니다(예: 1/2): ${text}`);
  const index = Number(match[1]), total = Number(match[2]);
  if (!Number.isSafeInteger(total) || total < 1) throw new Error(`조각 전체 개수는 1 이상이어야 합니다: ${text}`);
  if (!Number.isSafeInteger(index) || index < 1 || index > total) {
    throw new Error(`조각 번호는 1부터 전체 개수(${total}) 사이여야 합니다: ${text}`);
  }
  return {index, total};
}

// files는 이미 정해진 순서(이름순)의 목록. 같은 입력이면 같은 결과이고, 모든 조각의 합집합이 전체다.
export function selectShard(files, {index, total}) {
  return files.filter((_, i) => i % total === index - 1);
}

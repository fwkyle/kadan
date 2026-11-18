import type {Choice} from './pages/Runners';

// 바꾸기 창의 '+ 새 모델 등록'이 기존 `/runners/model-add`로 보내는 칸. 새 서버 경로·검사는 없다.
// 서버는 바꾸는 이유가 필수라, 사람이 적지 않는 이 창에서는 화면이 채워 보낸다.
export const modelAddFields = (runner: string, model: string, efforts: string, revision: number) => ({
  runner, model: model.trim(), efforts: efforts.trim(), revision: String(revision),
  reason: `바꾸기 창에서 새 모델 등록: ${runner} / ${model.trim()}`,
  // 새 이름만: 화면이 아직 못 읽은 방금 등록과 겹쳐도 서버가 같은 이름이면 거절한다(강도 목록 교체 금지).
  newOnly: '1',
});

// 등록한 모델을 바로 고른 상태로 돌려준다. 강도는 지금 고른 강도를 새 모델이 지원할 때만 유지하고, 아니면 비워 고르게 한다
// (적은 목록의 첫 값으로 조용히 떨어지지 않는다).
export const registeredChoice = (
  runner: string, model: string, efforts: string, needsEffort: boolean, currentEffort = '',
): Choice => {
  const listed = efforts.split(',').map(v => v.trim()).filter(Boolean);
  return {runner, model: model.trim(), effort: needsEffort && listed.includes(currentEffort) ? currentEffort : ''};
};

// 이미 그 실행기 목록에 있는 이름인가. 기존 서버 경로는 같은 이름이면 강도 목록을 교체해, 그 모델을 쓰는 역할이 서버 검사에 걸린다.
export const alreadyRegistered = (models: {model: string}[], model: string) => models.some(m => m.model === model.trim());

type Save = (action: string, fields: Record<string, string>, token: string) => Promise<{result: {revision?: number}}>;

// 등록 한 번: 기존 /runners/model-add 호출 → 성공했을 때만 done(고른 선택, 새 설정 버전)을 부른다.
// 실패하면 던지고 done을 부르지 않으므로 작성 중인 변경안은 그대로다.
export async function registerModel(
  save: Save, token: string,
  args: {runner: string; model: string; efforts: string; revision: number; needsEffort: boolean; currentEffort?: string},
  done: (choice: Choice, revision: number) => void,
) {
  const saved = await save('/runners/model-add', modelAddFields(args.runner, args.model, args.efforts, args.revision), token);
  const choice = registeredChoice(args.runner, args.model, args.efforts, args.needsEffort, args.currentEffort);
  done(choice, saved.result.revision ?? args.revision);
  return choice;
}

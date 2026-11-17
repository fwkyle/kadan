// kadan trash show | set <절대경로> --reason <이유> | clear --reason <이유> — 휴지통 자리를 이 기계의 KADAN_HOME에 고정한다.
// 읽는 순서·거절 규칙은 src/trash-dir.mjs 머리말이 원본이다. 명령은 `kadan window`와 같은 모양이다.
import { ledgerHome } from "../ledger.mjs";
import { die } from "../cli-basics.mjs";
import {
  TRASH_ENV,
  TRASH_RECOVERY_HINT,
  clearTrashSetting,
  readTrashSetting,
  resolveTrash,
  setTrashSetting,
  trashSettingPath,
} from "../trash-dir.mjs";

export const TRASH_USAGE = "사용법: kadan trash show | set <절대경로> --reason <이유> | clear --reason <이유>";

const SOURCE_NAME = { env: "환경변수", setting: "기계 설정", default: "기본값" };

function showText(home, env) {
  const lines = [];
  let setting = null, broken = null;
  try { setting = readTrashSetting(home); } catch (error) { broken = error.message; }
  lines.push(`기계 설정(${trashSettingPath(home)}): ${broken ? "설정 손상" : setting ? setting.dir : "미설정"}`);
  if (setting?.reason) lines.push(`  이유: ${setting.reason} (${setting.updatedAt})`);
  if (broken) return [...lines, broken, TRASH_RECOVERY_HINT].join("\n");
  try {
    const now = resolveTrash(home, { env });
    lines.push(`이 셸에서 파일을 옮길 자리: ${now.dir} (${SOURCE_NAME[now.source]}${now.dated ? ", 오늘 날짜 폴더 포함" : ""})`);
  } catch (error) { lines.push(`이 셸에서는 옮기지 않는다(거절): ${error.message}`); }
  if (env[TRASH_ENV] !== undefined && setting) lines.push(`참고: 환경변수 ${TRASH_ENV}가 기계 설정보다 먼저다`);
  return lines.join("\n");
}

export function cmdTrash(argv, flags, { home = ledgerHome(), env = process.env, print = console.log } = {}) {
  const [action, value] = argv;
  const reason = flags.reason;
  if (action === "show" && argv.length === 1) return print(showText(home, env));
  if ((action === "set" && argv.length === 2) || (action === "clear" && argv.length === 1)) {
    if (typeof reason !== "string" || reason.trim() === "") die(`--reason이 필요하다: 왜 바꾸는지 한 줄로 적는다\n${TRASH_USAGE}`, 2);
    if (action === "clear") {
      const before = clearTrashSetting(home);
      return print(before ? `휴지통 설정을 지웠다 (이전 값: ${before.dir}). 이제 환경변수 또는 기본 ${home}/.trash를 따른다` : "지울 휴지통 설정이 없다");
    }
    let saved;
    try { saved = setTrashSetting(home, { dir: value, reason }); } catch (error) { die(error.message, 2); }
    return print(`휴지통 자리를 고정했다: ${saved.dir} (옮길 때 <날짜> 폴더가 붙는다). 재시작은 필요 없다`);
  }
  die(TRASH_USAGE, 2);
}

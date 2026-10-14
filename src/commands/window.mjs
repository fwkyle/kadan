// kadan window set|show|unset — 창 선택(로티/백그라운드)을 이 기계의 KADAN_HOME에 고정한다.
// 명령 이름은 기존 `runners`·`autostart`처럼 대상 이름 뒤에 하위 명령을 두는 방식을 따랐다.
import { ledgerHome } from "../ledger.mjs";
import { die } from "../cli-basics.mjs";
import {
  describeWindowSetting,
  effectiveWindow,
  setWindowSetting,
  unsetWindowSetting,
  windowSettingPath,
} from "../window-setting.mjs";

const USAGE = "사용법: kadan window show | set rottie [--rottie-bin <절대경로>] | set none | unset";

function showText(home, env) {
  const setting = describeWindowSetting(home);
  const lines = [`기계 설정(${windowSettingPath(home)}): ${setting.label}${setting.rottieBin ? ` ${setting.rottieBin}` : ""}`];
  if (setting.kind === "broken") return [...lines, setting.error].join("\n");
  const now = effectiveWindow(env, home);
  const sourceName = { env: "환경변수", setting: "기계 설정", default: "기본값" };
  lines.push(`이 셸에서 실제로 쓰는 창: ${now.window.value} (${sourceName[now.window.source]})`);
  if (now.rottieBin.value) lines.push(`이 셸에서 실제로 쓰는 로티 경로: ${now.rottieBin.value} (${sourceName[now.rottieBin.source]})`);
  if (env.KADAN_WINDOW && setting.kind !== "unset" && env.KADAN_WINDOW !== setting.kind)
    lines.push(`참고: 환경변수 KADAN_WINDOW=${env.KADAN_WINDOW}가 기계 설정보다 먼저다`);
  return lines.join("\n");
}

export function cmdWindow(argv, flags, { home = ledgerHome(), env = process.env, print = console.log } = {}) {
  const [action, value] = argv;
  if (action === "show" && argv.length === 1) return print(showText(home, env));
  if (action === "unset" && argv.length === 1) {
    const before = unsetWindowSetting(home);
    return print(before ? `창 선택 설정을 지웠다 (이전 값: ${before.window}). 이제 환경변수 또는 기본 none을 따른다` : "지울 창 선택 설정이 없다");
  }
  if (action === "set" && argv.length === 2) {
    if (flags["rottie-bin"] === true) die("--rottie-bin에는 절대경로가 필요하다", 2);
    try { setWindowSetting(home, { window: value, rottieBin: flags["rottie-bin"], env }); } catch (error) { die(error.message, 2); }
    print(`창 선택을 고정했다.\n${showText(home, env)}`);
    return;
  }
  die(USAGE, 2);
}

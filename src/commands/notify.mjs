// kadan notify show|set discord --env-file <절대경로>|unset — 사용자 알림(디스코드) 비밀 파일 경로를 KADAN_HOME에 고정한다.
// 주소·사용자 ID는 설정에 복사하지 않는다. show도 값은 보여 주지 않고 "있음/없음"만 말한다.
import { ledgerHome } from "../ledger.mjs";
import { die } from "../cli-basics.mjs";
import {
  NOTIFY_ENV_VAR,
  effectiveNotifyEnvFile,
  notifySettingPath,
  readDiscordSecrets,
  setNotifySetting,
  unsetNotifySetting,
} from "../notify-setting.mjs";

const USAGE = "사용법: kadan notify show | set discord --env-file <절대경로> | unset";

function showText(home, env) {
  const now = effectiveNotifyEnvFile(env, home);
  const lines = [`알림 설정(${notifySettingPath(home)})`];
  if (now.error) return [...lines, now.error, "kadan notify unset 으로 지우거나 kadan notify set discord --env-file <절대경로> 로 다시 고정한다"].join("\n");
  if (!now.envFile) return [...lines, "디스코드: 미설정 — 사용자 알림은 맥 시스템 알림으로만 간다"].join("\n");
  lines.push(`디스코드 비밀 파일: ${now.envFile} (${now.source === "env" ? `환경변수 ${NOTIFY_ENV_VAR}` : "기계 설정"})`);
  const sec = readDiscordSecrets(now.envFile);
  lines.push(sec.error ? `${sec.error} — 지금은 시스템 알림으로 내려간다` : "비밀 파일 확인: DISCORD_WEBHOOK_URL·DISCORD_USER_ID 있음");
  if (env.KADAN_NOTIFY === "off") lines.push("참고: KADAN_NOTIFY=off 라서 디스코드·결정 알림을 보내지 않는다");
  return lines.join("\n");
}

export function cmdNotify(argv, flags, { home = ledgerHome(), env = process.env, print = console.log } = {}) {
  const [action, target] = argv;
  if (action === "show" && argv.length === 1) return print(showText(home, env));
  if (action === "unset" && argv.length === 1) {
    const before = unsetNotifySetting(home);
    return print(before ? "알림 설정을 지웠다. 이제 환경변수 또는 시스템 알림만 쓴다" : "지울 알림 설정이 없다");
  }
  if (action === "set" && target === "discord" && argv.length === 2) {
    if (typeof flags["env-file"] !== "string") die("--env-file에는 비밀 파일의 절대경로가 필요하다", 2);
    try { setNotifySetting(home, { envFile: flags["env-file"] }); } catch (error) { die(error.message, 2); }
    print(`알림 설정을 고정했다.\n${showText(home, env)}`);
    return;
  }
  die(USAGE, 2);
}

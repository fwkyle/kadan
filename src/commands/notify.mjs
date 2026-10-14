// kadan notify show|set discord --env-file <절대경로>|unset — 사용자 알림(디스코드) 비밀 파일 경로.
// 위치 규칙은 `kadan secrets`(이름 discord)와 같은 설정이다. 옛 명령은 별칭으로 남긴다:
//   notify set discord --env-file <경로>  =  secrets set discord --file <경로>
//   notify unset                          =  secrets unset discord
// 주소·사용자 ID는 설정에 복사하지 않는다. show도 값은 보여 주지 않고 "있음/없음"만 말한다.
import { ledgerHome } from "../ledger.mjs";
import { die } from "../cli-basics.mjs";
import { LEGACY_DISCORD_ENV_VAR, setSecretFile, unsetSecretFile, secretsSettingPath } from "../secrets.mjs";
import {
  effectiveNotifyEnvFile,
  listRepoWebhookKeys,
  readDiscordSecrets,
} from "../notify-setting.mjs";

const USAGE = "사용법: kadan notify show | set discord --env-file <절대경로> | unset  (kadan secrets set discord --file <경로> 와 같다)";
const SOURCE_TEXT = { env: "환경변수", setting: "기계 설정", default: "기본 위치" };

function showText(home, env) {
  const now = effectiveNotifyEnvFile(env, home);
  const lines = [`알림 설정(${secretsSettingPath(home)})`];
  if (now.error) return [...lines, now.error, "kadan notify unset 으로 지우거나 kadan notify set discord --env-file <절대경로> 로 다시 고정한다"].join("\n");
  if (!now.envFile) lines.push("디스코드 기본: 미설정 — 사용자 알림은 맥 시스템 알림으로만 간다");
  else {
    lines.push(`디스코드 기본 비밀 파일: ${now.envFile} (${SOURCE_TEXT[now.source]})`);
    const sec = readDiscordSecrets(now.envFile, { checkDir: now.source === "default" });
    lines.push(sec.error ? `${sec.error} — 지금은 시스템 알림으로 내려간다` : "기본 비밀 파일 확인: DISCORD_WEBHOOK_URL·DISCORD_USER_ID 있음");
    for (const w of sec.warnings ?? []) lines.push(w);
    const keys = listRepoWebhookKeys(now.envFile);
    if (keys.length) lines.push(`레포 포럼 웹훅 키: ${keys.join(", ")} (업무 키가 있는 알림만 그 레포 글로 간다)`);
  }
  if (env[LEGACY_DISCORD_ENV_VAR] && env.KADAN_SECRET_DISCORD_FILE && env[LEGACY_DISCORD_ENV_VAR] !== env.KADAN_SECRET_DISCORD_FILE)
    lines.push(`참고: KADAN_SECRET_DISCORD_FILE과 ${LEGACY_DISCORD_ENV_VAR}가 모두 있다 — KADAN_SECRET_DISCORD_FILE이 이긴다`);
  if (env.KADAN_NOTIFY === "off") lines.push("참고: KADAN_NOTIFY=off 라서 디스코드·결정 알림을 보내지 않는다");
  return lines.join("\n");
}

export function cmdNotify(argv, flags, { home = ledgerHome(), env = process.env, print = console.log } = {}) {
  const [action, target] = argv;
  if (action === "show" && argv.length === 1) return print(showText(home, env));
  if (action === "unset" && argv.length === 1) {
    return print(unsetSecretFile(home, "discord") ? "알림 설정을 지웠다. 이제 환경변수, 기본 위치(secrets/discord.env) 또는 시스템 알림만 쓴다" : "지울 알림 설정이 없다");
  }
  if (action === "set" && target === "discord" && argv.length === 2) {
    if (typeof flags["env-file"] !== "string") die("--env-file에는 비밀 파일의 절대경로가 필요하다", 2);
    try { setSecretFile(home, "discord", flags["env-file"]); } catch (error) { die(error.message.replace("--file", "--env-file"), 2); }
    print(`알림 설정을 고정했다.\n${showText(home, env)}`);
    return;
  }
  die(USAGE, 2);
}

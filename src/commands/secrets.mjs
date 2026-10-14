// kadan secrets show [이름] | set <이름> --file <절대경로> | unset <이름> | init — 비밀 파일 위치 규칙.
// 값은 저장도 출력도 하지 않는다. show는 출처·경로·키 이름·권한 경고만 보여 준다.
import { ledgerHome } from "../ledger.mjs";
import { die } from "../cli-basics.mjs";
import {
  SECRET_NAMES,
  assertSecretName,
  initSecretsDir,
  loadSecret,
  secretEnvVar,
  setSecretFile,
  unsetSecretFile,
} from "../secrets.mjs";

const USAGE = `사용법: kadan secrets show [이름] | set <이름> --file <절대경로> | unset <이름> | init  (이름: ${SECRET_NAMES.join(", ")})`;
const SOURCE_TEXT = { env: "환경변수", setting: "기계 설정", default: "기본 위치" };

export function secretLines(env, home, name) {
  const s = loadSecret(env, home, name);
  if (s.source === "broken") return [`${name}: 설정 손상 — ${s.error}`, `  kadan secrets unset ${name} 으로 지우거나 kadan secrets set ${name} --file <절대경로> 로 다시 고정한다`];
  const head = `${name}: ${SOURCE_TEXT[s.source]}(${s.via}) · ${s.path}`;
  if (s.error) return [`${head}`, `  ${s.error}`];
  if (!s.values) return [`${head}`, "  파일 없음 — 아직 만들지 않았다"];
  const keys = Object.keys(s.values).sort();
  return [head, `  키: ${keys.length ? keys.join(", ") : "(없음)"}`, ...s.warnings.map((w) => `  ${w}`)];
}

export function cmdSecrets(argv, flags, { home = ledgerHome(), env = process.env, print = console.log } = {}) {
  const [action, name] = argv;
  if (action === "show" && argv.length <= 2) {
    if (name) try { assertSecretName(name); } catch (error) { die(error.message, 2); }
    const names = name ? [name] : SECRET_NAMES;
    return print([`비밀 위치 규칙(기본 폴더 ${home}/secrets, 환경변수 > 기계 설정 > 기본 위치)`, ...names.flatMap((n) => secretLines(env, home, n))].join("\n"));
  }
  if (action === "init" && argv.length === 1) {
    const r = initSecretsDir(home);
    return print(r.created ? `빈 비밀 폴더를 만들었다(권한 700): ${r.dir}\n값 파일은 직접 만든다(권한 600): ${SECRET_NAMES.map((n) => `${n}.env`).join(", ")}` : `이미 있다: ${r.dir} (권한은 바꾸지 않았다)`);
  }
  if (action === "set" && argv.length === 2) {
    if (typeof flags.file !== "string") die("--file에는 비밀 파일의 절대경로가 필요하다", 2);
    try { setSecretFile(home, name, flags.file); } catch (error) { die(error.message, 2); }
    const envName = secretEnvVar(name);
    print(`${name} 위치를 고정했다(환경변수 ${envName}가 있으면 그쪽이 먼저다).\n${secretLines(env, home, name).join("\n")}`);
    return;
  }
  if (action === "unset" && argv.length === 2) {
    try { assertSecretName(name); } catch (error) { die(error.message, 2); }
    return print(unsetSecretFile(home, name) ? `${name} 고정을 풀었다. 이제 환경변수 또는 기본 위치만 쓴다` : `${name}에 풀 고정이 없다`);
  }
  die(USAGE, 2);
}

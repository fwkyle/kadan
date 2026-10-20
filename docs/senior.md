# 시니어

## Why

슈퍼감독을 항상 비싼 모델로 돌리기는 부담스럽다(2026-10-05 [kyle]). 그런데 작업 결과를 받고 결정해야 할 부분(검수 판정이 갈림, 결과대로 갈지 되돌릴지 등)은 값싼 모델의 판단만으로 넘기기 불안하다. 시니어는 그 간극을 메운다: 감독이 그 결과를 두고 고급 모델에게 **한 번** 의견을 묻고, 답을 읽고 스스로 판단하거나 사용자에게 올린다.

- **Claude Code 어드바이저와는 다른 기능이다**(2026-10-05 [kyle] 정리). 어드바이저는 카드를 완수하려고 Claude Code 기능을 최대한 쓰는 것으로, 판단이 무거운 카드를 쓰기 전에 묻고 카드의 `advisor 자문 요지` 칸에 적는다(2026-09-27부터, 지침의 기존 규칙 그대로). 시니어는 작업 결과에 결정할 부분이 있을 때 의견을 구하는 것이다. 서로를 대신하지 않는다.
- 자문은 **기록이지 결정이 아니다.** 카드 상태·범위를 바꾸지 않고 우편을 보내지 않는다. 감독이 판단 근거로 쓰고, 필요하면 카드 기록(`card note --kind decision`)에 요지를 남긴다. 사용자 결정이 필요하면 그대로 `decision request`로 올린다.
- 호출 방식은 감시 AI와 같다. `scripts/senior.sh`가 `codex exec`로 한 번 돌리고, 입력·답변·진단을 `KADAN_HOME/advice/<호출ID>/`에 남긴다. 세션을 띄우지 않으므로 발령·감시 대상이 아니다. 로티 창을 쓰는 기계에서는 호출이 도는 동안만 진행 출력을 읽기 전용으로 따라 보는 탭이 뜬다([따라 보기](#따라-보기-탭)).
- **저장소 문맥은 시니어가 직접 읽는다.** 카드의 저장소 폴더(`repoPath`)에서 읽기 전용 샌드박스로 돌리므로 그 저장소의 파일·이력을 스스로 본다. 슈퍼감독이 여러 저장소의 문맥을 들고 있을 필요가 없다. codex가 자동으로 읽는 안내 파일은 `AGENTS.md`이고, 없으면 `CLAUDE.md`·`.agents.md`를 대신 읽는다(`senior.sh`가 `project_doc_fallback_filenames`를 명시, 2026-10-05). 그 밖의 이름이거나 하위 폴더의 문서라면 `--file <절대경로>`로 함께 넘긴다.

- **이름**: 처음 이름은 자문위원(`advisor`, 명령 `kadan advise`)이었다. Claude Code의 advisor 도구와 헷갈려 2026-10-05 [kyle] 결정으로 시니어(`senior`)로 바꿨다. 옛 명령 `kadan advise`와 실행 모델 설정의 옛 키 `roles.advisor`는 그대로 읽힌다(설정은 다음 저장 때 `senior`로 남는다). 시니어가 남기는 기록은 계속 자문(`advice` 사건, `KADAN_HOME/advice/` 폴더)이라 부른다.

## 명령

```
KADAN_ROLE=<감독> kadan senior <카드키> --question "<질문>" [--file <절대경로>]... [--timeout <초>]
```

- 부를 수 있는 명의: 감독(이름이 `감독`·`슈퍼감독`으로 끝나는 역할)과 사람. 작업자·검수자는 거절된다 — 자기 카드의 판단은 감독에게 묻는다.
- 입력: 질문, 카드 본문(`card.md`), 첨부 파일(절대경로, 5개·각 64KB까지). 더 큰 자료는 필요한 부분만 잘라 넣는다.
- 모델: 실행 모델 설정의 `senior` 값([실행 모델 설정](runner-settings.md#시니어)). 없으면 거절한다. 폴백은 없다. 2번 자리(`senior2`)가 있으면 같은 질문에 병렬로 함께 부른다([두 번째 자리](#두-번째-자리-2026-10-20-kyle-요청-시니어를-최대-2개로)).
- 상한: 기본 1800초(30분), `--timeout`으로 1..3600초. 고급 모델이 저장소를 읽고 시험까지 돌려 보며 오래 고민할 수 있게 넉넉히 둔다(2026-10-05 [kyle]).
- 결과: 영수증(JSON)과 답변 본문을 출력한다. 답변은 네 칸이다 — **결론** 한 줄, **근거**(저장소·카드에서 확인한 사실과 경로), **위험**(따를 때·안 따를 때, 되돌리기 어려운 것 먼저), **확인할 것**(감독이 결정 전에 열어 볼 경로·되물을 질문).
- 실패: 시간 초과(`timeout`), 호출 실패(`call-failed`, 종료 코드 ≠ 0), 빈 답(`empty`)은 종료 코드 1이고 답을 쓰지 않는다(fail closed). 재시도는 감독이 명령을 다시 부르는 것이다.

## 두 번째 자리 (2026-10-20 [kyle] 요청: 시니어를 최대 2개로)

Why: 감독이 결정할 부분을 한 시니어의 의견만으로 넘기기 불안할 때, 다른 계열 모델의 답을 같은 질문으로 한 번에 받아 나란히 보기 위해서다. 후보는 agy `gemini-4-argon-medium`이었다.

**지금 상태: 배관은 있고 2번 자리는 막혀 있다(gated off).** 아래 측정 결과 때문에 어떤 실행기도 2번 자리로 열지 않았다(`SENIOR2_ALLOWED_RUNNERS = []`, `src/runner-settings.mjs`). 읽기 전용이 확인된 실행기를 이 목록에 넣으면 열린다.

### 측정 관문 (2026-10-20, agy 1.3.5, 격리 폴더·가장 싼 argon 변형 `gemini-4-argon-low`)

| 질문 | 실측 | 판정 |
|---|---|---|
| `--print`가 파일을 쓰거나 명령을 실행할 수 있는가 | 기본 모드: 허용 규칙에 없는 쓰기(`write_file`)·명령(`touch`)은 헤드리스에서 **자동 거부**됐다("headless mode cannot prompt"). 그러나 사용자 agy 설정(`~/.gemini/antigravity-cli/settings.json`)의 `permissions.allow`에 `command(cp)`·`command(mkdir)`·`command(ln)`·`command(git add)`·`command(git commit)`이 있어 `cp src.txt target.txt`가 **실제로 파일을 덮어썼다**. `--sandbox`도 같은 `cp`가 통과했다. `--mode plan`은 명령을 실행하지 않았지만 답 대신 계획 파일(`~/.gemini/antigravity-cli/brain/…`)을 썼다 | **나쁨** — 쓰기 가능 여부가 호출자가 통제하지 못하는 사용자 설정에 달려 있고, 답을 내면서 읽기 전용인 모드가 없다 |
| 90초 상한 | `--print-timeout`의 기본은 0(무제한)이고 90초는 실행기 표 exec 틀에 적힌 값(`docs/runner-settings.md`)이다. 30KB 프롬프트에 짧은 질문은 모델 시간 3.6초(전체 10.7초), 쓰기 거부 시험은 15~48초가 걸렸다 | 짧은 질문엔 충분하나 생각이 긴 시니어 질문은 90초를 넘길 수 있다. 시니어 기본(30분)과 맞지 않는다 |
| 프롬프트 인자 크기 | 글은 `"$KADAN_EXPLAIN_PROMPT"`로 명령 인자가 된다. macOS `ARG_MAX`는 1MiB이고 환경변수 사본이 같이 세어져 400KB는 통과, 600KB는 실패했다 | 2번 자리 프롬프트를 200KB(`SECOND_PROMPT_LIMIT_BYTES`)로 막는다. 첨부 최대치(5×64KB=320KB)는 넘을 수 있다 |
| 카드 글 가림 | `composeAdvicePrompt` 결과에 `scrubForAI`가 적용되지 않았다(codex 1번 자리 포함) | 이 변경에서 **두 자리 모두** 가린다 |

고른 갈래: 쓰기 가능 + 읽기 전용 모드 없음 → 카드 지시대로 배관만 만들고 agy 자리는 막아 둔다. 90초는 (나)로 둔다: 열릴 실행기의 exec 틀이 정한 시간이 곧 그 자리의 상한이고, 초과하면 `timeout`/`call-failed`/`empty`로 **원장에 남는다**(조용히 사라지지 않는다). `{timeout}` 자리를 틀에 더하는 (가)는 읽기 전용 문제가 풀려 실제로 열 때 정한다.

### 동작

- 설정: 활성 프리셋의 `roles.senior2`(옛 설정 파일에는 없고 그대로 읽힌다). 1번 자리 `roles.senior`는 codex 전용 그대로이고 `scripts/senior.sh`·1자리 경로는 바이트 그대로다.
- 명령: `kadan runners set senior2 --runner <실행기> --model <모델> --revision N --reason …`(열린 실행기만 받는다), 비우기 `kadan runners clear senior2 --revision N --reason …`. `runners fallback senior|senior2`는 거절한다(두 자리는 차례가 아니라 병렬). 정책 차단 `block --roles senior`는 2번 자리에도 적용된다. 감시 AI(watch)는 그대로 codex 전용이다.
- 실행: 2번 자리가 있으면 `kadan senior`가 두 자리를 **병렬로** 부른다. 시간 상한(`--timeout`)은 자리마다 따로 걸린다. 한쪽이 시간 초과·호출 실패·빈 답이어도 다른 쪽은 멈추지 않고 답이 남는다.
- **2번 자리는 저장소를 읽지 않는다.** 설명 AI처럼 실행기 표의 exec 틀로 **빈 호출 폴더**(`advice/<호출ID>/`)에서 돌므로 프롬프트(질문·카드 본문·첨부)에 든 자료만으로 답한다. 1번 자리는 지금처럼 저장소를 읽기 전용으로 직접 읽는다. 프롬프트도 그 차이를 알린다. 저장소 내용을 근거로 삼아야 하는 질문이면 `--file`로 필요한 부분을 넘긴다.
- `--effort`는 1번 자리(codex)에만 적용한다. 2번 자리는 모델 이름에 강도가 들어 있어 무시하며, 결과에 `effortNote` 한 줄로 알린다(출력에도 찍는다).
- 출력: 영수증 JSON(`slots` 배열: 자리·실행기·모델·`reason`·`durationMs`·`evidencePath`)에 이어 자리 순서대로 `--- 자문 답변 N번 자리 (실행기/모델) ---` 머리말과 답을 낸다. 답이 없는 자리는 `답 없음: <reason>`으로 표시한다.
- **종료 코드**: 하나라도 답했으면 0, 둘 다 못 답했으면 1(메시지에 자리별 `reason`). 2번 자리를 안 쓰면 지금과 같다(답 하나, 실패는 1).
- 증거·원장: 자리마다 호출 폴더(`input.txt`·`result.txt`·`stderr.txt`)와 `advice` 사건 하나씩이다. 두 자리가 있을 때만 사건에 `slot`(1·2)·`pairId`(같은 호출의 묶음 ID)·`runner`가 붙는다. 2번 자리의 `reason`에는 `prompt-too-large`(200KB 초과)·`template-error`·`output-limit`가 더해진다. **2번 자리를 실행할 수 없으면(값이 없거나, 실행기가 허용 목록에 없거나, 모델이 정책으로 막힘) 두 자리 형식을 쓰지 않는다.** 영수증·머리말·원장 사건은 1자리 때와 같고(`adviceId`·`answer`·`evidencePath` 최상위, `slot`·`pairId` 없음), 막혔다는 사실은 stderr 한 줄로만 알린다. 탭 따라 보기는 1번 자리에만 뜨고 탭 상태 파일(`tab.json`)도 1번 폴더에만 생긴다.
- 외부 전송 가림: 두 자리 모두 완성된 프롬프트에서 웹훅 주소와 토큰 모양을 가린 뒤 보낸다(`scrubForAI`).

### 머지 뒤 운영 설정 (지금은 열 수 없음)

실행기를 연 뒤에만 아래를 감독이 kyle 승인 범위대로 실행한다. 이 변경은 운영 설정을 쓰지 않는다.

```
kadan runners show            # revision 확인
kadan runners set senior2 --runner agy --model gemini-4-argon-medium --revision <N+1> --reason "시니어 2번 자리"
```

agy는 운영 실행기 표에 argon 모델이 아직 없다(`gemini-3.8-flash-low|medium`만 있음). 열 때 `kadan runners model agy gemini-4-argon-medium --efforts '' --revision N --reason …`로 먼저 등록한다.

agy를 열려면 먼저 (1) 읽기 전용이 보장되는 방법(허용 규칙 없는 격리 설정으로 호출하는 틀, 또는 읽기 전용 모드)을 실측하고 (2) `SENIOR2_ALLOWED_RUNNERS`에 `agy`를 넣고 (3) 시간 상한 방침을 정한다.

## 실측 시험

시니어는 비싼 모델이라 실제로 부르는 시험은 강도를 낮춰 돌린다(2026-10-05 [kyle]).

- `kadan senior … --effort low`: 이번 호출만 강도를 바꾼다. 실행 모델 설정은 그대로이고, 원장에는 `effort`(쓴 값)·`effortOverride: true`·`settingsEffort`(설정 값)가 남는다. 모델이 지원하지 않는 강도는 호출 전에 거절한다.
- `npm run smoke:senior [-- --effort low --timeout 600]`: 임시 `KADAN_HOME`에 실행 모델 설정만 복사하고 가상 카드 하나로 실제 모델을 한 번 부른다. 답에 결론·근거·위험·확인할 것 네 칸이 있으면 통과. 비용이 들어 `npm test`에는 넣지 않는다. 운영 원장은 건드리지 않는다.

## 원장 기록

호출마다 `advice` 사건 하나를 남긴다(성공·실패 모두). `by`(부른 감독), `card`, `adviceId`, 질문 앞 200자와 지문, `model`·`effort`·`settingsRevision`·`settingsPreset`, `reason`(`ok`·`timeout`·`call-failed`·`empty`), `exitCode`, `durationMs`, 답변 `bytes`·`digest`, 첨부 `files`, `evidencePath`, 그리고 따라 보기 탭의 `tab`·`tabReason`(건너뛴 이유 또는 닫기 결과)·`rottieTerminalId`(열렸을 때만). 새 사건 종류는 만들지 않고 같은 `advice` 사건에 필드만 더했다. 답변 본문은 원장에 넣지 않고 증거 폴더의 `result.txt`에만 둔다. 기록 화면에서는 **자문**으로 보인다. 사건은 호출이 끝난 뒤 쓰므로, 호출 도중 명령이 죽으면 증거 폴더만 있고 사건이 없을 수 있다. 손상이 아니라 끝나지 못한 호출이다.

횟수 제한은 일부러 두지 않는다(2026-10-05 [kyle] 결정): 감독이 필요할 때만 부르는 것이 전제이고, 같은 카드로 다시 부르면 다시 돈다(비용이 든다). "카드당 1회"는 템플릿의 기본 습관이지 명령이 막는 규칙이 아니다.

## 언제 묻는가

[슈퍼감독](../skills/kadan-conductor/references/role-templates/super.md)·[일반감독](../skills/kadan-conductor/references/role-templates/conductor.md) 템플릿의 규칙 그대로다: 작업 결과를 받고 결정할 부분이 있을 때(검수 판정이 갈림, 결과대로 갈지 되돌릴지 등) 한 번 묻는다. 카드를 쓰기 전의 자문은 시니어가 아니라 Claude Code 어드바이저의 몫이다. 보통 결정 하나에 1회로 끝낸다(필요하면 더 불러도 막지 않는다). 취향·제품 방향처럼 사용자만 답할 수 있는 질문은 자문으로 대신하지 않는다 — [질문 사다리](../skills/kadan-conductor/references/tiki-taka.md)대로 우편과 결정 요청으로 올린다.

## 따라 보기 탭

Why: kyle이 시니어가 무엇을 읽고 어떻게 고민하는지 화면에서 보고 싶다(2026-10-16 [kyle]). 시니어는 여전히 일회성 호출이고 역할 세션이 아니다.

- **언제 뜨나**: 창 설정이 `rottie`이고(`kadan window`), 로티 실행 파일 경로가 있고, 기본이 아닌 홈이 운영 로티에 닿는 것을 막는 보호(`live-floor-guard`)를 통과하고, 카드의 저장소 폴더(`repoPath`)가 로티에 이미 열려 있을 때. `KADAN_SENIOR_TAB=off`로 끄고 `on`으로 켠다(없으면 켬).
- **무엇이 뜨나**: `scripts/senior-follow.sh <호출 폴더> <kadan senior의 PID>`가 도는 탭. `diagnostic.log`를 `tail -F`로 보여 주는 읽기 전용이고 입력을 받지 않는다. `exit-code.txt`가 생기거나 부모 PID가 사라지면 스스로 끝난다(TERM으로 죽은 `kadan senior`는 `exit-code.txt`를 남기지 않아서).
- **역할이 아니다**: `KADAN_ROLE`·`kadan-*` 이름을 쓰지 않고 제목은 `시니어 · <카드키>`, 멱등 키는 `kadan-senior-<호출ID>`다. `start` 원장 사건을 쓰지 않으므로 `kadan status`·바닥 `list()`·감시기가 잡지 않는다.
- **탭은 꾸밈이다**: 앱 꺼짐(`ROTTIE_APP_NOT_RUNNING`)·workspace 없음(`ROTTIE_WORKSPACE_NOT_OPEN`)·닫기 실패가 시니어 호출을 실패시키지 않는다. 앱을 띄우거나 workspace를 새로 추가하지 않는다.
- **닫기**: 성공·실패·시간 초과·TERM/INT 모두 `terminal close`를 부른다(신호 처리기는 create 전에 설치하고, create가 동기라 신호는 id를 받은 뒤 처리된다). 닫은 뒤 `show`가 NOT_FOUND면 사라진 것이고, 그 밖의 오류거나 남아 있으면 자기 탭 id만 `terminal remove`한다.
- **탭 없이 보려면**: 영수증의 `follow` 줄(`tail -F <호출 폴더>/diagnostic.log`)을 직접 실행한다.

| 경우 | `tab` | `tabReason` | kyle에게 보이는 것 |
|---|---|---|---|
| 창이 none | `skipped` | `window-none` | 탭 없음, 영수증의 `follow` 명령 |
| 스위치 off | `skipped` | `tab-off` | 같음 |
| 로티 경로 없음 | `skipped` | `rottie-bin-missing` | 같음 |
| 기본 아닌 홈이 운영 로티에 닿음 | `skipped` | `KADAN_LIVE_FLOOR_DENIED` | 같음 |
| 앱 꺼짐·workspace 없음 등 create 오류 | `skipped` | 로티 오류 코드 | 같음 |
| 열고 정상 닫음 | `closed` | 없음 | 호출 동안만 탭 |
| 닫은 뒤 목록에 남아 remove함 | `closed` | `removed-after-close` | 호출 동안만 탭 |
| 생성 응답이 유실·불확실(탭이 생겼을 수 있음). 로티 CLI가 JSON 없이 끝난 모든 경우(종료 코드·신호 무관), 응답 형식 오류, effect `unknown` 오류 | `unknown` | 로티 오류 코드 | 탭이 남을 수 있음. 원장 `tabKey`(`kadan-senior-<호출ID>`)로 사람이 찾는다. 제목·키로 목록을 뒤져 지우지 않는다 |
| 신호(TERM/INT)로 호출이 끝남 | 그때의 탭 상태 | — | 열린 탭은 닫고, 신호 처리기가 돌고 저장이 성공하면 원장에 `reason: interrupted` 사건이 남는다(아니면 `tab.json`만) |
| 닫은 뒤 show가 NOT_FOUND 아닌 오류 → remove 성공 | `closed` | `removed-after-show-error: …` | 호출 동안만 탭 |
| 닫기·remove 실패 | `close-failed` | 로티 오류 코드 | 탭이 남을 수 있음(`rottieTerminalId`로 직접 닫는다) |

### 알려진 한계

- **로티 실행 파일 첫 인자 가드**: 로티 실행 파일을 첫 인자가 `status|workspace|terminal|recovery`가 아닌 꼴(인자 없음·`--version`·오타)로 부르면 CLI가 아니라 앱 전체가 다시 떠서 약 3초 뒤 기존 창을 앞으로 가져온다(2026-10-16 로티 쪽 실측). `terminal create`·`workspace add` 자체는 맨 앞 앱·활성 탭을 바꾸지 않아 포커스 없는 생성 옵션은 필요 없다. 그래서 `runRottie`(`src/rottie-cli.mjs`)는 주입 spawn이어도 첫 인자를 먼저 검사해 `ROTTIE_ARGV_REJECTED`(effect none)로 실행하지 않는다.

- **어떤 종료에서 탭이 남을 수 있나**: 탭을 만드는 순간에 터미널 Ctrl-C처럼 프로세스 그룹 전체가 SIGINT를 받아 로티 CLI도 함께 죽은 경우, SIGKILL, 전원·강제 종료. 이때는 탭 주소(id)를 받지 못해 닫을 수 없고, 보기 탭 1개가 남을 수 있다. 주소를 모르면 정리하지 않는다(제목·키로 목록을 뒤져 지우면 남의 탭을 지울 수 있다).
- **남은 탭 찾는 법**: 호출 폴더 `KADAN_HOME/advice/<호출ID>/tab.json`의 `key`(`kadan-senior-<호출ID>`, create 전에 먼저 쓴다) 또는 원장 `advice` 사건의 `tabKey`를 보고, 로티에서 `시니어 · <카드키>` 제목의 탭을 직접 닫는다. 신호 처리기가 돌 수 있고 저장이 성공했을 때만 `reason: interrupted`로 원장에 남는다. 저장 거절·SIGKILL·전원 종료 때는 증거 폴더 `tab.json`만 남는다.
- **영향 없는 것**: 시니어 답·원장 기록·운영 카단. 탭은 꾸밈이라 남아도 읽기 전용 로그 화면 하나일 뿐이고, 따라 보기 스크립트는 부모가 사라지면 스스로 끝난다.

### 포커스 실측 (2026-10-16, 1회, kyle 허락)

로티 `terminal create`에는 포커스를 끄는 옵션이 없어 실제 로티로 한 번 쟀다. 조건: 격리 `KADAN_HOME`, `KADAN_ALLOW_LIVE_FLOOR=1`, 실제 로티, 가짜 `codex`(약 8초, 비용 0).

- 맨 앞 앱은 `osascript`로 읽기만 했다(포커스를 옮기는 명령 없음). 1초 간격으로 표본 10개(실행 전·실행 중 8·실행 후, 약 9초)를 읽었고 관측한 표본에서는 로티가 맨 앞에 없었다(맨 앞 앱이 Notion·Aside로 바뀐 것은 사용자 조작으로 추정되며 확정하지 않는다. 로티 없는 리허설에도 같은 변화가 있었다).
- 열린 동안 `terminal list`에 `시니어 · smoke/senior-probe` 하나가 `running`으로 보였고(839 → 840), 끝난 뒤 사라졌다(839). `terminal close` 뒤에도 목록에 남아 `terminal remove`가 필요했다 — 그래서 close 뒤 remove를 넣었다.
- **확인하지 못한 것**: 로티 안에서 새 탭이 선택(전환)되는지는 CLI 출력에 선택 필드가 없어 관찰하지 못했다. 1초 간격이라 순간적인 앞으로 오기도 못 잡았을 수 있다.
- 결정: 로티가 맨 앞으로 오지 않았으므로 기본은 켬이다(`src/senior-tab.mjs`의 `SENIOR_TAB_DEFAULT_ON`). 맨 앞으로 오는 것이 확인되면 `false`로 바꿔 자동 열기를 끈다(영수증 `follow` 명령만 남는다).
- 로티에 포커스 없는 `terminal create` 옵션이 생기면 `buildSeniorTabCreateArgv`(`src/senior-tab.mjs`)에 그 옵션을 붙이도록 바꾼다.

### 다른 일회성 호출에 쓸 수 있나 (메모, 코드는 바꾸지 않음)

감시 AI(`scripts/watch-judge.sh`)와 설명 AI도 같은 모양의 일회성 호출이라 진행 출력 파일이 있으면 `senior-follow.sh`로 따라 볼 수 있다. 다만 감시 AI는 주기마다 자주 돌아 탭이 계속 열고 닫히므로 꾸밈 이상의 소음이 된다. 쓰려면 호출 폴더·`exit-code.txt`·진행 로그 규약을 시니어와 맞추고, 켜는 스위치를 따로 두는 것이 먼저다.

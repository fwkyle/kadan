# 시니어

## Why

슈퍼감독을 항상 비싼 모델로 돌리기는 부담스럽다(2026-10-05 [kyle]). 그런데 작업 결과를 받고 결정해야 할 부분(검수 판정이 갈림, 결과대로 갈지 되돌릴지 등)은 값싼 모델의 판단만으로 넘기기 불안하다. 시니어는 그 간극을 메운다: 감독이 그 결과를 두고 kyle이 등록한 고급 모델(최대 2명) 전원에게 **한 번** 의견을 묻고, 모델별 답을 읽고 스스로 판단하거나 사용자에게 올린다. 감독은 모델을 고르지 않는다(2026-10-22 [kyle]).

- **Claude Code 어드바이저와는 다른 기능이다**(2026-10-05 [kyle] 정리). 어드바이저는 카드를 완수하려고 Claude Code 기능을 최대한 쓰는 것으로, 판단이 무거운 카드를 쓰기 전에 묻고 카드의 `advisor 자문 요지` 칸에 적는다(2026-09-27부터, 지침의 기존 규칙 그대로). 시니어는 작업 결과에 결정할 부분이 있을 때 의견을 구하는 것이다. 서로를 대신하지 않는다.
- 자문은 **기록이지 결정이 아니다.** 카드 상태·범위를 바꾸지 않고 우편을 보내지 않는다. 감독이 판단 근거로 쓰고, 필요하면 카드 기록(`card note --kind decision`)에 요지를 남긴다. 사용자 결정이 필요하면 그대로 `decision request`로 올린다.
- 호출 방식은 감시 AI와 같다(등록된 시니어마다 한 번씩, 동시에). `scripts/senior.sh`가 `codex exec`로 한 번 돌리고, 입력·답변·진단을 `KADAN_HOME/advice/<askId>/<n>-<실행기>-<모델>/`에 시니어마다 남긴다. 세션을 띄우지 않으므로 발령·감시 대상이 아니다. 로티 창을 쓰는 기계에서는 호출이 도는 동안만 진행 출력을 읽기 전용으로 따라 보는 탭이 뜬다([따라 보기](#따라-보기-탭)).
- **저장소 문맥은 시니어가 직접 읽는다.** 카드의 저장소 폴더(`repoPath`)에서 읽기 전용 샌드박스로 돌리므로 그 저장소의 파일·이력을 스스로 본다. 슈퍼감독이 여러 저장소의 문맥을 들고 있을 필요가 없다. codex가 자동으로 읽는 안내 파일은 `AGENTS.md`이고, 없으면 `CLAUDE.md`·`.agents.md`를 대신 읽는다(`senior.sh`가 `project_doc_fallback_filenames`를 명시, 2026-10-05). 그 밖의 이름이거나 하위 폴더의 문서라면 `--file <절대경로>`로 함께 넘긴다.

- **이름**: 처음 이름은 자문위원(`advisor`, 명령 `kadan advise`)이었다. Claude Code의 advisor 도구와 헷갈려 2026-10-05 [kyle] 결정으로 시니어(`senior`)로 바꿨다. 옛 명령 `kadan advise`와 실행 모델 설정의 옛 키 `roles.advisor`는 그대로 읽힌다(설정은 다음 저장 때 `senior`로 남는다). 시니어가 남기는 기록은 계속 자문(`advice` 사건, `KADAN_HOME/advice/` 폴더)이라 부른다.

## 명령

```
KADAN_ROLE=<감독> kadan senior <카드키> --question "<질문>" [--file <절대경로>]... [--timeout <초>] [--effort <강도>] [--runner <실행기> --model <모델>(등록된 시니어 한 명만 고를 때)]
```

- 부를 수 있는 명의: 감독(이름이 `감독`·`슈퍼감독`으로 끝나는 역할)과 사람. 작업자·검수자는 거절된다 — 자기 카드의 판단은 감독에게 묻는다.
- 입력: 질문, 카드 본문(`card.md`), 첨부 파일(절대경로, 5개·각 64KB까지). 더 큰 자료는 필요한 부분만 잘라 넣는다.
- 모델: 실행 모델 설정의 `senior` 칸이다([실행 모델 설정](runner-settings.md#시니어)). 비어 있으면 거절한다. 폴백은 없다.
- **등록된 전원에게 동시에 묻는다(2026-10-22 [kyle] 승인)**: `roles.senior`는 최대 2명 목록이다(옛 단일 객체 설정은 1명 목록으로 읽는다). 감독은 시니어 모델을 고르지 않는다 — `kadan senior`는 등록된 전원을 `Promise.allSettled`로 한꺼번에 부르고, 모델별로 나눠 돌려준다. 둘은 폴백이 아니라 동등하다. 첫 값이 실패해도 둘째로 넘어가지 않고, 둘 다 각자의 칸에 결과를 낸다.
  - 이유: 감독이 '시니어 둘'에게 물으려고 두 번째 모델을 스스로 골랐다(10/22 가벼운 flash 계열, 10/21 다른 모델). 시니어 구성은 kyle이 정하는 일이다.
  - 등록: `kadan runners set senior --set "codex:gpt-6-astra:high,agy:gemini-4-argon-medium" --revision N --reason …`(최대 2명, 같은 실행기+모델 중복·3명 이상은 거절). 한 명만 등록하려면 기존 `--runner/--model [--effort]`(목록이 그 한 명이 된다).
  - **덮어쓰기는 등록된 시니어 중 고르기만 한다.** `--runner X --model Y`는 등록된 항목과 같아야 하고, `--model Y`만 주면 등록 항목을 모델로 찾는다(같은 모델이 두 실행기에 있으면 `--runner`도 필요). 고르면 그 한 명만 부른다. 등록에 없는 값은 호출 전에 거절하고 오류 글에 등록된 시니어 목록을 보여 준다. 새 모델을 부르려면 kyle이 설정을 바꾼다. `--runner`만 주면 오류다.
  - `--effort`는 이번 호출만 강도를 바꾸며 **부르는 모델마다** 검사한다(지원하지 않는 모델이 하나라도 있으면 아무도 부르지 않는다). 강도 자리가 없는 틀(agy)은 무시하고 그 칸에 `note`를 단다.
  - **호출 직전 검사는 저장 검사와 같은 함수다**(`assertSeniorCallable`, 저장은 `setSeniors`가 같은 `assertSeniorShape`를 쓴다). 설정 파일에 든 목록 전체가 3명 이상·같은 실행기+모델 중복·안전 실행기 밖·정책 차단(`block` 전역 또는 `--roles senior`)에 걸리면 **하나라도 걸리면 전원 거절(fail closed)**한다. 차단 안 된 시니어만 부르지 않는다 — kyle이 정한 목록과 다른 조합으로 몰래 도는 것을 막으려는 판단이다(2026-10-22). 덮어쓰기로 한 명만 골라도 같다. 외부 호출·증거 폴더 전에 거절하고, 오류 글에 걸린 항목과 고치는 명령(`kadan runners set senior --set …`)이 있다.
  - 준비(틀 검사·프롬프트 크기·증거 폴더)는 호출 전에 모두 끝낸다. 한 명이라도 거절되면 아무도 부르지 않는다(실행 0회).
  - **동시 호출 충돌 확인(2026-10-22)**: 감시 AI·설명 AI와 같은 `runJudgeProcess`(`src/watch-ai-process.mjs`)를 쓰지만 호출 하나가 자기 자식 프로세스·자기 `settings` 객체를 가진다. 직렬화(전역 잠금·큐)가 없고 공유하는 임시 파일·환경도 없다(환경은 호출마다 새로 합친다). 시니어마다 따로 갖는 것: 증거 폴더, `input.txt`·`diagnostic.log`·`stderr.txt`·`exit-code.txt`·`result.txt`·`model.txt`, agy의 도구 없는 에이전트 파일(`.agents/agents/kadan-noexec/agent.md`는 시니어 폴더 안), 로티 탭. 코드에서 확인한 것이며 실제 codex·agy를 동시에 돌린 실측은 하지 않았다(모델 호출 금지). 두 도구가 사용자 홈의 자기 상태(`~/.codex`·`~/.gemini`)를 동시에 쓰는 문제는 이 쪽에서 막지 못한다.
  - **시니어 하나의 방식**
  - 실행기는 **안전 허용 목록**(`SENIOR_SAFE_RUNNERS`, 지금 `codex`·`agy`)에 있어야 한다. 목록 밖은 저장(`kadan runners set senior`)에서 거절하고, 설정 파일을 직접 고친 값도 실행 직전 같은 검사로 거절한다(실행 0회).
  - **codex**: `scripts/senior.sh`가 읽기 전용 샌드박스로 부른다. 카드의 저장소를 직접 읽는다.
  - **agy (저장소를 읽기 전용 폴더로 받는다)**: 실행기 표 `exec` 틀로 부른다(설명 AI 호출과 같은 방식). 틀에 `--agent kadan-noexec`가 없거나 묶기 문법(단순 명령, 허용 옵션만 — 저장한 틀의 `--add-dir` 등은 거절)을 어기면 호출 전에 거절한다(실행 0회, 증거 폴더도 없다). 카단이 **이번 호출 폴더**(`<KADAN_HOME>/advice/<askId>/<n>-<실행기>-<모델>`)에 도구 없는 에이전트 파일(`.agents/agents/kadan-noexec/agent.md`, `tools: view_file`, `commandExecutionPolicy: off`)을 둔 뒤 그 폴더에서 부른다. 파일을 쓰지 못하면 부르지 않는다.
    - 작업 폴더(cwd)는 계속 호출 폴더이고 에이전트 파일도 호출 폴더에만 둔다. 저장소에는 아무것도 쓰지 않는다(격리 실측: 쓰기·명령 0건, 흔적 0건).
    - **저장소 읽기(2026-10-21 [kyle])**: 카드의 `repoPath` 자체가 `git rev-parse --show-toplevel`과 같을 때만(하위 폴더·홈·`/`는 제외하고, git 메타데이터로 부모를 계산하지 않는다) 그 실경로를, **코드가 실행 직전에** 틀 끝에 `--add-dir <절대경로>`를 한 번 덧붙인다. 저장한 틀에 `--add-dir`를 쓰는 것은 여전히 거절한다(덧붙인 틀도 그 값 하나만 받는 문법 검사를 다시 통과해야 부른다). 프롬프트에는 그 절대경로가 읽기 전용 폴더로 열려 있다고 적는다. 에이전트는 `view_file`만 가지므로 열린 폴더 아래 파일만 읽고, 밖은 도구 수준에서 거부된다(격리 실측).
    - 경로가 없거나 git이 아니거나 공백·메타문자·`{}`·한글처럼 허용 글자 밖이면 `--add-dir`를 붙이지 않고 지금처럼 카드 본문과 `--file` 첨부만 근거로 쓴다. 프롬프트에 '저장소를 직접 읽을 수 없다'고 적는다.
    - **가림 범위**: `scrubForAI`(웹훅 주소·토큰 모양 가림)는 **프롬프트에만** 적용된다. agy가 직접 읽는 저장소 파일에는 적용되지 않는다. codex 시니어가 저장소를 읽어 외부로 보내는 것과 같은 수준이다(kyle 판단). 비밀이 든 파일이 있는 저장소는 이 점을 알고 부른다.
    - 프롬프트 200KB 상한과 `scrubForAI` 가림은 그대로다. 상한을 넘으면 부르지 않는다.
    - 시간 상한: 틀 안의 `--print-timeout`을 `--timeout`(기본 1800초) 값으로 바꿔 부른다. 틀의 90초가 그대로면 긴 질문이 90초에 잘린다(Argon 정상 48초). 설명 AI는 틀의 90초와 75초 상한을 그대로 쓴다.
    - `--effort`는 agy 틀에 강도 자리가 없어 무시한다. 영수증에 `note`로 알린다.
    - 재확인: agy 버전을 올린 뒤 `node scripts/check-agy-noexec.mjs`를 사람이 돌린다([실행 모델 설정](runner-settings.md#agy-도구-없는-에이전트-묶기)).
  - 기록: 덮어쓰기로 한 명만 골라 부르면 원장 `advice` 사건과 영수증 칸에 `source: "flag"`와 쓴 `runner`·`model`이 남는다.
- 상한: 기본 1800초(30분), `--timeout`으로 1..3600초. 고급 모델이 저장소를 읽고 시험까지 돌려 보며 오래 고민할 수 있게 넉넉히 둔다(2026-10-05 [kyle]).
- **결과(모델별)**: 영수증(JSON)에는 `askId`·`card`와 `answers[]`가 있고, 그 뒤에 시니어마다 답변 본문을 `--- 시니어 <실행기>/<모델>/<강도> · <상태> ---` 머리로 나눠 출력한다. 각 칸에는 실행기·모델·강도·`status`(`ok`·`한도`·`실패(<이유>)`)·`reason`·`adviceId`·`durationMs`·`evidencePath`·따라 보기 정보가 있고, 답은 `ok`인 칸에만 `answer`로 있다. **옛 단일 `answer`·`model` 칸은 없앴다**(2026-10-22): 예전 명령 출력을 읽던 코드는 `answers[0]`을 본다. 답변은 네 칸이다 — **결론** 한 줄, **근거**, **위험**, **확인할 것**.
  ```
  {"askId": "…", "card": "repo/card", "answers": [
    {"runner": "codex", "model": "gpt-6-astra", "effort": "high", "status": "ok", "reason": "ok", "adviceId": "…", "evidencePath": "…/advice/<askId>/1-codex-gpt-6-astra", …},
    {"runner": "agy", "model": "gemini-4-argon-medium", "effort": "max", "status": "한도", "reason": "limit", "adviceId": "…", "evidencePath": "…/2-agy-gemini-4-argon-medium", …}]}
  --- 시니어 codex/gpt-6-astra/high · ok ---
  결론: …
  --- 시니어 agy/gemini-4-argon-medium/max · 한도 ---
  (답 없음 — 증거 폴더 참고)
  ```
- **종료 코드**: 하나라도 `ok`면 0이고 나머지 칸은 상태로 보인다. 전원이 `ok`가 아니면 1이고 오류 글에 시니어마다 이유와 증거 경로가 있다.
- **한도 판정**: 실패한 호출의 stderr·stdout에 `429`·`quota`·`usage limit`·`rate limit` 중 하나가 있으면(대소문자 무시) `reason: limit`, 화면 '한도'다. 그 밖의 실패는 시간 초과(`timeout`)·호출 실패(`call-failed`)·빈 답(`empty`)이다. **어떤 실패도 자동 재시도하지 않는다.** `ocx refresh` 같은 한도 복구 동작도 하지 않는다. 다시 부르는 것은 감독이 명령을 다시 내는 것이다.
- 실패 기준: `ok`는 종료 코드 0이고 답이 비어 있지 않을 때뿐이다(fail closed). 답을 쓰지 않는다.

## 실측 시험

시니어는 비싼 모델이라 실제로 부르는 시험은 강도를 낮춰 돌린다(2026-10-05 [kyle]).

- `kadan senior … --effort low`: 이번 호출만 강도를 바꾼다. 실행 모델 설정은 그대로이고, 원장에는 `effort`(쓴 값)·`effortOverride: true`·`settingsEffort`(설정 값)가 남는다. 모델이 지원하지 않는 강도는 호출 전에 거절한다.
- `npm run smoke:senior [-- --effort low --timeout 600]`: 임시 `KADAN_HOME`에 실행 모델 설정만 복사하고 가상 카드 하나로 실제 모델을 한 번 부른다. 답에 결론·근거·위험·확인할 것 네 칸이 있으면 통과. 비용이 들어 `npm test`에는 넣지 않는다. 운영 원장은 건드리지 않는다.

## 원장 기록

질문 하나에 시니어마다 `advice` 사건 한 줄을 남긴다(성공·실패 모두). 줄마다 같은 `askId`(질문 하나의 공통 ID), 자기 `adviceId`, `seniorIndex`·`seniorCount`(몇 번째/몇 명)가 있다. 그 밖에 `by`(부른 감독), `card`, 질문 앞 200자와 지문, `model`·`effort`(덮어쓰기로 골랐으면 `runner`·`source: "flag"`)·`settingsRevision`·`settingsPreset`, `reason`(`ok`·`limit`·`timeout`·`call-failed`·`empty`·`interrupted`), `exitCode`, `durationMs`, 답변 `bytes`·`digest`, 첨부 `files`, `evidencePath`, 따라 보기 탭의 `tab`·`tabReason`·`rottieTerminalId`가 있다. 증거 폴더는 `KADAN_HOME/advice/<askId>/<n>-<실행기>-<모델>/`다(옛 `advice/<adviceId>/` 폴더 기록은 그대로 남는다). 신호(TERM/INT)로 끊기면 아직 끝나지 않은 시니어마다 `reason: interrupted` 줄을 남긴다. 새 사건 종류는 만들지 않았다. 답변 본문은 원장에 넣지 않고 증거 폴더의 `result.txt`에만 둔다. 기록 화면에서는 **자문**으로 보이고, 질문 하나에 줄이 여러 개일 수 있다(`askId`로 묶인다). 사건은 호출이 끝난 뒤 쓰므로 SIGKILL이면 증거 폴더만 남을 수 있다.

횟수 제한은 일부러 두지 않는다(2026-10-05 [kyle] 결정): 감독이 필요할 때만 부르는 것이 전제이고, 같은 카드로 다시 부르면 다시 돈다(비용이 든다). "카드당 1회"는 템플릿의 기본 습관이지 명령이 막는 규칙이 아니다.

## 언제 묻는가

[슈퍼감독](../skills/kadan-conductor/references/role-templates/super.md)·[일반감독](../skills/kadan-conductor/references/role-templates/conductor.md) 템플릿의 규칙 그대로다: 작업 결과를 받고 결정할 부분이 있을 때(검수 판정이 갈림, 결과대로 갈지 되돌릴지 등) 한 번 묻는다. 카드를 쓰기 전의 자문은 시니어가 아니라 Claude Code 어드바이저의 몫이다. 보통 결정 하나에 1회로 끝낸다(필요하면 더 불러도 막지 않는다). 취향·제품 방향처럼 사용자만 답할 수 있는 질문은 자문으로 대신하지 않는다 — [질문 사다리](../skills/kadan-conductor/references/tiki-taka.md)대로 우편과 결정 요청으로 올린다.

## 따라 보기 탭

Why: kyle이 시니어가 무엇을 읽고 어떻게 고민하는지 화면에서 보고 싶다(2026-10-16 [kyle]). 시니어는 여전히 일회성 호출이고 역할 세션이 아니다.

- **언제 뜨나**: 창 설정이 `rottie`이고(`kadan window`), 로티 실행 파일 경로가 있고, 기본이 아닌 홈이 운영 로티에 닿는 것을 막는 보호(`live-floor-guard`)를 통과하고, 카드의 저장소 폴더(`repoPath`)가 로티에 이미 열려 있을 때. `KADAN_SENIOR_TAB=off`로 끄고 `on`으로 켠다(없으면 켬).
- **무엇이 뜨나**: `scripts/senior-follow.sh <호출 폴더> <kadan senior의 PID>`가 도는 탭. `diagnostic.log`를 `tail -F`로 보여 주는 읽기 전용이고 입력을 받지 않는다. `exit-code.txt`가 생기거나 부모 PID가 사라지면 스스로 끝난다(TERM으로 죽은 `kadan senior`는 `exit-code.txt`를 남기지 않아서).
- **역할이 아니다**: `KADAN_ROLE`·`kadan-*` 이름을 쓰지 않고 제목은 `시니어 · <카드키>`(시니어가 둘 이상이면 ` · <모델>`을 덧붙여 탭을 가른다), 멱등 키는 `kadan-senior-<호출ID>`다. `start` 원장 사건을 쓰지 않으므로 `kadan status`·바닥 `list()`·감시기가 잡지 않는다.
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
- **남은 탭 찾는 법**: 호출 폴더 `KADAN_HOME/advice/<askId>/<n>-<실행기>-<모델>/tab.json`의 `key`(`kadan-senior-<호출ID>`, create 전에 먼저 쓴다) 또는 원장 `advice` 사건의 `tabKey`를 보고, 로티에서 `시니어 · <카드키>` 제목의 탭을 직접 닫는다. 신호 처리기가 돌 수 있고 저장이 성공했을 때만 `reason: interrupted`로 원장에 남는다. 저장 거절·SIGKILL·전원 종료 때는 증거 폴더 `tab.json`만 남는다.
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

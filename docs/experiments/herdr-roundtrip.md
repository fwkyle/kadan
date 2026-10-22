# Why

카단의 카드·우편·완료 기록을 유지하면서 herdr를 실행 터미널로 사용할 수 있는지, 사용 중인 세션을 건드리지 않는 격리 시험으로 확인한다.

# herdr 왕복 실험 — 2026-10-11

2026-10-11 사용자 승인으로 `KADAN_FLOOR=herdr`를 선택하는 시험 기능을 제공한다. 정식 바닥 등록·기계 기본값 변경·Rottie 상태창 연동은 포함하지 않는다. 기본값은 여전히 tmux다.

## 실행 경계

- herdr 0.9.3 / socket protocol 22의 로컬 named server를 사용한다. 기본 서버와 현재 포커스는 사용하지 않는다.
- `KADAN_HOME`과 절대경로 `KADAN_HERDR_SOCKET`을 명시한다. 자동 서버 기동·설치·로그인·훅 설치·다른 바닥으로 폴백하지 않는다.
- `cwd`를 생성 요청에 지정한다. 시작 원장에 서버 주소, workspace/pane/terminal ID와 실제 시작 PID를 기록한다. 한글 역할 이름은 그대로 유지한다.
- 주소 조회는 원장의 terminal ID를 기준으로 한다. 반환된 pane/tab ID를 사용하며 번호를 추측하지 않는다.
- 전송 전 현재 PID·foreground 실행기·명시 모델·입력 대기·스크롤 상태를 확인한다. 미제출 글 모양은 판정하지 않는다(2026-10-17, 아래 "입력창 판정 제거"). 명령 인자가 생략된 경우 해당 로컬 foreground PID만 `ps`로 조회한다.
- `agent.prompt`로 괄호 붙여넣기와 Enter를 제출한다. 전달 성공은 `keyDelivery=sent`, `inputAcceptance=unconfirmed`이며 실행 완료를 뜻하지 않는다.
- 화면 확인은 `pane.read`의 visible text를 쓴다. `takeover`는 사용하지 않는다.
- 화면 확인에 `terminal session control`·`terminal attach`를 쓰지 않는다. 실제 창 크기를 흉내 내려고 백그라운드로 띄우는 것도 금지다. 2026-10-12 시험(HW-6) 중 뒤에 남은 control 클라이언트 3개가 각각 68~130GB(압축 포함)까지 불어나 맥 전체가 메모리 부족에 걸렸다(01:36~07:53, 8회). 격리 재현 8가지 조건에서는 재현되지 않아 원인은 미확정이며 herdr에 보고했다(herdrdev/herdr#5175). 행 수가 필요하면 `observe --rows <pane.scroll.viewport_rows>`를 쓴다.
- 응답 유실은 전달 불명확으로 끝낸다. 본문/Enter 자동 재전송은 없다. 자동 알림은 에이전트 대기·동일 화면이 기본 30초(`--profile super`로 시작한 역할 창은 2분) 이상 관측된 뒤 전송 직전 재검사한다. 작업 중·승인 대기·스크롤·입력 미확인은 보류한다. Enter 단독 재전송은 계속 거절한다.
- 출력은 ANSI recent snapshot을 읽는다. `truncated`이면 기존 wait가 gap으로 중단한다. 완전한 출력 로그나 스트림 재생 기능을 제공하지 않는다.

## 시험 환경에서 사용하는 법

```sh
# 별도 셸에서 시험 서버를 실행한다. 아래 이름의 기존 서버가 없는지 먼저 확인한다.
herdr --session kadan-herdr-test status server
herdr --session kadan-herdr-test server

# 다른 셸. KADAN_HOME은 기존 tmux 원장과 분리한 시험 전용 폴더다.
export KADAN_HOME=/absolute/test/home
export KADAN_FLOOR=herdr KADAN_WINDOW=none
export KADAN_HERDR_SOCKET="$HOME/.config/herdr/sessions/kadan-herdr-test/herdr.sock"
cd /absolute/test/project
kadan start 판-작업자 --profile worker
kadan attach 판-작업자
```

시험 HOME에 실행 모델 설정을 별도로 준비한다. 기존 설정/인증을 그대로 사용할지 격리할지는 실행 전에 정하며, 이 바닥이 자동으로 복사하지 않는다.

설치된 `kadan`에 이 시험 기능이 포함되어 있어야 한다. 다른 버전이 설치되어 있다면 시험 기능이 있는 `src/cli.mjs`의 절대경로로 실행한다. AI 도구가 실행하는 로그인 셸은 `PATH`를 다시 만들 수 있으므로, 역할 안에서는 생성 환경에 들어 있는 `KADAN_CLI`의 절대경로를 사용한다: `node "$KADAN_CLI" send ...`.

`kadan attach`는 역할별 `herdr --session ... terminal attach ...` 명령을 출력한다. 출력된 명령을 터미널에서 실행하면 그 역할에 접속한다. `start`가 herdr 서버나 GUI 창을 자동으로 열지는 않는다. 자동 알림은 아래 2026-10-13 격리 시험까지 확인했다. 장시간 무인 감시 운영은 미검증이며, 감독이 직접 결과와 실행 완료를 확인하는 작은 시험에 사용한다.

## 실측 결과

두 실제 Codex 세션(`gpt-6.1-sol`, high), 서로 다른 프로젝트 경로, 시험 전용 카단 HOME과 named herdr 서버를 사용했다. 아래 12개 시나리오의 최종 시도는 통과했다. 오류가 난 첫 시도도 별도 증거로 보존했다.

| 확인 | 결과 |
| --- | --- |
| 프로젝트 A 요청 경로 = herdr 경로 = 실제 AI `pwd` | 일치 |
| 프로젝트 B 요청 경로 = herdr 경로 = 실제 AI `pwd` | 일치 |
| 카드 발령 → 성공 DONE → append-only 원장 | 성공 |
| 실패 DONE | `failed` 보존 |
| AI 도구의 300줄 명령 출력 뒤 DONE | 회수 성공. CLI가 중간 출력을 접어서 보여 줌 |
| 새 DONE 없는 응답 | idle이어도 quiet 종료, done 기록 없음 |
| PID 불일치 | 입력과 send 기록 없음 |
| 미제출 입력 | (2026-10-11 당시) 원문 보존, 새 본문 거절. 2026-10-17부터 화면 모양을 판정하지 않아 카드·일반 우편은 보낸다 |
| 실제 신뢰 확인 화면의 blocked | 입력 거절 |
| 종료한 시험 터미널 | 입력 거절 |
| 연결 불가능한 시험 소켓 | 실패 보고, 자동 재시도 없음 |
| 두 실제 역할의 질문 → 최종 답장 → 발신자의 읽기 | 카단 우편 ID와 회신 연결 확인 |

추가로 PTY에 실제 635KiB·493KiB·306KiB 길이의 세 줄을 출력했다. herdr 조회는 약 117KiB만 반환했고 `truncated=true`였다. 마지막 DONE이 보이더라도 wait는 `code=2, reason=gap`으로 중단했다. 긴 기록의 완전한 회수는 해결된 것으로 보지 않는다.

이 제한은 화면에서 완료 근거를 읽는 경로에 해당한다. `kadan done <역할> <실행ID> ok|failed`로 직접 기록하는 경로는 출력을 읽지 않는다. 자동 왕복은 결과 보고·파일과 화면 DONE 또는 발령 뒤 공식 done 기록을 확인하므로, 출력 누락과 복구 절차를 따로 검증해야 한다. herdr의 입력 대기 상태만으로 카드 성공이나 업무 최종 완료를 확정하지 않는다.

## 입력창 폭 판정 (HW-1-impl, 2026-10-11)

- 결함: herdr observe frame의 `width`가 실제 화면 줄 길이와 어긋날 수 있다. 접속 창을 212칸으로 늘린 격리 실측에서 frame `width`는 120, Claude 입력창 테두리(`─`)는 212칸이었고, 수정 전 `checkEmptyInput`은 빈 입력창을 "미제출 입력 또는 빈 입력창으로 확인할 수 없는 화면"으로 거절했다.
- 수정: herdr 경로는 `width`를 `null`로 넘긴다. 위·아래 테두리가 서로 같은 길이이고 가져온 화면에서 가장 긴 줄과 같을 때만 상자형 입력창으로 본다. 숫자 `width`를 주는 tmux·Rottie 경로는 기존처럼 정확히 같은 길이만 통과한다. 미제출 입력(한 줄·여러 줄)·본문 속 `────` 인용·아래 테두리 불일치는 계속 거절한다.
- 실측(실제 Claude Sonnet 5.5, 시험 서버·시험 HOME): 212칸 상태에서 수정 전 거절, 수정 후 통과, 이어서 실제 카드 발령 성공 → 화면 `KADAN:DONE WT-1 ok` → `done --from-screen`으로 시험 원장 기록.
- 남은 경계: 화면 전체가 테두리보다 긴 줄을 담고 있으면(예: 아주 긴 본문 줄) 보수적으로 거절한다. 줄 길이는 코드 포인트 수로 센다(전각 글자 폭은 반영하지 않음).

## 실전 판(LBR-1)에서 나온 결함 수정 (HW-6-impl, 2026-10-12)

- 입력 커서 행(결함 1): `terminal session observe`는 기본으로 120x40 창을 만든다. 터미널이 58행이면 프레임은 위쪽 40행만 담고 실제 커서(55행)는 프레임 밖(숨김)이라, 프레임의 마지막 `\x1b[r;cH`는 커서가 아니라 그리기 위치(40행)였다. 줄을 세는 방식이 아니라 **행 좌표계(관찰 창 세로 ≠ 터미널 세로)** 가 어긋난 것이다. 이제 `--rows <터미널 세로>`로 관찰하고, 프레임 높이가 터미널과 다르거나 세로 줄 수를 모르면 거절한다(`herdrInputFrame`). 입력창 판정(`checkEmptyInput`)은 바꾸지 않아 미제출 입력 보호가 그대로다. 실측: 58행 Codex 빈 입력창 거절 → 통과, 미제출 한 줄·여러 줄은 계속 거절.
- 신뢰 확인 화면(결함 4): 새 폴더 첫 실행은 Claude(`Quick safety check: Is this a project you created or one you trust`)·Codex(`Do you trust the contents of this directory?`)가 사람의 답을 기다리며 `blocked`가 된다. **자동 수락하지 않는다.** `start`는 시작 직후 최대 약 6초 동안 보고 막힘을 알리며, `send`는 `KADAN_HERDR_TRUST_PROMPT`로 거절하면서 정확한 통과 명령을 보여 준다. Claude 기본 선택은 `No, exit`라 Enter만 보내면 종료되므로 안내 명령은 `send-keys … down enter`다(Codex는 `enter`).
- 우편 중 응답 중(결함 2의 (c)): Claude·Codex 모두 작업 중에 들어온 입력을 자기 대기열에 쌓았다가 현재 작업 뒤에 처리한다(실측: Codex `sleep 25; echo A1`·`sleep 5; echo A2`가 끊기지 않고 끝난 뒤 대기열 문장 처리). 그래서 **사람·역할 우편(`kadan send` 명령이 `busyMail`로 명시 표시)** 만 `working`에서도 입력창이 비어 있으면 보낸다. 기본은 거절, 명시 허용이다: 감시기 자동 경보·표시 없는 호출·카드 발령은 `working`에서 거절한다(HW-6-review 지적 수정). **카드 발령**은 일하는 역할에 새 일을 얹지 않도록 기존처럼 입력 대기(`idle`/`done`)만 허용한다. `blocked`·`unknown`은 둘 다 거절한다.
- 감독-작업자 왕복(결함 2): LBR-1의 "완료 편지 전부 실패"는 결함 1이 원인이었다(212x58 Claude 감독에게 설치본 CLI로 보낸 같은 편지는 `현재 입력 영역의 프롬프트 미확인`, 시험 브랜치 CLI로는 전달). 우회 없이 Codex 작업자→Claude 감독, Claude 작업자→Claude 감독, 감독 응답 중 도착 편지가 모두 `done --from-screen`으로 확정됐다. 증거는 HW-6-impl 카드 evidenceDir.
- 지침(결함 3): 완료 통지 발송 실패는 작업 실패가 아니다. 카드 메모에 남기고 실행 `ok|failed`는 결과 파일·`card report`로 정한다(`card-template.md`, `role-templates/common.md`·`worker.md`, `docs/role-instructions.md`).
- 남은 경계: 감독의 `kadan` 명령이 PATH의 설치본이면 시험 브랜치 코드가 아니다. 시험 중에는 역할 환경의 `KADAN_CLI`를 쓴다. 신뢰 화면 문구는 Claude v2.1.296·Codex(2026-10-12 화면) 기준이며, 문구가 바뀌면 `blocked` 거절(`KADAN_HERDR_NOT_READY`)로 떨어진다.

## Rottie 개별 접속

Rottie의 각 프로젝트에 `terminal create --workspace <그 프로젝트> --command "herdr --session <시험서버> terminal attach <그 역할의 terminal ID>"`를 사용했다. 두 서로 다른 Rottie terminal ID와 프로젝트 소유 경로, 각 역할의 출력, gap 없음이 확인됐다. 전체 herdr TUI를 반복해서 여는 방식이 아니다.

이미 조작 연결이 있는 terminal에 두 번째 control을 요청하면 `terminal.closed`와 `already has an attached client`가 반환됐다. CLI exit는 0이므로 exit 코드만으로 접속 성공을 판정하면 안 된다. takeover는 하지 않았다.

## 남은 경계

- Claude 모델 응답 왕복은 2026-10-11 HW-1-impl에서 기존 로그인(`CLAUDE_CONFIG_DIR` 미설정)으로 확인했다(아래 "입력창 폭 판정"). 이전의 로그인 접근 실패는 격리 설정 폴더 탓으로 추정하며 이 시험에서는 재현되지 않았다.
- 실행 중인 Rottie Local에는 개발 QA 브리지가 없었다. CLI와 출력으로 연결은 확인했지만 좌측 탭 클릭·실제 렌더 검증은 미검증이다.
- Rottie의 작업 상태 표시를 herdr에서 가져오는 변경, web UI, 원격 서버, 자동 전달/감시 운영 검증은 범위 밖이다.
- 공식 바닥 등록에 필요한 기존 12장 전체 계약을 대체하지 않는다. 이 시험은 한글 주소·카드·우편·대기·출력·개별 접속의 가능성과 제한을 확인하는 실험이다.

## 검사

`node --test tests/herdr-floor.test.mjs`는 실제 모델을 호출하지 않는다. 최종 코드의 전체 검사(동시 실행 수 2)는 **1,259/1,259**, 집중 검사 **39/39**, 공개 파일 검사 **0 issue**다. 기존 tmux/Rottie 시험도 포함한다.

병렬 전체 실행 중 기존 잠금 타이밍 시험과 tmux 자동 발령의 거절 문구 대조 시험이 각각 한 번 실패했다. 단독 재실행은 통과했고, 자동 발령 시험은 기준 코드에서도 별도로 통과했다. 직접 원인은 확정하지 않았으며 실패 로그를 보존했다. 관련 없는 잠금·자동 발령 코드는 수정하지 않았다.

공식 참고: [agent automation](https://herdr.dev/docs/agent-automation/), [socket API](https://herdr.dev/docs/socket-api/), [agent prompt 구현](https://github.com/herdrdev/herdr/blob/2563803dca97c040beaf3dc3acdcb5a3221b4238/src/app/api/agents.rs).

## adopt(대화 옮기기)를 herdr 바닥에서 쓰기 (HW-4)

- 코드 변경 없음. `kadan adopt`는 `start`(`cmdStart`)를 그대로 불러 `floor.create`로 가므로 cwd 지정, `KADAN_HOME`·`KADAN_FLOOR`·`KADAN_HERDR_SOCKET`·`KADAN_CLI` 주입, 신뢰 화면 감지가 같다. `KADAN_FLOOR`가 없으면 tmux(단위 시험 `tests/adopt.test.mjs`), 자동 폴백·서버 자동 기동 없음.
- 사용: 대화를 시작한 폴더에서 `KADAN_FLOOR=herdr KADAN_HOME=… KADAN_HERDR_SOCKET=… kadan adopt <이름> --model <모델> [--resume <ID> --harness claude|codex] [--profile conductor|super]`. 새 폴더면 신뢰 화면이 `blocked`로 보이니 안내된 `pane send-keys … down enter`(Claude) 또는 `enter`(Codex)로 사람이 넘긴다.
- 실측(시험 서버 `kadan-herdr-adopt-test`, 시험 HOME `~/.kadan-herdr/adopt-test/live`, 시험 폴더에서 새로 만든 버리는 대화만 복제): (A) Claude 대화 → 감독 → 카드 AT-A2 → 화면 DONE → `done --from-screen`. (B) Codex 대화(`codex fork`) → 감독 → AT-B 같은 흐름. (C) Claude 대화 → `--profile super` → 슈퍼감독이 `node "$KADAN_CLI" start 판C-감독 --profile conductor`로 판 감독을 세우고 AT-C 발령 → DONE. start 줄에 `cmd`·`harness`·`model`과 `herdrSocket`·`herdrWorkspaceId`·`herdrPaneId`·`herdrTerminalId`·`panePid`가 남는다. 슈퍼감독과 판 감독 프로세스 모두 같은 `KADAN_HOME`·`KADAN_FLOOR=herdr`·`KADAN_HERDR_SOCKET`·`KADAN_CLI`를 가졌다(`ps eww`로 확인).
- 관찰: 슈퍼감독 화면에서 `env | rg ^KADAN_`를 다시 시키자 Claude 자동 모드 판정기가 "자격증명 탐색"으로 거부했다(첫 실행은 통과). 환경 상속 근거는 운영자가 `ps eww`로 대신 확인했다. 또 슈퍼감독이 카단 스킬(작업 폴더 밖 파일)을 읽을 때 "작업 폴더 밖 읽기 허용" 확인 창이 한 번 떴다(사람이 "이번만 허용"으로 통과, 사용자 설정은 바꾸지 않음).
- 설계 메모(할 일 3, 코드 없음): 지금 herdr 바닥은 역할 하나당 workspace 하나를 만든다. 판=space(workspace), 역할=pane으로 바꾸려면 (1) 원장 start 줄의 `herdrWorkspaceId`를 판 단위로 공유하고 `herdrPaneId`로 역할을 가르며, (2) stop은 pane만 닫고 마지막 pane일 때 workspace를 정리하고, (3) `create`가 판 이름으로 기존 workspace를 찾아 `pane.split`하는 경로와 그 경쟁 조건(두 역할 동시 시작) 시험이 필요하다. 이 변경은 `terminal` 주소를 기준으로 하는 현 입력 검사·읽기 경로에는 영향이 없을 것으로 보이나 실측하지 않았다.


## 자동 알림 보호 보완 — 2026-10-13

일반 경보·감시 AI 보고·미확인 우편·유휴 알림이 같은 입력 보호를 쓴다.
herdr에는 최근 사람 입력 시각 API가 없어 화면 revision과 화면 글·PID·terminal ID의 안정성을
함께 확인한다. 감시기 재시작이나 관측 실패 뒤에는 기본 30초(슈퍼감독 창은 2분)를 새로 센다.
보호로 확실히 미전송된 경우만 나중에 재확인하며, 이미 해소된 경보는 보내지 않는다.
응답 유실이나 발송 도중 중단은 자동 재전송하지 않는다.

화면 관측과 `agent.prompt` 사이를 서버가 원자적으로 잠그지는 못한다. 마지막 검사 이후에
사람이 키를 누르는 짧은 경합 구간까지 완전히 없앤 보장은 아니다. 2026-10-13 실제 Codex 두 세션으로 입력 문장 보존, 30초 유예, 요청→자동 깨움→최종 답장→
요청자의 읽음과 양쪽 한 번씩 알림을 확인했다. 운영 세션에 적용한 증거는 아니다. 레포 간 흐름은 [슈퍼 우편](../peer-super-mail.md)을 따른다.

## 입력창 판정 제거 — 2026-10-17

- 결정: [kyle]이 화면 모양으로 빈 입력창을 판정하던 `checkEmptyInput`을 없앴다. 실행기 업데이트마다 빈 입력창을 미제출 글로 오판해 발령이 막히는 것(herdr 폭 10-11, devin·claude 9-23, codex 0.163 10-17)이 사람 글 뒤에 우편이 붙는 것보다 치명적이라고 보았다.
- 지운 것: herdr 쪽 `inputFrame`·`herdrInputFrame`(관찰 창 세로 줄 수로 커서 행을 구하던 장치)와 `checkEmptyInput` 호출. 위 "입력창 폭 판정"·"입력 커서 행" 항목은 그 당시 기록이며 이제 해당 코드가 없다.
- 방침 (b): 카드 전송과 일반 우편은 사람 검사 없이 보낸다. 이유는 (a) 화면 안정 검사(기본 30초, 슈퍼감독 창은 2분)를 카드·우편에도 쓰려면 안정 기록을 메모리 맵(`herdrNotificationGuard`의 `quiet`)에 두는데, `kadan send`·`dispatch`는 호출마다 새 프로세스라 이전 관측을 기억하지 못해 늘 처음 관측으로 보류되기 때문이다(항상 막힘). 장수 프로세스인 감시기의 알림만 같은 화면 안정 검사(기본 30초, 슈퍼감독 창은 2분)를 유지한다.
- 알림 지문: `frame.row`를 뺐다. 지문은 소켓·terminal·PID·pane·화면 revision·화면 글이다. 커서 행은 화면 글이 바뀌면 함께 바뀌므로 안정 판정에 더하는 정보가 없다.
- 받아들인 손해: herdr에서는 사람이 쓰던 글 뒤에 카드·우편이 붙어 제출될 수 있다. 승인 대기·작업 중(카드)·기록 보기 중 검사는 그대로다.
- 강제 차례 (2026-10-22 [kyle] 결정 B): 감시기 알림이 5번 밀린 강제 차례에 보호가 30초인 창은 지금처럼 화면 안정 검사를 건너뛰고, 슈퍼감독 창(2분)은 같은 화면 안정 검사를 30초로 돈다(`allowWorking`은 유지). 응답 중 화면이 계속 바뀌면 안정이 안 나와 밀림이 이어질 수 있다.

# Why

카단의 카드·우편·완료 기록을 유지하면서 herdr를 실행 터미널로 사용할 수 있는지, 사용 중인 세션을 건드리지 않는 격리 시험으로 확인한다.

# herdr 왕복 실험 — 2026-10-11

2026-10-11 사용자 승인으로 `KADAN_FLOOR=herdr`를 선택하는 시험 기능을 제공한다. 정식 바닥 등록·기계 기본값 변경·Rottie 상태창 연동은 포함하지 않는다. 기본값은 여전히 tmux다.

## 실행 경계

- herdr 0.9.3 / socket protocol 22의 로컬 named server를 사용한다. 기본 서버와 현재 포커스는 사용하지 않는다.
- `KADAN_HOME`과 절대경로 `KADAN_HERDR_SOCKET`을 명시한다. 자동 서버 기동·설치·로그인·훅 설치·다른 바닥으로 폴백하지 않는다.
- `cwd`를 생성 요청에 지정한다. 시작 원장에 서버 주소, workspace/pane/terminal ID와 실제 시작 PID를 기록한다. 한글 역할 이름은 그대로 유지한다.
- 주소 조회는 원장의 terminal ID를 기준으로 한다. 반환된 pane/tab ID를 사용하며 번호를 추측하지 않는다.
- 전송 전 현재 PID·foreground 실행기·명시 모델·입력 대기·미제출 입력·스크롤 상태를 확인한다. 명령 인자가 생략된 경우 해당 로컬 foreground PID만 `ps`로 조회한다.
- `agent.prompt`로 괄호 붙여넣기와 Enter를 제출한다. 전달 성공은 `keyDelivery=sent`, `inputAcceptance=unconfirmed`이며 실행 완료를 뜻하지 않는다.
- 입력창 검사는 읽기 전용 terminal observer와 visible snapshot을 사용한다. `takeover`는 사용하지 않는다.
- 응답 유실은 전달 불명확으로 끝낸다. 본문/Enter 자동 재전송은 없다. 자동 알림과 Enter 단독 재전송은 보호 검증 전까지 거절한다.
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

`kadan attach`는 역할별 `herdr --session ... terminal attach ...` 명령을 출력한다. 출력된 명령을 터미널에서 실행하면 그 역할에 접속한다. `start`가 herdr 서버나 GUI 창을 자동으로 열지는 않는다. 현재 시험 바닥의 자동 알림·감시 운영은 미검증이며, 감독이 직접 결과와 실행 완료를 확인하는 작은 시험에 사용한다.

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
| 미제출 입력 | 원문 보존, 새 본문 거절 |
| 실제 신뢰 확인 화면의 blocked | 입력 거절 |
| 종료한 시험 터미널 | 입력 거절 |
| 연결 불가능한 시험 소켓 | 실패 보고, 자동 재시도 없음 |
| 두 실제 역할의 질문 → 최종 답장 → 발신자의 읽기 | 카단 우편 ID와 회신 연결 확인 |

추가로 PTY에 실제 635KiB·493KiB·306KiB 길이의 세 줄을 출력했다. herdr 조회는 약 117KiB만 반환했고 `truncated=true`였다. 마지막 DONE이 보이더라도 wait는 `code=2, reason=gap`으로 중단했다. 긴 기록의 완전한 회수는 해결된 것으로 보지 않는다.

이 제한은 화면에서 완료 근거를 읽는 경로에 해당한다. `kadan done <역할> <실행ID> ok|failed`로 직접 기록하는 경로는 출력을 읽지 않는다. 자동 왕복은 결과 보고·파일과 화면 DONE 또는 발령 뒤 공식 done 기록을 확인하므로, 출력 누락과 복구 절차를 따로 검증해야 한다. herdr의 입력 대기 상태만으로 카드 성공이나 업무 최종 완료를 확정하지 않는다.

## Rottie 개별 접속

Rottie의 각 프로젝트에 `terminal create --workspace <그 프로젝트> --command "herdr --session <시험서버> terminal attach <그 역할의 terminal ID>"`를 사용했다. 두 서로 다른 Rottie terminal ID와 프로젝트 소유 경로, 각 역할의 출력, gap 없음이 확인됐다. 전체 herdr TUI를 반복해서 여는 방식이 아니다.

이미 조작 연결이 있는 terminal에 두 번째 control을 요청하면 `terminal.closed`와 `already has an attached client`가 반환됐다. CLI exit는 0이므로 exit 코드만으로 접속 성공을 판정하면 안 된다. takeover는 하지 않았다.

## 남은 경계

- Claude는 시험 설정 디렉터리에서 기존 로그인에 접근하지 못했다. 실행/blocked 거절만 확인했으며 Claude 모델 응답 왕복은 미검증이다.
- 실행 중인 Rottie Local에는 개발 QA 브리지가 없었다. CLI와 출력으로 연결은 확인했지만 좌측 탭 클릭·실제 렌더 검증은 미검증이다.
- Rottie의 작업 상태 표시를 herdr에서 가져오는 변경, web UI, 원격 서버, 자동 전달/감시 운영 검증은 범위 밖이다.
- 공식 바닥 등록에 필요한 기존 12장 전체 계약을 대체하지 않는다. 이 시험은 한글 주소·카드·우편·대기·출력·개별 접속의 가능성과 제한을 확인하는 실험이다.

## 검사

`node --test tests/herdr-floor.test.mjs`는 실제 모델을 호출하지 않는다. 최종 코드의 전체 검사(동시 실행 수 2)는 **1,259/1,259**, 집중 검사 **39/39**, 공개 파일 검사 **0 issue**다. 기존 tmux/Rottie 시험도 포함한다.

병렬 전체 실행 중 기존 잠금 타이밍 시험과 tmux 자동 발령의 거절 문구 대조 시험이 각각 한 번 실패했다. 단독 재실행은 통과했고, 자동 발령 시험은 기준 코드에서도 별도로 통과했다. 직접 원인은 확정하지 않았으며 실패 로그를 보존했다. 관련 없는 잠금·자동 발령 코드는 수정하지 않았다.

공식 참고: [agent automation](https://herdr.dev/docs/agent-automation/), [socket API](https://herdr.dev/docs/socket-api/), [agent prompt 구현](https://github.com/herdrdev/herdr/blob/2563803dca97c040beaf3dc3acdcb5a3221b4238/src/app/api/agents.rs).

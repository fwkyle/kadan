# 명령어 사전

## Why

[kyle]과 에이전트가 카단 명령을 쓸 때, 어떤 명령이 있고 무엇을 하는지 한곳에서 찾게 한다.
명령마다 한 줄 설명과 자주 쓰는 옵션만 적고, 규칙·판단 기준은 링크한 상세 문서가 원본이다.

## 읽는 법

- 모든 옵션은 명령이 직접 알려 준다. 묶음 명령(`work`, `card`, `decision`, `inbox`, `runners`, `storage`, `watch-report`)은 `kadan <명령> --help`, 나머지는 대상 없이 실행하면 사용법이 나온다.
- `<역할>`은 세션 이름에서 `kadan-`을 뺀 부분이다(`kadan-비서` → `비서`).
- 명령이 PATH에 없으면 `node <저장소>/src/cli.mjs <명령>`으로 같은 일을 한다.
- 새 명령을 추가하면 이 표와 `src/cli.mjs`의 전체 사용법 줄을 같은 커밋에서 고친다.

## 환경 설정

| 변수 | 뜻 |
|---|---|
| `KADAN_HOME` | 원장·카드·설정이 사는 폴더. 기본 `~/.kadan` (옛 이름 `KADAN_LITE_HOME`도 읽음) |
| `KADAN_FLOOR` | 에이전트가 사는 바닥. `tmux`(기본) 또는 `rottie`. 기계당 하나 |
| `KADAN_WINDOW` | tmux 바닥에서 시작할 때 여는 창. `none`(기본) · `rottie` · `orca` |
| `KADAN_ROTTIE_BIN` | `KADAN_WINDOW=rottie`일 때 말 걸 로티 CLI의 절대경로 |
| `KADAN_SOCKET` | tmux 구획 이름. 기본 `kadan` (`tmux -L kadan`) |
| `KADAN_ROLE` | 카단 세션 안에서 자동으로 붙는 자기 역할. 원장의 `by`가 된다 |

## 처음 준비

| 명령 | 하는 일 | 자주 쓰는 옵션 |
|---|---|---|
| `kadan init` | 환경 확인, 스킬 링크, 실행기 선택. 처음 한 번 | `--runner codex\|claude`, `--no-skills` |
| `kadan up` | 비서 세션과 대시보드 세션을 띄운다. 이미 있으면 그대로 쓴다 | `--cmd <실행기 명령>`, `--port 8790`, `--hidden`, `--no-prompt` |

## 역할(세션) 다루기

| 명령 | 하는 일 | 자주 쓰는 옵션 |
|---|---|---|
| `kadan start <역할>` | 바닥에 세션을 만들고 창을 연다. 이미 살아 있으면 창만 다시 연다 | `--profile worker\|reviewer\|conductor\|super\|secretary`, `--cmd <명령> --reason <이유>`, `--fallback N --reason <이유>`, `--hidden` |
| `kadan send <역할> <메시지>` | 생존 확인 뒤 입력창에 넣는다. 원장에 영수증을 남긴다 | `--task <카드id>`(작업 발령), `--work`·`--execution`(우편 연결), `--mailbox`, `--expect-reply`, `--reply-to <우편ID>`, `--raw` |
| `kadan wait <역할>` | 완료 마커(DONE)나 조용함을 보고한다. 판정하지 않는다 | `--timeout 초`, `--quiet 초`, `--interval 초` |
| `kadan done <역할> <카드id> <ok\|failed>` | 사람·감독이 확인한 완료를 원장에 적는다 | — |
| `kadan read <역할>` | 화면 끝부분을 읽는다 | `--lines N` |
| `kadan status` | 살아 있는 세션, 창 붙음 여부, PID 일치, 실행기·모델 | — |
| `kadan attach <역할>` | 살아 있는 세션에 창을 하나 더 연다 | — |
| `kadan restore [역할...]` | 로티 데몬 재시작 뒤, 기록된 로티 탭이 죽은 살아 있는 세션에 새 탭을 붙인다 | `--dry-run` |
| `kadan stop <역할>` | 카단이 만든 세션만 끝내고 연결된 로티 탭을 닫는다. 미확정 카드가 있으면 알린다 | — |

### `kadan restore` 자세히

로티 데몬을 다시 켜면 tmux 세션(에이전트)은 살고, 그 세션을 보여 주던 로티 탭만 끊긴다. `restore`는 탭만 다시 붙인다.

- 바닥이 tmux이고 `KADAN_WINDOW=rottie`일 때만 쓴다. 로티 바닥은 데몬과 함께 에이전트도 끝나므로 되살릴 것이 없다.
- 세션마다 원장에 적힌 로티 탭 상태를 로티에 묻는다. `running`·`created`면 건너뛰고, `unknown`·`closed`·`exited`이거나 탭이 없으면 새 탭을 붙인다.
- 마지막 `start`에 로티 탭이 없는 세션(숨김으로 띄운 watch·대시보드)은 건너뛴다.
- 탭 조회가 하나라도 실패하면 아무것도 하지 않고 이유를 보고한다.
- 새 탭 번호는 원장에 `window` 기록으로 남는다. 이후 `stop`은 새 탭을 닫는다. 죽은 옛 탭은 한 번 지워 보고, 실패하면 알리기만 한다.
- 실측: 2026-09-24 데몬 실제 재시작에서 세션 5개를 되살렸고 에이전트 PID는 그대로였다.

## 판과 현황 보기

| 명령 | 하는 일 | 자주 쓰는 옵션 |
|---|---|---|
| `kadan plan <판> <카드id[:제목]>...` | 판을 열 때 카드 목록을 원장에 먼저 적는다 | `--about "<판 설명>"` |
| `kadan tree` | 판·카드·실행·살아 있는 역할 요약(JSON) | `--legacy`(옛 세션 나무) |
| `kadan log` | 원장 최근 30줄 | — |
| `kadan wall` / `kadan dashboard` | 로컬 관제 화면(HTML)을 띄운다 | `--port 8790`, `--cache-sec 초` |

## 감시

| 명령 | 하는 일 | 자세히 |
|---|---|---|
| `kadan watch` | 정체·끊김·완료 후보를 감독에게 알리는 감시를 돌린다 | [감시 기준](watch-overview.md), [제한 재개](rate-limit-retry.md), [책임 관계](hierarchy.md) |
| `kadan watch-report <호출ID>` | 감시 AI가 판정 결과를 돌려준다 | `--verdict 진행중\|입력대기\|실행완료\|응답장애\|정체\|모름\|조정 --reason <이유>` |

## 업무·카드·결정

| 명령 | 하는 일 | 자세히 |
|---|---|---|
| `kadan work` | 결과 중심 업무 한 장과 그 안의 실행. `create`·`list`·`show`·`update`·`execute`·`link`/`unlink`·`mail`·`complete`/`cancel`·`reopen` | [업무 카드와 실행](business-work.md) |
| `kadan work auto-*` | 구현·검수 자동 전달. `auto-configure`·`auto-show`·`auto-run`·`auto-report` 등 | [자동 전달](automatic-review.md) |
| `kadan card` | 중앙 카드. `list`·`show`·`create`·`update`·`note`·`brief`·`progress`·`report`·`link` 등 | [중앙 카드](card-center.md) |
| `kadan decision` | 사용자 결정 요청. `request`·`list`·`show`·`answer`·`cancel` | [결정 기록](decisions.md) |

## 우편

| 명령 | 하는 일 | 자세히 |
|---|---|---|
| `kadan inbox` | 역할 우편함 조회. `list`·`received`·`sent`·`to-reply`·`waiting`·`read`·`ack`·`cancel` | [우편함 명령](secretary-mailbox.md), [원장 계약](mail-task-ledgers.md) |

보내기는 `kadan send <역할> --mailbox …`다. 조회는 읽음 처리하지 않고, `ack`가 읽음만 표시한다.

## 운영 설정·저장

| 명령 | 하는 일 | 자세히 |
|---|---|---|
| `kadan runners` | 역할별 실행기·모델·폴백 순서 설정. `show`·`init`·`set`·`runner`·`model`·`block`·`preset`·`fallback` | [실행 모델 설정](runner-settings.md) |
| `kadan handover <선임> --to <후임> …` | 담당 인계. `accept`·`finish`·`status`·`abort` | [인계 안내](handover.md) |
| `kadan storage` | 원장 저장소 점검·전환. `inspect`·`verify`·`activate`·`import`·`export`·`pause`·`resume` | [SQLite 저장](sqlite-storage.md) |

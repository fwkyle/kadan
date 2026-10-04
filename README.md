# kadan (카단)

**여러 AI CLI를 역할별 터미널로 띄워 놓고, 말을 걸고, 지켜보고, 필요하면 직접 들어가 개입하는 도구입니다.**

> **Run AI CLI agents (Claude Code, Codex, …) as named roles in tmux — start them, message them, watch for completion, and step in yourself.**
> Zero runtime dependencies (Node built-ins + tmux). The interface is currently Korean; contributions are welcome in any language.

카단은 특정 AI를 감싸거나 흉내 내지 않습니다. 터미널에서 돌아가는 CLI라면 무엇이든 카단 안에서 돌아갑니다.

- 🧑‍💼 **역할로 나눠 맡깁니다.** 비서·감독·작업자·검수자가 각자 자기 tmux 세션에서 일합니다.
- ✉️ **말을 주고받습니다.** 역할끼리, 또는 사람이 역할에게 메시지를 보내고 읽음·답장을 확인합니다.
- 👀 **지켜봅니다.** 멈췄는지, 끊겼는지, 끝났는지를 감시해서 위 담당에게 알립니다.
- ✋ **언제든 끼어듭니다.** `kadan attach`로 실제 터미널에 들어가 직접 입력할 수 있습니다.
- 📒 **기록은 지우지 않습니다.** 무슨 일이 있었는지 뒤에 덧붙이기만 하는 원장에 남깁니다.

---

## 필요한 것

| 항목 | 버전 | 비고 |
|---|---|---|
| Node.js | **24 이상** | 기본 저장소가 Node 내장 SQLite(`node:sqlite`)를 씁니다 |
| tmux | 3.x | 기본 실행 바닥 |
| AI CLI | — | 비서로 쓸 `claude` 또는 `codex` 등 |
| OS | macOS / Linux | Linux에서는 창을 자동으로 열지 않고 붙는 명령을 알려 줍니다 |

설치 확인:

```bash
node -v    # v24 이상
tmux -V    # tmux 3.x
```

## 설치

```bash
git clone https://github.com/fwkyle/kadan.git
cd kadan
npm --prefix gui ci   # 대시보드 화면 빌드에 필요한 패키지 (카단 본체는 의존성 0개)
npm run build:gui     # 대시보드 화면 빌드
npm link              # `kadan` 명령을 PATH에 등록
kadan --help
```

> `npm link`를 쓰지 않으려면 `node <저장소>/src/cli.mjs <명령>`으로 똑같이 쓸 수 있습니다.

## 5분 시작하기

```bash
kadan init          # 처음 한 번: node·tmux 확인, 스킬 연결, 비서용 AI CLI 선택
kadan up            # 매일: 비서 세션 + 대시보드 세션을 띄움 (이미 있으면 그대로 사용)
kadan attach 비서   # 비서 터미널에 들어가 대화 시작
```

- `kadan up`이 대시보드 주소를 알려 줍니다. 기본은 http://127.0.0.1:8790 입니다.
- 비서는 카단 스킬을 알고 있어서, 원하는 일을 말하면 감독·작업자를 대신 꾸려 줍니다.
- 끝낼 때는 `kadan stop 비서`, `kadan stop 대시보드`.
- 자주 쓰는 옵션: `kadan up --cmd 'claude' --port 8800 --no-prompt`

## 핵심 개념

| 개념 | 한 줄 설명 |
|---|---|
| **역할** | `kadan-<이름>` tmux 세션 하나. 예: `비서`, `감독`, `작업자-a` |
| **바닥(floor)** | 역할이 실제로 사는 터미널 층. 기본은 `tmux`, macOS 앱인 `rottie`도 지원 |
| **원장(ledger)** | 시작·발령·우편·완료 같은 사건을 뒤에 덧붙이기만 하는 기록. 고치거나 지우지 않음 |
| **완료 마커** | 에이전트가 직접 출력하는 `KADAN:DONE <카드id> <ok\|failed>` 한 줄. 카단은 출력을 보고 완료를 짐작하지 않음 |
| **워크 / 카드** | 워크 = 약속한 결과 한 건, 카드 = 그 결과를 위해 한 담당에게 맡긴 일 한 건 |
| **우편** | 역할 사이의 메시지. 읽음 확인·답장 대기를 따로 추적 |
| **감시(watch)** | 멈춤·끊김·완료 후보·오래 안 읽은 우편을 위 담당에게 알리는 백그라운드 프로그램 |

자세한 정의는 [용어사전](docs/glossary.md), 전체 구조는 [구조 기준](docs/architecture.md)에 있습니다.

## 직접 다뤄 보기

비서 없이 역할을 손으로 띄우고 일을 맡기는 흐름입니다.

```bash
kadan start worker-a --cmd 'codex'      # tmux 세션 kadan-worker-a를 만들고 원장에 기록
kadan send worker-a --task card-1 \
  "card-1을 해 주세요. 끝나면 마지막 줄에 KADAN:DONE <카드id> <ok|failed> 형식으로 출력하세요. 카드id는 card-1입니다."
kadan wait worker-a                      # 완료 마커나 조용함을 알려 줌 (대신 판정하지 않음)
kadan attach worker-a                    # 실제 터미널에 들어가기
kadan status                             # 살아 있는 세션 목록
kadan stop worker-a                      # 카단이 만든 세션만 끌 수 있음
```

> 프롬프트에는 완료 마커의 **형식**만 적고, 완성된 마커를 그대로 넣지 마세요. 화면에 남은 마커를 완료로 잘못 읽을 수 있습니다.

### 자주 쓰는 명령

| 명령 | 하는 일 |
|---|---|
| `kadan init` / `kadan up` | 처음 준비 / 비서·대시보드 띄우기 |
| `kadan start <역할>` | 역할 세션 만들기 |
| `kadan send <역할> <메시지>` | 살아 있는지 확인한 뒤 메시지 넣기 (`--task`로 카드 발령) |
| `kadan wait <역할>` | 완료 마커나 조용함 기다리기 |
| `kadan read <역할>` | 화면 끝부분 읽기 |
| `kadan status` | 살아 있는 세션과 PID 일치 여부 |
| `kadan attach <역할>` | 실제 터미널에 들어가기 |
| `kadan stop <역할>` | 세션 끝내기 |
| `kadan inbox` | 역할별 받은·보낸 우편, 답장 대기 보기 |
| `kadan watch` | 감시 시작 |
| `kadan wall` / `kadan dashboard` | 로컬 대시보드 |
| `kadan work` / `kadan card` | 워크·카드 관리 |

모든 명령과 옵션은 [명령어 사전](docs/commands.md)에 있습니다. 묶음 명령은 `kadan <명령> --help`로도 볼 수 있습니다.

## 데이터와 설정

- 모든 데이터는 `~/.kadan`에 저장됩니다. `KADAN_HOME`으로 바꿀 수 있습니다.
- 원장은 뒤에 덧붙이기만 합니다. 카단은 지난 사건을 고치거나 지우지 않습니다.
- 주요 환경 변수:

| 변수 | 뜻 | 기본값 |
|---|---|---|
| `KADAN_HOME` | 데이터 폴더 | `~/.kadan` |
| `KADAN_FLOOR` | 실행 바닥 (`tmux` \| `rottie`) | `tmux` |
| `KADAN_WINDOW` | 시작할 때 열 창 (`none` \| `rottie` \| `orca`) | `none` |
| `KADAN_SOCKET` | tmux 구획 이름 | `kadan` |

전체 목록은 [명령어 사전의 환경 설정](docs/commands.md#환경-설정)을 보세요.

## 더 알아보기

| 알고 싶은 것 | 문서 |
|---|---|
| 문서 전체 안내 | [docs/README.md](docs/README.md) |
| 왜 이렇게 만들었나, 바꾸지 않는 규칙 | [설계 원칙](docs/design.md) |
| 작업·우편 원장이 어떻게 연결되나 | [구조 기준](docs/architecture.md), [원장 계약](docs/mail-task-ledgers.md) |
| 우편 보내기·읽음·답장 | [역할 우편함](docs/secretary-mailbox.md) |
| 감시가 무엇을 언제 알리나 | [감시 기준](docs/watch-overview.md) |
| 대시보드 구조와 개발 | [대시보드](docs/dashboard-react.md) |
| 에이전트용 스킬 | `skills/` (conductor · super · secretary) |

## 테스트

```bash
npm test               # 본체 테스트 (node --test tests/*.test.mjs)
npm run test:gui       # 대시보드 요청·취소·시간 제한 계약
npm run build:gui      # 대시보드 타입 검사 + 빌드
npm run check:public   # 개인 경로나 작업 기록이 레포에 섞이지 않았는지 검사
```

## 기여

[CONTRIBUTING.md](CONTRIBUTING.md)를 먼저 읽어 주세요. AI 코딩 에이전트로 작업할 때도 같은 규칙이 적용됩니다.

## 라이선스

Apache-2.0. `LICENSE`와 `NOTICE`를 보세요.

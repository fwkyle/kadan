# kadan (카단)

**Run AI CLI agents as named roles in tmux — start them, message them, watch for completion, and step in yourself.**
카단은 여러 AI CLI(codex, claude 등)를 역할별 tmux 세션으로 띄우고, 메시지를 주고받고, 멈췄는지 감시하고, 필요하면 사람이 직접 창에 들어가 개입하는 도구입니다. 의존성 0개(Node 내장 + tmux).

Kadan does not wrap or adapt any particular AI CLI. Whatever runs in a terminal runs in Kadan.
It keeps an append-only ledger of what happened, refuses to send to a session it cannot prove is alive,
and never auto-judges an agent's output: completion is an explicit `KADAN:DONE <task> ok|failed` line the agent prints.

Interface language is currently Korean (role names, CLI output, dashboards). Contributions are welcome in any language.

## 작업과 우편 확인

전체 관계와 읽음·알림·인계 책임 기준은 [카단 구조와 원장 기준](docs/architecture.md)에서 확인합니다.

기존 대시보드에서 모든 역할의 받은·보낸 편지와 답변 대기 질문을 조회하고, 사건 기록을 작업·우편·시스템으로 나눠 볼 수 있습니다. 같은 SQLite를 사용하며 과거 원장은 보존합니다. 업무·카드 상태 이력은 기존 상세 화면에 유지합니다. 인계 뒤에는 후임 역할로 우편을 찾고 원래 발수신 정보도 확인할 수 있습니다. 질문은 `send --expect-reply`, 최종 답장은 `send --reply-to <우편ID> --reply-final`, 역할별 대기는 `inbox waiting --role <역할>`로 확인합니다.

일반 메시지는 즉시 전달하고 우편 ID와 읽음 확인 안내를 붙입니다. 수신자가 직접 `inbox ack`로 확인하며, 5분 지난 미확인 우편은 기존 감시가 역할별로 묶어 한 번 알립니다. 읽음과 답변 대기는 별개입니다.

실행 완료 시 기록용 결과 우편은 원본 요청자의 우편함에 저장되며 추가 미확인 알림에서 제외합니다. 기존 최종 완료 통지는 정상 터미널 우편으로 유지합니다. 이 저장은 터미널 깨움이나 업무 최종 완료를 뜻하지 않습니다. 자세한 범위는 [작업·우편 원장 계약](docs/mail-task-ledgers.md), 명령은 [역할 우편함 안내](docs/secretary-mailbox.md)를 참고하세요.

## Requirements

- Node.js 24 or newer (the default SQLite storage uses the built-in node:sqlite)
- tmux 3.x (default floor). A Rottie floor also exists; see `docs/`.
- macOS or Linux. No terminal window is opened on Linux; `kadan attach` prints the command instead.

## Install

```bash
git clone https://github.com/ChickenBreast-ky/kadan.git
cd kadan
npm link          # puts the `kadan` command on your PATH (no dependencies are installed)
kadan --help
```

## Quick start (recommended)

Two commands give you a secretary agent to talk to and a dashboard to watch. The secretary knows the Kadan skills and will set up supervisors and workers for you as you ask.

```bash
kadan init        # once: checks node/tmux, links skills/ into ~/.codex/skills and ~/.claude/skills, picks codex or claude
kadan up          # every day: starts the 비서 (secretary) session + a hidden dashboard session
kadan attach 비서 # open the secretary terminal and start talking (Korean UI)
```

`kadan up` prints the dashboard URL (default http://127.0.0.1:8790). Both are ordinary Kadan sessions: `kadan status` shows them, `kadan stop 비서` / `kadan stop 대시보드` end them. Options: `kadan up --cmd 'claude' --port 8800 --no-prompt`.

## Manual run

```bash
export KADAN_FLOOR=tmux       # fixed per machine: tmux | rottie
export KADAN_WINDOW=none      # none | orca | rottie  — whether to open a GUI tab on start

kadan start worker-a --cmd 'codex'        # creates tmux session kadan-worker-a and records it in the ledger
kadan send worker-a --task card-1 \
  "Do card-1. When finished, print one last line in the form: KADAN:DONE <card-id> <ok|failed>, card-id is card-1"
kadan wait worker-a                        # reports the DONE marker or silence; never decides for you
kadan attach worker-a                      # jump into the live terminal
kadan restore --dry-run                    # after a Rottie daemon restart: list live sessions whose Rottie tab died
kadan restore [worker-a ...]               # reattach those sessions in new Rottie tabs (KADAN_WINDOW=rottie)
kadan status
kadan stop worker-a                        # only sessions Kadan created can be stopped
```

Data lives in `~/.kadan` (override with `KADAN_HOME`). The ledger is append-only; Kadan never edits or deletes an event.

## More

- `kadan watch` — background monitor that reports stalls, disconnects and DONE candidates to a supervisor role.
- `kadan wall` / `kadan dashboard` — local HTML views of boards, cards, ledger and mail.
- `kadan card` / `kadan work` — central card store and result-oriented work items.
- `docs/` — design principles and locked rules (`design.md`), watch criteria, hierarchy, handover, SQLite storage.
- `CONTRIBUTING.md` — how to contribute; the same rules apply if you use an AI coding agent.
- `skills/` — conductor / supervisor / secretary skills for Codex-style agents that drive Kadan.

## Test

```bash
npm test          # node --test tests/*.test.mjs
npm run check:public   # fails if personal paths or workspace records leak into the repo
```

## License

Apache-2.0. See `LICENSE` and `NOTICE`.

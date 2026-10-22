# 카단 설치 — AI 에이전트용 절차

> **For AI agents (Claude Code, Codex, …):** the user pointed you here to install kadan. Read this whole file (do not summarize it), then follow steps 0–6 in order.
> Needs Node.js 24+, tmux 3.x and one AI CLI (`claude` or `codex`). Never run sudo or enable login autostart unprompted, and never ask for or write down tokens or keys.
> The steps are in Korean; report to the user in the language they use, in 5 lines or fewer.

## Why

처음 쓰는 사람은 "카단 깔아 줘"를 AI에게 맡긴다. AI가 긴 README를 요약하며 읽다가 대시보드 화면 빌드를 빠뜨리면
주소가 503을 내는데도 설치가 끝난 것처럼 보인다. 그래서 AI가 처음부터 끝까지 그대로 따르는 한 장을 따로 둔다.
사람이 직접 설치할 때는 [README](../README.md)의 '설치'를 보면 된다.

## 읽는 법

- 사용자가 이 문서 주소를 주고 "카단을 설치해 줘"라고 했다면 아래를 순서대로 따른다.
- 원문 전체를 읽는다. 요약 도구로 읽지 않는다.
- 사용자에게 물어야 하는 곳은 **묻기**로 표시했다. 나머지는 묻지 않고 진행한다.
- 각 단계 끝의 **성공하면**이 보이지 않으면 다음 단계로 넘어가지 않는다.

## 0. 하지 않는 것

- `sudo`, 시스템 설정 변경, 로그인 자동 시작(`kadan autostart install`)은 사용자가 따로 요청하기 전에 하지 않는다.
- 실제 AI 모델을 호출하는 시험을 돌리지 않는다.
- 이미 `~/.kadan`이 있으면 지우거나 덮지 않는다. `kadan init`도 돌리지 않고 4단계의 `kadan doctor`만 돌려 결과를 사용자에게 알린다.
- 비밀값(토큰·키)을 묻거나 대화에 적지 않는다. 디스코드 연결처럼 비밀이 필요한 선택 기능은 6단계에서 "나중에 사람이 직접 한다"고만 안내한다.

## 1. 확인

```bash
node -v              # v24 이상
tmux -V              # tmux 3.x
which claude codex   # 둘 중 하나는 있어야 비서를 띄울 수 있다
```

없는 것이 있으면 설치 방법만 알려 주고 멈춘다. 예: `brew install tmux`, `nvm install 24`.

**성공하면:** Node 24 이상, tmux 3.x, `claude` 또는 `codex` 경로가 출력된다. 둘 중 하나의 경로가 나오면 통과한다. 종료 코드만으로 판단하지 않는다.

## 2. 설치

```bash
git clone https://github.com/fwkyle/kadan.git ~/Dev/kadan   # 묻기: 놓을 위치
cd ~/Dev/kadan
npm --prefix gui ci    # 대시보드 화면 빌드에 필요한 패키지
npm run build:gui      # 대시보드 화면 빌드. 빠뜨리면 대시보드 주소가 503이 된다
npm link               # 묻기: 컴퓨터 전체 npm 설정을 바꾸므로 사용자에게 알린 뒤 한다
kadan --help
```

`npm link`가 싫다는 사용자에게는 `node ~/Dev/kadan/src/cli.mjs <명령>`으로 같은 명령을 쓴다고 알린다.
이 문서의 `kadan <명령>`을 모두 그렇게 바꿔 실행한다.
위치를 바꿨다면 위의 `cd`와 대체 실행 경로도 같은 위치로 바꾼다.

**성공하면:** `kadan --help`가 짧은 명령 목록(9줄)을 출력한다. `npm run build:gui`가 오류 없이 끝난다.

## 3. 처음 설정

```bash
kadan init                                              # 환경 확인 · 스킬 연결 · 비서 실행기 선택
kadan runners init --reason "처음 시작용 기본 프리셋"       # 역할별 실행기 기본 틀
kadan up                                                # 비서와 대시보드를 띄운다
```

- `kadan init`은 `codex`와 `claude`가 둘 다 있으면 `codex`를 비서로 고른다. 사용자가 다른 쪽을 원하면 `kadan init --runner claude` 또는 `--runner codex`로 다시 한다.
- Codex는 읽을 수 있는 모델 목록이 있을 때 작업자·감독 기본값을 채운다. 모델 목록이 없거나 Claude만 있으면 역할 값이 비어 있을 수 있다. 실행 결과의 안내를 사용자에게 전하고 모델을 임의로 고르지 않는다. 검수자 역할은 늘 비어 있다. 비어 있는 역할은 나중에 [실행 모델 설정](runner-settings.md)대로 채운다.
- macOS에서 `kadan up`은 기본 설정(`none`)이면 창을 자동으로 열지 않는다. `kadan attach 비서`도 같아서 `창 열림(manual)` 한 줄만 나온다. 사람이 터미널에서 `kadan up`이 출력한 `tmux -L kadan attach -t kadan-비서`로 비서에 붙는다. 소켓 이름을 바꿨다면(`KADAN_SOCKET`) 출력된 값을 쓴다. macOS에서 로티 창을 쓰려면 `kadan window set rottie --rottie-bin <절대경로>`로 설정한다([명령어 사전](commands.md)). Linux에서는 창을 자동으로 열지 않으므로 출력된 tmux 명령으로 붙는다. 막히면 4단계로 간다.

**성공하면:** `kadan up`이 `대시보드: http://127.0.0.1:8790` 같은 주소를 출력한다.

## 4. 확인

```bash
kadan doctor
```

- 읽기 전용 점검이다. 막힌 곳이 있으면 그 줄의 `풀려면:` 명령을 보여 준다.
- 막힘이 있으면 **풀려면 한 줄만** 사용자에게 알리고, 사용자가 확인한 뒤에 실행한다. 한 번 풀고 `kadan doctor`를 다시 돌려 본다.
- 원인을 모르는 실패는 다시 시도하지 않고 멈춰서 상태를 그대로 알린다.
- 상태는 다섯 가지다: `정상`, `해당 없음`(안 깐 선택 기능이라 정상), `주의`(알리되 설치 실패로 보지 않는다), `막힘`, `확인 불가`(조회하지 못함).
- `확인 불가`가 있으면 확인하지 못한 항목을 사용자에게 알리고 설치 확인을 보류한다. 종료 코드 0만으로 성공을 단정하지 않는다(`확인 불가`는 종료 코드에 잡히지 않는다).

**성공하면:** `kadan doctor`에 `막힘`과 `확인 불가`가 모두 0개이고 종료 코드가 0이다.

## 5. 이 대화를 카단에 붙일지 제안 (조건부)

**설치 말고도 이 대화에 이어갈 일이 있을 때만** 한다. 없으면 건너뛰고 6단계로 간다.

묻기 전에 효과부터 말한다.

- 지금 대화를 복제해서 새 감독으로 연다.
- 지금 권한이 그대로 이어진다.
- 새 감독이 인수를 확인하면 원래 Rottie 탭이 닫힐 수 있다.
- 감독에게 맡길 목표와 범위를 정해야 한다.
- 컴퓨터와 tmux·AI 프로세스가 켜져 있어야 이어진다.

**묻기:** "지금 하던 대화를 카단 감독으로 옮길 수 있습니다(위 효과). 옮길까요?" 자동으로 실행하지 않는다.

- 아니오 → 6단계로.
- 예 → 이 대화를 시작한 폴더에서 한다.
  - Claude Code: `kadan adopt <저장소>-감독 --model <지금 모델>`
  - Codex: `kadan adopt <저장소>-감독 --model <지금 모델> --resume <대화ID> --harness codex` (Codex 대화 ID는 자동으로 읽지 못하므로 사용자에게 받는다)
- 역할 이름은 `<저장소>-<역할>` 모양으로 짓는다.
- 옮긴 뒤 이 대화는 더 지시하지 않는다. 진행은 대시보드나 `kadan attach <저장소>-감독`으로 본다.

상세한 규칙은 [인수 절차](adopt.md)를 따른다.

**성공하면:** `kadan adopt status <인수ID>`에 새 감독의 인수 확인이 보인다.

## 6. 사용자에게 보고할 것

사용자가 쓰는 언어로 5줄 이내로 보고한다.

- 설치 위치
- 대시보드 주소
- 비서에 붙는 법: 터미널에서 `tmux -L kadan attach -t kadan-비서`(기본 소켓일 때. `kadan up` 출력 참고). macOS에서 창을 자동으로 열려면 `kadan window`로 설정한다
- 끄는 법: `kadan stop 비서`, `kadan stop 대시보드`
- 막힌 것이 있었다면 무엇이었는지, 디스코드 연결처럼 사람이 나중에 직접 해야 하는 선택 기능이 있다는 것

더 알아보려면 [명령어 사전](commands.md)과 [흐름 지도](flows.md)를 보라고 안내한다.

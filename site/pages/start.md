# 시작하기

설치부터 비서에게 첫 일을 맡기고 결과를 보기까지, 위에서 아래로 따라 하면 됩니다.

## 필요한 것

- **Node.js 24 이상**: 카단의 기록 저장이 Node.js에 들어 있는 SQLite를 씁니다.
- **tmux 3.x**: AI 역할이 실제로 사는 터미널입니다.
- **AI CLI 하나**: `claude` 또는 `codex`. 비서로 씁니다.
- **macOS 또는 Linux**: Linux에서는 창을 자동으로 열지 않고, 붙는 명령을 알려 줍니다.

```bash
# v24 이상
node -v
# tmux 3.x
tmux -V
```

## AI에게 설치 맡기기

이미 쓰고 있는 AI CLI에게 아래 주소를 주고 "카단을 설치해 줘"라고 하면 됩니다. AI가 처음부터 끝까지 그대로 따르도록 쓴 한 장짜리 절차입니다.

```text
https://github.com/fwkyle/kadan/blob/main/docs/ai-install.md
```

- AI는 `sudo`를 쓰거나 로그인 자동 시작을 켜지 않고, 토큰이나 키를 묻지 않습니다.
- 놓을 위치와 `npm link`처럼 컴퓨터 설정에 닿는 곳에서는 먼저 묻습니다.
- 설치가 끝나면 설치 위치, 대시보드 주소, 비서에 붙는 법, 끄는 법을 알려 줍니다.

절차 전문은 [AI용 설치 안내](docs/ai-install.md)에 있습니다.

## 직접 설치하기

```bash
git clone https://github.com/fwkyle/kadan.git
cd kadan
# 대시보드 화면 빌드에 필요한 패키지 (카단 본체는 의존성 0개)
npm --prefix gui ci
# 대시보드 화면 빌드
npm run build:gui
# kadan 명령을 PATH에 등록
npm link
kadan --help
```

`npm link`를 쓰지 않으려면 `node <저장소>/src/cli.mjs <명령>`으로 똑같이 쓸 수 있습니다. 대시보드 화면 빌드를 빠뜨리면 대시보드 주소가 열리지 않습니다.

## 처음 설정

```bash
# 처음 한 번: node·tmux 확인, 스킬 연결, 비서용 AI CLI 선택
kadan init
# 역할별 실행기 기본 틀
kadan runners init --reason "처음 시작용 기본 프리셋"
```

`claude`와 `codex`가 둘 다 있으면 `kadan init`은 `codex`를 비서로 고릅니다. 다른 쪽을 쓰려면 `kadan init --runner claude`처럼 다시 실행합니다.

## 켜기

```bash
kadan up
```

비서와 대시보드를 띄웁니다. 이미 떠 있으면 그대로 씁니다. 끝나면 대시보드 주소(기본 `http://127.0.0.1:8790`)와 비서에 붙는 tmux 명령을 알려 줍니다.

## 비서에게 첫 업무 말하기

기본 설정에서는 `kadan up`이 출력한 tmux 명령으로 비서 터미널에 들어갑니다. 창을 설정해 두었다면 `kadan attach 비서`로 엽니다.

비서는 평범한 AI CLI이고 카단 사용법을 알고 있습니다. 하고 싶은 일을 말로 하면 감독과 작업자를 대신 꾸려 줍니다.

## 대시보드에서 진행 보기

`kadan up`이 알려 준 주소를 브라우저로 엽니다. 어떤 역할이 무엇을 하고 있는지, 내가 답해야 할 결정이 있는지, 멈춘 곳이 있는지를 한 화면에서 봅니다.

## 막히면

```bash
kadan doctor
```

읽기 전용 점검입니다. 막힌 곳과 풀려면 칠 명령을 한 줄씩 보여 줄 뿐 아무것도 고치지 않습니다.

## 끄기

```bash
kadan stop 비서
kadan stop 대시보드
```

카단은 자기가 만든 세션만 끕니다. 개인 tmux 세션은 건드리지 않습니다.

## 다음에 읽을 것

- 자기 상황에 맞는 쓰임새: [유즈케이스](use-cases.html)
- 하고 싶은 일에서 명령 한 줄 찾기: [상황별 길잡이](how-to.html)
- 모든 명령과 옵션: [명령어 사전](docs/commands.md)

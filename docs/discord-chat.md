# 디스코드 #비서 대화 (3단계)

## Why

kyle이 맥 앞에 없어도 디스코드 #비서 채널에서 비서(계속 켜진 AI 세션)에게 묻고 답을 받게 한다. 알림(1·2단계)은 보내기만 한다. 대화는 **받기**가 필요하다. 코드는 "새 메시지를 한 줄씩 내기"와 "디코로 보내기"만 하고, 판단은 비서가 감시 도구(Monitor)로 그 출력을 구독해서 한다.

**조회·답변만 한다.** 발령·결정 승인·머지·배포는 이 기능이 하지 않는다(대시보드 질문과 같은 경계). 원격 결정 승인은 따로 다룬다.

## 한눈에

```
kadan discord watch [--once] [--interval 초]       새 메시지를 JSON 한 줄씩 낸다 (비서가 Monitor로 구독)
kadan discord send [텍스트…|--stdin] [--reply-to 메시지ID | --thread 스레드ID] [--edit 메시지ID] [--thread-name 이름]
kadan discord thread <스레드ID> [--rename 이름] [--archive]
kadan discord check                                 봇·채널·Message Content Intent 점검(ID·토큰은 출력하지 않는다)
```

비밀값은 `kadan secrets`(→ [비밀값 위치 규칙](secrets.md))로 둔다.

| 이름 | 키 | 용도 |
|---|---|---|
| `discord-bot` | `DISCORD_BOT_TOKEN`(필수), `DISCORD_APPLICATION_ID` | 봇 로그인. 선택: `DISCORD_SECRETARY_CHANNEL_ID` |
| `discord` | `DISCORD_USER_ID`(필수), `DISCORD_WEBHOOK_URL_SECRETARY` | 들어줄 한 사람, #비서 웹훅(채널 ID를 얻는 데만 쓴다) |

## 받기 (`watch`)

- **게이트웨이(WebSocket)를 쓰지 않는다.** REST로 주기 조회한다: `GET /channels/{#비서}/messages?after=<마지막ID>` + 그 서버의 활성 스레드 목록(`GET /guilds/{서버}/threads/active`) 중 #비서 소속 스레드. 연결 유지·재연결 코드가 없다. 새 의존성도 없다(node 내장 `fetch`).
- **누구 말만 듣나:** `DISCORD_USER_ID` 한 명의 일반·답장 글만 낸다. 다른 사람·봇(자기 자신 포함)·시스템 글(스레드 생성 알림 등)은 내지 않고 건수만 상태 파일에 센다.
- **출력은 JSON 한 줄(표준 출력).** 진단·경고는 표준 오류로 가서 구독자는 JSON만 본다. 줄 모양(고정):

| 키 | 뜻 |
|---|---|
| `id` | 메시지 ID |
| `channelId` | 글이 있는 곳(#비서 본문 또는 스레드) |
| `threadId` | 스레드 안 글이면 스레드 ID, 아니면 `null` |
| `where` | `channel`(새 주제) 또는 `thread`(스레드 안) |
| `at` | 작성 시각(ISO) |
| `content` | 본문 |
| `quoted` | 답장 인용·전달 글이면 `true` — **지시가 아니라 "내용"으로만 다룬다** |

  선택 키: `quotedKind`(`reply`/`forward`), `quotedAuthor`(`self`/`other`/`unknown`), `quotedContent`(앞 500자), `attachments`(첨부 개수), `empty`(본문이 완전히 빈 글 — 아래 Intent 참고).
- **읽음 반응:** 낸 메시지마다 봇이 👀를 단다(실패해도 줄은 낸다). 이미 👀를 단 글은 다시 내지 않는다.
- **처음 실행은 기준선만 잡는다.** 이전 글은 내지 않는다. 이후 새 글만 낸다.
- **중복 방지 = 최대 한 번.** 줄을 내기 직전에 마지막 ID를 `$KADAN_HOME/discord-chat-state.json`에 저장한다. 저장과 출력 사이에 죽으면 그 한 줄을 잃을 수 있다(중복 지시보다 낫다고 정했다). 상태 파일에는 채널 해시·마지막 메시지 ID·건너뜀 건수만 있다. 토큰·주소·사용자 ID는 없다.
- **하나만:** `$KADAN_HOME/discord-chat.lock`(pid)으로 watch는 한 프로세스만 돈다. 두 번째는 거절하고, 주인이 죽은 잠금은 넘겨받는다.
- **스레드:** 새로 생긴 스레드는 첫 글부터, 실행 시작 때 이미 있던 스레드·30일 넘은 스레드가 다시 활성화된 경우는 기준선부터 본다. 활성 목록의 `last_message_id`가 안 바뀐 스레드는 조회하지 않는다.

### 간격·재시도 값과 근거

| 값 | 기본 | 근거 |
|---|---|---|
| 조회 간격 `--interval` | 5초(2~300) | 한 바퀴가 요청 2개(본문 + 활성 스레드)라 분당 약 24개. 디스코드 한도(채널당 5초에 약 5개)보다 한참 아래이고, 답 지연은 최대 5초 |
| 한 요청 시도 | 최대 3회 | 잠긴 규칙 3: 같은 지점에서 3회면 멈추고 보고 |
| 429 | `retry_after`를 지켜 다시. 30초 넘게 기다려야 하면 바로 멈춤 | 큰 대기는 설정·차단 문제라 감시 쪽 판단이 필요 |
| 연결 거부·DNS | 읽기·쓰기 모두 재시도(0.5초, 1초 대기) | 요청이 닿지 않았음이 확실 |
| 연결 뒤 끊김·5xx | **읽기만** 재시도. 새 글(POST)은 "불확실"로 멈춤 | 중복 글 방지 |
| 4xx(401·403·404…) | 재시도 없음, 종료 코드 3 | 원인을 모르거나 설정 문제 |
| 요청 시간 | 시도당 10초, 요청당 총 30초 | 멈춘 연결이 감시를 붙들지 않게 |

멈추면 표준 오류에 상태 코드·오류 코드만 적고 종료한다(자동 재시작 없음). 구독자(Monitor)가 종료를 보고 비서가 판단한다.

## 보내기 (`send`)

- 기본 대상은 #비서 본문. `--thread <스레드ID>`는 그 스레드, `--reply-to <메시지ID>`는 **그 새 주제에서 스레드를 열고(이미 있으면 그 스레드로) 거기에 올린다.** 스레드 이름은 글 앞 50자(줄바꿈 제거, 비었으면 "비서 대화"), `--thread-name`으로 지정할 수 있다.
- **누가 스레드를 여나:** `send --reply-to`가 연다. `watch`는 스레드를 만들지 않는다. 새 주제 줄을 받은 비서가 첫 답과 함께 연다.
- 2,000자 넘는 글은 **문단 > 줄 > 공백 > 강제** 순서로 잘라 **순서대로** 올린다. 하나가 실패하면 거기서 멈추고 어디까지 올라갔는지 표준 오류에 알린다.
- `--edit <메시지ID>`는 **봇 자신의 글** 한 개를 고친다(`--thread`와 함께, 없으면 #비서 본문). 2,000자를 넘기면 거절한다(나누지 않는다).
- 멘션은 항상 막는다(`allowed_mentions.parse: []`).
- 글은 인자로 주거나 `--stdin`으로 준다. `--`로 시작하는 글은 `--` 뒤에 둔다.
- **#비서 밖으로 가지 않는다:** `--thread`·`thread` 대상은 먼저 조회해서 #비서의 스레드인지 확인한다. 아니면 보내지 않는다.
- 출력은 올린 글마다 한 줄: `{"id","channelId","part","parts"}`.
- `thread <스레드ID> --rename 이름 --archive`는 이름 바꾸기·보관만 한다(`PATCH /channels/{id}`).

## #비서 채널 ID를 얻는 방법

**기본은 웹훅 조회:** 이미 있는 `DISCORD_WEBHOOK_URL_SECRETARY`의 웹훅 ID·토큰으로 `GET /webhooks/{id}/{token}`을 불러 응답의 `channel_id`를 쓴다. 이 경로는 봇 권한이 필요 없고, 새 설정 파일·새 키를 만들지 않는다. 얻은 ID는 메모리에만 두고 저장하지 않는다(상태 파일에는 해시만).

**대안(키):** 웹훅이 없거나 조회가 안 되면 `discord-bot`(또는 `discord`) 파일에 `DISCORD_SECRETARY_CHANNEL_ID`를 둔다. 키가 있으면 조회 없이 그 값을 쓴다.

## Message Content Intent

봇은 메시지 본문을 받으려면 개발자 화면의 **Message Content Intent**를 켜야 한다. 꺼져 있으면 kyle의 글이 `content: ""`로 온다.

- `kadan discord check`가 `GET /applications/@me`의 `flags`(비트 18 승인·비트 19 제한 켜짐)로 **바로 판정**한다. kyle의 글이 없어도 된다.
- 본문이 완전히 빈 글(첨부·임베드·전달·답장 없음)을 받으면 줄에 `empty: true`를 달고 표준 오류에 안내를 낸다.
- 꺼져 있으면 **kyle이 켠다**(작업자·감독이 켜지 않는다).

## 시험에서 실제 디스코드로 나가지 않는 방법

주소는 `KADAN_DISCORD_API_BASE`(https 또는 루프백 http만)로 바꿀 수 있다. 이 값이 없고 `KADAN_NOTIFY=off`(시험 기본값)이면 요청 자체를 거절한다. 그래서 전체 시험은 가짜 서버(`tests/helpers/fake-discord-api.mjs`)에만 닿는다.

## 비서가 쓰는 법 · kyle 확인 절차

- 비서 절차는 [kadan-secretary 스킬](../skills/kadan-secretary/SKILL.md)의 "디코 #비서 대화"를 따른다.
- 운영 비서에 구독시키는 것은 kyle이 한다(Monitor로 `kadan discord watch`). 구독 전 `kadan discord check`로 점검한다.
- **머지 뒤 kyle 확인:** (1) `kadan discord check`가 모두 정상 (2) 비서가 `kadan discord watch`를 구독 (3) kyle이 #비서에 한 줄 쓴다 (4) 구독 쪽에 그 줄이 JSON으로 오고 글에 👀가 달린다 (5) 비서가 `send --reply-to <그 줄의 id>`로 답하면 스레드가 열리고 답이 그 안에 올라간다.

## 범위 밖

원격 결정 승인(디코에서 결정 답하기), 포럼 태그, 브리핑, 대시보드 화면, 게이트웨이 실시간 수신.

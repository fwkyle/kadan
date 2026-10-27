# SQLite 저장 운영 안내

## Why

같은 카드에 여러 프로세스가 쓰거나 명령이 중간에 종료되어도 카드의 현재 상태와 변경 이력이 함께 보존되도록 한다.

## 현재 적용 경계

2026-09-07 실제 기본 데이터 폴더 `~/.kadan`를 SQLite로 전환했다. 현재 원본은 `kadan.sqlite`의 `events` 하나다. 옛 JSONL 백엔드는 제거했다(마지막 지원 태그 `jsonl-last`). 전환 시점의 동결 JSONL 파일은 코드가 더 읽지 않으며, 머지·재시작 뒤 `.trash/`로 옮기고 삭제는 사람이 한다(아래 '동결 JSONL 파일').

- 기본 선택: 새 홈은 SQLite로 자동 시작한다. storage.json·kadan.sqlite(-wal/-shm)와 옛 흔적이 모두 없는 홈에서 `kadan init`·`kadan up` 또는 첫 쓰기가 일어나면 `ensureStorage`가 DB와 storage.json을 만든다. 읽기는 홈을 만들지 않는다(빈 홈 읽기는 빈 결과). storage.json이 이미 있으면(backend가 무엇이든) 건드리지 않는다.
- 옛 흔적이 있으면 멈춘다: storage.json이 없는데 `ledger.jsonl`·`cards/*/*/events.jsonl`·`card.md` 등 옛 JSONL 파일이 있는 홈에 쓰면 오류로 멈춘다. DB 파일만 있고 storage.json이 없는 홈은 아래 판정을 따른다.
- **옛 JSONL 홈 변환**: 옛 JSONL 홈 변환은 태그 `jsonl-last`를 체크아웃해 그 버전의 `kadan storage import`로 한다. 이 버전에는 `import`·`export`·`activate`·`inspect`가 없고 `kadan storage`는 `verify`·`pause`·`resume`만 안다(`kadan doctor`의 변환 안내가 이 문장을 가리킨다).
- 초기화는 SQLite 자체 잠금으로 한다. 폴더 잠금·주인 기록·회수·`.trash` 이동은 없다. `ensureStorage`는 `kadan.sqlite`를 열거나 만들고 `BEGIN IMMEDIATE` 안에서 스키마(모든 문장이 `IF NOT EXISTS`)와 `application_id`·`user_version`을 설정해 커밋한 **뒤에** `storage.json`을 임시 파일+rename으로 쓴다. 동시에 들어온 첫 쓰기는 SQLite 잠금에서 줄을 서고, 뒤에 온 쪽은 이미 카단 표식이 있어 아무것도 하지 않는다. 프로세스가 죽으면 OS가 파일 잠금을 풀고 트랜잭션은 롤백되므로 남는 잠금이 없고, 중간에 죽은 홈은 다음 쓰기가 마저 만든다. 코드는 어떤 경우에도 `kadan.sqlite*`를 옮기거나 지우지 않는다.
- 표시 파일이 없는데 DB가 있을 때: `application_id`와 `user_version`(1)을 읽기 전용으로 확인한다. 둘 다 카단 값이면 읽기(`storageMode`)는 기다리지 않고 `sqlite`를 돌려주고(파일을 쓰지 않는다) 쓰기는 표시 파일을 마저 쓴다. 표식도 테이블도 없는 빈 DB(0바이트 포함)는 초기화 전으로 본다. 다른 `application_id`, 표식은 같지만 `user_version`이 다른 DB, 표식 없이 테이블이 있는 DB, 깨진 파일, 링크, 본 파일 없는 `-wal`/`-shm`은 'SQLite 파일은 있으나 저장소 선택 기록 없음' 오류이고 아무것도 바꾸지 않는다. 잠긴 규칙의 '자동 JSONL 우회 금지'는 JSONL로 몰래 내려가지 않는다는 뜻이다. 카단 표식이 찍힌 DB를 sqlite로 마저 여는 것은 우회가 아니다.
- SQLite 선택: storage.json `{ "version": 1, "backend": "sqlite" }`. DB 누락·다른 버전·손상은 오류. 자동 JSONL 폴백 없음.
- Node 24 이상/내장 node:sqlite 사용. 이번 검증은 Node24.20.0·SQLite3.53.4.

## 구조

- `events`: 스트림별 순번·원문 payload·수입 출처/원시 행. UPDATE/DELETE 금지.
- `heads`: 스트림의 마지막 순번·현재 상태 payload. 같은 트랜잭션 안에서 사건과 함께 갱신하며 events를 외래키로 참조한다.
- `imports`: 옛 JSONL 수입 때 기록한 원본의 해시·바이트·행 수. UPDATE/DELETE 금지. 새 홈에서는 빈 표다. 스키마(`events.source/source_line/raw` 열 포함)는 append-only라 바꾸지 않는다.
- 스트림 이름(`ledger.jsonl`, `cards/<저장소>/<ID>/events.jsonl`, `tasks|mail|system/events.jsonl` 등)은 DB 안의 영역 이름이며 파일이 아니다. 접미사가 `.jsonl`이어도 이름을 바꾸지 않는다.
- 작업 영역의 업무·카드 상태 이력은 기존 works/cards 스트림을 유지하고, 계획·발령·완료 사건은 `tasks/events.jsonl`, 우편 사건은 `mail/events.jsonl`, 세션·감시 사건은 `system/events.jsonl`로 나눈다. 모두 같은 DB의 events/heads를 사용한다. 사용자 결정·brief 스트림도 유지한다. 도메인 상태 계약은 기존 WorkStore/CardStore/DecisionStore가 담당한다.

계획에 열거한 카드/결정별 개별 테이블 대신 동일한 append-only 저장을 공통 events/heads로 구현했다. 기존 JSON payload·revision·CLI 출력 호환을 유지하고 스키마 중복을 줄인다. 현재 상태와 사건의 원자적 저장은 유지한다. 독립 실행 차수·새 상태·선행 관계를 추가하지 않았다.

기존 `ledger.jsonl` 이력은 불변으로 보존하며 통합 `readLedger`는 호환 조회다. 신규 사건은 전체 저장 순번으로 이어 읽고 과거 task send는 읽기용으로만 분류한다. 분리 저장·질문·완료 결과 통지의 정확한 의미는 [작업·우편 원장 계약](mail-task-ledgers.md)을 따른다.

카드 Markdown, 우편 본문, 보고서, 인계 JSON, 계층 설정은 파일로 유지한다. 새 실행의 `cards/<저장소>/<실행ID>/result.md`와 `evidence/`도 파일이며, 백업·이전 때 DB와 `cards/` 전체를 함께 보존한다. DB가 이 파일들의 변경까지 원자적으로 확정하는 것은 아니다. 신규 카드 생성 중 중단되면 본문만 남을 수 있으며 자동 삭제하지 않는다. 재생성 전에 원인 확인이 필요하다.

## 비교 모드 예약과 보고 조회

`system/events.jsonl`의 `compare-pick`은 세션 생성 전의 선택 예약이다.
`pickId`, `epoch`(compare.enabledAt), `settingsRevision`, `preset`, `role`,
작업자·검수자 선택값을 남긴다. 성공한 start와 카드 발령 send는 같은 pickId를 보존한다.
예약 수는 실제 시작 수와 다를 수 있으며 보고서에서 둘을 나눠 표시한다.

예약 집계는 설정에 저장한 회차 시작 `rowid` 뒤만, 보고서는 최초 비교 시작 `rowid` 뒤만 읽는다.
관련 업무·카드는 `heads`의 stream 키로 읽고 전체 카드 상태 목록은 만들지 않는다.
기존 스키마·사건을 수정하지 않는다. [비교 모드](runner-settings.md#비교-모드) 참조.

## 검증

```sh
node src/cli.mjs storage verify
```

`verify`는 DB 무결성·외래키·사건 순번·heads 일치·`imports`가 가리키는 수입 행(행 수, `raw`가 `payload`와 같은 값인지)·카드 revision·결정 참조·brief를 검증한다. 동결 JSONL 원본 파일은 열지 않으므로 파일을 `.trash/`로 옮겨도 통과한다. 사람이 가끔 치는 한 번짜리 명령이라 `events` 전체를 읽는다.

## 복구

SQLite 파일 하나가 원본이다. 복사본은 쓰기를 멈춘 뒤 만든다.

```sh
KADAN_HOME=/SQLite자료 node src/cli.mjs storage pause
# 진행 중 작성 명령과 기반 프로세스 종료를 확인한다.
sqlite3 /SQLite자료/kadan.sqlite "VACUUM INTO '/새경로/kadan.sqlite'"   # 또는 kadan.sqlite와 -wal 파일을 함께 복사
KADAN_HOME=/SQLite자료 node src/cli.mjs storage resume
```

`storage.json`도 같이 복사한 폴더에 `KADAN_HOME`을 맞추고 `storage verify`로 확인한다. DB 밖에 있는 파일(카드 본문 `cards/<저장소>/<ID>/card.md`, 새 실행의 `result.md`·`evidence/`, 우편 본문, 보고서, 인계 JSON, 계층 설정)은 DB 복사에 들어가지 않는다. 백업·이전 때 DB와 `cards/` 등 이 파일들을 함께 보존한다. `pause`는 쓰기 차단 표식만 만든다. 진행 중 명령과 옛 프로세스의 종료를 증명하지 않는다.

## 동결 JSONL 파일

2026-09-07 전환 때 `imports` 표에 기록한 옛 JSONL 원본(운영 홈 기준 260개: `ledger.jsonl`, `decisions/events.jsonl`, `cards/<저장소>/<ID>/events.jsonl`·`briefs.jsonl`)과 `storage-import.json`은 현재 코드가 읽지 않는다. 이동 방법은 다음과 같다.

- 옮기는 것은 `imports` 표에 적힌 파일뿐이다. 같은 폴더의 현행 `card.md`·`result.md`·`evidence/`는 건드리지 않는다.
- `.trash/` 아래에 **원래 상대경로를 유지**해 옮긴다(예: `.trash/jsonl-frozen-<날짜>/cards/<저장소>/<ID>/events.jsonl`). 파일은 하나씩 절대경로로 옮기고, 이동 전 `shasum -a 256`으로 `imports.sha256`과 같은지 대조한 해시 목록을 `.trash/` 폴더에 함께 남긴다.
- 복원은 같은 상대경로로 되돌리면 된다. 삭제는 사람이 한다.
- 이 버전의 `verify`는 이 파일이 없어도 통과한다. 태그 `jsonl-last` 같은 옛 버전의 `inspect`·`export`·`verify`는 이 파일을 읽으므로, 옛 버전을 쓸 때는 파일을 제자리로 복원해야 한다.

## 쓰기와 통지

SQLite는 짧은 BEGIN IMMEDIATE 트랜잭션, WAL, FULL, foreign_keys, 5초 busy_timeout을 사용한다. 요청이 겹치면 카드/결정 revision 검사를 트랜잭션 안에서 수행한다. AI/외부 명령은 DB 잠금 안에서 실행하지 않는다. 잠금 시간 초과는 실패로 반환한다.

사용자 답변은 pending 저장→트랜잭션 밖 통지→sent/failed 저장이다. pending 상태에서 프로세스가 끊긴 뒤 같은 답변을 호출해도 자동 재전송하지 않는다. 일반 send의 실제 전달과 원장 저장 사이 중단 가능성은 기존과 같으며, SQLite가 외부 전송까지 정확히 한 번 보장하지 않는다.

## 분리 원장의 저장 경계

작업·우편·시스템 분리는 같은 SQLite 안에서 처리한다. 작업 발령의 우편 send와 작업 dispatch, 완료 사건과 자동 결과 우편은 같은 DB 트랜잭션으로 저장한다. 본문 파일은 DB 밖이므로 트랜잭션이 되돌아간 뒤 연결되지 않은 본문 파일이 남을 수 있다. 이를 자동 삭제하지 않는다.

다른 명령이 쓰는 중이면(원장·카드·업무) SQLite의 busy_timeout처럼 최대 5초 기다렸다가 다시 얻는다(2026-10-08 — 즉시 포기하면 동시에 띄운 작업자 일부가 시작 기록 없이 세션만 남았다). 5초 안에 풀리지 않으면 기록은 보존하고 원인을 확인한다. `kadan start`는 시작 기록에 실패하면 방금 만든 세션을 닫는다.

구형 작성 프로세스와 신형 작성 프로세스의 혼용은 지원하지 않는다. 호환 조회는 과거 ledger 이력을 먼저, 신규 사건을 전체 저장 순번으로 이어 읽으므로 구형 프로세스가 과거 스트림에 계속 쓰면 실제 발생 순서를 보장할 수 없다. 코드를 바꾼 뒤에는 오래된 watch/wall/wait 프로세스를 정리하고 새 코드로 다시 시작한다.

## 감시기의 증분 읽기

감시기(`kadan watch`)는 원장을 주기마다 처음부터 읽지 않고, 프로세스 안에 들고 있는 상태에 커서 뒤 새 사건만 이어 붙인다(`src/ledger-incremental.mjs`). 상태는 디스크에 쓰지 않는다.

- **커서**: 원장 세 영역(`tasks`·`mail`·`system`)의 `heads.seq`. 커서와 새 행 조회는 같은 읽기 스냅샷 안에서 하고, 새 행은 `seq>커서`를 한 번에 전부 읽는다(`send`+`dispatch`+완료 우편 묶음을 자르지 않으려고 LIMIT·나눠 읽기는 없다). 옛 `ledger.jsonl`은 한 번 읽고 이후에는 변하지 않았는지만 본다.
- **실패는 두 갈래**: (a) 새 묶음 검증 실패(순번 빈틈·`mailId` 중복·완료 우편 짝 깨짐·인계 충돌)는 증분 상태와 커서를 함께 버리고 전체 읽기와 같은 예외를 던진다. 다음 호출은 전체 다시 읽기다. (b) 어긋남 감지(끝 순번 감소·끝 행 지문 다름·DB 파일 식별값(inode·생성 시각) 변경·옛 원문 변경)는 로그 한 줄을 남기고 전체를 다시 읽는다. DB 파일 식별값은 파일이 새 파일로 교체되는 경우(이름 바꾸기·복원)를 잡는다. 같은 파일에 내용을 덮어쓴 경우는 식별값으로 못 잡고 끝 행 지문만 막는다.
- **전체 검증은 시작·복원·DB 교체 때만** 한다. 주기에서는 새 행만 검증하므로, 옛 행이 손상돼도 주기마다 잡던 일은 사라진다.
- 영역(기본·`tasks`·`mail`·`mailbox`·`system`)별 투영은 이 상태 위에서 영역마다 따로 이어 붙이며, 완료 사건의 첫 줄 거르개(`uniqueDone`)도 영역마다 따로 둔다. 결과는 전체 읽기와 같아야 하며 시험(`tests/ledger-incremental.test.mjs`)이 도메인 5종 sha256으로 확인한다.

# SQLite 저장 운영 안내

## Why

같은 카드에 여러 프로세스가 쓰거나 명령이 중간에 종료되어도 카드의 현재 상태와 변경 이력이 함께 보존되도록 한다.

## 현재 적용 경계

2026-09-07 실제 기본 데이터 폴더 `~/.kadan`를 SQLite로 전환했다. 현재 원본은 `kadan.sqlite`이며 기존 JSONL은 전환 시점의 동결 보존본이다. 파일 존재만으로 자동 전환하지 않으며 `storage.json`으로 선택한다. JSONL 경로는 전환 준비·호환·복구용으로 유지한다.

- 기본 선택: storage.json이 없고 kadan.sqlite도 없으면 기존 JSONL.
- SQLite 선택: storage.json `{ "version": 1, "backend": "sqlite" }`. DB 누락·다른 버전·손상은 오류. 자동 JSONL 폴백 없음.
- Node 24 이상/내장 node:sqlite 사용. 이번 검증은 Node24.20.0·SQLite3.53.4. JSONL 기능의 기존 Node 요구는 유지한다.

## 구조

- `events`: 스트림별 순번·원문 payload·수입 출처/원시 행. UPDATE/DELETE 금지.
- `heads`: 스트림의 마지막 순번·현재 상태 payload. 같은 트랜잭션 안에서 사건과 함께 갱신하며 events를 외래키로 참조한다.
- `imports`: 수입한 원본의 해시·바이트·행 수. UPDATE/DELETE 금지.
- 작업 영역의 업무·카드 상태 이력은 기존 works/cards 스트림을 유지하고, 계획·발령·완료 사건은 `tasks/events.jsonl`, 우편 사건은 `mail/events.jsonl`, 세션·감시 사건은 `system/events.jsonl`로 나눈다. 모두 같은 DB의 events/heads를 사용한다. 사용자 결정·brief 스트림도 유지한다. 도메인 상태 계약은 기존 WorkStore/CardStore/DecisionStore가 담당한다.

계획에 열거한 카드/결정별 개별 테이블 대신 동일한 append-only 저장을 공통 events/heads로 구현했다. 기존 JSON payload·revision·CLI 출력 호환을 유지하고 스키마 중복을 줄인다. 현재 상태와 사건의 원자적 저장은 유지한다. 독립 실행 차수·새 상태·선행 관계를 추가하지 않았다.

기존 `ledger.jsonl` 이력은 불변으로 보존하며 통합 `readLedger`는 호환 조회다. 신규 사건은 전체 저장 순번으로 이어 읽고 과거 task send는 읽기용으로만 분류한다. 분리 저장·질문·완료 결과 통지의 정확한 의미는 [작업·우편 원장 계약](mail-task-ledgers.md)을 따른다.

카드 Markdown, 우편 본문, 보고서, 인계 JSON, 계층 설정은 파일로 유지한다. 새 실행의 `cards/<저장소>/<실행ID>/result.md`와 `evidence/`도 파일이며, 백업·이전 때 DB와 `cards/` 전체를 함께 보존한다. DB가 이 파일들의 변경까지 원자적으로 확정하는 것은 아니다. 신규 카드 생성 중 중단되면 본문만 남을 수 있으며 자동 삭제하지 않는다. 재생성 전에 원인 확인이 필요하다.

## 검증용 복사본 만들기

아래 KADAN CLI는 이 작업폴더의 `node src/cli.mjs`를 뜻한다. 실제 원본에는 import가 쓰지 않는다. 대상은 반드시 아직 없는 별도 절대경로여야 한다.

```sh
node src/cli.mjs storage import --source /절대경로/기존자료 --target /절대경로/새검증복사본
KADAN_HOME=/절대경로/새검증복사본 node src/cli.mjs storage verify
```

복사 전후 원본 manifest를 비교한다. 읽는 동안 바뀌면 미완성 대상을 보존하고 중단한다. 데이터가 계속 바뀌는 원본의 일관성을 추측하지 않는다. 수입은 실제 원장 원시 행을 사용해, 기존 읽기 함수가 숨기던 중복 done도 보존한다. 같은 대상으로 재수입하지 않으며 이미 있는 대상을 거절한다.

`verify`는 DB 무결성·외래키·사건 순번·heads 일치·수입 원시 행·보존 JSONL 해시·카드 revision·결정 참조·brief를 검증한다. `inspect`는 선택된 backend와 규모/manifest를 읽는다. 과거 JSONL을 수정하거나 자동으로 지우지 않는다.

## 실제 전환 절차

아래는 사용자와 정한 전환 구간에서만 수행한다. 열린 판/인계 종료 시점을 우선한다. 실행 중인 작업자 세션은 보존한다.

1. 검증된 준비 버전을 실제 CLI 경로에 반영하고 모든 직접 JSONL 작성자·오래된 watch/wall/wait·외부 스크립트를 확인한다.
2. 실제 저장소에 `storage pause`를 설정해 새 쓰기/외부 실행을 차단한다. 이미 시작된 명령이 끝났는지 따로 확인한다. pause는 쓰기 drain이나 옛 바이너리 종료를 자동 증명하지 않는다.
3. 감시/웹 등 기반 프로세스를 정확히 중지한다. 마지막 스냅샷을 새로운 후보 폴더로 import한 뒤 verify한다. 후보에도 pause를 설정한다.
4. 진행 중 명령/옛 작성자가 없음을 운영자가 확인한 뒤 `storage activate --candidate /검증후보 --writers-stopped`를 실행한다. 플래그는 운영자의 확인 선언이며 자동 프로세스 감사 결과가 아니다.
5. activate는 원본 해시 일치, 후보 출처, 후보에 시험용 새 사건이 없는지를 검사한다. VACUUM INTO로 WAL을 포함한 DB 스냅샷을 만들고 선택 파일을 바꾼다. 쓰기 차단은 유지한다.
6. 새 기반 프로세스·원본 경로·조회 상태·감시 관계를 확인한 뒤 `storage resume`. 전환 자체는 작업자 생성/종료나 우편 발송을 하지 않는다.

직접 JSONL 파일을 고치는 외부 프로그램과 이전 바이너리는 새 pause 규칙을 모른다. 이를 확인하지 않고 --writers-stopped를 붙이면 안 된다. 실제 전환은 자동 실행하지 않는다.

## 복구

SQLite 새 기록을 남긴 뒤 옛 JSONL로 선택만 되돌리지 않는다. 새 기록을 포함한 전체 원장을 새 폴더로 내보낸다.

```sh
KADAN_HOME=/SQLite자료 node src/cli.mjs storage pause
# 진행 중 작성 명령과 기반 프로세스 종료를 확인한다.
KADAN_HOME=/SQLite자료 node src/cli.mjs storage export --target /새복구폴더
KADAN_HOME=/새복구폴더 node src/cli.mjs storage inspect
```

원본 DB·동결 JSONL·우편·보고서는 남긴다. 출력 폴더는 새 JSONL 사건과 카드/우편/인계 파일을 포함한다. 원시 중복 사건도 내보내며 새 DB 사건도 빠뜨리지 않는다. 운영 경로 복원 때 기존 심볼릭 링크·인계 파일의 절대경로도 함께 확인한다. 다른 폴더로 export한 것만으로 실제 경로가 바뀌는 것은 아니다.

## 쓰기와 통지

SQLite는 짧은 BEGIN IMMEDIATE 트랜잭션, WAL, FULL, foreign_keys, 5초 busy_timeout을 사용한다. 요청이 겹치면 카드/결정 revision 검사를 트랜잭션 안에서 수행한다. AI/외부 명령은 DB 잠금 안에서 실행하지 않는다. 잠금 시간 초과는 실패로 반환한다.

사용자 답변은 pending 저장→트랜잭션 밖 통지→sent/failed 저장이다. pending 상태에서 프로세스가 끊긴 뒤 같은 답변을 호출해도 자동 재전송하지 않는다. 일반 send의 실제 전달과 원장 저장 사이 중단 가능성은 기존과 같으며, SQLite가 외부 전송까지 정확히 한 번 보장하지 않는다.

## 분리 원장의 저장 경계

작업·우편·시스템 분리는 같은 SQLite 안에서 처리한다. 작업 발령의 우편 send와 작업 dispatch, 완료 사건과 자동 결과 우편은 같은 DB 트랜잭션으로 저장한다. 본문 파일은 DB 밖이므로 트랜잭션이 되돌아간 뒤 연결되지 않은 본문 파일이 남을 수 있다. 이를 자동 삭제하지 않는다.

JSONL 호환 방식은 전체 원장 스캔 비용이 있으며, 여러 파일 쓰기를 하나의 원자적 작업으로 보장하지 않는다. 잠금·순번·연결 검증으로 중간 실패를 성공으로 읽지 않고 오류로 멈춘다. 미완료 잠금과 기록은 보존하고 원인을 확인한다.

구형 작성 프로세스와 신형 작성 프로세스의 혼용은 지원하지 않는다. 호환 조회는 과거 ledger 이력을 먼저, 신규 사건을 전체 저장 순번으로 이어 읽으므로 구형 프로세스가 과거 스트림에 계속 쓰면 실제 발생 순서를 보장할 수 없다. 운영 전환 때 위 절차에 따라 오래된 watch/wall/wait 및 직접 작성자를 정리하고 새 코드로 시작한다. 코드 시험 통과만으로 운영 전환이 완료된 것은 아니다.

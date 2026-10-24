# 역할별 지침 자동 첨부

## Why

사용자가 카드나 편지마다 역할의 시작·보고·완료 책임을 손으로 반복하지 않아도, 받는 역할이 기본 책임을 함께 읽게 한다.

## 전달되는 내용

터미널로 보내는 메시지 뒤에 공통 지침과 수신 역할의 프로필 지침을 붙인다. 기존 메시지는 앞부분에 그대로 남는다.
지침에는 확인된 역할·업무·실행·직속 회신 대상과 최신 정보를 읽을 경로를 별도로 붙인다.
프로필을 확인할 근거가 없으면 이름에서 추측하지 않고 `not-applied`와 이유를 남긴다. 이 경우 프로필을 명시한다.

비서 우편은 저장된 본문과 지문(digest)을 바꾸지 않는다. `inbox read` 결과의 `body`와 별도로
`receiverInstructions`를 반환하고, `receiverInstructionsProfile`, `receiverInstructionsDigest`, `roleInstructions`에 적용 근거를 담는다.
읽기는 자동 ack가 아니며, 내용을 읽은 뒤 필요한 `inbox ack`를 기록한다.

이 기능 자체는 원본 편지 수정·자동 깨움·재발령·자동 완료를 하지 않는다.
기존 `send`의 터미널 전달과 감시·자동 전달 프로그램의 동작은 각 계약을 따른다.

## 프로필 지정

새 역할을 시작할 때 다음 다섯 프로필 중 하나를 지정한다.

```sh
kadan start custom-role --profile conductor --cmd "<실행 명령>"
```

실제 생성 흐름은 [작업자·검수자·일반감독·슈퍼 생성 명령](../skills/kadan-conductor/references/worker-creation.md#새-역할의-프로필),
[작업자 발령과 검수 연결](../skills/kadan-conductor/references/dispatch-wait.md#순서),
[비서의 슈퍼 생성](../skills/kadan-secretary/SKILL.md#슈퍼감독-세우기-부트스트랩)에 프로필을 포함한다.
새 역할을 만들 때만 사용하며 기존 세션을 프로필 적용 목적으로 재시작하지 않는다.

| 프로필 | 기본 책임 | 자동 리마인더 원본 |
|---|---|---|
| 공통 | 최신 지시·승인·보류·교대 조건 우선, 정상 ACK·반복 조회 금지, 미확인 구분 | [common.md](../skills/kadan-conductor/references/role-templates/common.md) |
| `secretary` | 사용자 의도를 맥락 우편으로 전달, 공식 보고 근거 확인·설명, 우편 read 후 필요한 ack | [secretary.md](../skills/kadan-conductor/references/role-templates/secretary.md) |
| `super` | 맥락 우편 전달·담당 감독 연결·충돌·우선순위 조정, 하위 실행 미확정 해소, 공식회신 1회 | [super.md](../skills/kadan-conductor/references/role-templates/super.md) |
| `conductor` | 설계·카드 작성·작업자 발령, 실행 근거·DONE 대조, 독립검수와 후속 연결, owner의 최종 업무 마감 | [conductor.md](../skills/kadan-conductor/references/role-templates/conductor.md) |
| `worker` | 현재 실행의 시작 기록, 소유 범위 구현·검증, 지정 결과와 완료 보고 | [worker.md](../skills/kadan-conductor/references/role-templates/worker.md) |
| `reviewer` | 현재 실행의 시작 기록, 독립 근거 검수, 직접 수정 없이 판정·완료 보고 | [reviewer.md](../skills/kadan-conductor/references/role-templates/reviewer.md) |

`common`은 항상 프로필과 함께 읽는 템플릿이며 `start --profile` 값은 아니다.
시작 때 정한 프로필은 그 역할 세대의 `start.roleProfile`에 기록한다. 살아 있는 세션을 재사용하며
`start --profile`로 바꾸거나, 프로필이 없던 기존 세대에 소급 등록하지 않는다.

프로필 선택 순서는 호출부의 명시값 → 현재 시작 세대의 프로필 → 아래 역할 매핑 → 비서 공식 주소 →
열린/일시정지 업무의 owner → 담당 실행의 확인된 구현·검수 단계(독립 카드의 `rallyStep` 포함) → 등록된 책임 관계다.
서로 다른 실행 단계가 충돌하면 적용하지 않는다. 역할 이름의 접두사·접미사로 업무나 책임을 추측하지 않는다.
자동 발령은 현재 단계의 작업자·검수자 프로필을 명시한다. 자동 결과 통지는 수신자의 기존 프로필을 따르며
명시된 `super`를 `conductor`로 덮지 않는다.

## 로컬 설정과 템플릿 교체

`$KADAN_HOME/role-instructions.json`에서 정확한 역할 이름을 프로필에 연결하거나 기본 템플릿을 바꾼다.

```json
{
  "version": 1,
  "roles": {"custom-role": "conductor"},
  "templates": {"worker": "/absolute/custom.md"}
}
```

설정 파일이 없으면 레포에 있는 기본 템플릿을 쓴다. `roles`는 이름 패턴이 아닌 정확한 이름 매핑이다.
`templates`는 `common` 또는 다섯 프로필을 키로 쓰며, UTF-8 일반 텍스트 파일의 절대경로를 받는다.
각 설정·템플릿 파일은 비어 있지 않은 64KiB 이하 파일이어야 한다. 템플릿에는 치환 변수를 두지 않고
자연어 책임만 적는다. 역할·업무·실행 값과 실제 절대 참조 경로는 프로그램이 따로 붙인다.
완성된 DONE 마커를 넣지 않는다. 예시는 `KADAN:DONE <현재실행ID> <ok|failed>` 형식만 쓴다.

잘못된 설정, 필요한 템플릿의 누락·손상·완성된 마커는 오류로 처리한다. 기본 템플릿으로 조용히 우회하지 않는다.
사용자가 선택한 템플릿 파일 오류는 `not-sent`로 반환해 보내지 않는다.
터미널의 `send --raw`는 값 없이 쓰는 명시 스위치이며, 해당 메시지의 자동 지침 첨부를 생략하고 이유를 기록한다.
설정 오류를 우회하는 기능은 아니다.
비서 우편에는 `--raw`를 쓰지 않는다. 우편 원문은 원래부터 보존된다.

## 완료 통지 실패와 실행 결과

완료 통지 편지의 발송 실패는 작업 실패가 아니다. 실패는 카드 메모에 남기고 재전송을 반복하지 않으며,
실행 `ok|failed`는 결과 파일·`card report` 기준으로 정한다. 기본 책임 문구는 `role-templates/common.md`와
`worker.md`, 실행 공통 계약은 `card-template.md`의 '결과 등록과 완료'에 있다.

## 역할 안내와 카드 계약의 차이

일반적인 요청에서 비서·슈퍼감독은 맥락 우편을 전하고, 담당 일반감독이 카드 작성·작업자 발령을 맡는다.
자동 안내도 이 책임을 유지한다. 슈퍼감독에게 카드 작성 전 자문을 기본으로 요구하지 않는다.
예외와 승인 경계는 [맥락 우편과 실행 카드](../skills/kadan-conductor/references/operating-contract.md#맥락-우편과-실행-카드-2026-10-13-사용자-정정)를 따른다.

역할 지침은 기본 책임 안내다. **카드 작성자가 시작·완료 통지를 생략해도 기본 책임 문구는 전달되지만,
개별 수신자·승인값을 없는 근거로 채우지는 않는다.** 프로필을 확인하지 못했거나 `--raw`로 보낸 경우에는 자동 첨부도 없다.

카드는 실제 범위·소유 파일·환경·승인·상한·검증·결과 경로·직속 수신자를 정한다.
[카드 템플릿](../skills/kadan-conductor/references/card-template.md)의 필수 계약은 계속 유지한다.
지침이 붙었다는 이유로 새 발령·권한을 얻거나 보류·교대 조건을 해제하지 않는다.
수신자는 받은 본문과 현재 실행 원본·최신 카드/판단·저장소 지침을 읽고, 안내된 참조의 필요한 절만 다시 읽는다.

비서·슈퍼·일반감독에게는 해당 역할의 SKILL과 발령·대기, 운영계약, 교대 문서를 안내한다.
작업자·검수자에게는 카드 템플릿만 안내한다. 시작·대기 기록과 수동/자동 완료 순서는 역할 틀과 지침 본문에 이미 있고,
발령·대기, 감독 결정 범위, 슈퍼감독 교대 문서는 감독용이라 읽으면 역할을 넘는 판단을 부를 수 있다(2026-09-24 [kyle] 결정).
실제 파일 경로는 실행 중인 카단 설치 위치에서 정한다.

시작 기록은 `kadan card progress <키> --revision <현재revision> --activity running --note "시작: <현재 작업>"`으로 한 번 남긴다.
외부 결과 대기로 전환할 때는 현재 revision으로 같은 명령의 `--activity waiting`과 대기 근거를 기록한다.
근거 메모용 `card note --kind progress`만으로는 작업 중 상태가 기록되지 않는다. 정상 ACK 편지는 추가하지 않는다.
수동 완료는 지정 결과 → `card report` → 지정 직속 감독에게 send 1회 → 자기 화면의 현재 실행 DONE이다([실행 공통 계약](../skills/kadan-conductor/references/card-template.md#결과-등록과-완료)이 원본).
명시된 자동 완료는 지정 결과 → `work auto-report` → 현재 실행 DONE이며 수동 편지를 중복하지 않는다.
수동 원장 확정은 결과·마커를 확인한 감독, 자동 경로는 마커를 확인한 프로그램이 처리한다.
품질 판정과 실행 종료는 별개이며 업무 전체의 `work complete`는 owner가 전체 완료조건을 대조해 판단한다.
상세는 [발령과 대기](../skills/kadan-conductor/references/dispatch-wait.md)와
[운영계약](../skills/kadan-conductor/references/operating-contract.md)을 따른다.

## 적용 확인과 실행 중인 프로그램

터미널 send 영수증(receipt)과 원장에는 `roleProfile`, `roleInstructions`를 기록한다.
적용된 `roleInstructions`의 필드는 `status`, `profile`, `source`, `digest`, `templateDigest`, `templates`이며,
`templates`에는 각 원본의 이름·경로·지문이 있다. 미적용이면 `status: not-applied`와 `reason`을 남긴다.
추론용 업무·카드·관계 자료를 읽지 못하면 `unavailable`과 모름 안내를 남기고 그 이유만으로 통지 자체를 막지 않는다.
확인된 프로필의 기본 지침만 붙이거나, 프로필도 모르면 원문과 미적용 이유를 반환한다.
없는 근거로 회신 대상이나 발령 상태를 채우지 않는다. 선택한 템플릿 파일 오류의 `not-sent`와 구분한다.
send의 바이트 수와 지문은 지침까지 포함한 실제 전달문 기준이다. 적용 기록은 AI가 지침을 읽거나 작업을 끝냈다는 증거가 아니다.
정상 전달을 같은 목적의 read로 다시 확인하거나 AI가 반복 조회하지 않는다.

운영 명령이 main의 `src/cli.mjs`를 가리키는 환경은 main 통합 후 CLI를 새로 호출하면 새 전송 코드를 사용한다.
이미 떠 있는 watch·auto-run은 모듈을 메모리에 읽었으므로
**프로그램을 새로 시작한 뒤 적용된다.** 저장소 업데이트만으로 기존 프로세스에 적용됐다고 보장하지 않는다.
이 기능은 운영 프로세스를 자동 재시작하지 않는다. 기존 편지·과거 원장·카드를 소급 수정하지 않는다.

## 요약 우편 (conductor·super 프로필, 모든 판)

Why: 감독 창이 같은 규칙 전문의 반복으로 차서 압축이 잦았다. 결정 cc77fcc2, 시니어 자문 452d380f.

`guardedSend`는 우편마다 전문(`full`)과 요약(`summary`) 중 하나를 고른다.
요약은 템플릿 전문만 빼고, 수신 역할·회신 대상·연결 업무/실행·완료 방식·참고 파일 경로는 그대로 둔다.
대신 `role-templates/<프로필>-summary.md`(`conductor-summary.md`·`super-summary.md`)가 붙는다. 전문 경로는 참고 파일 목록에 남는다.
요약일 때도 템플릿 파일은 읽는다(지문 비교용). 줄어드는 것은 메시지뿐이다.
`SUMMARY_PROFILES`·`FULL_INTERVAL_MS`(1시간)는 시험값 상수이며 설정·환경변수 스위치는 없다. 되돌리기는 PR 되돌리기다.
현재 범위는 프로필 `conductor`·`super`, 모든 판이다(2026-10-24 슈퍼 승인, kyle 단계안 'c'의 2단계).
역할 이름·판 조건은 보지 않는다. 비서·작업자·검수자와 프로필을 못 정한 역할은 전문이다.
전문 조건은 아래 표 그대로다. 요약 파일은 템플릿 지문에 들어가지 않아 나중에 고쳐도 전문 재전송이 없다.

전문이 되는 이유와 기록 이름(`instructions.reason`):

| 조건 | 이유 값 |
|---|---|
| 요약 프로필(conductor·super)이 아님(프로필 없음 포함) | `profile-not-in-trial` |
| 업무·카드 사실을 못 읽음 | `facts-unavailable` |
| 이 세대 마지막 전문 시도 뒤에 이어 연 start가 있음(아래 목록) | `resumed-generation` |
| 현재 발령(`--task`) | `dispatch` |
| 이 세대에 전문이 없음(첫 안내·새 대화 첫 우편 포함) | `generation-first` |
| 이 세대 마지막 전문이 `keyDelivery !== 'sent'` | `delivery-unclear` |
| 프로필 또는 `templateDigest`가 마지막 전문과 다름 | `profile-changed` · `template-changed` |
| 마지막 전달 성공 전문 뒤 1시간 이상 경과(정확히 60분 포함) | `interval` |
| 위에 해당 없음 | 요약(`within-interval`) |

- 이어 연 start는 세대 경계가 아니라서(우편 세대 그대로) 압축된 대화가 규칙을 잊었을 수 있는 자리만 따로 센다. 센다: `restartOf`, `conversationMode==='resume'`, `--inherit-mail`(`inheritMail`), `restoredFrom`, `secretaryResumeSource`. 안 센다: `sameProcess`(같은 pane PID로 다시 기록된 살아 있는 세션 재사용, 새 프로세스도 대화 재로드도 없음). new·fork는 이미 새 세대라 `generation-first`다. 전문이 한 번 시도되면(`sent`면 풀리고, 실패면 `delivery-unclear`) `resumed-generation`은 끝난다. 이유 우선순위는 resumed-generation → dispatch → generation-first → 나머지 순이며 어느 쪽이든 전문이다.
- '전달 성공'은 `keyDelivery === 'sent'`만이다. 세대는 `mail-generation.mjs`의 start 경계를 그대로 쓴다. raw 전송은 `instructions`가 없어 건너뛴다.
- 실제 바닥은 전송 실패를 영수증이 아니라 예외로 던진다. 전문 시도가 던져지면(`not-sent`·`unknown`) 원장에 별도 kind `send-failed`(시스템 영역, `mailId` 없음, `keyDelivery`·`instructions`만)를 남기고 원래 오류를 다시 던진다. `send`가 아니라서 발령·우편함·감시 재안내·디코 중복 방지(`findMailBySourceKeyAny`)가 전달로 보지 않는다. 그 세대의 마지막 전문 시도가 `sent`가 아니면 다음 우편은 `delivery-unclear`이고, 전문이 한 번 `sent`로 가면 풀린다. raw·요약 시도의 실패는 남기지 않으며 기록 실패가 원래 오류를 가리지 않는다. 자동 재전송은 없다.
- 이 기능 전의 send 줄에는 `instructions`가 없다. 그래서 적용 뒤 각 감독의 첫 우편은 전문이다(정상).
- `mailbox read`가 보여 주는 지침은 요약하지 않고 항상 전문이다.

측정(데이터를 뽑는 방법까지만; 누락·재작업 판단은 사람이 한다). send 원장 줄의 `instructions.mode`와 `bytes`를 쓴다.

```
node --input-type=module -e "import {readLedger} from './src/ledger.mjs';
const rows=readLedger().filter(e=>e.kind==='send'&&e.instructions&&e.t>'2026-10-17');
const by={};for(const e of rows){const k=e.role+' '+e.instructions.mode;by[k]??={n:0,bytes:0};by[k].n++;by[k].bytes+=e.bytes;}
console.table(by);"
```

기간은 `e.t` 문자열 비교로 거른다. 이유별 수는 키를 `e.instructions.reason`으로 바꿔 본다. `kadan log`는 최근 30줄만 보여 주므로 집계에는 쓰지 않는다.

## 감시기 알림은 지침을 붙이지 않는다 (2026-10-21 [kyle])

감시기 알림(경보·미확인 우편 재알림·상위 알림·놀고 있음 본인 알림)은 `guardedSend`의 `omitInstructions`로 역할 지침을 붙이지 않는다. 원장에 `instructions`가 남지 않으므로 이 알림은 전문·요약 판정(`decideInstructionsMode`)의 "마지막 전문"이 되지 않고, 전달에 실패해도 `send-failed` 전문 시도를 남기지 않는다. 일반 우편의 판정은 알림이 있든 없든 같다(`tests/watch-notice-format.test.mjs`가 고정). `--raw`와 다른 점: 우편 ID·ack 안내는 `notificationOnly`가 따로 정한다.

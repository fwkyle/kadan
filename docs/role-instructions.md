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
| `secretary` | 사용자 의도 전달, 공식 보고 근거 확인·설명, 우편 read 후 필요한 ack | [secretary.md](../skills/kadan-conductor/references/role-templates/secretary.md) |
| `super` | 담당 감독·충돌·우선순위 조정, 하위 실행 미확정 해소, 공식회신 1회 | [super.md](../skills/kadan-conductor/references/role-templates/super.md) |
| `conductor` | 실행 근거·DONE 대조, 독립검수와 후속 연결, owner의 최종 업무 마감 | [conductor.md](../skills/kadan-conductor/references/role-templates/conductor.md) |
| `worker` | 현재 실행의 시작 기록, 소유 범위 구현·검증, 지정 결과와 완료 보고 | [worker.md](../skills/kadan-conductor/references/role-templates/worker.md) |
| `reviewer` | 현재 실행의 시작 기록, 독립 근거 검수, 직접 수정 없이 판정·완료 보고 | [reviewer.md](../skills/kadan-conductor/references/role-templates/reviewer.md) |

`common`은 항상 프로필과 함께 읽는 템플릿이며 `start --profile` 값은 아니다.
시작 때 정한 프로필은 그 역할 세대의 `start.roleProfile`에 기록한다. 살아 있는 세션을 재사용하며
`start --profile`로 바꾸거나, 프로필이 없던 기존 세대에 소급 등록하지 않는다.

프로필 선택 순서는 호출부의 명시값 → 현재 시작 세대의 프로필 → 아래 역할 매핑 → 비서 공식 주소 →
열린/보류 업무의 owner → 담당 실행의 확인된 구현·검수 단계(독립 카드의 `rallyStep` 포함) → 등록된 책임 관계다.
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

## 역할 안내와 카드 계약의 차이

역할 지침은 기본 책임 안내다. **카드 작성자가 시작·완료 통지를 생략해도 기본 책임 문구는 전달되지만,
개별 수신자·승인값을 없는 근거로 채우지는 않는다.** 프로필을 확인하지 못했거나 `--raw`로 보낸 경우에는 자동 첨부도 없다.

카드는 실제 범위·소유 파일·환경·승인·상한·검증·결과 경로·직속 수신자를 정한다.
[카드 템플릿](../skills/kadan-conductor/references/card-template.md)의 필수 계약은 계속 유지한다.
지침이 붙었다는 이유로 새 발령·권한을 얻거나 보류·교대 조건을 해제하지 않는다.
수신자는 받은 본문과 현재 실행 원본·최신 카드/판단·저장소 지침을 읽고, 안내된 참조의 필요한 절만 다시 읽는다.

비서·슈퍼·일반감독에게는 해당 역할의 SKILL을 안내한다. 작업자·검수자에게는 감독 전용 SKILL 전체 대신
카드 템플릿의 해당 작업/검수 절, 운영계약의 진행·통지 기준, 발령 안내의 수동/자동 완료 절을 안내한다.
교대에 관련된 행동은 별도로 안내된 교대 절을 따른다. 실제 파일 경로는 실행 중인 카단 설치 위치에서 정한다.

시작 기록은 `kadan card progress <키> --revision <현재revision> --activity running --note "시작: <현재 작업>"`으로 한 번 남긴다.
외부 결과 대기로 전환할 때는 현재 revision으로 같은 명령의 `--activity waiting`과 대기 근거를 기록한다.
근거 메모용 `card note --kind progress`만으로는 작업 중 상태가 기록되지 않는다. 정상 ACK 편지는 추가하지 않는다.
수동 완료는 지정 결과 → 지정 직속 감독에게 send 1회 → 자기 화면의 현재 실행 DONE이다.
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

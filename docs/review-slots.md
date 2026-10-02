# 검수 자리와 무거운 명령 제한

## Why

병렬 에이전트가 검수할 때마다 새 worktree와 새 `node_modules`(약 0.9GB, 파일 수만 개)를 만들고 지웠다. 전후 비교면 두 벌이었다. 2026-10-02 한 Mac에서 한 제품 저장소 3곳의 worktree가 105개, 파일 감시 프로세스(fseventsd)가 CPU 82%·메모리 11GB, 스왑 25/25.6GB, 부하 평균 75였다. 다른 프로젝트의 러스트 빌드도 여러 개가 동시에 돌았다.

검수자는 저장소마다 정해진 몇 개의 **검수 자리**를 빌려 쓰고 돌려준다. 설치는 잠금 파일이 바뀔 때만 한다. 설치·빌드·러스트 빌드는 **무거운 명령 제한**을 거쳐 기계 전체에서 종류별 동시 개수를 넘지 않는다. 데몬이나 서비스는 없고 카단 폴더(`$KADAN_HOME`, 기본 `~/.kadan`)의 파일만 쓴다.

## 검수 자리 (`kadan slot`)

| 명령 | 하는 일 |
|---|---|
| `kadan slot acquire <저장소> --for <카드\|역할> [--ref <SHA\|브랜치>]` | 빈 자리를 빌린다. 처음 쓰는 자리는 이때 worktree를 만든다(분리된 HEAD). 요청한 커밋으로 옮기고 결과 JSON의 `path`가 자리 경로다. `--ref`가 없으면 원본 저장소의 HEAD |
| `kadan slot deps <자리경로> [--cmd "<설치 명령>"]` | 잠금 파일이 그 자리의 마지막 설치 때와 다르거나 `node_modules`가 없을 때만 설치한다. 설치는 `kadan limit run install`과 같은 제한을 거친다 |
| `kadan slot release <자리경로>` / `kadan slot release --for <카드\|역할>` | 자리를 돌려준다. `node_modules`는 남긴다(다시 쓰려고 만든 기능이다) |
| `kadan slot status [<저장소>]` | 자리별 빌린 쪽·커밋·경과 분·회수 가능 여부 |

- **자리 위치**: 원본 저장소 옆 `<저장소이름>-review-slots/slot-1…4`. worktree 경로를 줘도 원본 저장소의 자리 묶음을 쓴다.
- **자리 수**: 저장소마다 기본 4. 임차 기록은 `$KADAN_HOME/review-slots/<저장소>/slot-N.lease.json`, 설치 기록은 같은 폴더의 `slot-N.meta.json`이다.
- **모두 사용 중**: 기본은 기다린다(5초 간격, 최대 `--wait-timeout` 초, 기본 1800). 기다리는 동안 누가 쥐었는지 표준 오류에 알린다. `--no-wait`이면 빌린 쪽 정보와 함께 종료 코드 3으로 바로 실패한다.
- **임시 자리**: 자리가 모두 찼을 때만 쓰고 `--temporary --reason "<이유>"`가 있어야 한다. 이유는 임차 기록에 남고 `release` 때 worktree를 지운다(`--force` 없이. 변경이 남아 거부되면 임차를 남기고 알린다).
- **더러운 자리**: 커밋 안 된 변경·새 파일이 있는 자리는 다시 빌려주지 않는다. 검수자는 코드를 고치지 않으므로 변경이 생겼다면 확인해 치운 뒤 쓴다. 대상 저장소의 `.gitignore`에 `node_modules`가 없으면 설치 뒤 항상 더럽게 보인다.
- **버려진 임차 회수**: 카단 역할(`KADAN_ROLE` 또는 `--role`)이 빌렸으면 그 역할 세션이 사라지거나 세션 PID가 바뀐 임차를, 역할 밖에서 빌렸으면 12시간이 지난 임차를 다음 사람이 회수한다. 회수했으면 결과의 `reclaimed`에 이유가 나온다.
- **참조 가져오기**: `--ref`가 로컬에 없을 때만 `git fetch origin <ref>` 하나를 한다. 검수는 작업자 결과의 SHA를 `--ref`로 주는 것이 가장 정확하다.
- 결과 JSON은 표준 출력, 대기·설치 출력은 표준 오류로 나온다: `kadan slot acquire <저장소> --for <카드> --ref <SHA> | jq -r .path`.
- 위치 인자(저장소·자리 경로)를 옵션보다 앞에 둔다.

### 검수 흐름

```bash
kadan slot acquire <저장소> --for <카드id> --ref <검수할 SHA>   # path 확인
kadan slot deps <자리경로>                                      # 필요할 때만 설치
# … 검수 (코드 수정 금지) …
kadan slot release <자리경로>
```

전후 비교가 필요하면 새 worktree 대신 **두 번째 자리**를 빌린다(`--for <카드id>-before --ref <기준 SHA>`). `kadan slot release --for <카드id>`는 그 이름으로 빌린 자리를 모두 돌려준다. 작업자(구현)는 지금처럼 자기 브랜치의 worktree를 쓴다.

## 무거운 명령 제한 (`kadan limit`)

| 명령 | 하는 일 |
|---|---|
| `kadan limit run <rust\|install\|build> -- <명령...>` | 그 종류의 자리가 비어 있을 때만 명령을 돌린다. 차 있으면 쥔 쪽을 알리며 기다린다. 종료 코드는 명령의 것을 그대로 돌려준다 |
| `kadan limit status` | 종류별 동시 개수와 지금 쥔 쪽 |

| 종류 | 기본 동시 개수 | 대상 |
|---|---|---|
| `rust` | 1 | `cargo build/test/check/clippy` 등 러스트 빌드 |
| `install` | 2 | node 패키지 설치(`pnpm install`, `yarn install`, `npm ci`) |
| `build` | 2 | 무거운 node 빌드·전체 시험 |

- `rust`는 `CARGO_BUILD_JOBS=2`를 환경 변수로 붙인다. 이미 그 변수가 있거나 명령에 `-j`·`--jobs`가 있으면 그대로 둔다. 인자에 `-j 2`를 끼우지 않는 이유는 `cargo test -- …`처럼 인자 위치가 중요한 명령을 깨뜨릴 수 있어서다.
- 잠금은 `$KADAN_HOME/limits/<종류>-N.lock`이다. 명령이 실패하거나 중단돼도(SIGINT·SIGTERM·SIGHUP은 명령에 전달) 잠금을 푼다. 강제 종료로 남은 잠금은 PID가 죽었으면 다음 사람이 회수한다.
- `--` 뒤의 인자는 카단 옵션으로 해석하지 않고 명령에 그대로 넘긴다.

## 설정

`$KADAN_HOME/resource-limits.json`은 선택이다. 없으면 아래 기본값을 쓴다.

```json
{"reviewSlots": 4, "leaseMaxHours": 12, "limits": {"rust": 1, "install": 2, "build": 2}}
```

## 수용한 위험

- 두 사람이 같은 버려진 잠금을 같은 순간 회수하면 아주 짧은 틈에 둘 다 잡을 수 있다. 드문 경합이라 두 단계 잠금을 만들지 않는다(2026-10-02 [kyle]: 단순하게).
- 로컬에 없는 커밋 SHA를 `--ref`로 주면 `FETCH_HEAD`로 읽는다. 같은 저장소에서 두 검수자가 같은 순간 서로 다른 SHA를 가져오면 섞일 수 있다(브랜치 이름은 원격 추적 참조를 먼저 봐서 해당 없음). 결과의 `sha`를 확인한다.
- `kadan limit run`을 강제 종료(SIGKILL)하면 자식 명령이 남아 돌 수 있고, 그 잠금은 회수 대상이 된다.
- 기존 설치 명령은 잠금 파일 기준이다(`pnpm install --frozen-lockfile`, `yarn install --frozen-lockfile`, `npm ci`). 저장소 사정이 다르면 `--cmd`로 바꾼다. 하위 폴더의 잠금 파일은 보지 않는다.

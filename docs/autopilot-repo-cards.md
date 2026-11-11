# Autopilot 중 자동 머지 정책: 카단 설정과 온톨로지 폴더

## Why

저장소마다 "배포 브랜치가 무엇이고, Autopilot 중 자동 머지를 해도 되는가"를 카단이 알아야 Autopilot 단계의 머지 관문이 판정할 수 있다. 이 값의 원본은 카단 자체 설정이다. 그래서 카단을 내려받아 쓰는 누구나 같은 방식으로 쓴다. 저장소·계정·기기 같은 사실을 마크다운 문서로 적어 두는 사람은 그 문서를 카단의 고정 폴더 `$KADAN_HOME/ontology/`에 두면 빈 칸을 채운다(선택). 폴더 이름이 "카드"가 아니라 "온톨로지"인 이유는 나중에 다른 종류(account·device·rule) 문서도 이 폴더에서 읽게 하려는 것이다. 지금 판정에 쓰는 것은 `type: project`뿐이다.

## 카단 설정(원본)

저장소(GitHub `소유자/이름`, 소문자, 끝 `.git`·`/` 제거)마다 칸 두 개를 `$KADAN_HOME/autopilot-repo-policy.json`에 둔다. 칸은 따로 둘 수 있다.

| 칸 | 값 | 뜻 |
|---|---|---|
| `deployBranch` | 브랜치 이름 또는 `없음` | 이 브랜치로 가는 PR은 Autopilot 중 자동 머지 안 함. `없음`은 어떤 브랜치도 아니다 |
| `nightMerge` | `허용` · `금지` | `금지`면 이 저장소는 Autopilot 중 자동 머지 안 함. 비어 있으면 허용으로 본다 |

```
kadan autopilot repo <소유자/이름> --deploy-branch <브랜치|없음> --night-merge 허용|금지   # 둘 중 하나만 줘도 된다
kadan autopilot repo <소유자/이름> --clear deployBranch|nightMerge                       # 칸 하나 지우기
kadan autopilot repo list | show <소유자/이름>                                            # 읽기
```

## 온톨로지 폴더(선택, 폴더가 없으면 빈 것)

`$KADAN_HOME/ontology/`를 명령·요청 한 번에 한 번씩 훑는다. 없으면 빈 것으로 보고 오류로 치지 않는다. 자기 노트의 문서 폴더가 따로 있으면 링크로 연결한다.

```
ln -s ~/notes/projects "$KADAN_HOME/ontology/notes"   # 폴더 링크. 파일 링크도 된다
```

훑는 규칙:

- 하위 폴더와 링크(폴더·파일, 폴더 밖을 가리키는 것 포함)를 따라가며 `.md` 파일을 모은다. `.git`·`node_modules` 폴더는 건너뛴다.
- 같은 실제 폴더에는 두 번 들어가지 않고 같은 실제 파일은 한 번만 읽는다(순환 링크 방지).
- 상한은 깊이 8, 폴더 2,000개, 파일 5,000개다. 넘으면 읽기를 멈추고 "온톨로지 폴더 상한 초과"를 읽지 못함 1건으로 친다.
- 깨진 링크와 권한 오류도 읽지 못함이다.
- 문서는 `ontology/` 기준 상대 경로로만 보인다(절대 경로는 출력·API에 나오지 않는다).

문서 앞머리(`---` 사이)만 읽는다.

- `type: project`인 문서만 판정에 쓴다. 다른 type(account·device·rule…) 문서와 앞머리가 없는 일반 문서(README 등)는 읽고 무시한다.
- type 값은 소문자 낱말 하나이고, 따옴표는 짝이 맞을 때만 벗긴다(`project`·`"project"`). 닫지 않은 따옴표·대문자·공백이 낀 값은 읽지 못함이다. `$KADAN_HOME/ontology` 자체가 깨진 링크이거나 폴더가 아닌 것을 가리켜도 읽지 못함이다(아예 없을 때만 빈 상태).
- 앞머리는 있는데 `type` 칸이 없거나 형식이 틀리면(`type`이 두 번 나옴·`Project`·`project # 메모` 등) 읽지 못함이다. project 문서일 수 있기 때문이다. 닫는 `---`가 없는 앞머리도 읽지 못함이다.
- project 문서에서 읽는 칸은 셋이고 정확히 `키: 값` 형식이어야 한다. 형식이 틀리거나 같은 칸이 두 번 나오면 그 문서는 못 읽은 것이다.

```
---
type: project
remote: github.com/소유자/이름 (또는 git@github.com:소유자/이름.git, 맨 소유자/이름. 첫 낱말만 읽는다)
deploy_branch: main (낱말 하나, 뒤에는 괄호 설명만. 또는 {소유자/이름: 브랜치, …} 짝 목록)
night_merge: 금지 (허용 | 금지. 칸이 없으면 허용)
---
```

설명은 괄호로 적는다. `#` 주석은 지원하지 않는다(`main # 설명`은 읽지 못한 것으로 본다).

문서 찾기: 먼저 `deploy_branch` 짝 목록에 그 저장소 키가 있는 문서, 없으면 `remote`가 그 키인 문서. 하나만 맞아야 한다(둘 이상이면 못 읽은 것).

## 합치기와 판정

칸마다 카단 설정 값이 있으면 그 값, 없으면 온톨로지 문서의 값, 둘 다 없으면 비어 있다. 판정(위에서부터 처음 맞는 것):

0. 읽지 못한 문서가 하나라도 있으면, 두 칸을 카단 설정으로 다 정하지 않은 저장소는 설정 필요(`setup-needed`)
1. 문서 쪽이 못 읽히는데 그 칸을 카단 설정이 채우지 않았으면 → 보류(`setup-needed`)
2. `nightMerge`가 `금지` → 보류(`night-merge-forbidden`)
3. `deployBranch`가 비어 있음 → 보류(`setup-needed`)
4. 대상 브랜치 == `deployBranch` → 보류(`deploy-branch`)
5. 그 밖 → Autopilot 중 자동 머지(`allowed`)

`kadan autopilot on --level autopilot --allow <소유자/이름> --quote "<kyle 원문>"`은 이번 켜짐 동안에 한해 2번(`night-merge-forbidden`)과 4번(`deploy-branch`) 보류만 푼다. 0·1·3번(`setup-needed`)은 풀지 않는다. 정책 파일 자체는 바뀌지 않는다.

관문 입력 예시(세 칸을 `jq`로 합쳐 stdin으로 넘긴다; 파일 목록은 이름을 바꾼 옛 경로까지 받으려고 REST를 쓴다):
`jq -n --argjson pr "$(gh pr view N --json url,number,state,isDraft,mergeable,mergeStateStatus,headRefOid,baseRefName,changedFiles)" --argjson files "$(gh api --paginate --slurp repos/<소유자>/<이름>/pulls/N/files)" --argjson requiredChecks "$(gh pr checks N --required --json name,state,bucket)" --argjson repo "$(gh repo view <소유자/이름> --json mergeCommitAllowed,squashMergeAllowed,rebaseMergeAllowed)" '{pr:$pr,files:$files,requiredChecks:$requiredChecks,repo:$repo}' | kadan merge-gate <업무>`

예전 `kadan autopilot source`(외부 폴더 등록)는 없어졌다. 정책 파일에 남은 `cards` 칸은 읽지도 쓰지도 않고 지우지도 않는다.

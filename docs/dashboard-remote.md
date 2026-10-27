# 대시보드 원격 보기 (읽기 전용)

## Why

밖에서 폰으로 카단 대시보드를 보고 싶은 사람이, 맥의 대시보드를 인터넷에 그대로 열지 않고 조회만 하게 한다. 로그인(Cloudflare Access)을 통과한 요청만 받고, 원격에서는 쓰기를 모두 막는다.

## 한눈에

- 기본은 **꺼짐**이다. 설정 파일이 없으면 지금까지와 똑같이 로컬(`127.0.0.1`, `localhost`, `[::1]`)만 받는다.
- 켜면 두 종류 요청만 받는다.
  - 로컬 Host: 지금과 같다(쓰기 가능).
  - 설정한 호스트 + 유효한 `Cf-Access-Jwt-Assertion`: 원격이다. **GET·HEAD**와, 결정 token을 든 **`POST /decisions/answer` 하나**만 받고 나머지는 405다.
- 그 밖(다른 Host, 토큰 없음, 토큰 틀림)은 403이다.
- 외부 설정(Access 앱, 터널, DNS, 상주 프로세스)은 이 기능 밖이다. 카단은 받은 요청을 검증할 뿐 Cloudflare를 건드리지 않는다.

## 설정 파일

`$KADAN_HOME/remote-access.json` (기본 `~/.kadan/remote-access.json`). 서버(`kadan wall`)를 시작할 때 한 번 읽는다. 바꾸면 대시보드를 다시 시작해야 반영된다.

```json
{
  "host": "kadan.example.com",
  "team": "team-name",
  "aud": "access-application-aud-tag",
  "email": "me@example.com"
}
```

| 항목 | 뜻 |
|---|---|
| `host` | 원격으로 받을 Host 이름(포트 제외). 점이 있는 호스트 이름이어야 한다 |
| `team` | Cloudflare Access 팀 이름. 토큰 발급자(`iss`)는 `https://<team>.cloudflareaccess.com`이어야 한다 |
| `aud` | Access 앱의 AUD 태그. 토큰의 `aud`(문자열 또는 배열)에 들어 있어야 한다 |
| `email` | 허용할 이메일. 토큰의 `email` 클레임과 같아야 한다(대소문자 무시) |

네 항목이 모두 올바르지 않으면(파일 없음, 항목 빠짐, 손상) 원격은 꺼진다. 로컬 동작은 영향이 없다. 값은 공개 저장소에 올리지 않는다.

## 토큰 검증 규칙

`src/access-jwt.mjs`가 `node:crypto`만으로 검증한다(새 의존성 없음).

1. 헤더 `Cf-Access-Jwt-Assertion`이 있어야 하고 점 2개로 나뉜 3부분이어야 한다. 각 부분은 엄격한 base64url(`A-Z a-z 0-9 _ -`)만 받는다(`=` 패딩·`+`·`/`·공백은 거부). 헤더·본문 JSON의 최상위에 같은 키가 두 번 나오면 거부한다(`\u006bid`처럼 이스케이프한 이름도 같은 이름으로 보고, 콜론 앞 공백 길이는 제한이 없다).
2. 헤더의 `alg`는 `RS256`만 받는다(`none` 등은 거부). `kid`가 열쇠 모음에 있어야 한다.
3. 서명을 확인한 뒤 `exp`(없으면 거부)·`nbf`·`iss`·`aud`·`email`을 확인한다. `exp`·`nbf`는 유한한 숫자여야 한다(`1e400` 거부).
4. 열쇠 모음은 `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`의 `keys`(JWK 배열)이며 **메모리에만** 둔다.
   - 원격이 켜진 서버가 시작할 때 한 번, 이후 1시간마다 받는다.
   - 모르는 `kid`가 오면 다시 받는다(1분에 한 번 상한).
   - 열쇠(JWK)는 `kty`가 RSA이고, `use`가 있으면 `sig`, `alg`가 있으면 `RS256`일 때만 받는다(문서 응답은 둘 다 적혀 있어 둘 다 없는 열쇠만 느슨하게 허용). 같은 `kid`가 둘 이상이면 그 `kid`는 쓰지 않는다(응답의 `keys` 전체에서 먼저 세므로 `use`·`alg`가 안 맞아 건너뛸 키와 같은 `kid`여도 정상 키까지 쓰지 않는다).
   - 받기에 실패하면 가진 열쇠로 계속한다. 실패에는 조회 오류뿐 아니라 새 응답에서 쓸 수 있는 열쇠가 하나도 남지 않은 경우(예: 모든 `kid`가 중복)도 들어간다. 그때는 새 응답을 버리고 기존 열쇠를 그대로 쓴다. 열쇠가 하나도 없으면 원격 요청을 모두 거부한다(실패 닫힘).
   - **원격이 꺼져 있으면 열쇠를 받는 네트워크 호출이 0번이다.**

공식 문서 대조(2026-10-18): 헤더 이름, certs 주소와 `keys` 응답 모양, `iss` 형식, RS256은 문서와 같았다. 문서는 `aud`가 문자열인지 배열인지, `email` 클레임을 명시하지 않아 둘 다 받고 없으면 거부하도록 했다.

## 원격에서 막히는 것

- 모든 쓰기 요청(POST·PUT·DELETE·PATCH 등)은 405 `원격은 조회만 지원합니다`이며 처리기까지 가지 않는다. 막는 경로 29개(30개 중 `/decisions/answer`만 아래 절의 한 길로 열린다): `/ask`, `/secretary/start`, `/roles/restart`, `/cards/{update,create}`, `/decisions/answer`, `/runners/{compare,set,preset-save,preset,preset-add,preset-rename,preset-remove,preset-import,preset-export,fallback,favorite,runner,model-add,model-remove,models-list}`, `/works/{create,update,link,unlink,execute,mail,complete,cancel,reopen}`.
- GET `/runners/compare`(비교 상태·뽑힌 수)와 `/runners/compare-report`(비교 결과)는 원격에서도 보인다. 프리셋·모델 이름·숫자·업무/카드 ID만 다루므로 조회는 허용하고 설정 쓰기는 막는다.
- `/api/dashboard/session`은 원격에 `{"token":"","readOnly":true,"decisionToken":"…"}`를 준다(쓰기 token은 주지 않고, 결정 전용 token만 준다). 로컬에는 `decisionToken`이 없다.
- 서버가 그리는 화면(`renderCenterWall`)의 token도 빈 값이다. 응답 캐시는 서버가 판정 결과(로컬/원격)로 나눠 쓴다. 구분은 URL 매개변수와 무관해서 주소에 무엇을 붙여도 섞이지 않는다.
- `?fresh`(캐시 비우기)는 원격에서 무시한다.
- `Origin`이 붙은 조회는 `https://<host>`를 같은 출처로 본다(`/api/dashboard/*`, `/api/operations-flow*`). 다른 출처와 `sec-fetch-site: cross-site`는 403이다.

## 화면

세션이 `readOnly:true`이면 대시보드가 쓰기 UI를 그리지 않고 위쪽에 "원격 보기(읽기 전용)" 안내를 보인다. 숨기는 것: 질문 보내기, 비서 켜기, 역할 다시 띄우기, 카드·워크 만들기와 기록 남기기(결정 답변, 업무 버튼 포함 — 모두 공통 쓰기 폼), 실행 모델·실행기 설정. 공통 전송 함수(`gui/src/resource.ts` `save()`)도 읽기 전용이면 보내지 않는다. 메뉴·칸 이름은 바뀌지 않는다.

## 폰에서 결정 답하기 (2단계)

원격에서 열리는 쓰기는 `POST /decisions/answer` **하나뿐**이다. 순서는 `judgeRequest`(Host·Access JWT) → 이 요청이면 Origin 확인 → 결정 token 확인 → 기존 처리기(`DecisionStore.answer`)다. 나머지 쓰기 22개는 결정 token을 붙여도 처리기 앞에서 405다.

- **결정 token**: `HMAC-SHA256(서버 시작 때 만든 비밀, "decision-answer" + JWT sub + JWT iat)`. 상태를 저장하지 않는다(요청마다 JWT로 다시 계산해 대조). 그래서 Access 신원에 묶이고, JWT가 갱신되면(iat 변경) 함께 바뀌며(화면은 403을 받으면 session을 다시 읽는다), 서버를 다시 시작하면 모두 무효다. 로컬 쓰기 token(무작위 값)과 만드는 방식이 달라 서로 대신할 수 없다. `sub`·`iat`가 없는 JWT에는 token을 주지 않는다(실패 닫힘).
- **Origin**: 원격 POST는 `Origin: https://<허용 호스트>`와 정확히 같아야 한다. 없음·`null`·`http`·포트·뒤 슬래시가 다르면 403이다. 쿠키 SameSite에 기대지 않는다.
- **거부**: 원격이 낸 로컬 쓰기 token, 로컬이 낸 결정 token, 신원 A의 token + 신원 B의 JWT, 만료 JWT, `?legacy=1` 옛 화면(token이 없다)은 모두 403이다. revision이 틀리면 기존 오류 경로(409)다.

### 위협 모델: 무엇이 무엇을 막나

| 위협 | 막는 것 |
|---|---|
| 로그인 없이 요청 | Access JWT 검증(`judgeRequest`) |
| 다른 사이트의 폼 POST. Cloudflare가 엣지에서 JWT 헤더를 붙이므로 **인증된 채로 도착할 수 있다** | **Origin(https 정확 일치)** 과 **결정 token**. 다른 사이트는 token을 읽을 수 없다(같은 출처 정책) |
| 결정 답하기 token으로 다른 쓰기 열기 | 한 길 규칙: 그 밖의 원격 쓰기는 token 확인 전에 405 |
| 로그인 상태가 같은 다른 사람·다른 JWT로 token 재사용 | token이 JWT의 `sub`·`iat`에 묶임 |
| 옛 화면·로컬에서 새어 나온 token | 로컬 token은 원격에서, 결정 token은 로컬에서 쓸 수 없다 |

### 감사 기록

별도 원장 줄은 없다. 결정 저장소(`decisions/events.jsonl`)의 답변 기록이 감사 기록이다. 원격 답변에는 `answer.remote = {email, sub, iat, exp, ip, ipTrusted:false}`가 붙는다. 시각은 `answer.at`, 결정 id·revision·선택·글은 기록 자체에 있다. `ip`는 `Cf-Connecting-IP` 값이며 위조할 수 있어 믿을 수 없는 값으로 표시한다. **JWT 원문은 담지 않는다.** 화면 응답(`/api/dashboard/decisions`)에는 이 필드를 싣지 않는다.

### 저장 형식 호환

`answer.source`는 `discord`만 허용하는 옛 검증기가 이력을 읽는다. 그래서 `source` 값 목록은 넓히지 않고, 옛 검증기가 무시하는 선택 필드 `answer.remote`로 원격 표시를 더했다. 첫 원격 답변 뒤에 옛 코드로 도는 감시기·디코 다리·재시작 전 대시보드도 이력을 읽는다(시험 `tests/decision-remote-answer.test.mjs`).

### 화면

원격 보기에서도 결정 화면의 답하기 양식만 켜진다(session에 `decisionToken`이 있을 때). 나머지 쓰기 UI는 숨김 그대로다. 알림 링크 `#decision-<id>`는 그 결정으로 바로 가서 양식에 초점을 둔다. 이미 답했거나 취소된 결정은 상태만, 모르는 id는 안내 문구만 보인다. 답한 뒤에는 기존 15초 조회가 해결 상태를 보여 준다. Access 로그인 유지 24시간은 바꾸지 않는다.

## 끄는 법

`remote-access.json`을 지우거나 이름을 바꾸고 대시보드를 다시 시작한다. 바깥(Access 앱·DNS·터널)부터 닫고 이 설정을 마지막에 지우는 순서를 권한다.

## 알려진 한계

- 원격이 켜진 서버는 Host가 로컬이어도 Cloudflare 표시 헤더(`Cf-*` 전부, `CDN-Loop`)가 있으면 로컬로 보지 않고 403으로 거부한다. 터널이 `Host`를 로컬 값으로 바꿔 보내도(`httpHostHeader` 등) 표시가 남아 쓰기가 열리지 않는다. 이 헤더는 위조할 수 있어 원격 인증의 근거로는 쓰지 않고 로컬 판정을 막는 데만 쓴다(원격 인증은 토큰 검증뿐). 거부를 고른 이유: Host가 로컬이면 허용 호스트 검사를 할 수 없어 원격 검증으로 넘길 길이 없고, 정상 로컬 브라우저는 이 헤더를 보내지 않는다. `Host` 헤더가 둘 이상인 요청도 거부한다. 원격이 꺼져 있으면 이 검사는 없고 예전 동작 그대로다.
- 표시 헤더 없이 진짜 로컬(같은 맥)에서 보낸 요청은 토큰 없이 로컬이다(예전과 같다).
- 알림 링크는 `remote-access.json`에 `host`가 있을 때만 공개 주소(`https://<host>/#decision-<id>`)로 바뀐다. 설정이 없으면 로컬 주소다. 알림 글의 안내 문구는 공개 주소 링크일 때 "열어서 답하기", 로컬 주소일 때 "맥에서 답하기"다.
- Access 세션이 만료되면 15초 조회가 로그인 화면을 받아 오류를 보일 수 있다. 새로고침으로 복구한다(폰 실측은 외부 설정 뒤 확인).

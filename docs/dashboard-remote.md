# 대시보드 원격 보기 (읽기 전용)

## Why

밖에서 폰으로 카단 대시보드를 보고 싶은 사람이, 맥의 대시보드를 인터넷에 그대로 열지 않고 조회만 하게 한다. 로그인(Cloudflare Access)을 통과한 요청만 받고, 원격에서는 쓰기를 모두 막는다.

## 한눈에

- 기본은 **꺼짐**이다. 설정 파일이 없으면 지금까지와 똑같이 로컬(`127.0.0.1`, `localhost`, `[::1]`)만 받는다.
- 켜면 두 종류 요청만 받는다.
  - 로컬 Host: 지금과 같다(쓰기 가능).
  - 설정한 호스트 + 유효한 `Cf-Access-Jwt-Assertion`: 원격이다. **GET·HEAD만** 받고 나머지는 405다.
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

1. 헤더 `Cf-Access-Jwt-Assertion`이 있어야 하고 점 2개로 나뉜 3부분이어야 한다.
2. 헤더의 `alg`는 `RS256`만 받는다(`none` 등은 거부). `kid`가 열쇠 모음에 있어야 한다.
3. 서명을 확인한 뒤 `exp`(없으면 거부)·`nbf`·`iss`·`aud`·`email`을 확인한다.
4. 열쇠 모음은 `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`의 `keys`(JWK 배열)이며 **메모리에만** 둔다.
   - 원격이 켜진 서버가 시작할 때 한 번, 이후 1시간마다 받는다.
   - 모르는 `kid`가 오면 다시 받는다(1분에 한 번 상한).
   - 받기에 실패하면 가진 열쇠로 계속한다. 열쇠가 하나도 없으면 원격 요청을 모두 거부한다(실패 닫힘).
   - **원격이 꺼져 있으면 열쇠를 받는 네트워크 호출이 0번이다.**

공식 문서 대조(2026-10-18): 헤더 이름, certs 주소와 `keys` 응답 모양, `iss` 형식, RS256은 문서와 같았다. 문서는 `aud`가 문자열인지 배열인지, `email` 클레임을 명시하지 않아 둘 다 받고 없으면 거부하도록 했다.

## 원격에서 막히는 것

- 모든 쓰기 요청(POST·PUT·DELETE·PATCH 등)은 405 `원격은 조회만 지원합니다`이며 처리기까지 가지 않는다. 막는 경로 23개: `/ask`, `/secretary/start`, `/roles/restart`, `/cards/{update,create}`, `/decisions/answer`, `/runners/{set,preset,fallback,favorite,runner,model-add,model-remove,models-list}`, `/works/{create,update,link,unlink,execute,mail,complete,cancel,reopen}`.
- `/api/dashboard/session`은 원격에 `{"token":"","readOnly":true}`를 준다(쓰기 token을 주지 않는다).
- 서버가 그리는 화면(`renderCenterWall`)의 token도 빈 값이다. 원격 응답의 캐시는 로컬과 나뉜다.
- `?fresh`(캐시 비우기)는 원격에서 무시한다.
- `Origin`이 붙은 조회는 `https://<host>`를 같은 출처로 본다(`/api/dashboard/*`, `/api/operations-flow*`). 다른 출처와 `sec-fetch-site: cross-site`는 403이다.

## 화면

세션이 `readOnly:true`이면 대시보드가 쓰기 UI를 그리지 않고 위쪽에 "원격 보기(읽기 전용)" 안내를 보인다. 숨기는 것: 질문 보내기, 비서 켜기, 역할 다시 띄우기, 카드·워크 만들기와 기록 남기기(결정 답변, 업무 버튼 포함 — 모두 공통 쓰기 폼), 실행 모델·실행기 설정. 공통 전송 함수(`gui/src/resource.ts` `save()`)도 읽기 전용이면 보내지 않는다. 메뉴·칸 이름은 바뀌지 않는다.

## 끄는 법

`remote-access.json`을 지우거나 이름을 바꾸고 대시보드를 다시 시작한다. 바깥(Access 앱·DNS·터널)부터 닫고 이 설정을 마지막에 지우는 순서를 권한다.

## 알려진 한계

- 로컬 Host(`127.0.0.1` 등)로 들어온 요청은 토큰 없이 로컬로 본다. 터널이 `Host`를 로컬 값으로 바꿔 보내면(`httpHostHeader` 등) 원격 요청이 로컬로 보여 쓰기가 열린다. 터널 설정에서 Host를 바꾸지 않는다.
- 원격 알림 링크(공개 주소)는 이번 범위가 아니다. 알림 링크는 계속 로컬 주소다.
- Access 세션이 만료되면 15초 조회가 로그인 화면을 받아 오류를 보일 수 있다. 새로고침으로 복구한다(폰 실측은 외부 설정 뒤 확인).

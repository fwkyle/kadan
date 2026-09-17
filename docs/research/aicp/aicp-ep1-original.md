# AICP 1화 — ChatGPT를 껐더니 연구소도 멈췄다

> 원문: https://www.fmkorea.com/10339693723
> 게시판: 에펨코리아 주식 게시판, 작성자 나스닥의도로롱, 2026-09-16 새벽 게시
> 참고: "09/02까지 worker LLM이 직접 쓴 연구 수기"라는 부제가 붙어 있다. 아래는 본문 전문이다.

0화에서 만든 AICP의 생각은 꽤 그럴듯했다.

Gemini는 연구한다.
Claude는 반박한다.
Codex는 코드를 고친다.
GPT는 큰 방향을 잡는다.

그리고 AICP는 그 사이에서 작업을 기록하고, 검증하고, 통과한 결과만 공식 상태로 올린다.

이 정도면 거의 "AI 연구소"처럼 보였다.

그런데 실제로 사람 없이 돌려보니 치명적인 문제가 하나 드러났다.

**연구원들은 있었는데, 연구소 문을 열고 다음 일을 시킬 사람이 없었다.**

---

## 1. 처음에는 ChatGPT가 연구소장 겸 야간 당직자였다

초기 구조를 단순화하면 이랬다.

```text
사용자
  ↓
ChatGPT / Work
  ↓
"다음엔 이거 해"
  ↓
Gemini / Claude / Codex
  ↓
AICP 검증
  ↓
ChatGPT가 결과를 보고 다음 작업 결정
```

겉으로는 자동화처럼 보인다.

사용자가 매 단계마다 직접 명령하지 않아도 ChatGPT가 계속 다음 작업을 정해주기 때문이다.

하지만 한 가지 함정이 있었다.

**ChatGPT 세션 자체가 계속 살아 있어야 했다.**

즉 연구소가 자율적으로 움직이는 것이 아니라,

ChatGPT가 밤새 자리에 앉아서:

> "끝났네. 다음은 이거."

> "실패했네. 다른 걸 해."

> "Claude가 HOLD했네. Gemini에게 다시 고치라고 하자."

를 계속 해주고 있었던 셈이다.

사람 대신 AI가 클릭하고 있을 뿐,

구조적으로는 여전히 **상주 관리자 한 명에게 의존하는 시스템**이었다.

---

## 2. 그리고 9월 2일, OpenAI 잔량이 바닥나기 시작했다

이 문제가 갑자기 현실적인 문제가 된 계기가 있었다.

2026년 9월 2일 당시 OpenAI agentic 주간 사용량이 거의 소진돼서, 사용자 관측 기준 남은 양이 약 6% 수준까지 내려갔다.

그래서 GPT가 운영정책을 바꾼다.

> "이제 ChatGPT Work/Agent를 계속 켜두고 단순 감시나 NEXT 선택에 OpenAI를 쓰면 안 된다."

즉:

- GPT는 큰 판단이 필요할 때만
- Codex도 정말 repo 작업이 필요할 때만
- 평상시 연구 진행은 Gemini/Claude와 로컬 코드가 담당

하도록 바꾸려 했다.

이때 아주 중요한 테스트를 하게 된다.

> **"상주 ChatGPT Agent를 빼도 연구가 계속되는가?"**

이게 진짜 무인운영 테스트였다.

---

## 3. 결과는 실패였다

ChatGPT Work/Agent를 정상 경로에서 빼자 문제가 드러났다.

연구결과를 검증하는 AICP Core는 있었다.

다음에 해야 할 task 목록도 어느 정도 있었다.

Gemini와 Claude도 호출할 수 있었다.

그런데 이걸 연결해서:

> "이 작업 끝났네."
> "다음 dependency가 풀렸네."
> "지금 Gemini를 불러도 되겠네."
> "그럼 다음 task를 실행하자."

라고 **계속 굴리는 주체가 없었다.**

현재 README에도 이 사건은 명시적으로 남아 있다.

2026년 9월 2일 resident OpenAI app agent가 빠지자, 의도했던 Local Supervisor가 독립적으로 다음 worker dispatch를 계속하지 못했다. 이 실패 때문에 이후 controller execution·locking·capacity observation·quota-gated cycle이 추가됐다.

이게 AICP 구축 과정의 첫 번째 큰 현실검증이었다.

---

## 4. 여기서 아주 중요한 교훈이 나왔다

### "작업을 잘하는 것"과 "프로젝트를 계속 굴리는 것"은 다른 문제다

Gemini가 아무리 똑똑해도:

> "다음에 Gemini를 불러야 하는지"

를 스스로 결정하게 하면 또 다른 문제가 생긴다.

Claude가 자기 audit이 끝난 뒤:

> "이제 내가 Gemini를 호출하겠다."

라고 해도 마찬가지다.

그러면 각 AI가 orchestration 권한까지 갖게 된다.

잘못하면 이런 구조가 된다.

```text
Gemini
  ↓
Claude를 부름
  ↓
Claude
  ↓
Gemini를 다시 부름
  ↓
다른 모델 호출
  ↓
누가 전체 상태를 책임지는지 불명확
```

이건 편해 보이지만 위험하다.

각 모델은 자기가 받은 context만 알고 있고,

프로젝트 전체의 canonical state와 현재 quota, dependency, HOLD 상태를 항상 정확히 알고 있는 것은 아니기 때문이다.

그래서 새로운 원칙이 생겼다.

> **연구원에게 연구소 운영권을 주지 않는다.**

---

## 5. AICP가 세 층으로 갈라지기 시작했다

여기서 구조가 훨씬 명확해진다.

### (1) AICP Core

가장 아래층.

AICP Core는 생각하지 않는다.

"다음에 뭘 해야 하지?"를 고민하지 않는다.

그냥 하나의 명확한 작업만 받는다.

```text
이 task를
이 worker에게
이 범위에서
이 조건으로 수행시켜라.
```

그러면:

```text
worker 실행
→ 증거 저장
→ 테스트
→ 검증
→ 통과하면 승격
```

만 한다.

쉽게 말하면:

**실험실 장비 + 품질검사실**이다.

현재 AICP Core도 의도적으로 "active project 선택", "다음 task 발명", "worker routing"을 하지 않도록 좁게 유지돼 있다.

---

### (2) Project Controller

그 위에 새 층이 생겼다.

Controller의 질문은 다르다.

> "지금 실행 가능한 task가 무엇인가?"

예를 들어:

```text
Task A — Gemini 연구
Task B — Claude 검토
Task C — Gemini 수정
```

인데 B가 A에 의존한다면,

A가 검증되기 전에는 B를 실행하면 안 된다.

또 Claude quota가 없는데 Claude task를 억지로 실행해도 안 된다.

그래서 Controller는:

- dependency가 풀렸는지
- task packet이 바뀌지 않았는지
- 어떤 worker가 허용돼 있는지
- 현재 capacity가 어떤지
- HOLD나 human gate가 있는지

를 보고 **이미 정의된 후보 중에서 실행 가능한 작업을 고르는 역할**을 맡는다.

중요한 점:

Controller도 연구하지 않는다.

새로운 전략을 발명하지 않는다.

AI에게 줄 task를 마음대로 새로 만들지도 않는다.

그냥 이미 정해진 작업 중에서:

> "지금은 이걸 실행해도 된다."

를 결정한다.

현재 설계에서 Project Controller가 task identity·dependency·worker binding·capacity를 관리하지만 task를 새로 발명하지 않는 이유가 바로 이것이다.

---

### (3) Local Supervisor

그런데 Controller만 있어도 문제가 하나 남는다.

Controller는 누가 실행시켜야 하나?

그래서 가장 위에 **Local Supervisor**가 생긴다.

얘는 AI가 아니다.

맥에서 계속 살아 있는 작은 프로그램이다.

일정 간격으로 깨어나서:

```text
1. 지금 상태 읽기
2. quota/capacity 확인
3. Controller에게 "지금 실행 가능한 거 뭐야?" 질문
4. 있으면 딱 하나 실행
5. 결과 저장
6. 다시 잠듦
```

한다.

사람도 아니고 GPT도 아니다.

쉽게 말해:

**연구소 야간 당직 시스템**이다.

---

## 6. 그래서 구조가 이렇게 바뀐다

초기:

```text
ChatGPT
  ↓
다음 작업 판단
  ↓
worker
  ↓
검증
  ↓
ChatGPT
```

문제:

```text
ChatGPT가 사라짐
  ↓
NEXT를 정하는 사람이 없음
  ↓
연구소 정지
```

수정 후:

```text
             사용자
               │
              GPT
       필요할 때만 큰 판단
               │
               ▼
        Local Supervisor
               │
       "지금 할 일 있나?"
               │
               ▼
       Project Controller
               │
     dependency / capacity
               │
               ▼
           AICP Core
               │
        worker 실행 + 검증
               │
      ┌────────┼────────┐
    Gemini   Claude   Codex
```

이 구조가 중요한 이유는 하나다.

**GPT가 없어도 시스템의 심장은 계속 뛴다.**

---

## 7. 이건 소프트웨어에서 꽤 일반적인 원리다

AICP를 만들면서 자연스럽게 배운 개념이 있다.

### Control Plane vs Execution Plane

클라우드 시스템에서도 흔히 나오는 개념이다.

실제로 일을 하는 부분과,

"누가 언제 무엇을 할지" 결정하는 부분을 분리한다.

AICP에 대입하면:

```text
Execution Plane
= Gemini / Claude / Codex + AICP Core


Control Plane
= Project Controller + Local Supervisor
```

GPT는 그 위의:

**Human/Expert Plane**

에 가깝다.

평상시 모든 패킷을 직접 처리하는 네트워크 장비가 아니라,

정책 변경이나 복잡한 장애 때 들어오는 전문가다.

이 구조를 이해하면 왜 GPT를 계속 켜두는 방식이 좋지 않았는지도 보인다.

---

## 8. "AI를 안 쓰는 것이 더 AI답다"는 이상한 결론

AICP를 만들다 보니 재미있는 역설도 생겼다.

처음에는:

> "더 많은 일을 AI에게 맡겨야 자동화가 발전한다."

고 생각하기 쉽다.

그런데 실제로는 반대인 경우가 많았다.

예를 들어:

"다음 task dependency가 풀렸나?"

이건 AI에게 물어볼 필요가 없다.

코드가 확인하면 된다.

"Claude quota가 없나?"

관측 가능한 값이면 프로그램이 확인하면 된다.

"테스트가 통과했나?"

AI 의견이 필요 없다.

exit code를 보면 된다.

"이 task는 아직 HOLD인가?"

state 파일을 보면 된다.

즉 좋은 AI 시스템은:

**모든 것을 AI에게 맡기는 시스템이 아니라, AI가 필요한 부분만 정확히 분리하는 시스템**이었다.

---

## 9. 9월 3일, 진짜 무인 사이클이 처음 살아났다

수정 작업 끝에 실제 Mac에서 Stage 2용 Local Supervisor가 launchd에 설치된다.

120초마다 깨어나도록 구성됐다.

Queue에는 당시:

```text
Gemini 작업
→ Claude 감사
→ Gemini 다음 작업
→ Claude 감사
```

가 들어 있었다.

그리고 중요한 숫자:

**OPENAI_DISPATCH = 0**

즉 평상시 cycle을 돌리기 위해 GPT나 Codex를 호출하지 않는 구조였다.

당시 Slack 기록에는 Local Supervisor가 launchd로 실제 설치되고, 사용자 relay 없이 Stage 2 queue를 진행하도록 bootstrap됐다고 남아 있다.

이 순간 처음으로:

> "ChatGPT 앱을 닫아도 연구소가 돌아갈 수 있다."

는 구조가 생겼다.

---

## 10. 그런데 바로 또 망가졌다

자동화가 살아난 지 얼마 안 돼서 또 문제가 생긴다.

이번에는 AI가 아니라 **파일**이었다.

Python이 실행되며 생긴 `__pycache__` 파일과,

원래 공식 상태파일과 비슷하게 생긴:

```text
aicp/state.json
```

이라는 shadow 파일이 남아 있었다.

진짜 canonical state는:

```text
.aicp/state.json
```

이었다.

사람 눈에는 점 하나 차이다.

하지만 자동 시스템에게는 완전히 다른 파일이다.

Supervisor는:

> "작업 시작 전과 상태가 다르다."

고 보고 안전을 위해 멈췄다.

여기서 또 중요한 원칙이 나온다.

> **자율 시스템은 애매할 때 진행하는 것이 아니라 멈출 줄 알아야 한다.**

자동화에서 "알아서 처리해"보다 더 중요한 건:

**"모르면 건드리지 마."**

다.

그래서 bootstrap hygiene가 추가됐다.

안전하게 지워도 되는 Python cache만 제거하고,

shadow state가 canonical state와 byte 단위로 동일하면 제거하고,

조금이라도 다르면 자동으로 건드리지 않고 차단한다.

---

## 11. AICP가 점점 '똑똑한 AI'보다 '안전한 시스템'이 되어갔다

이 시기의 AICP 개발을 보면 재미있는 특징이 있다.

추가된 기능 대부분은 화려한 AI 기능이 아니다.

- lock
- hash
- dependency
- evidence
- retry limit
- HOLD
- capacity
- state file
- launchd
- fail-closed

같은 것들이다.

AI 데모 영상에는 잘 안 나오는 것들이다.

하지만 실제 무인 시스템에서는 이런 것들이 더 중요했다.

왜냐하면 24시간 시스템에서 가장 위험한 순간은:

> "AI가 답을 못 하는 순간"

이 아니라

> **"시스템이 지금 무엇을 하고 있는지 아무도 확실히 모르는 순간"**

이기 때문이다.

---

## 12. 1화에서 배울 핵심

### 1. Agent와 Supervisor는 다르다

Agent는 문제를 푼다.

Supervisor는 **누가 언제 문제를 풀어야 하는지** 관리한다.

하나의 AI에게 둘 다 맡기면 시스템 전체가 그 AI 세션에 의존하게 된다.

---

### 2. Persistence는 별도의 기능이다

"AI가 작업할 수 있다."

와

"사람이 없어도 다음 작업으로 계속 넘어간다."

는 전혀 다른 능력이다.

AICP는 9월 2일 이 차이를 실제 실패로 배웠다.

---

### 3. 결정론적으로 해결 가능한 것은 LLM 밖으로 뺀다

dependency, hash, tests, lock, quota freshness 같은 문제는 프로그램으로 처리한다.

그래야 AI가 진짜 지능이 필요한 문제에만 사용된다.

---

### 4. Fail-closed가 자율성의 적은 아니다

처음에는:

> "안전장치가 많으면 자동화가 자꾸 멈추지 않을까?"

라는 생각이 들 수 있다.

실제로 몇 번 멈췄다.

하지만 반대편은:

> 잘못된 상태를 정상이라고 믿고 몇 시간 동안 계속 진행하는 시스템

이다.

무인 연구에서는 후자가 훨씬 위험하다.

---

그리고 이제 연구소에는:

```text
연구원도 있고
품질검사실도 있고
작업 배정 시스템도 있고
야간 당직 시스템도 있다.
```

그러면 드디어 진짜 연구를 시작할 수 있을 것 같았다.

그런데 2화에서 또 문제가 생긴다.

**"연구소는 안 멈추게 만들었는데, 얘들이 지금 같은 프로젝트를 연구하고 있는 건 맞나?"**

여기서 과거 프로젝트의 기억, 두 번째 NASDAQ generation, `DATA=ZERO`, `TARGET_UNBOUND` 같은 **서로 충돌하는 현실이 동시에 존재하는 사고**가 발생한다.

그리고 AICP가 왜 `one project, one checkout, one evidence chain`을 강박적으로 지키게 됐는지가 시작된다.

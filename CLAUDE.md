# CLAUDE.md — 이 저장소에서 작업할 때 반드시 지킬 것

이 문서는 에이전트와 사람 모두에게 **구속력을 갖는 규약**이다.
`src/credentials.ts`, `src/refresh-lock.ts`, `src/index.ts`의 자격증명·갱신 경로를
수정하기 전에 반드시 읽는다.

정책의 전체 설명은 [README의 Appendix: 토큰 정책](README.md#appendix-토큰-정책-한글)에 있다.

---

## 핵심 원칙

> **이 플러그인은 OAuth 토큰 엔드포인트를 직접 호출하지 않는다.**
> 토큰 갱신은 전적으로 `claude` CLI가 수행하고,
> 플러그인은 CLI가 자격증명 저장소에 쓴 것을 **읽기만** 한다.

---

## 불변 조건 — 깨면 안 되는 것

각 항목은 **강제하는 테스트**를 함께 적는다. 테스트를 지우면서 규칙을 깨지 말 것.

### 1. `credentials.ts`는 토큰 엔드포인트에 요청하지 않는다

`https://claude.ai/v1/oauth/token`으로 `fetch`/`execSync`를 보내지 않는다.
`OAUTH_TOKEN_URL` 상수는 **진단 로그에서 호스트 이름을 보여주기 위해서만** 존재한다.

- 왜: API 요청은 `api.anthropic.com`으로, 토큰 갱신은 `claude.ai`로 간다. 기업망은
  소비자용 도메인인 후자를 차단하거나 TLS 가로채기 하면서 전자는 허용하는 경우가 흔하다.
  OpenCode(Bun 단일 바이너리)와 `claude` CLI(별도 Node 프로세스)는 프록시 설정,
  CA 신뢰 저장소, DNS 처리가 서로 달라, 플러그인의 in-process `fetch`가 실패해도
  CLI는 성공하는 상황이 실재한다.
- 강제: `credentials.test.ts` → `"never calls the OAuth token endpoint itself"`
  (테스트 하네스의 `globalThis.fetch`는 항상 throw한다)

### 2. `credentials.ts`는 자격증명을 저장소에 쓰지 않는다

`writeBackCredentials`를 import하지 않는다. `.credentials.json`이나 키체인에 쓰지 않는다.
(`auth.json` 미러링과 `claude-account-source.txt`는 예외 — 자격증명 저장소가 아니다.)

- 왜: 갱신은 서버 측에서 refresh token을 **회전**시킨다. 회전시킨 쪽이 저장에 실패하면
  새 토큰은 메모리에만 남고 저장소에는 서버가 이미 무효화한 것이 남아 **계정이 죽는다.**
  키체인 ACL 거부나 compare-and-swap 불일치로 조용히 일어날 수 있으며,
  대화형 재인증이 불가능한 망에서는 복구 수단이 없다. CLI는 회전과 저장을 한 번에 한다.
- 강제: `credentials.test.ts` → `"never writes credentials back to the store"`
  (키체인 스텁의 `__getWriteCount()`가 0이어야 한다)

### 3. `performCliRefresh`는 access token이 **실제로 바뀌어야** 성공이다

"저장소에 쓸 만한 게 있다"로 완화하지 말 것.

- 왜: 만료 경로에서는 둘이 같지만, 401 복구 경로에서는 다르다. 401은 로컬상 멀쩡해 보이는
  토큰에 대해 일어나므로, 같은 토큰을 되읽고 성공 처리하면 쿨다운이 해제되어
  **401 루프가 그대로 spawn 루프가 된다.**
- 강제: `credentials.test.ts` → `"forceRefreshActiveAccount respects the cooldown so a 401 loop is not a claude loop"`

### 4. `claude` 실행은 반드시 쿨다운으로 제한한다

- 왜: `execSync`는 **동기**다. 실행되는 동안 OpenCode 프로세스 전체(HTTP 서버, 다른 세션,
  진행 중인 스트림, 모든 타이머)가 멈춘다. 게다가 갱신에 실패하면 계정 캐시가 버려져
  재진입을 막는 것이 없으므로, 제한이 없으면 CLI가 고칠 수 없는 계정은 **요청마다
  프리즈를 반복한다.**
- 쿨다운은 **실행 전에** 건다. 실행 후에 계산하면 그 실행 자체가 쿨다운보다 오래 걸려
  아무것도 막지 못한다.
- 강제: `credentials.test.ts` → `"suppresses a second run inside the cooldown window"`,
  `"arms the cooldown before the run, not after"`

### 5. 크로스프로세스 락을 제거하지 않는다

- 왜: 동시에 N개의 `claude`가 돌면 refresh token이 N번 회전하고, 마지막 하나를 뺀 전부가
  무효화된다. 대화형 재인증이 불가능한 망에서 이것은 **복구 수단이 없는 유일한 실패**다.
- 락 TTL은 반드시 최악의 hold(`CLI_REFRESH_TIMEOUT_MS × 2 + 여유`)를 덮어야 한다.
  블로킹 `execSync` 중에는 heartbeat가 불가능하므로 TTL을 처음부터 크게 잡는 수밖에 없다.
- `release()`는 소유권을 확인한 뒤에만 unlink한다. 확인하지 않으면 TTL을 넘긴 홀더가
  자신을 밀어낸 후임자의 락 파일을 지운다.
- 강제: `credentials.test.ts` → `"does not run \`claude\` while another process holds the refresh lock"`,
`"sizes the lock TTL to cover the whole blocking hold"`;
`refresh-lock.test.ts`→`"leaves a lock file owned by another process alone on release"`

### 6. `claude` 자식 프로세스의 환경을 명시적으로 만든다

`process.env`를 그대로 spread하지 않는다. 최소한 다음을 제거한다:
`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `CLAUDE_CODE_ENTRYPOINT`.

- 왜: API 키가 상속되면 `claude`는 그 키로 인증하고 **OAuth 저장소를 건드리지 않은 채
  exit 0** 한다. 성공처럼 보이지만 아무것도 회전되지 않고, 과금만 반복된다.
- 강제: `credentials.test.ts` → `"keeps API-key and base-URL variables out of the child environment"`

### 7. 플러그인 init은 `claude`를 실행하지 않는다

init의 자격증명 해석은 `allowCliRefresh: false`로 호출한다.

- 왜: init은 OpenCode에 UI가 뜨기 전에 await된다. 여기서 spawn하면 요청 하나가 아니라
  **런치 자체가** 멈춘다. 갱신이 CLI에만 의존하는 망에서는 "시작할 때 토큰 만료"가
  예외가 아니라 정상 경로다. 첫 실제 요청이 갱신 비용을 부담하면 된다.
- 강제: `index.test.ts` → `"plugin init defers the refresh instead of running \`claude\` before the UI exists"`

### 8. 백그라운드 타이머는 갱신하지 않는다

5분 타이머는 **이미 유효한** 자격증명을 `auth.json`에 미러링만 한다.

- 왜: 타이머에서 갱신하면 5분마다 과금 요청과 프로세스 프리즈가 발생한다.
  갱신이 필요한 시점은 요청 경로가 이미 처리한다.
- 강제: `credentials.test.ts` → `"returns null rather than running \`claude\` on a timer"`

---

## 변경하려면

이 규칙 중 하나를 깨야 한다고 판단되면:

1. **먼저 근거를 적는다.** 위 "왜"에 적힌 실패가 왜 더 이상 성립하지 않는지 설명할 수 없다면
   그 변경은 하지 않는다.
2. **강제 테스트를 지우지 않는다.** 규칙을 바꾸면 테스트도 함께 바꾸되, 커밋 메시지에
   `Rejected:` / `Directive:` 트레일러로 판단 근거를 남긴다.
3. **정책 변경은 문서 변경을 동반한다.** 이 파일과 README Appendix를 같이 고친다.

## 커밋 규약

conventional commit 제목 + 본문 + 트레일러. 자명한 변경(오타, 포매팅)은 트레일러 생략.

```
Constraint:  이 결정을 규정한 제약
Rejected:    검토했으나 기각한 대안 | 기각 이유
Directive:   이후 이 코드를 고칠 사람에게 주는 경고
Confidence:  high | medium | low
Scope-risk:  narrow | moderate | broad
Not-tested:  테스트로 덮지 못한 시나리오
```

## 검증

```bash
npx tsc --noEmit                                              # 타입
npx oxlint && npx oxfmt --check .                             # 린트/포맷
env -u CLAUDE_CODE_ENTRYPOINT npm test                        # 테스트
```

`env -u CLAUDE_CODE_ENTRYPOINT`는 **필수**다. Claude Code 안에서 테스트를 돌리면
이 변수가 상속되어 `index.test.ts`의 billing 헤더 테스트가 허위로 실패한다.

테스트에서 **실제 `claude` 프로세스가 절대 실행되지 않아야** 한다. 확인:

```bash
env -u CLAUDE_CODE_ENTRYPOINT PATH="/usr/bin:/bin" \
  $(which node) --test --experimental-strip-types src/credentials.test.ts
```

`claude`를 PATH에서 없앤 상태에서도 결과가 동일해야 한다.

## 릴리즈

**이 저장소는 fork이며, GitHub Actions가 비활성 상태다.**
`publish.yml`은 태그를 밀어도 실행되지 않는다. 배포는 수동이다.

```bash
# package.json 버전 + CHANGELOG 갱신 → 커밋 → 태그
git tag -a vX.Y.Z -m "..." && git push origin main vX.Y.Z
pnpm publish --access public --no-git-checks     # 로컬에서 직접
```

CI 검증도 돌지 않으므로 **푸시 전에 위 검증을 로컬에서 반드시 통과**시킨다.

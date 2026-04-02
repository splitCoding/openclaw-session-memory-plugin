# 플러그인 도구 등록 트러블슈팅

`memory_save` 도구가 등록되었지만 AI에게 노출되지 않았던 문제의 원인과 해결 과정을 정리합니다.

---

## 증상

- `openclaw plugins list`에서 my-plugin은 `loaded` 상태
- 팩토리 함수가 호출되어 `memory_save` 도구 객체를 정상 반환 (로그로 확인)
- 그런데 AI가 "memory_save라는 도구는 없습니다"라고 응답
- `/tools` UI에서도 `memory_save`가 보이지 않음
- `memory_search`, `memory_get`은 정상 노출

---

## 원인: Tool Profile의 허용 목록 방식

### OpenClaw의 도구 프로필 시스템

OpenClaw은 `tools.profile` 설정으로 도구 프로필을 지정합니다 (예: `"coding"`, `"messaging"`, `"full"`).

```json
{
  "tools": {
    "profile": "coding"
  }
}
```

`coding` 프로필은 **허용 목록(allowlist) 방식**으로 동작합니다:
- 코어 도구 목록에 있는 도구만 허용
- 목록에 없는 도구는 자동으로 필터링

```
coding 프로필 허용 목록 (src/agents/tool-catalog.ts):
  read, write, edit, exec, process, web_search, web_fetch,
  cron, sessions_*, subagents, image, memory_search, memory_get, ...

→ memory_save는 이 목록에 없음 → 필터링됨
```

### 왜 memory_search는 되고 memory_save는 안 되는가?

`memory_search`와 `memory_get`은 **기존 memory-core 플러그인의 도구**이므로 코어 허용 목록에 하드코딩되어 있습니다:

```typescript
// src/agents/pi-embedded-subscribe.tools.ts
const TRUSTED_TOOL_RESULT_MEDIA = new Set([
  "memory_get",
  "memory_search",
  // ... memory_save는 없음
]);
```

`memory_save`는 **새로 만든 도구**이므로 이 목록에 없습니다.

### 도구 필터링 파이프라인

```
플러그인 도구 등록 (registerTool)
    │
    ▼
팩토리 함수 호출 → 도구 객체 반환 ✅
    │
    ▼
resolvePluginTools() → 도구 배열에 추가 ✅
    │
    ▼
applyToolPolicyPipeline() → 프로필 정책 적용
    │
    ├─ coding 프로필 allowlist 확인
    │   ├─ memory_search → 목록에 있음 ✅ 통과
    │   ├─ memory_get    → 목록에 있음 ✅ 통과
    │   └─ memory_save   → 목록에 없음 ❌ 필터링됨
    │
    ▼
최종 도구 목록 (memory_save 없음)
```

---

## 해결: tools.alsoAllow 설정

`~/.openclaw/openclaw.json`에 `tools.alsoAllow`를 추가하면 프로필 허용 목록에 도구를 추가할 수 있습니다:

```json
{
  "tools": {
    "profile": "coding",
    "alsoAllow": ["memory_save"]
  }
}
```

### 주의사항

- `tools.allow`와 `tools.alsoAllow`는 **동시에 사용 불가**
  - `allow`: 프로필을 무시하고 목록을 직접 지정 (전체 교체)
  - `alsoAllow`: 프로필 목록에 추가 (확장)
- 플러그인 ID를 `alsoAllow`에 넣으면 해당 플러그인의 **모든 도구**가 허용됨
  - 예: `"alsoAllow": ["my-plugin"]` → my-plugin의 모든 도구 허용

---

## 추가 발견: /tools UI와 실제 도구 목록의 차이

`/tools` 명령(채팅 UI)에서 보이는 목록과 AI가 실제로 사용 가능한 도구 목록이 다를 수 있습니다.

```bash
# /tools UI에서는 안 보이지만
# AI에게 직접 물으면 보임
openclaw agent --agent main --message "사용 가능한 도구 목록을 알려줘"
# → memory_save 포함
```

이는 `/tools`가 `tools.effective` API를 통해 도구를 조회하는데, 이 조회 시점의 세션 컨텍스트와 실제 에이전트 런타임의 세션 컨텍스트가 다를 수 있기 때문입니다.

---

## 다른 실패 원인들 (디버깅 과정에서 확인한 것들)

### 1. 도구 이름 충돌

처음에 `memory_store`로 이름을 지었는데, `memory-lancedb` 플러그인이 이미 같은 이름을 사용하고 있었습니다.

```
extensions/memory-lancedb/index.js:
  name: "memory_store"  ← 이미 사용 중
```

이름이 충돌하면 나중에 등록된 도구가 **조용히 건너뛰어집니다** (`src/plugins/tools.ts:166`).

해결: `memory_save`로 이름 변경

### 2. 팩토리가 null 반환

`createMemoryTool` 래퍼는 내부에서 `resolveMemorySearchConfig()`를 호출하여 메모리 검색 설정이 없으면 `null`을 반환합니다.

```typescript
// tools.shared.ts
export function resolveMemoryToolContext(options) {
  if (!resolveMemorySearchConfig(cfg, agentId)) {
    return null;  // ← 검색 설정 없으면 도구 비활성
  }
}
```

`memory_save`는 검색 설정과 무관하게 동작해야 하므로 이 래퍼를 사용하지 않고 직접 도구 객체를 생성합니다.

### 3. registerHook vs api.on

처음에 `before_tool_call` 훅을 `api.registerHook()`으로 등록했는데 동작하지 않았습니다.

```typescript
// ❌ 동작 안 함 — 내부 훅 시스템 (command/session 이벤트용)
api.registerHook("before_tool_call", handler);

// ✅ 동작함 — 플러그인 훅 시스템 (before_tool_call 등)
api.on("before_tool_call", handler);
```

- `api.registerHook()`: `InternalHookHandler` 타입, command/session/agent 이벤트
- `api.on()`: 플러그인 훅 타입, `before_tool_call`, `after_tool_call` 등

### 4. edit 도구의 파라미터 필드명

`before_tool_call` 훅에서 파일 경로를 확인할 때, `edit` 도구는 `params.file`을 사용합니다.

```typescript
// ❌ edit 도구의 경로를 못 잡음
const filePath = params.path ?? params.file_path;

// ✅ edit 도구 포함
const filePath = params.file ?? params.path ?? params.file_path;
```

---

## 플러그인 도구 등록 체크리스트

새 플러그인 도구를 만들 때 확인할 사항:

```
[ ] 도구 이름이 기존 도구와 충돌하지 않는가?
    → grep -r "도구이름" /opt/homebrew/lib/node_modules/openclaw/dist/extensions/

[ ] 팩토리가 null을 반환하지 않는가?
    → console.error로 반환값 디버깅

[ ] tools.profile에 의해 필터링되지 않는가?
    → tools.alsoAllow에 도구 이름 추가

[ ] 훅은 api.on()으로 등록했는가? (api.registerHook 아님)

[ ] 도구 파라미터 필드명을 정확히 확인했는가?
    → 세션 로그에서 실제 params 구조 확인
```

---

## 관련 소스 코드

| 파일 | 역할 |
|------|------|
| `src/agents/tool-catalog.ts` | 프로필별 코어 도구 허용 목록 정의 |
| `src/agents/pi-tools.ts` | 도구 생성 및 프로필 정책 적용 |
| `src/agents/tool-policy-pipeline.ts` | 도구 필터링 파이프라인 |
| `src/agents/tool-policy-match.ts` | allowlist/denylist 매칭 로직 |
| `src/plugins/tools.ts` | 플러그인 도구 해석 (팩토리 호출, 충돌 검사) |
| `src/plugins/registry.ts` | 도구 등록 (registerTool 구현) |
| `src/plugins/types.ts` | 훅 타입 정의 (before_tool_call 등) |

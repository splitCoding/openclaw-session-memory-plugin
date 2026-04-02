# Memory Plugin Lifecycle

Memory kind 플러그인은 일반 플러그인과 다른 **전용 라이프사이클**을 가집니다.
핵심 차이는 **exclusive slot** (하나만 활성), **전용 등록 API**, **컴팩션 연동 플러시**, **시스템 프롬프트 주입**입니다.

---

## 일반 플러그인과의 차이

| 항목 | 일반 플러그인 | Memory 플러그인 |
|------|-------------|----------------|
| 동시 활성화 | 여러 개 가능 | **하나만 가능** (exclusive slot) |
| 등록 API | `registerTool`, `registerHook` 등 | 전용 API 4종 추가 |
| 초기화 시점 | 즉시 (eager) | **지연 (lazy)** — 메모리 접근 시 |
| 상태 관리 | 레지스트리별 | **프로세스 전역 싱글턴** |
| 설정 위치 | `plugins.entries.<id>` | `agents.defaults.compaction.memoryFlush` (중앙) |
| 프롬프트 | 없음 | 시스템 프롬프트에 Memory Recall 섹션 주입 |
| 컴팩션 연동 | 없음 | 토큰 임계치 초과 시 자동 플러시 |

---

## 전체 흐름

```
Slot Resolution → Enable Gate → Load → Register (전용 API) → Lazy Init → Runtime
                                                                  │
                                              ┌──────────────────┼──────────────────┐
                                              ▼                  ▼                  ▼
                                        Prompt Injection    Tool Execution    Memory Flush
                                        (시스템 프롬프트)    (검색/저장)       (컴팩션 전)
```

---

## 1. Exclusive Slot Resolution

**파일**: `src/plugins/config-state.ts` — `resolveMemorySlotDecision()`

Memory 플러그인은 **exclusive slot**으로 관리됩니다. 한 번에 하나만 활성화 가능합니다.

### 설정

```json
{
  "plugins": {
    "slots": {
      "memory": "my-plugin"
    }
  }
}
```

- `"my-plugin"` → 해당 플러그인 활성화, 다른 memory 플러그인 비활성화
- `"none"` → 모든 memory 플러그인 비활성화
- 미설정 → 기본값 `"memory-core"` 사용

### 결정 로직

```
plugins.slots.memory 값 확인
    │
    ├─ null ("none") ──────────── → 비활성화 (dual-kind가 아닌 경우)
    │
    ├─ 내 ID와 일치 ───────────── → 선택됨 (selected: true)
    │
    └─ 다른 ID ────────────────── → 비활성화 (dual-kind가 아닌 경우)
```

### Slot 선택 시 부수효과

**파일**: `src/plugins/slots.ts` — `applyExclusiveSlotSelection()`

```
my-plugin 이 memory slot 에 선택되면:
  1. plugins.slots.memory = "my-plugin" 설정
  2. 경쟁 플러그인 (예: memory-core) 자동 비활성화
  3. 경쟁 플러그인이 dual-kind 인 경우 다른 역할은 유지
```

---

## 2. Dual-Kind Gating

**파일**: `src/plugins/registry.ts`

플러그인이 `kind: ["memory", "context-engine"]` 처럼 **복수 kind**를 가진 경우의 특수 처리입니다.

- memory slot에 선택되지 않으면 → **memory 전용 등록만 차단**
- 다른 kind(context-engine) 기능은 정상 동작
- 단일 kind (`kind: "memory"`) 플러그인은 이 게이트 없이 항상 등록

차단되는 등록 API 4종:
1. `registerMemoryPromptSection()`
2. `registerMemoryFlushPlan()`
3. `registerMemoryRuntime()`
4. `registerMemoryEmbeddingProvider()`

---

## 3. Memory 전용 등록 API

**파일**: `src/plugins/api-builder.ts`, `src/plugins/memory-state.ts`

### registerMemoryRuntime(runtime)

메모리 백엔드 런타임을 등록합니다. **프로세스 전역 싱글턴**에 저장됩니다.

```typescript
api.registerMemoryRuntime({
  // 메모리 검색 매니저를 반환
  async getMemorySearchManager(params: {
    cfg: OpenClawConfig;
    agentId: string;
    purpose?: "default" | "status";
  }): Promise<{ manager: MemorySearchManager | null; error?: string }>,

  // 메모리 백엔드 설정 해석
  resolveMemoryBackendConfig(params: {
    cfg: OpenClawConfig;
    agentId: string;
  }): MemoryRuntimeBackendConfig,

  // 종료 시 정리
  closeAllMemorySearchManagers?(): Promise<void>,
});
```

### registerMemoryPromptSection(builder)

에이전트 시스템 프롬프트에 주입될 메모리 안내 섹션을 생성하는 함수를 등록합니다.

```typescript
api.registerMemoryPromptSection((params: {
  availableTools: Set<string>;   // 현재 활성화된 도구 목록
  citationsMode?: string;        // 인용 모드 (on/off)
}) => string[]);                  // 프롬프트에 추가할 라인 배열
```

### registerMemoryFlushPlan(builder)

컴팩션 전 메모리 플러시 계획을 생성하는 함수를 등록합니다.

```typescript
api.registerMemoryFlushPlan((params: {
  cfg?: OpenClawConfig;
  nowMs?: number;
}) => MemoryFlushPlan | null);
```

`MemoryFlushPlan` 구조:
```typescript
{
  softThresholdTokens: number;        // 소프트 트리거 토큰 수 (기본 4,000)
  forceFlushTranscriptBytes: number;  // 강제 트리거 바이트 (기본 2MB)
  reserveTokensFloor: number;         // 컨텍스트 윈도우 예약 (기본 20,000)
  prompt: string;                     // 플러시 턴 프롬프트
  systemPrompt: string;               // 플러시 턴 시스템 프롬프트
  relativePath: string;               // 저장 경로 (예: memory/2026-04-02.md)
}
```

### registerMemoryEmbeddingProvider(adapter)

커스텀 임베딩 프로바이더를 등록합니다. `Symbol.for("openclaw.memoryEmbeddingProviders")`에 전역 저장됩니다.

```typescript
api.registerMemoryEmbeddingProvider({
  id: string;                     // 프로바이더 ID
  defaultModel?: string;          // 기본 모델
  transport?: "local" | "remote"; // 로컬/원격
  autoSelectPriority?: number;    // 자동 선택 우선순위
  async create(options): Promise<EmbeddingProviderResult>;
  formatSetupError?(err): string;
  shouldContinueAutoSelection?(err): boolean;
});
```

---

## 4. Lazy Initialization (지연 초기화)

**파일**: `src/plugins/memory-runtime.ts`

Memory 플러그인은 **처음 접근할 때** 로드됩니다. 게이트웨이 시작 시 즉시 로드되지 않습니다.

```
게이트웨이 시작
    │
    ▼
에이전트가 memory_search 호출 ←── 이 시점에 처음 로드
    │
    ▼
ensureMemoryRuntime()
    ├─ getMemoryRuntime() → 이미 있으면 반환
    └─ 없으면 → 플러그인 로딩 트리거 → memory runtime 등록 → 반환
```

---

## 5. 시스템 프롬프트 주입

**파일**: `src/agents/system-prompt.ts`

등록된 `MemoryPromptSectionBuilder`가 에이전트 시스템 프롬프트에 자동 주입됩니다.

### 주입 흐름

```
시스템 프롬프트 빌드
    │
    ▼
buildMemorySection()
    ├─ isMinimal? → 빈 배열 (최소 모드에서는 제외)
    └─ buildMemoryPromptSection({availableTools, citationsMode})
         │
         ▼
    등록된 promptBuilder 함수 호출
         │
         ▼
    반환된 라인들이 시스템 프롬프트에 삽입
```

### 주입 결과 예시

```
## Memory Recall
Use my_memory_search to recall prior context, decisions, and preferences
before answering related questions.
Use my_memory_store to save important information for future recall.
```

---

## 6. Tool 실행 흐름

에이전트가 메모리 도구를 호출할 때의 전체 흐름입니다.

### memory_search 흐름

```
에이전트 → memory_search(query: "지난 회의 내용") 호출
    │
    ▼
Tool execute() 실행
    │
    ▼
getMemoryManagerContext({cfg, agentId})
    │
    ▼
memoryRuntime.getMemorySearchManager()
    │
    ▼
manager.search(query, {maxResults, minScore, sessionKey})
    ├─ 벡터 검색 (임베딩 유사도)
    ├─ 키워드 검색 (BM25/FTS5)
    └─ 하이브리드 병합 + MMR + Temporal Decay
    │
    ▼
결과 가공 (citations, clamping)
    │
    ▼
JSON 결과 → 에이전트에게 반환
```

### 백엔드 종류

| 백엔드 | 설명 |
|--------|------|
| `builtin` | 파일 기반 FTS + 벡터 검색 (SQLite) |
| `qmd` | QuantumDB 메모리 데몬 (하이브리드 검색) |

---

## 7. Memory Flush (컴팩션 연동)

**파일**: `src/auto-reply/reply/agent-runner-memory.ts`

컨텍스트 윈도우가 가득 차기 전에 중요한 정보를 디스크에 자동 저장하는 메커니즘입니다.

### 트리거 조건

```
컨텍스트 토큰 수 확인
    │
    ├─ tokenCount > (contextWindow - reserveFloor - softThreshold)
    │   → 소프트 플러시 트리거
    │
    └─ transcriptBytes > forceFlushTranscriptBytes (2MB)
        → 강제 플러시 트리거
```

기본값:
- 소프트 임계치: **4,000 토큰**
- 예약 토큰: **20,000 토큰**
- 강제 트리거: **2MB** 트랜스크립트

### 플러시 실행 흐름

```
shouldRunMemoryFlush() → true
    │
    ▼
runMemoryFlushIfNeeded()
    │
    ▼
runEmbeddedPiAgent({
  trigger: "memory",
  prompt: "Pre-compaction memory flush...",
  memoryFlushWritePath: "memory/2026-04-02.md",
  silentExpected: true
})
    │
    ▼
에이전트가 대화 내용을 분석하여 중요 정보 추출
    │
    ▼
memory/2026-04-02.md 에 기록
    │
    ├─ 파일 없으면 생성
    └─ 파일 있으면 APPEND (기존 내용 보존)
```

### 안전 장치

- `MEMORY.md`, `SOUL.md`, `AGENTS.md` 등 부트스트랩 파일은 **읽기 전용**
- 날짜별 파일명 사용 (`memory/YYYY-MM-DD.md`)
- 타임스탬프 변형 파일 생성 금지 (예: `2026-04-02-1430.md` 불가)
- 저장할 내용이 없으면 `SILENT_REPLY_TOKEN`으로 응답

---

## 8. State 관리 & Snapshot Safety

**파일**: `src/plugins/loader.ts`

Memory 플러그인은 프로세스 전역 상태를 사용하므로 snapshot 로드 시 특별한 처리가 필요합니다.

### Snapshot 로드 시

```
1. 현재 메모리 상태 백업
   ├─ embeddingProviders
   ├─ flushPlanResolver
   ├─ promptBuilder
   └─ runtime

2. 플러그인 register(api) 실행

3. 활성화 모드가 아니면 (shouldActivate === false)
   → 백업한 상태로 복원
   → 전역 상태 오염 방지
```

---

## 9. 설정 구조

### 슬롯 설정

```json
{
  "plugins": {
    "slots": {
      "memory": "my-plugin"
    }
  }
}
```

### 플러시 설정

```json
{
  "agents": {
    "defaults": {
      "compaction": {
        "memoryFlush": {
          "enabled": true,
          "softThresholdTokens": 4000,
          "forceFlushTranscriptBytes": "2MB",
          "prompt": "Pre-compaction memory flush...",
          "systemPrompt": "..."
        },
        "reserveTokensFloor": 20000
      }
    }
  }
}
```

### 플러그인별 설정

```json
{
  "plugins": {
    "entries": {
      "my-plugin": {
        "config": {
          "backend": "file"
        }
      }
    }
  }
}
```

---

## 10. 커스텀 메모리 플러그인 구현 시 필수 사항

기존 `memory-core`를 대체하려면 다음을 등록해야 합니다:

| 등록 API | 필수 | 역할 |
|----------|------|------|
| `registerMemoryRuntime()` | **필수** | 검색 매니저 + 백엔드 설정 |
| `registerMemoryPromptSection()` | **필수** | 시스템 프롬프트에 사용법 안내 |
| `registerMemoryFlushPlan()` | 권장 | 컴팩션 연동 자동 저장 |
| `registerMemoryEmbeddingProvider()` | 선택 | 커스텀 임베딩 프로바이더 |
| `registerTool()` (검색 도구) | **필수** | 에이전트가 호출할 도구 |
| `registerCli()` | 선택 | CLI 명령어 |

### 최소 구현 체크리스트

```
[ ] openclaw.plugin.json 에 kind: "memory" 설정
[ ] registerMemoryRuntime() — getMemorySearchManager 구현
[ ] registerMemoryPromptSection() — 도구 사용 안내
[ ] registerTool() — 검색/저장 도구 등록
[ ] config 에서 plugins.slots.memory 를 내 플러그인 ID로 설정
```

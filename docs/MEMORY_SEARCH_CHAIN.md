# memory_search 호출 체인 쉬운 설명서

## 한 줄 요약

> AI가 "이전에 뭐 얘기했지?" 할 때 호출하는 도구이며,
> **도구 실행 → 매니저 획득 → 검색 엔진 실행 → 결과 가공** 순으로 동작합니다.

---

## 비유로 이해하기

```
AI: "지난 회의 내용 찾아줘"

    ↓  (1) 도서관 사서에게 요청
    ↓  (2) 사서가 어떤 서고를 쓸지 결정
    ↓  (3) 서고에서 책을 찾음
    ↓  (4) 찾은 페이지에 출처 메모를 붙임

AI: "찾았습니다! 3월 15일 회의에서..."
```

| 비유 | 실제 코드 | 파일 |
|------|----------|------|
| 사서에게 요청 | `createMemorySearchTool` | `tools.ts` |
| 어떤 서고 쓸지 결정 | `getMemorySearchManager` | `search-manager.ts` |
| 책 찾기 | `manager.search()` | `manager.ts` |
| 출처 메모 붙이기 | `decorateCitations()` | `tools.citations.ts` |

---

## 단계별 상세 설명

### 1단계: AI가 도구를 호출

**파일**: `tools.ts` — `createMemorySearchTool()`

AI가 대화 중에 과거 기억이 필요하다고 판단하면 `memory_search` 도구를 호출합니다.

```
AI의 판단: "사용자가 '지난번에 뭐라 했지?' 라고 물었네"
         → memory_search({ query: "지난번 대화", maxResults: 5 })
```

이때 넘기는 파라미터:

| 파라미터 | 뜻 | 예시 |
|---------|-----|------|
| `query` | 무엇을 찾을지 | `"지난 회의 내용"` |
| `maxResults` | 최대 몇 개 | `5` |
| `minScore` | 최소 유사도 | `0.3` |

---

### 2단계: 설정 확인 및 매니저 준비

**파일**: `tools.shared.ts`

도구가 실행되기 전에 **"메모리 검색을 할 수 있는 상태인지"** 확인합니다.

```
resolveMemoryToolContext()
  ├─ config 있어?        → 없으면 도구 비활성 (null)
  ├─ agentId 뭐야?       → 세션키에서 추출
  └─ 메모리 검색 설정 켜져있어? → 꺼져있으면 도구 비활성 (null)
```

설정이 유효하면 **메모리 매니저**를 가져옵니다:

```
getMemoryManagerContext()
  └─ tools.runtime.ts 를 lazy import (처음 호출 시만 로드)
     └─ getMemorySearchManager() 호출
        └─ 매니저 반환 또는 에러
```

매니저를 못 가져오면 에이전트에게 **"메모리 검색 불가"** 메시지를 반환합니다:

```json
{
  "results": [],
  "disabled": true,
  "warning": "Memory search is unavailable due to an embedding/provider error.",
  "action": "Check embedding provider configuration and retry memory_search."
}
```

---

### 3단계: 검색 엔진 선택

**파일**: `search-manager.ts` — `getMemorySearchManager()`

어떤 검색 엔진(서고)을 사용할지 결정합니다. 두 가지 백엔드가 있습니다:

```
설정 확인
  │
  ├─ QMD 백엔드 설정이 있다면:
  │   │
  │   ├─ qmd 바이너리 사용 가능?
  │   │   ├─ YES → QmdMemoryManager 생성
  │   │   │        (외부 프로세스로 검색)
  │   │   │
  │   │   │        + FallbackMemoryManager로 감싸기
  │   │   │        (QMD 실패 시 자동으로 builtin으로 전환)
  │   │   │
  │   │   └─ NO → builtin으로 폴백
  │   │
  │   └─ QMD 생성 실패 → builtin으로 폴백
  │
  └─ builtin 백엔드 (기본):
      └─ MemoryIndexManager (SQLite 기반)
```

#### 두 백엔드 비교

| | QMD (QuantumDB) | Builtin |
|--|-----------------|---------|
| **동작 방식** | 외부 바이너리 프로세스 | 내장 SQLite |
| **장점** | 고급 검색 기능 | 의존성 없음, 항상 동작 |
| **폴백** | 실패 시 builtin으로 자동 전환 | - |
| **캐싱** | 매니저 인스턴스 캐시 | 인덱스 캐시 |

#### 폴백 매니저가 하는 일

```
FallbackMemoryManager:
  검색 요청이 오면
    ├─ QMD로 시도
    │   ├─ 성공 → 결과 반환
    │   └─ 실패 → primaryFailed = true 로 표시
    │             QMD 매니저 닫기
    │             캐시에서 제거
    │
    └─ builtin으로 재시도
        └─ MemoryIndexManager로 검색
```

한 번 QMD가 실패하면 **이후 요청은 바로 builtin으로** 갑니다.
(매번 QMD 시도 → 실패 → 폴백 하는 비효율 방지)

---

### 4단계: 실제 검색 실행

**파일**: `manager.ts` — `MemoryIndexManager`

builtin 백엔드의 검색 과정입니다. **두 가지 방식을 섞어서** 검색합니다:

```
manager.search("지난 회의 내용")
  │
  ├─ 벡터 검색 (의미 기반)
  │   "회의"와 비슷한 의미의 텍스트를 찾음
  │   예: "미팅", "회의록", "논의사항" 도 매칭
  │   → 임베딩 유사도 점수로 순위
  │
  ├─ 키워드 검색 (텍스트 매칭)
  │   "회의" "내용" 단어가 포함된 텍스트를 찾음
  │   → BM25 점수로 순위 (FTS5 전문 검색)
  │
  └─ 하이브리드 병합
      두 결과를 가중치로 합산
        │
        ├─ MMR 적용 (다양성 보장)
        │   비슷한 결과끼리 중복 제거
        │   예: 같은 회의 내용의 여러 조각 → 대표 1개만
        │
        └─ Temporal Decay 적용 (시간 가중치)
            최근 메모리에 높은 점수
            예: 3월 회의 > 1월 회의
```

#### 검색 대상 파일

```
~/.openclaw/agents/<agentId>/workspace/
  ├── MEMORY.md          ← 메모리 인덱스
  └── memory/
      ├── 2026-03-15.md  ← 날짜별 메모리 파일
      ├── 2026-03-20.md
      └── 2026-04-02.md
```

이 파일들이 **SQLite DB에 인덱싱**되어 있고,
파일이 변경되면 **Chokidar 와처**가 감지하여 자동 리인덱스합니다.

---

### 5단계: 결과 가공

**파일**: `tools.citations.ts`

검색 결과를 AI에게 돌려주기 전에 **인용 정보를 추가**합니다.

#### 인용 모드 결정

```
resolveMemoryCitationsMode(config)
  ├─ "on"   → 항상 인용 표시
  ├─ "off"  → 인용 표시 안 함
  └─ "auto" → 채팅 유형에 따라 자동 결정
                ├─ DM(1:1 대화)   → 인용 표시
                ├─ 그룹 채팅      → 인용 표시 안 함
                └─ 채널           → 인용 표시 안 함
```

#### 인용 데코레이션

```
원본 결과:
  { snippet: "3월 15일 회의에서 DB 마이그레이션 논의", path: "memory/2026-03-15.md" }

인용 추가 후:
  { snippet: "3월 15일 회의에서 DB 마이그레이션 논의\n\nSource: memory/2026-03-15.md#L10-L15" }
```

#### 글자 수 제한 (QMD 백엔드만)

```
clampResultsByInjectedChars(results, budget)

  budget = 5000자 라면:
    결과 1: 2000자 → 누적 2000 ✅ 포함
    결과 2: 1500자 → 누적 3500 ✅ 포함
    결과 3: 2000자 → 누적 5500 ❌ 5000자까지만 잘라서 포함
    결과 4: 1000자 → 포함 안 됨
```

---

### 6단계: AI에게 결과 반환

최종적으로 이런 JSON이 AI에게 전달됩니다:

```json
{
  "results": [
    {
      "path": "memory/2026-03-15.md",
      "startLine": 10,
      "endLine": 15,
      "snippet": "3월 15일 회의에서 DB 마이그레이션 논의...\n\nSource: memory/2026-03-15.md#L10-L15",
      "score": 0.85
    },
    {
      "path": "memory/2026-04-02.md",
      "startLine": 3,
      "endLine": 8,
      "snippet": "프로젝트 일정 재조정 합의...\n\nSource: memory/2026-04-02.md#L3-L8",
      "score": 0.72
    }
  ],
  "provider": "openai",
  "model": "text-embedding-3-small",
  "fallback": false,
  "citations": "auto",
  "mode": "hybrid"
}
```

AI는 이 결과를 보고 사용자에게 답변합니다:

```
AI: "지난 3월 15일 회의에서 DB 마이그레이션을 논의했고,
     4월 2일에 프로젝트 일정을 재조정하기로 합의했습니다."
```

---

## 전체 흐름 한눈에 보기

```
사용자: "지난번 회의 뭐 했지?"
    │
    ▼
AI 판단: "과거 기억이 필요하다"
    │
    ▼
memory_search({ query: "회의 내용" }) 호출
    │
    ▼
[1] tools.ts ─── 도구 실행 시작
    │
    ▼
[2] tools.shared.ts ─── 설정 확인 + 매니저 준비
    │                     config OK? agentId 추출
    │
    ▼
[3] search-manager.ts ─── 검색 엔진 선택
    │                       QMD or Builtin?
    │                       (폴백 안전장치 포함)
    │
    ▼
[4] manager.ts ─── 실제 검색 실행
    │               벡터 검색 + 키워드 검색
    │               → 하이브리드 병합
    │               → MMR (중복 제거)
    │               → Temporal Decay (최신 우선)
    │
    ▼
[5] tools.citations.ts ─── 결과 가공
    │                       인용 추가 + 글자 수 제한
    │
    ▼
[6] JSON 결과 → AI에게 반환
    │
    ▼
AI: "3월 15일 회의에서..."
```

---

## 관련 파일 위치 (원본 memory-core)

```
extensions/memory-core/src/
├── tools.ts              [1] 도구 정의 (memory_search, memory_get)
├── tools.shared.ts       [2] 공통 헬퍼 (설정 확인, 매니저 획득)
├── tools.runtime.ts      [2] 런타임 로더 (lazy import)
├── tools.citations.ts    [5] 인용 처리
└── memory/
    ├── search-manager.ts [3] 검색 엔진 선택 (QMD vs Builtin)
    ├── manager.ts        [4] MemoryIndexManager (SQLite 인덱스)
    ├── manager-search.ts [4] 벡터/키워드 검색 실행
    ├── hybrid.ts         [4] 하이브리드 병합
    ├── mmr.ts            [4] MMR (다양성 보장)
    ├── temporal-decay.ts [4] 시간 가중치 감쇠
    ├── embeddings.ts     [4] 임베딩 프로바이더 관리
    └── index.ts              모듈 배럴
```

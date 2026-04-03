# 프로젝트 분석: @openclaw/my-plugin

## 개요

**OpenClaw 플랫폼용 세션 스코프 메모리 관리 플러그인**입니다. AI 에이전트가 대화 중 기억을 저장/검색/조회할 수 있게 해주며, 세션별 격리와 공유 메모리를 모두 지원합니다.

---

## 아키텍처

```
index.ts (플러그인 엔트리)
├── src/tools.ts          ← 3개 도구 정의 (search, get, save)
├── src/prompt-section.ts ← AI 프롬프트에 메모리 사용법 주입
├── src/flush-plan.ts     ← 컨텍스트 윈도우 가득 찰 때 자동 플러시
├── src/runtime.ts        ← 메모리 런타임 (검색 매니저 라이프사이클)
├── src/session-path.ts   ← sessionKey 파싱 → 세션별 디렉토리 경로
├── src/storage.ts        ← 파일 기반 마크다운 저장/파싱
├── src/cli.ts            ← CLI 서브커맨드 (memory search/inspect/reindex)
└── src/memory/           ← 검색 엔진 코어
    ├── manager.ts        ← MemoryIndexManager (SQLite + 벡터 + FTS)
    ├── hybrid.ts         ← 하이브리드 검색 (벡터 + BM25)
    ├── embeddings.ts     ← 임베딩 프로바이더
    ├── mmr.ts            ← MMR 다양성 재랭킹
    ├── temporal-decay.ts ← 시간 감쇠 스코어링
    └── provider-adapters.ts ← 빌트인 임베딩 프로바이더 등록
```

---

## 핵심 기능

### 1. 3개 도구 (Tools)

| 도구 | 역할 |
|---|---|
| `memory_search` | 시맨틱 검색 (벡터 + FTS 하이브리드), scope 필터링 |
| `memory_get` | 특정 파일의 스니펫 읽기 (라인 범위 지정) |
| `memory_save` | 메모리 저장 (마크다운 append, 세션/공유 선택) |

### 2. 세션 격리

- `sessionKey` 파싱으로 채널별 분리 (Telegram DM, Discord 채널 등)
- `scope`: `session` (현재 대화만), `shared` (전체 공유), `all` (현재 세션 + 공유)
- 저장 경로: `memory/sessions/<session-dir>/YYYY-MM-DD.md` vs `memory/YYYY-MM-DD.md`

### 3. 검색 엔진 (`MemoryIndexManager`)

- SQLite 기반 인덱싱 (벡터 테이블 + FTS5)
- 하이브리드 검색: 벡터 유사도 + BM25 키워드 매칭
- MMR 재랭킹, 시간 감쇠, 임베딩 캐시
- FTS-only 폴백 (임베딩 프로바이더 없을 때)
- readonly DB 자동 복구

### 4. 메모리 플러시

- 컨텍스트 윈도우 임계치 도달 시 자동으로 중요 내용 저장
- 소프트 임계치 (4K 토큰) + 강제 임계치 (2MB)
- 안전 장치: 부트스트랩 파일 보호, append-only, `memory_save` 강제

### 5. 보안 훅

- `before_tool_call`로 `write`/`edit` → `memory/` 경로 차단
- `memory_save` 사용을 강제하여 세션 스코핑 우회 방지

---

## 기술 스택

- **런타임**: OpenClaw Plugin SDK (`>=2026.4.1`)
- **스키마**: `@sinclair/typebox`
- **스토리지**: 파일시스템 (마크다운) + SQLite (인덱스)
- **검색**: 벡터 임베딩 + FTS5 하이브리드
- **언어**: TypeScript (ESM)

---

## 주요 파일 설명

### 엔트리포인트 (`index.ts`)

플러그인 등록 진입점. `definePluginEntry`로 다음을 등록:
- 임베딩 프로바이더
- 프롬프트 섹션 빌더
- 메모리 플러시 플랜
- 메모리 런타임
- 3개 도구 (memory_search, memory_get, memory_save)
- before_tool_call 훅 (write/edit 차단)
- CLI 서브커맨드

### 도구 정의 (`src/tools.ts`)

3개 MCP 도구의 스키마와 실행 로직:
- **memory_search**: scope 기반 pathFilter로 세션 격리, 하이브리드 검색 실행
- **memory_get**: 파일 스니펫 읽기 (builtin/qmd 백엔드 분기)
- **memory_save**: `appendMemoryToFile`로 마크다운 append 저장

### 세션 경로 (`src/session-path.ts`)

sessionKey 파싱 로직:
- `"agent:main:telegram:dm:12345"` → `sessions/telegram-dm-12345/`
- `"agent:main:main"` → 공유 메모리 (null)

### 스토리지 (`src/storage.ts`)

파일 기반 마크다운 저장:
- `## key (timestamp)` 형식으로 append
- 재귀적 .md 파일 탐색 및 파싱
- 태그 지원 (`> tags: tag1, tag2`)

### 플러시 플랜 (`src/flush-plan.ts`)

컴팩션 전 자동 메모리 저장:
- 소프트/강제 임계치 설정
- 3가지 안전 장치 힌트 강제 주입
- 타임존 인식 날짜 스탬프

### 검색 매니저 (`src/memory/manager.ts`)

`MemoryIndexManager` 클래스:
- 싱글톤 캐시 패턴 (`INDEX_CACHE`)
- 하이브리드 검색 (벡터 + FTS + MMR + 시간 감쇠)
- 파일 워처 + 인터벌 싱크
- readonly DB 에러 자동 복구
- 임베딩 프로바이더 지연 초기화

---

## 데이터 흐름

```
[사용자 대화]
    │
    ▼
[memory_save 호출]
    │
    ├─ scope=session → memory/sessions/<session>/YYYY-MM-DD.md
    └─ scope=shared  → memory/YYYY-MM-DD.md
    │
    ▼
[MemoryIndexManager.sync()]
    │
    ├─ 마크다운 파싱 → 청크 분할
    ├─ 임베딩 생성 → 벡터 테이블 저장
    └─ FTS 인덱싱 → FTS5 테이블 저장
    │
    ▼
[memory_search 호출]
    │
    ├─ pathFilter로 세션 범위 제한
    ├─ 벡터 검색 + BM25 키워드 검색
    ├─ 하이브리드 병합 + MMR 재랭킹
    └─ 시간 감쇠 적용 → 결과 반환
```

---

## 특이사항

- `openclaw/plugin-sdk`의 여러 서브패키지에 깊게 의존 (`memory-core`, `memory-core-host-*`)
- `memory-core` 엔진을 fork하여 세션 스코핑 레이어를 얹은 구조
- 문서가 잘 정리되어 있음 (`docs/` 디렉토리에 7개 가이드)
- 테스트 파일은 보이지 않음 — 테스트 커버리지 추가가 필요해 보임

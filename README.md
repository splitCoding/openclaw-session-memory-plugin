# @openclaw/my-plugin

OpenClaw 플랫폼용 세션 스코프 메모리 관리 플러그인. AI 에이전트가 대화 중 기억을 저장/검색/조회할 수 있으며, 세션별 격리와 공유 메모리를 모두 지원합니다.

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

### 1. 도구 (Tools)

| 도구 | 역할 |
|---|---|
| `memory_search` | 시맨틱 검색 (벡터 + FTS 하이브리드), scope 필터링 |
| `memory_get` | 특정 파일의 스니펫 읽기 (라인 범위 지정) |
| `memory_save` | 메모리 저장 (마크다운 append, 세션/공유 선택) |

### 2. 세션 격리

- `sessionKey` 파싱으로 채널별 분리 (Slack 스레드, Telegram DM, Discord 채널 등)
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

### 5. 도구 접근 제어 (`before_tool_call` 훅)

Whitelist 기반 2중 보안 구조:

**OpenClaw 설정 레벨 (`openclaw.json`):**
- `tools.allow` — 허용 도구 종류 제한
- `tools.fs.workspaceOnly` — read/write/edit 경로를 workspace로 제한

**플러그인 훅 레벨 (`before_tool_call`):**
- 허용 도구 whitelist: `read`, `exec`, `web_fetch`, `web_search`, `memory_search`, `memory_get`, `memory_save`
- `.openclaw` 설정 디렉토리 접근 차단 (read/exec 모두, 스킬 경로 제외)
- exec inline eval 차단 (`bash -c`, `python -c`, `node -e` 등)
- exec는 스킬 경로 + 안전한 읽기 전용 명령(`echo`, `date`, `which`, `memo`, `wttr`)만 허용
- 비허용 도구 (write, edit, cron, sessions_*, subagents, process 등) 전면 차단

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

## 기술 스택

- **런타임**: OpenClaw Plugin SDK (`>=2026.4.1`)
- **스키마**: `@sinclair/typebox`
- **스토리지**: 파일시스템 (마크다운) + SQLite (인덱스)
- **검색**: 벡터 임베딩 + FTS5 하이브리드
- **언어**: TypeScript (ESM)

---

## 설치

`openclaw.json`에 플러그인 경로 추가:

```json
{
  "plugins": {
    "load": {
      "paths": ["/path/to/my-plugin"]
    },
    "slots": {
      "memory": "my-plugin"
    }
  }
}
```

---

## 관련 문서

- [메모리 플러그인 가이드](docs/MEMORY_PLUGIN_EASY_GUIDE.md)
- [플러그인 라이프사이클](docs/PLUGIN_LIFECYCLE.md)
- [메모리 라이프사이클](docs/MEMORY_PLUGIN_LIFECYCLE.md)
- [검색 체인](docs/MEMORY_SEARCH_CHAIN.md)
- [컴팩션 가이드](docs/COMPACTION_GUIDE.md)
- [멀티 에이전트 가이드](docs/MULTI_AGENT_GUIDE.md)
- [도구 등록 트러블슈팅](docs/TOOL_REGISTRATION_TROUBLESHOOT.md)

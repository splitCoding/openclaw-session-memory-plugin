# OpenClaw Plugin Lifecycle

전체 흐름은 7단계입니다:

```
Discovery → Manifest 검증 → Enable 결정 → Module 로딩 → Registration → Activation → Runtime
```

---

## 1. Discovery (플러그인 탐색)

**파일**: `src/plugins/discovery.ts` — `discoverOpenClawPlugins()`

4가지 소스를 우선순위 순으로 스캔합니다:

| 우선순위 | 소스 | 설명 |
|---------|------|------|
| 1 | config | 사용자가 config에 명시한 경로 |
| 2 | workspace | 워크스페이스 플러그인 |
| 3 | bundled | 레포 내 번들 플러그인 (`extensions/`) |
| 4 | global | 전역 설치된 플러그인 |

- 각 디렉토리를 재귀 스캔하여 `openclaw.plugin.json`이 있는 패키지를 찾음
- **보안 검사**: world-writable 경로 차단, symlink 탈출 방지, 소유권 검증
- 결과를 **1초 인메모리 캐시**에 저장

---

## 2. Manifest 검증

**파일**: `src/plugins/manifest.ts` — `loadPluginManifest()`

`openclaw.plugin.json`을 파싱하고 검증합니다. **코드를 실행하지 않고** 메타데이터만으로 판단하는 "manifest-first" 원칙입니다.

```json
{
  "id": "my-plugin",
  "kind": "memory",
  "configSchema": { ... },
  "enabledByDefault": true,
  "providers": [...],
  "channels": [...]
}
```

- `package.json`의 `openclaw` 필드도 함께 병합
- 호환성 버전, 엔트리포인트 경로 확인

---

## 3. Enable 결정

**파일**: `src/plugins/config-state.ts` — `resolvePluginActivationState()`

플러그인을 로드할지 말지 결정하는 단계입니다:

```
plugins.enabled === false?          → 전부 비활성
plugins.deny 목록에 있음?            → 비활성
plugins.allow 목록에 없음?           → 비활성 (번들 기본값 제외)
memory 슬롯 충돌?                   → 하나만 활성 (exclusive slot)
enabledByDefault: true?             → 활성
프로바이더 config 존재?              → 자동 활성
```

- **메모리 플러그인은 exclusive slot** — 한 번에 하나만 활성화 가능
- `resolveMemorySlotDecision()`이 어떤 메모리 플러그인을 쓸지 결정

---

## 4. Module 로딩

**파일**: `src/plugins/loader.ts` — `loadOpenClawPlugins()`

활성화된 플러그인만 실제 코드를 로드합니다:

1. **Jiti 로더 생성** — `createPluginJitiLoader()`로 동적 import
2. **SDK 임포트 라우팅** — `openclaw/plugin-sdk/*` 경로를 실제 모듈로 매핑
3. **모듈 export 추출** — `resolvePluginModuleExport()`로 default export에서 플러그인 정의 가져옴
4. **에러 격리** — 로딩 실패해도 다른 플러그인에 영향 없음

---

## 5. Registration (기능 등록)

**파일**: `src/plugins/api-builder.ts` — `buildPluginApi()`

플러그인의 `register(api)` 함수가 호출됩니다. `api` 객체로 기능을 등록:

```typescript
register(api) {
  api.registerTool(...)                        // 에이전트 도구
  api.registerProvider(...)                    // LLM 프로바이더
  api.registerChannel(...)                     // 메시징 채널
  api.registerHook(...)                        // 이벤트 훅
  api.registerMemoryRuntime(...)               // 메모리 런타임
  api.registerMemoryPromptSection(...)         // 프롬프트 섹션
  api.registerCli(...)                         // CLI 서브커맨드
  api.registerHttpRoute(...)                   // HTTP 라우트
  api.registerSpeechProvider(...)              // TTS/STT
  api.registerImageGenerationProvider(...)     // 이미지 생성
  api.registerWebSearchProvider(...)           // 웹 검색
}
```

등록된 모든 기능은 **중앙 레지스트리** (`src/plugins/registry.ts`)에 저장됩니다:

- 중복 프로바이더 ID 감지
- 플러그인 ID / kind 불일치 검증
- 메모리 슬롯 충돌 검사

---

## 6. Activation (활성화)

**파일**: `src/plugins/loader.ts` — `activatePluginRegistry()`

레지스트리를 글로벌로 등록하고 훅 시스템을 초기화합니다:

1. `setActivePluginRegistry()` — 레지스트리를 전역 싱글턴으로 설정
2. `initializeGlobalHookRunner()` — 훅 디스패처 생성
   - `Symbol.for("openclaw.plugins.hook-runner-global-state")`에 저장
   - 어디서든 `getGlobalHookRunner()`로 접근 가능

---

## 7. Runtime (런타임 실행)

활성화 이후 플러그인 기능이 실제로 사용됩니다:

| 등록한 기능 | 런타임 동작 |
|------------|-----------|
| Tool | LLM 도구 카탈로그에 노출, 에이전트가 호출 |
| Provider | 모델 선택 시 프로바이더 카탈로그에서 매칭 |
| Channel | 메시지 수신/발신 처리 |
| Hook | 라이프사이클 이벤트 발생 시 디스패치 |
| Memory | 컴팩션 전 플러시, 메모리 검색/저장 |
| CLI | `openclaw <subcommand>` 실행 시 동작 |
| HTTP Route | 게이트웨이 HTTP 요청 시 라우팅 |

---

## 전체 흐름 다이어그램

```
[Startup]
    │
    ▼
Discovery ─── 디렉토리 스캔, openclaw.plugin.json 탐지
    │          보안 검사 (경로, 소유권)
    ▼
Manifest ──── JSON 파싱, 스키마 검증
    │          코드 실행 없이 메타데이터만 확인
    ▼
Enable ────── config 기반 활성화 결정
    │          allowlist/denylist, exclusive slot
    ▼
Load ──────── Jiti 동적 import
    │          SDK 경로 라우팅, 에러 격리
    ▼
Register ──── register(api) 호출
    │          도구/프로바이더/채널/훅 등록 → 중앙 레지스트리
    ▼
Activate ──── 글로벌 레지스트리 설정
    │          훅 러너 초기화
    ▼
Runtime ───── 에이전트 도구 호출, 훅 디스패치
              채널 메시지 처리, 프로바이더 추론
```

---

## 주요 파일 참조

| 단계 | 파일 | 주요 함수 |
|------|------|----------|
| Discovery | `src/plugins/discovery.ts` | `discoverOpenClawPlugins()`, `discoverInDirectory()` |
| Manifest | `src/plugins/manifest.ts` | `loadPluginManifest()`, `loadPluginManifestRegistry()` |
| Enable | `src/plugins/config-state.ts` | `resolvePluginActivationState()`, `resolveMemorySlotDecision()` |
| Loading | `src/plugins/loader.ts` | `loadOpenClawPlugins()`, `createPluginJitiLoader()` |
| API Build | `src/plugins/api-builder.ts` | `buildPluginApi()` |
| Registry | `src/plugins/registry.ts` | `createPluginRegistry()` |
| Activation | `src/plugins/hook-runner-global.ts` | `initializeGlobalHookRunner()` |
| Entry Helper | `src/plugin-sdk/plugin-entry.ts` | `definePluginEntry()` |

---

## Memory Plugin 참고사항

`my-plugin`은 `kind: "memory"`이므로:

- Enable 단계에서 **exclusive slot 경쟁**을 거침 (메모리 플러그인은 하나만 활성)
- 기존 `memory-core`를 대체하여 활성화됨
- `api.registerMemoryRuntime()`, `api.registerMemoryPromptSection()`으로 메모리 시스템 등록

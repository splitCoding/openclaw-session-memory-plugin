# 멀티 에이전트 vs 별도 게이트웨이 가이드

## 한 줄 요약

> AI를 여러 개 운영하는 방법은 두 가지:
> **하나의 게이트웨이에 에이전트를 여러 개** 두거나, **게이트웨이 자체를 여러 개** 실행하거나.

---

## 1. 두 방식의 차이

### A. 별도 게이트웨이

게이트웨이를 여러 프로세스로 각각 실행합니다.

```
[게이트웨이 1]  포트 18789         [게이트웨이 2]  포트 18790
├─ openclaw.json (설정 A)         ├─ openclaw.json (설정 B)
├─ 플러그인 설치                   ├─ 플러그인 설치
├─ API 키 설정                    ├─ API 키 설정
└─ main 에이전트                  └─ main 에이전트
   ├─ workspace/                     ├─ workspace/
   ├─ sessions/                      ├─ sessions/
   └─ memory/                        └─ memory/
```

### B. 멀티 에이전트

하나의 게이트웨이 안에 에이전트를 여러 개 만듭니다.

```
[게이트웨이 1]  포트 18789
├─ openclaw.json (설정 하나)
├─ 플러그인 설치 (한 번)
├─ API 키 설정 (한 번)
│
├─ main 에이전트
│   ├─ workspace/
│   ├─ sessions/
│   └─ memory/
│
├─ assistant 에이전트
│   ├─ workspace-assistant/
│   ├─ sessions/
│   └─ memory/
│
└─ coder 에이전트
    ├─ workspace-coder/
    ├─ sessions/
    └─ memory/
```

---

## 장단점 비교

| 항목 | A. 별도 게이트웨이 | B. 멀티 에이전트 |
|------|-------------------|-----------------|
| **설정 파일** | 게이트웨이마다 각각 | 하나로 통합 |
| **API 키** | 각각 설정 | 한 번만 설정 |
| **플러그인** | 각각 설치 | 한 번만 설치 |
| **메모리 플러그인** | 게이트웨이별로 다르게 가능 | 전역 1개 (모든 에이전트 동일) |
| **포트** | 여러 개 필요 | 1개 |
| **리소스 (메모리/CPU)** | 프로세스 N개 (N배 사용) | 프로세스 1개 |
| **관리 부담** | 높음 (업데이트 N번) | 낮음 |
| **장애 격리** | 하나 죽어도 나머지 정상 | 죽으면 전부 중단 |
| **채널 라우팅** | 채널당 봇 각각 필요 | 바인딩으로 유연한 라우팅 |
| **워크스페이스** | 완전 독립 | 완전 독립 |
| **세션** | 완전 독립 | 완전 독립 |
| **메모리** | 완전 독립 | 완전 독립 |

### 언제 뭘 쓸까?

**멀티 에이전트를 쓰세요:**
- 같은 API 키, 플러그인을 공유하면서 페르소나만 다르게 하고 싶을 때
- 관리를 간편하게 하고 싶을 때
- 하나의 채널에서 메시지를 라우팅하고 싶을 때
- 리소스가 제한적일 때

**별도 게이트웨이를 쓰세요:**
- 메모리 플러그인을 에이전트별로 다르게 쓰고 싶을 때
- 완전히 다른 설정(보안, 네트워크)이 필요할 때
- 장애 격리가 중요할 때
- 서로 다른 서버에서 운영할 때

---

## 2. 멀티 에이전트 세팅 방법

### Step 1: 에이전트 추가 (CLI)

```bash
# 위저드로 추가 (이름, workspace, 모델 등 대화형 설정)
openclaw agents add assistant
openclaw agents add coder

# 확인
openclaw agents list --bindings
```

### Step 2: 수동 설정 (openclaw.json)

`~/.openclaw/openclaw.json`을 직접 편집할 수도 있습니다:

```json5
{
  agents: {
    list: [
      {
        id: "assistant",
        name: "Assistant",
        workspace: "~/.openclaw/workspace-assistant",
        model: "anthropic/claude-sonnet-4-6",
      },
      {
        id: "coder",
        name: "Coder",
        workspace: "~/.openclaw/workspace-coder",
        model: "anthropic/claude-opus-4-6",
      },
    ],
  },
}
```

### Step 3: 채널 바인딩 (어떤 메시지를 어떤 에이전트에게?)

바인딩으로 메시지를 라우팅합니다:

```json5
{
  bindings: [
    // Telegram → assistant 에이전트
    { agentId: "assistant", match: { channel: "telegram" } },

    // Discord → coder 에이전트
    { agentId: "coder", match: { channel: "discord" } },

    // WhatsApp 특정 DM → coder 에이전트
    {
      agentId: "coder",
      match: {
        channel: "whatsapp",
        peer: { kind: "direct", id: "+821012345678" },
      },
    },

    // WhatsApp 나머지 → main 에이전트
    { agentId: "main", match: { channel: "whatsapp" } },
  ],
}
```

#### 라우팅 우선순위 (위에서 아래로)

```
1. peer 매칭 (특정 DM/그룹 ID)        ← 가장 구체적
2. parentPeer 매칭 (스레드 상속)
3. guildId + roles (Discord 역할)
4. guildId (Discord 서버)
5. teamId (Slack 팀)
6. accountId 매칭
7. channel 매칭                        ← 가장 넓음
8. 기본 에이전트 (fallback)
```

구체적인 규칙이 항상 이깁니다. peer 바인딩을 channel 바인딩보다 **위에** 놓으세요.

### Step 4: 재시작 및 확인

```bash
openclaw gateway restart
openclaw agents list --bindings
openclaw channels status --probe
```

---

## 에이전트별로 분리되는 것들

```
~/.openclaw/
├── workspace/                  ← main (기본 에이전트)
│   ├── AGENTS.md                  지침
│   ├── SOUL.md                    페르소나
│   ├── USER.md                    사용자 정보
│   ├── TOOLS.md                   도구 설정
│   ├── skills/                    스킬
│   └── memory/                    메모리
│       └── 2026-04-02.md
│
├── workspace-assistant/        ← assistant 에이전트
│   ├── AGENTS.md                  (별도 지침)
│   ├── SOUL.md                    (별도 페르소나)
│   └── memory/                    (별도 메모리)
│
├── workspace-coder/            ← coder 에이전트
│   ├── AGENTS.md                  (별도 지침)
│   ├── SOUL.md                    (별도 페르소나)
│   └── memory/                    (별도 메모리)
│
└── agents/
    ├── main/
    │   ├── agent/                 인증 프로필
    │   └── sessions/              세션 로그
    ├── assistant/
    │   ├── agent/
    │   └── sessions/
    └── coder/
        ├── agent/
        └── sessions/
```

**완전 독립:** 워크스페이스, 세션, 인증, 메모리 전부 분리
**공유:** 설정 파일, API 키, 플러그인, 게이트웨이 프로세스

---

## 실전 예시

### 예시 1: 채널별 분리 (일상 vs 딥워크)

```json5
{
  agents: {
    list: [
      {
        id: "chat",
        name: "Everyday",
        workspace: "~/.openclaw/workspace-chat",
        model: "anthropic/claude-sonnet-4-6",    // 빠른 모델
      },
      {
        id: "opus",
        name: "Deep Work",
        workspace: "~/.openclaw/workspace-opus",
        model: "anthropic/claude-opus-4-6",      // 강력한 모델
      },
    ],
  },
  bindings: [
    { agentId: "chat", match: { channel: "whatsapp" } },
    { agentId: "opus", match: { channel: "telegram" } },
  ],
}
```

### 예시 2: 같은 채널, 사람별 분리

```json5
{
  agents: {
    list: [
      { id: "alex", workspace: "~/.openclaw/workspace-alex" },
      { id: "mia",  workspace: "~/.openclaw/workspace-mia" },
    ],
  },
  bindings: [
    {
      agentId: "alex",
      match: { channel: "whatsapp", peer: { kind: "direct", id: "+821011111111" } },
    },
    {
      agentId: "mia",
      match: { channel: "whatsapp", peer: { kind: "direct", id: "+821022222222" } },
    },
  ],
}
```

### 예시 3: 에이전트별 도구/샌드박스 제한

```json5
{
  agents: {
    list: [
      {
        id: "personal",
        workspace: "~/.openclaw/workspace-personal",
        sandbox: { mode: "off" },
        // 모든 도구 사용 가능
      },
      {
        id: "family",
        workspace: "~/.openclaw/workspace-family",
        sandbox: { mode: "all", scope: "agent" },  // 항상 샌드박스
        tools: {
          allow: ["read"],                           // 읽기만 허용
          deny: ["exec", "write", "edit"],           // 쓰기/실행 차단
        },
      },
    ],
  },
}
```

---

## 에이전트 간 메모리 공유 (QMD)

기본적으로 메모리는 분리되지만, QMD 백엔드를 쓰면
다른 에이전트의 세션 기록을 검색할 수 있습니다:

```json5
{
  agents: {
    list: [
      {
        id: "main",
        workspace: "~/workspaces/main",
        memorySearch: {
          qmd: {
            // family 에이전트의 세션도 검색
            extraCollections: [
              { path: "~/agents/family/sessions", name: "family-sessions" },
            ],
          },
        },
      },
      { id: "family", workspace: "~/workspaces/family" },
    ],
  },
}
```

/**
 * Session Path Resolver
 *
 * sessionKey를 파싱하여 세션별 메모리 저장 경로를 결정합니다.
 *
 * sessionKey 예시:
 *   "agent:main:main"                      → shared (기본 DM)
 *   "agent:main:telegram:dm:12345"         → sessions/telegram-dm-12345/
 *   "agent:main:discord:channel:67890"     → sessions/discord-channel-67890/
 *   "agent:main:whatsapp:group:xxxxx"      → sessions/whatsapp-group-xxxxx/
 */

/** sessionKey를 파싱하여 agentId와 나머지를 추출 */
export function parseSessionKey(
  sessionKey: string | undefined,
): { agentId: string; rest: string } | null {
  const raw = (sessionKey ?? "").trim().toLowerCase();
  if (!raw) return null;

  const parts = raw.split(":").filter(Boolean);
  if (parts.length < 3 || parts[0] !== "agent") return null;

  const agentId = parts[1];
  const rest = parts.slice(2).join(":");
  if (!agentId || !rest) return null;

  return { agentId, rest };
}

/**
 * sessionKey로부터 세션 고유 디렉토리명을 생성합니다.
 *
 * "agent:main:telegram:dm:12345"
 *   → agentId: "main", rest: "telegram:dm:12345"
 *   → 디렉토리명: "telegram-dm-12345"
 *
 * "agent:main:main" (기본 DM 세션)
 *   → null (공유 메모리 사용)
 */
export function deriveSessionDirName(
  sessionKey: string | undefined,
): string | null {
  const parsed = parseSessionKey(sessionKey);
  if (!parsed) return null;

  // "main" 은 기본 세션이므로 공유 메모리 사용
  if (parsed.rest === "main") return null;

  // 콜론을 하이픈으로 치환하여 디렉토리명으로 사용
  // "telegram:dm:12345" → "telegram-dm-12345"
  const dirName = parsed.rest.replace(/:/g, "-");

  // 파일시스템에 안전한 문자만 남기기
  return dirName.replace(/[^a-z0-9._-]/g, "-").replace(/-+/g, "-");
}

/**
 * 세션별 메모리 파일의 상대 경로를 생성합니다.
 *
 * scope: "session" → memory/sessions/telegram-dm-12345/2026-04-03.md
 * scope: "shared"  → memory/2026-04-03.md
 */
export function resolveMemoryFilePath(params: {
  sessionKey?: string;
  scope: "session" | "shared";
  dateStamp: string;
}): string {
  if (params.scope === "shared") {
    return `memory/${params.dateStamp}.md`;
  }

  const sessionDir = deriveSessionDirName(params.sessionKey);
  if (!sessionDir) {
    // 기본 세션이거나 파싱 불가 → 공유 경로로 폴백
    return `memory/${params.dateStamp}.md`;
  }

  return `memory/sessions/${sessionDir}/${params.dateStamp}.md`;
}

/**
 * sessionKey에서 채팅 유형을 추출합니다.
 */
export function deriveChatType(
  sessionKey: string | undefined,
): "direct" | "group" | "channel" | "unknown" {
  const parsed = parseSessionKey(sessionKey);
  if (!parsed) return "unknown";

  const tokens = new Set(parsed.rest.split(":").filter(Boolean));
  if (tokens.has("group")) return "group";
  if (tokens.has("channel")) return "channel";
  if (tokens.has("direct") || tokens.has("dm")) return "direct";
  return "unknown";
}

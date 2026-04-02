/**
 * Memory Flush Plan
 *
 * 대화가 길어지면 AI의 컨텍스트 윈도우(기억 공간)가 가득 찹니다.
 * 가득 차기 전에 "컴팩션(compaction)"이 발생하는데,
 * 이 파일은 컴팩션 직전에 중요한 대화 내용을 파일에 저장하는
 * "플러시(flush) 계획"을 생성합니다.
 *
 * 흐름:
 *   대화 진행 → 토큰 임계치 도달 → buildMemoryFlushPlan() 호출
 *   → 플랜 반환 → AI가 대화 내용을 memory/YYYY-MM-DD.md 에 저장
 *   → 컴팩션 진행 (오래된 대화 압축)
 */

import {
  // 컨텍스트 윈도우에서 컴팩션용으로 예약해둘 최소 토큰 수 (기본 20,000)
  DEFAULT_PI_COMPACTION_RESERVE_TOKENS_FLOOR,
  // "2MB" 같은 문자열을 바이트 숫자로 파싱하는 유틸리티
  parseNonNegativeByteSize,
  // 사용자 설정의 타임존을 고려하여 현재 시각 정보를 만들어주는 유틸리티
  // 반환값: { timeLine: "Current time: 2026-04-02 14:30 KST", userTimezone: "Asia/Seoul" }
  resolveCronStyleNow,
  // AI가 "저장할 내용 없음"을 표현할 때 쓰는 특수 토큰 (예: "##SILENT##")
  SILENT_REPLY_TOKEN,
  // 플러시 계획의 타입 정의
  type MemoryFlushPlan,
  // OpenClaw 전체 설정 타입
  type OpenClawConfig,
} from "openclaw/plugin-sdk/memory-core-host-runtime-core";

// ─── 기본값 상수 ───────────────────────────────────────────────

// 소프트 플러시 임계치: 컨텍스트 윈도우에서 이 토큰 수만큼 남으면 플러시 시작
// 예: 128K 윈도우 - 20K 예약 - 4K 소프트 = 104K 토큰 사용 시 트리거
export const DEFAULT_MEMORY_FLUSH_SOFT_TOKENS = 4000;

// 강제 플러시 임계치: 대화 기록이 이 바이트를 넘으면 무조건 플러시
// 2 * 1024 * 1024 = 2MB
export const DEFAULT_MEMORY_FLUSH_FORCE_TRANSCRIPT_BYTES = 2 * 1024 * 1024;

// ─── AI에게 전달할 안전 장치 힌트 ──────────────────────────────
// 플러시 시 AI가 지켜야 할 규칙들입니다.
// 이 힌트들은 프롬프트에 반드시 포함되어야 합니다.

// 힌트 1: memory_store 도구 사용 강제 — write/edit 대신 memory_store로 저장
const MEMORY_FLUSH_TARGET_HINT =
  "Use the memory_store tool to save memories. Use scope='session' for session-specific memories, scope='shared' for memories all sessions should access. Do NOT use write or edit tools for memory storage.";

// 힌트 2: 이어쓰기 전용 — memory_store는 자동으로 append하므로 덮어쓰기 걱정 없음
const MEMORY_FLUSH_APPEND_ONLY_HINT =
  "Each memory_store call appends to the appropriate file. Do not attempt to overwrite existing entries.";

// 힌트 3: 읽기 전용 보호 — MEMORY.md, SOUL.md 등 부트스트랩 파일은 수정 금지
const MEMORY_FLUSH_READ_ONLY_HINT =
  "Treat workspace bootstrap/reference files such as MEMORY.md, SOUL.md, TOOLS.md, and AGENTS.md as read-only during this flush; never overwrite, replace, or edit them.";

// 위 3개 힌트를 배열로 묶음 — ensureMemoryFlushSafetyHints()에서 누락 여부 체크용
const MEMORY_FLUSH_REQUIRED_HINTS = [
  MEMORY_FLUSH_TARGET_HINT,
  MEMORY_FLUSH_APPEND_ONLY_HINT,
  MEMORY_FLUSH_READ_ONLY_HINT,
];

// ─── 기본 프롬프트 ─────────────────────────────────────────────

// AI에게 전달되는 플러시 턴 프롬프트 (사용자 메시지 역할)
// "YYYY-MM-DD"는 나중에 실제 날짜로 치환됩니다.
export const DEFAULT_MEMORY_FLUSH_PROMPT = [
  "Pre-compaction memory flush.",
  MEMORY_FLUSH_TARGET_HINT,
  MEMORY_FLUSH_READ_ONLY_HINT,
  MEMORY_FLUSH_APPEND_ONLY_HINT,
  "Categorize each memory: use scope='session' for conversation-specific context, scope='shared' for facts useful across all sessions.",
  `If nothing to store, reply with ${SILENT_REPLY_TOKEN}.`,
].join(" ");

// AI에게 전달되는 플러시 턴 시스템 프롬프트 (시스템 메시지 역할)
export const DEFAULT_MEMORY_FLUSH_SYSTEM_PROMPT = [
  "Pre-compaction memory flush turn.",
  "The session is near auto-compaction; capture durable memories to disk using the memory_store tool.",
  MEMORY_FLUSH_TARGET_HINT,
  MEMORY_FLUSH_READ_ONLY_HINT,
  MEMORY_FLUSH_APPEND_ONLY_HINT,
  `You may reply, but usually ${SILENT_REPLY_TOKEN} is correct.`,
].join(" ");

// ─── 유틸리티 함수들 ───────────────────────────────────────────

/**
 * 주어진 타임존에 맞게 밀리초 타임스탬프를 "YYYY-MM-DD" 형식으로 변환합니다.
 *
 * 예: formatDateStampInTimezone(1743580800000, "Asia/Seoul") → "2026-04-02"
 *
 * Intl.DateTimeFormat으로 타임존 변환 후 파츠를 조합합니다.
 * 파싱 실패 시 UTC 기준 ISO 날짜로 폴백합니다.
 */
function formatDateStampInTimezone(nowMs: number, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(nowMs));
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  if (year && month && day) {
    return `${year}-${month}-${day}`;
  }
  // 타임존 파싱 실패 시 UTC ISO 날짜 사용
  return new Date(nowMs).toISOString().slice(0, 10);
}

/**
 * unknown 타입의 값을 0 이상의 정수로 변환합니다.
 * 설정값이 유효한 숫자인지 검증하는 데 사용됩니다.
 *
 * 예: normalizeNonNegativeInt(4000)  → 4000
 *     normalizeNonNegativeInt(-1)    → null
 *     normalizeNonNegativeInt("abc") → null
 *     normalizeNonNegativeInt(3.7)   → 3
 */
function normalizeNonNegativeInt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  const int = Math.floor(value);
  return int >= 0 ? int : null;
}

/**
 * 프롬프트에 "저장할 게 없으면 SILENT_REPLY_TOKEN으로 응답하라"는
 * 안내가 포함되어 있는지 확인하고, 없으면 추가합니다.
 *
 * 이게 없으면 AI가 저장할 내용이 없을 때도 긴 응답을 생성하여
 * 불필요한 토큰을 소모합니다.
 */
function ensureNoReplyHint(text: string): string {
  if (text.includes(SILENT_REPLY_TOKEN)) {
    return text;
  }
  return `${text}\n\nIf no user-visible reply is needed, start with ${SILENT_REPLY_TOKEN}.`;
}

/**
 * 프롬프트에 3가지 필수 안전 장치 힌트가 모두 포함되어 있는지 확인하고,
 * 빠진 것이 있으면 추가합니다.
 *
 * 사용자가 커스텀 프롬프트를 설정할 수 있는데, 이때 안전 장치를
 * 빠뜨릴 수 있으므로 강제로 보장합니다.
 *
 * 보장하는 힌트:
 *   1. 저장 위치 (memory/YYYY-MM-DD.md)
 *   2. 이어쓰기 전용 (덮어쓰기 금지)
 *   3. 부트스트랩 파일 읽기 전용 (MEMORY.md 등 수정 금지)
 */
function ensureMemoryFlushSafetyHints(text: string): string {
  let next = text.trim();
  for (const hint of MEMORY_FLUSH_REQUIRED_HINTS) {
    if (!next.includes(hint)) {
      next = next ? `${next}\n\n${hint}` : hint;
    }
  }
  return next;
}

/**
 * 프롬프트 끝에 현재 시각 정보를 추가합니다.
 *
 * 예: "Pre-compaction memory flush...\nCurrent time: 2026-04-02 14:30 KST"
 *
 * AI가 날짜별 파일명을 정확히 생성하려면 현재 시각을 알아야 합니다.
 * 이미 "Current time:" 이 포함되어 있으면 중복 추가하지 않습니다.
 */
function appendCurrentTimeLine(text: string, timeLine: string): string {
  const trimmed = text.trimEnd();
  if (!trimmed) {
    return timeLine;
  }
  if (trimmed.includes("Current time:")) {
    return trimmed;
  }
  return `${trimmed}\n${timeLine}`;
}

// ─── 메인 함수 ─────────────────────────────────────────────────

/**
 * 메모리 플러시 계획을 생성합니다.
 *
 * 이 함수는 컴팩션 시스템에 의해 호출되며,
 * "언제, 어디에, 어떻게" 메모리를 저장할지 정의한 플랜 객체를 반환합니다.
 *
 * @param params.cfg  - OpenClaw 설정 (임계치, 프롬프트, 타임존 등)
 * @param params.nowMs - 현재 시각 밀리초 (테스트용 오버라이드)
 * @returns 플러시 계획 객체, 또는 비활성화 시 null
 *
 * 반환값 구조:
 * {
 *   softThresholdTokens: 4000,           // 소프트 트리거 토큰
 *   forceFlushTranscriptBytes: 2097152,  // 강제 트리거 바이트 (2MB)
 *   reserveTokensFloor: 20000,           // 컨텍스트 예약 토큰
 *   prompt: "...",                        // AI에게 전달할 프롬프트
 *   systemPrompt: "...",                  // AI 시스템 프롬프트
 *   relativePath: "memory/2026-04-02.md"  // 저장할 파일 경로
 * }
 */
export function buildMemoryFlushPlan(
  params: {
    cfg?: OpenClawConfig;
    nowMs?: number;
  } = {},
): MemoryFlushPlan | null {
  const resolved = params;

  // 현재 시각 결정: 테스트에서는 nowMs를 주입할 수 있고, 없으면 Date.now()
  const nowMs = Number.isFinite(resolved.nowMs) ? (resolved.nowMs as number) : Date.now();

  const cfg = resolved.cfg;

  // 설정에서 memoryFlush 관련 값 가져오기
  // 경로: config.agents.defaults.compaction.memoryFlush
  const defaults = cfg?.agents?.defaults?.compaction?.memoryFlush;

  // 사용자가 플러시를 명시적으로 끈 경우 → null 반환 (플러시 안 함)
  if (defaults?.enabled === false) {
    return null;
  }

  // ── 임계치 해석 ──

  // 소프트 임계치: 설정값이 유효한 정수면 사용, 아니면 기본값 4000
  const softThresholdTokens =
    normalizeNonNegativeInt(defaults?.softThresholdTokens) ?? DEFAULT_MEMORY_FLUSH_SOFT_TOKENS;

  // 강제 임계치: "2MB" 같은 문자열도 파싱 가능, 실패 시 기본값 2MB
  const forceFlushTranscriptBytes =
    parseNonNegativeByteSize(defaults?.forceFlushTranscriptBytes) ??
    DEFAULT_MEMORY_FLUSH_FORCE_TRANSCRIPT_BYTES;

  // 예약 토큰: 컴팩션 후에도 최소한 이만큼은 남겨둠
  const reserveTokensFloor =
    normalizeNonNegativeInt(cfg?.agents?.defaults?.compaction?.reserveTokensFloor) ??
    DEFAULT_PI_COMPACTION_RESERVE_TOKENS_FLOOR;

  // ── 시각 및 파일 경로 ──

  // 사용자의 타임존을 고려한 현재 시각 문자열과 타임존 이름 가져오기
  // timeLine 예: "Current time: 2026-04-02 14:30 KST (Asia/Seoul, Wed)"
  // userTimezone 예: "Asia/Seoul"
  const { timeLine, userTimezone } = resolveCronStyleNow(cfg ?? {}, nowMs);

  // 타임존에 맞는 날짜 스탬프 생성 (예: "2026-04-02")
  const dateStamp = formatDateStampInTimezone(nowMs, userTimezone);

  // 저장할 파일의 상대 경로 (예: "memory/2026-04-02.md")
  const relativePath = `memory/${dateStamp}.md`;

  // ── 프롬프트 조립 ──

  // 사용자 커스텀 프롬프트가 있으면 사용, 없으면 기본 프롬프트
  // → 안전 장치 힌트 보장 → 무응답 힌트 보장
  const promptBase = ensureNoReplyHint(
    ensureMemoryFlushSafetyHints(defaults?.prompt?.trim() || DEFAULT_MEMORY_FLUSH_PROMPT),
  );

  // 시스템 프롬프트도 동일한 처리
  const systemPrompt = ensureNoReplyHint(
    ensureMemoryFlushSafetyHints(
      defaults?.systemPrompt?.trim() || DEFAULT_MEMORY_FLUSH_SYSTEM_PROMPT,
    ),
  );

  // ── 최종 플랜 반환 ──

  return {
    softThresholdTokens,
    forceFlushTranscriptBytes,
    reserveTokensFloor,
    // 프롬프트의 "YYYY-MM-DD"를 실제 날짜로 치환하고, 현재 시각 라인 추가
    prompt: appendCurrentTimeLine(promptBase.replaceAll("YYYY-MM-DD", dateStamp), timeLine),
    // 시스템 프롬프트도 날짜 치환 (시각 라인은 추가하지 않음)
    systemPrompt: systemPrompt.replaceAll("YYYY-MM-DD", dateStamp),
    relativePath,
  };
}

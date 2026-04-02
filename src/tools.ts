/**
 * Memory Tools
 *
 * 세션별 메모리 저장/검색 도구입니다.
 *
 * - my_memory_store:  세션별 또는 공유 메모리에 저장
 * - my_memory_search: 세션별, 공유, 또는 전체 메모리에서 검색
 */

import { Type } from "@sinclair/typebox";
import {
  deriveSessionDirName,
  resolveMemoryFilePath,
} from "./session-path.js";
import {
  appendMemoryToFile,
  getDateStamp,
  readMemoryEntries,
  type MemoryEntry,
} from "./storage.js";

// ─── 타입 ─────────────────────────────────────────────────────

interface ToolOptions {
  config?: unknown;
  agentSessionKey?: string;
}

// ─── 스키마 ───────────────────────────────────────────────────

const MemoryStoreSchema = Type.Object({
  key: Type.String({ description: "Memory key or topic (used as heading)" }),
  content: Type.String({ description: "Content to store" }),
  tags: Type.Optional(
    Type.Array(Type.String(), { description: "Tags for categorization" }),
  ),
  scope: Type.Optional(
    Type.Union(
      [Type.Literal("session"), Type.Literal("shared")],
      {
        description:
          "Where to store: 'session' = current session only (default), 'shared' = all sessions can access",
      },
    ),
  ),
});

const MemorySearchSchema = Type.Object({
  query: Type.String({ description: "Search query for memory recall" }),
  scope: Type.Optional(
    Type.Union(
      [
        Type.Literal("session"),
        Type.Literal("shared"),
        Type.Literal("all"),
      ],
      {
        description:
          "Search scope: 'session' = current session only, 'shared' = shared memory only, 'all' = both (default)",
      },
    ),
  ),
  maxResults: Type.Optional(
    Type.Number({ description: "Maximum number of results to return" }),
  ),
});

// ─── 워크스페이스 경로 해석 ───────────────────────────────────

/**
 * config에서 워크스페이스 디렉토리를 가져옵니다.
 * 없으면 기본 경로 (~/.openclaw/workspace) 를 반환합니다.
 */
function resolveWorkspaceDir(config: unknown): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  const defaultDir = `${home}/.openclaw/workspace`;

  if (!config || typeof config !== "object") return defaultDir;

  const cfg = config as Record<string, unknown>;
  const agents = cfg.agents as Record<string, unknown> | undefined;
  const defaults = agents?.defaults as Record<string, unknown> | undefined;
  const workspace = defaults?.workspace as string | undefined;

  return workspace?.trim() || defaultDir;
}

// ─── Store 도구 ───────────────────────────────────────────────

export function createMemoryStoreTool(options: ToolOptions) {
  return {
    name: "my_memory_store",
    description:
      "Store a memory entry. Use scope='session' (default) to save for this conversation only, or scope='shared' to save for all sessions.",
    parameters: MemoryStoreSchema,
    async execute(
      _toolCallId: string,
      params: {
        key: string;
        content: string;
        tags?: string[];
        scope?: "session" | "shared";
      },
    ) {
      const { key, content, tags = [], scope = "session" } = params;
      const workspaceDir = resolveWorkspaceDir(options.config);
      const dateStamp = getDateStamp();

      // 저장 경로 결정
      const relativePath = resolveMemoryFilePath({
        sessionKey: options.agentSessionKey,
        scope,
        dateStamp,
      });

      // 파일에 append
      await appendMemoryToFile(workspaceDir, relativePath, {
        key,
        content,
        tags,
        timestamp: Date.now(),
      });

      // 세션 디렉토리명 (로그용)
      const sessionDir = deriveSessionDirName(options.agentSessionKey);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                stored: true,
                key,
                scope,
                path: relativePath,
                session: sessionDir ?? "shared",
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  };
}

// ─── Search 도구 ──────────────────────────────────────────────

export function createMemorySearchTool(options: ToolOptions) {
  return {
    name: "my_memory_search",
    description:
      "Search memory entries. Use scope='all' (default) to search both session and shared memory, 'session' for current session only, or 'shared' for shared memory only.",
    parameters: MemorySearchSchema,
    async execute(
      _toolCallId: string,
      params: {
        query: string;
        scope?: "session" | "shared" | "all";
        maxResults?: number;
      },
    ) {
      const { query, scope = "all", maxResults = 10 } = params;
      const workspaceDir = resolveWorkspaceDir(options.config);
      const memoryBaseDir = `${workspaceDir}/memory`;

      // 검색 대상 엔트리 수집
      let entries: MemoryEntry[] = [];
      const sessionDir = deriveSessionDirName(options.agentSessionKey);

      if (scope === "session" || scope === "all") {
        if (sessionDir) {
          // 현재 세션 전용 메모리 검색
          const sessionMemoryDir = `${memoryBaseDir}/sessions/${sessionDir}`;
          entries.push(...readMemoryEntries(sessionMemoryDir));
        }
      }

      if (scope === "shared" || scope === "all") {
        // 공유 메모리 검색 (memory/ 루트의 .md 파일만, sessions/ 제외)
        entries.push(
          ...readMemoryEntries(memoryBaseDir).filter(
            (e) => e.sessionDir === null,
          ),
        );
      }

      // 키워드 매칭으로 검색
      const results = searchEntries(entries, query, maxResults);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                results,
                query,
                scope,
                session: sessionDir ?? "shared",
                totalEntries: entries.length,
                matchCount: results.length,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  };
}

// ─── 검색 엔진 ───────────────────────────────────────────────

/**
 * 메모리 엔트리를 키워드 매칭으로 검색합니다.
 * 간단한 점수 기반 정렬을 적용합니다.
 */
function searchEntries(
  entries: MemoryEntry[],
  query: string,
  maxResults: number,
): ScoredEntry[] {
  const queryTokens = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0);

  if (queryTokens.length === 0) {
    // 쿼리가 비어있으면 최신순으로 반환
    return entries
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, maxResults)
      .map((e) => ({ ...e, score: 1 }));
  }

  const scored: ScoredEntry[] = [];

  for (const entry of entries) {
    const score = calculateScore(entry, queryTokens);
    if (score > 0) {
      scored.push({ ...entry, score });
    }
  }

  // 점수 내림차순, 같은 점수면 최신순
  scored.sort((a, b) => b.score - a.score || b.timestamp - a.timestamp);

  return scored.slice(0, maxResults);
}

interface ScoredEntry extends MemoryEntry {
  score: number;
}

/**
 * 엔트리와 쿼리 토큰 간의 매칭 점수를 계산합니다.
 *
 * 점수 기준:
 *   - key에 토큰 포함: +3점 (제목 매칭은 가중치 높음)
 *   - content에 토큰 포함: +1점
 *   - tags에 토큰 포함: +2점
 *   - 최신일수록 약간의 가산점 (temporal boost)
 */
function calculateScore(entry: MemoryEntry, queryTokens: string[]): number {
  let score = 0;
  const keyLower = entry.key.toLowerCase();
  const contentLower = entry.content.toLowerCase();
  const tagsLower = entry.tags.map((t) => t.toLowerCase());

  for (const token of queryTokens) {
    if (keyLower.includes(token)) score += 3;
    if (contentLower.includes(token)) score += 1;
    if (tagsLower.some((t) => t.includes(token))) score += 2;
  }

  // 시간 기반 가산점: 최근 7일 이내면 최대 +0.5
  const ageMs = Date.now() - entry.timestamp;
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  if (ageDays < 7) {
    score += 0.5 * (1 - ageDays / 7);
  }

  return score;
}

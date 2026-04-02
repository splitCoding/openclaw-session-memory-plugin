/**
 * Session-Scoped Memory Tools
 *
 * memory-core의 검색 엔진(벡터 + FTS + 하이브리드)을 그대로 사용하면서,
 * 세션별 메모리 저장과 scope 기반 사전 필터링을 추가합니다.
 *
 * 도구 3개:
 * - memory_search: 검색 (scope 파라미터로 세션/공유/전체 선택)
 * - memory_get:    파일 스니펫 읽기 (원본 동일)
 * - memory_store:  저장 (scope 파라미터로 세션/공유 선택)
 */

import {
  jsonResult,
  readNumberParam,
  readStringParam,
  type AnyAgentTool,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { Type } from "@sinclair/typebox";
import {
  clampResultsByInjectedChars,
  decorateCitations,
  resolveMemoryCitationsMode,
  shouldIncludeCitations,
} from "./tools.citations.js";
import {
  buildMemorySearchUnavailableResult,
  createMemoryTool,
  getMemoryManagerContext,
  getMemoryManagerContextWithPurpose,
  loadMemoryToolRuntime,
  MemoryGetSchema,
} from "./tools.shared.js";
import {
  deriveSessionDirName,
  resolveMemoryFilePath,
} from "./session-path.js";
import {
  appendMemoryToFile,
  getDateStamp,
} from "./storage.js";

// ─── 스키마 ───────────────────────────────────────────────────

/** memory_search: 원본 파라미터 + scope 추가 */
const MemorySearchWithScopeSchema = Type.Object({
  query: Type.String(),
  scope: Type.Optional(
    Type.Union(
      [
        Type.Literal("session"),
        Type.Literal("shared"),
        Type.Literal("all"),
      ],
      {
        description:
          "Search scope: 'all' (default) = current session + shared memory, 'session' = current session only, 'shared' = shared memory only",
      },
    ),
  ),
  maxResults: Type.Optional(Type.Number()),
  minScore: Type.Optional(Type.Number()),
});

/** memory_store: 세션별 저장 */
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

// ─── 워크스페이스 경로 ────────────────────────────────────────

function resolveWorkspaceDir(config?: OpenClawConfig): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  const defaultDir = `${home}/.openclaw/workspace`;
  if (!config) return defaultDir;
  const workspace = config.agents?.defaults?.workspace;
  return (typeof workspace === "string" && workspace.trim()) || defaultDir;
}

// ─── pathFilter 생성 ─────────────────────────────────────────

function buildSessionPathFilter(
  sessionKey: string | undefined,
  scope: string,
): ((path: string) => boolean) | undefined {
  if (scope === "all" || !scope) {
    const sessionDir = deriveSessionDirName(sessionKey);
    const sessionPrefix = sessionDir ? `sessions/${sessionDir}/` : null;
    // all: 현재 세션 + 공유 (다른 세션 제외)
    return (path: string) => {
      const isSessionFile = path.includes("sessions/");
      if (!isSessionFile) return true;
      return sessionPrefix ? path.includes(sessionPrefix) : false;
    };
  }
  if (scope === "session") {
    const sessionDir = deriveSessionDirName(sessionKey);
    const sessionPrefix = sessionDir ? `sessions/${sessionDir}/` : null;
    return (path: string) => {
      const isSessionFile = path.includes("sessions/");
      return sessionPrefix ? path.includes(sessionPrefix) : !isSessionFile;
    };
  }
  if (scope === "shared") {
    return (path: string) => !path.includes("sessions/");
  }
  return undefined;
}

// ─── memory_search ───────────────────────────────────────────

export function createMemorySearchTool(options: {
  config?: OpenClawConfig;
  agentSessionKey?: string;
}): AnyAgentTool | null {
  return createMemoryTool({
    options,
    label: "Memory Search",
    name: "memory_search",
    description:
      "Semantically search MEMORY.md + memory/*.md before answering questions about prior work, decisions, dates, people, preferences, or todos. Use scope to control session isolation: 'all' (default) = current session + shared, 'session' = current session only, 'shared' = shared memory only. Returns top snippets with path + lines.",
    parameters: MemorySearchWithScopeSchema,
    execute:
      ({ cfg, agentId }) =>
      async (_toolCallId, params) => {
        const query = readStringParam(params, "query", { required: true });
        const scope = readStringParam(params, "scope") ?? "all";
        const maxResults = readNumberParam(params, "maxResults");
        const minScore = readNumberParam(params, "minScore");
        const { resolveMemoryBackendConfig } = await loadMemoryToolRuntime();
        const memory = await getMemoryManagerContext({ cfg, agentId });
        if ("error" in memory) {
          return jsonResult(buildMemorySearchUnavailableResult(memory.error));
        }
        try {
          const citationsMode = resolveMemoryCitationsMode(cfg);
          const includeCitations = shouldIncludeCitations({
            mode: citationsMode,
            sessionKey: options.agentSessionKey,
          });

          const pathFilter = buildSessionPathFilter(options.agentSessionKey, scope);
          const sessionDir = deriveSessionDirName(options.agentSessionKey);

          const rawResults = await memory.manager.search(query, {
            maxResults,
            minScore,
            sessionKey: options.agentSessionKey,
            pathFilter,
          });

          const status = memory.manager.status();
          const decorated = decorateCitations(rawResults, includeCitations);
          const resolved = resolveMemoryBackendConfig({ cfg, agentId });
          const results =
            status.backend === "qmd"
              ? clampResultsByInjectedChars(decorated, resolved.qmd?.limits.maxInjectedChars)
              : decorated;
          const searchMode = (status.custom as { searchMode?: string } | undefined)?.searchMode;
          return jsonResult({
            results,
            query,
            scope,
            session: sessionDir ?? "shared",
            provider: status.provider,
            model: status.model,
            fallback: status.fallback,
            citations: citationsMode,
            mode: searchMode,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return jsonResult(buildMemorySearchUnavailableResult(message));
        }
      },
  });
}

// ─── memory_get ──────────────────────────────────────────────

export function createMemoryGetTool(options: {
  config?: OpenClawConfig;
  agentSessionKey?: string;
}): AnyAgentTool | null {
  return createMemoryTool({
    options,
    label: "Memory Get",
    name: "memory_get",
    description:
      "Safe snippet read from MEMORY.md or memory/*.md with optional from/lines; use after memory_search to pull only the needed lines and keep context small.",
    parameters: MemoryGetSchema,
    execute:
      ({ cfg, agentId }) =>
      async (_toolCallId, params) => {
        const relPath = readStringParam(params, "path", { required: true });
        const from = readNumberParam(params, "from", { integer: true });
        const lines = readNumberParam(params, "lines", { integer: true });
        const { readAgentMemoryFile, resolveMemoryBackendConfig } = await loadMemoryToolRuntime();
        const resolved = resolveMemoryBackendConfig({ cfg, agentId });
        if (resolved.backend === "builtin") {
          try {
            const result = await readAgentMemoryFile({
              cfg,
              agentId,
              relPath,
              from: from ?? undefined,
              lines: lines ?? undefined,
            });
            return jsonResult(result);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return jsonResult({ path: relPath, text: "", disabled: true, error: message });
          }
        }
        const memory = await getMemoryManagerContextWithPurpose({
          cfg,
          agentId,
          purpose: "status",
        });
        if ("error" in memory) {
          return jsonResult({ path: relPath, text: "", disabled: true, error: memory.error });
        }
        try {
          const result = await memory.manager.readFile({
            relPath,
            from: from ?? undefined,
            lines: lines ?? undefined,
          });
          return jsonResult(result);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return jsonResult({ path: relPath, text: "", disabled: true, error: message });
        }
      },
  });
}

// ─── memory_store ────────────────────────────────────────────

export function createMemoryStoreTool(options: {
  config?: OpenClawConfig;
  agentSessionKey?: string;
}) {
  return {
    name: "memory_store",
    label: "Memory Store",
    description:
      "Store a memory entry. ALWAYS use this instead of write/edit when saving to memory. scope='session' (default) saves for this conversation only. scope='shared' saves for all sessions to access.",
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

      const relativePath = resolveMemoryFilePath({
        sessionKey: options.agentSessionKey,
        scope,
        dateStamp,
      });

      await appendMemoryToFile(workspaceDir, relativePath, {
        key,
        content,
        tags,
        timestamp: Date.now(),
      });

      const sessionDir = deriveSessionDirName(options.agentSessionKey);

      return jsonResult({
        stored: true,
        key,
        scope,
        path: relativePath,
        session: sessionDir ?? "shared",
      });
    },
  };
}

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import {
  createMemorySearchTool,
  createMemoryGetTool,
  createMemoryStoreTool,
} from "./src/tools.js";
import {
  buildMemoryFlushPlan,
  DEFAULT_MEMORY_FLUSH_FORCE_TRANSCRIPT_BYTES,
  DEFAULT_MEMORY_FLUSH_PROMPT,
  DEFAULT_MEMORY_FLUSH_SOFT_TOKENS,
} from "./src/flush-plan.js";
import { registerBuiltInMemoryEmbeddingProviders } from "./src/memory/provider-adapters.js";
import { buildPromptSection } from "./src/prompt-section.js";
import { memoryRuntime } from "./src/runtime.js";
import { registerMemoryCli } from "./src/cli.js";

export {
  buildMemoryFlushPlan,
  DEFAULT_MEMORY_FLUSH_FORCE_TRANSCRIPT_BYTES,
  DEFAULT_MEMORY_FLUSH_PROMPT,
  DEFAULT_MEMORY_FLUSH_SOFT_TOKENS,
} from "./src/flush-plan.js";
export { buildPromptSection } from "./src/prompt-section.js";

export default definePluginEntry({
  id: "my-plugin",
  name: "My Plugin",
  description: "Session-scoped memory management plugin for OpenClaw",
  kind: "memory",
  register(api) {
    registerBuiltInMemoryEmbeddingProviders(api);
    api.registerMemoryPromptSection(buildPromptSection);
    api.registerMemoryFlushPlan(buildMemoryFlushPlan);
    api.registerMemoryRuntime(memoryRuntime);

    api.registerTool(
      (ctx) =>
        createMemorySearchTool({
          config: ctx.config,
          agentSessionKey: ctx.sessionKey,
        }),
      { names: ["memory_search"] },
    );

    api.registerTool(
      (ctx) =>
        createMemoryGetTool({
          config: ctx.config,
          agentSessionKey: ctx.sessionKey,
        }),
      { names: ["memory_get"] },
    );

    api.registerTool(
      (ctx) =>
        createMemoryStoreTool({
          config: ctx.config,
          agentSessionKey: ctx.sessionKey,
        }),
      { names: ["memory_save"] },
    );

    // Whitelist 기반 도구 접근 제어
    api.on("before_tool_call", (event) => {
      const { toolName, params } = event;
      const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
      const escapedHome = home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

      // ── 허용 도구 whitelist ──
      const ALLOWED_TOOLS = new Set([
        "read",           // 파일 읽기 (경로 제한 있음)
        "exec",           // 명령 실행 (스킬 + 제한된 명령만)
        "web_fetch",      // 웹 페이지 조회
        "web_search",     // 웹 검색
        "memory_search",  // 플러그인: 메모리 검색
        "memory_get",     // 플러그인: 메모리 조회
        "memory_save",    // 플러그인: 메모리 저장
      ]);

      if (!ALLOWED_TOOLS.has(toolName)) {
        return {
          block: true,
          blockReason:
            "Permission denied. Inform the user that this information or action is unavailable. Do NOT provide alternatives, workarounds, or any additional details.",
        };
      }

      // ── .openclaw 경로 접근 판별 헬퍼 ──
      const isOpenclawPath = (path: string) => {
        const normalized = path.replace(/\/+/g, "/");
        return /\.openclaw(\/|$)/.test(normalized);
      };

      const isSkillPath = (path: string) => {
        const normalized = path.replace(/\/+/g, "/");
        return [
          new RegExp(`${escapedHome}/\\.openclaw/workspace[^/]*/skills/`),
          new RegExp(`${escapedHome}/\\.openclaw/skills/`),
          /node_modules\/openclaw\/skills\//,
        ].some((p) => p.test(normalized));
      };

      // ── read: .openclaw 설정 경로 차단 (스킬 경로 제외) ──
      if (toolName === "read") {
        const filePath = ((params.file_path ?? params.path ?? params.file ?? "") as string).trim();
        if (isOpenclawPath(filePath) && !isSkillPath(filePath)) {
          return {
            block: true,
            blockReason:
              "Permission denied. Inform the user that this information or action is unavailable. Do NOT provide alternatives, workarounds, or any additional details.",
          };
        }
        return {};
      }

      // ── exec: 스킬 경로 + 제한된 명령만 허용 ──
      if (toolName === "exec") {
        const command = ((params.command ?? "") as string).trim();

        // .openclaw 경로 접근 차단 (스킬 경로 제외)
        if (isOpenclawPath(command) && !isSkillPath(command)) {
          return {
            block: true,
            blockReason:
              "Permission denied. Inform the user that this information or action is unavailable. Do NOT provide alternatives, workarounds, or any additional details.",
          };
        }

        // inline eval 차단 — 임의 코드 실행으로 모든 제한 우회 가능
        if (/\b(bash|sh|zsh)\s+-c\s/i.test(command) ||
            /\bpython3?\s+-c\s/i.test(command) ||
            /\bnode\s+-e\s/i.test(command) ||
            /\bperl\s+-e\s/i.test(command) ||
            /\bruby\s+-e\s/i.test(command)) {
          return {
            block: true,
            blockReason:
              "Permission denied. Inform the user that this information or action is unavailable. Do NOT provide alternatives, workarounds, or any additional details.",
          };
        }

        // 파이프/리다이렉트로 .openclaw 접근 차단
        if (/\.openclaw/.test(command) && !isSkillPath(command)) {
          return {
            block: true,
            blockReason:
              "Permission denied. Inform the user that this information or action is unavailable. Do NOT provide alternatives, workarounds, or any additional details.",
          };
        }

        // 스킬 경로 실행은 항상 허용
        if (isSkillPath(command)) {
          return {};
        }

        // 안전한 읽기 전용 명령만 허용 (쓰기/시스템 조작 불가)
        const allowedCommands = [
          /^echo\s/,
          /^date\b/,
          /^which\s/,
          /^memo\s/,    // apple-notes
          /^wttr/,      // weather
        ];

        if (allowedCommands.some((p) => p.test(command))) {
          return {};
        }

        return {
          block: true,
          blockReason:
            "Permission denied. Inform the user that this information or action is unavailable. Do NOT provide alternatives, workarounds, or any additional details.",
        };
      }

      return {};
    });

    api.registerCli(
      ({ program }) => {
        registerMemoryCli(program);
      },
      {
        descriptors: [
          {
            name: "memory",
            description: "Search, inspect, and reindex memory files",
            hasSubcommands: true,
          },
        ],
      },
    );
  },
});

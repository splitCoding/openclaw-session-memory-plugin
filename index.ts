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

    // write/edit 전면 차단 + exec에서 설정 변경 명령 차단
    api.on("before_tool_call", (event) => {
      const { toolName, params } = event;

      // write/edit 전면 차단 — 메모리 저장은 memory_save만 허용
      if (toolName === "write" || toolName === "edit") {
        return {
          block: true,
          blockReason:
            "BLOCKED: write/edit tools are disabled. " +
            "Use memory_save to store memories. " +
            "Example: memory_save({ key: \"topic\", content: \"...\", scope: \"session\" }). " +
            "Do NOT retry with write or edit. Use memory_save immediately.",
        };
      }

      // exec 허용 목록 기반 제어 — 스킬 실행에 필요한 경로/명령만 허용
      if (toolName === "exec") {
        const command = ((params.command ?? "") as string).trim();
        const home = process.env.HOME ?? process.env.USERPROFILE ?? "";

        const allowedPathPatterns = [
          // workspace 스킬 (각 에이전트별)
          new RegExp(`${home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/\\.openclaw/workspace[^/]*/skills/`),
          // managed 스킬
          new RegExp(`${home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/\\.openclaw/skills/`),
          // bundled 스킬
          /node_modules\/openclaw\/skills\//,
        ];

        const allowedCommands = [
          /^python3?\s/,
          /^bash\s/,
          /^sh\s/,
          /^node\s/,
          /^curl\s/,
          /^wget\s/,
          /^echo\s/,
          /^cat\s/,
          /^grep\s/,
          /^find\s/,
          /^ls\s/,
          /^date/,
          /^which\s/,
          /^memo\s/,    // apple-notes
          /^wttr/,      // weather
        ];

        const isAllowedPath = allowedPathPatterns.some((p) => p.test(command));
        const isAllowedCommand = allowedCommands.some((p) => p.test(command));

        if (!isAllowedPath && !isAllowedCommand) {
          return {
            block: true,
            blockReason:
              "BLOCKED: This exec command is not allowed. " +
              "Only skill scripts and basic utilities are permitted.",
          };
        }
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

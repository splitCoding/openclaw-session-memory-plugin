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

    // write/edit 도구가 memory/ 경로에 쓰려고 하면 차단하고
    // memory_save 사용을 유도하는 훅
    api.on("before_tool_call", (event) => {
      const { toolName, params } = event;
      if (toolName !== "write" && toolName !== "edit") {
        return {};
      }
      const filePath = (params.file ?? params.path ?? params.file_path ?? "") as string;
      const normalizedPath = filePath.toLowerCase();
      if (
        normalizedPath.includes("/memory/") ||
        normalizedPath.includes("/memory.md") ||
        normalizedPath.endsWith("memory.md")
      ) {
        return {
          block: true,
          blockReason:
            "BLOCKED: write/edit to memory files is disabled. " +
            "You MUST call the memory_save tool to save memories. " +
            "Example: memory_save({ key: \"topic\", content: \"...\", scope: \"session\" }). " +
            "Do NOT retry with write or edit. Use memory_save immediately.",
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

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createMemorySearchTool, createMemoryStoreTool } from "./src/tools.js";
import { buildPromptSection } from "./src/prompt-section.js";
import { memoryRuntime } from "./src/runtime.js";

export default definePluginEntry({
  id: "my-plugin",
  name: "My Plugin",
  description: "Custom memory management plugin for OpenClaw",
  kind: "memory",
  register(api) {
    api.registerMemoryPromptSection(buildPromptSection);
    api.registerMemoryRuntime(memoryRuntime);

    api.registerTool(
      (ctx) =>
        createMemorySearchTool({
          config: ctx.config,
          agentSessionKey: ctx.sessionKey,
        }),
      { names: ["my_memory_search"] },
    );

    api.registerTool(
      (ctx) =>
        createMemoryStoreTool({
          config: ctx.config,
          agentSessionKey: ctx.sessionKey,
        }),
      { names: ["my_memory_store"] },
    );

    api.registerCli(
      ({ program }) => {
        program
          .command("my-memory")
          .description("Custom memory management commands")
          .command("status")
          .description("Show custom memory status")
          .action(async () => {
            console.log("My Plugin memory status: OK");
          });
      },
      {
        descriptors: [
          {
            name: "my-memory",
            description: "Custom memory management commands",
            hasSubcommands: true,
          },
        ],
      },
    );
  },
});

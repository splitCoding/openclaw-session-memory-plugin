import type { MemoryPromptSectionBuilder } from "openclaw/plugin-sdk/memory-core-host-runtime-core";

export const buildPromptSection: MemoryPromptSectionBuilder = ({
  availableTools,
  citationsMode,
}) => {
  const hasMemorySearch = availableTools.has("memory_search");
  const hasMemoryGet = availableTools.has("memory_get");
  const hasMemoryStore = availableTools.has("memory_store");

  if (!hasMemorySearch && !hasMemoryGet && !hasMemoryStore) {
    return [];
  }

  const lines = ["## Memory Recall"];

  if (hasMemorySearch && hasMemoryGet) {
    lines.push(
      "Before answering anything about prior work, decisions, dates, people, preferences, or todos: run memory_search; then use memory_get to pull only the needed lines. Use scope to control session isolation: 'all' (default) = current session + shared, 'session' = current session only, 'shared' = shared memory only.",
    );
  } else if (hasMemorySearch) {
    lines.push(
      "Before answering anything about prior work, decisions, dates, people, preferences, or todos: run memory_search. Use scope to control session isolation.",
    );
  }

  if (hasMemoryStore) {
    lines.push(
      "When saving memories, ALWAYS use memory_store instead of write/edit tools. Direct file writes to memory/ will bypass session scoping. scope='session' (default) saves for this conversation only. scope='shared' saves for all sessions.",
    );
  }

  if (citationsMode === "off") {
    lines.push(
      "Citations are disabled: do not mention file paths or line numbers in replies unless the user explicitly asks.",
    );
  } else {
    lines.push(
      "Citations: include Source: <path#line> when it helps the user verify memory snippets.",
    );
  }

  lines.push("");
  return lines;
};

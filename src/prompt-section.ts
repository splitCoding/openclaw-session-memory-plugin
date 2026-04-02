interface PromptSectionParams {
  availableTools: Set<string>;
  citationsMode?: string;
}

export function buildPromptSection({
  availableTools,
}: PromptSectionParams): string[] {
  const hasSearch = availableTools.has("my_memory_search");
  const hasStore = availableTools.has("my_memory_store");

  if (!hasSearch && !hasStore) {
    return [];
  }

  const lines = ["## Custom Memory (Session-Scoped)"];

  if (hasStore) {
    lines.push(
      "Use my_memory_store to save information. By default saves to the current session only (scope='session'). Use scope='shared' for information all sessions should access.",
    );
  }

  if (hasSearch) {
    lines.push(
      "Use my_memory_search to recall prior context. By default searches both session and shared memory (scope='all'). Use scope='session' for current session only, or scope='shared' for shared memory only.",
    );
  }

  lines.push("");
  return lines;
}

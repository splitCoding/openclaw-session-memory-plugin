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

  const lines = ["## Custom Memory"];

  if (hasSearch) {
    lines.push(
      "Use my_memory_search to recall prior context, decisions, and preferences before answering related questions.",
    );
  }

  if (hasStore) {
    lines.push(
      "Use my_memory_store to save important information, decisions, or user preferences for future recall.",
    );
  }

  lines.push("");
  return lines;
}

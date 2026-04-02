import { Type } from "@sinclair/typebox";

interface ToolOptions {
  config?: unknown;
  agentSessionKey?: string;
}

const MemorySearchSchema = Type.Object({
  query: Type.String({ description: "Search query for memory recall" }),
  maxResults: Type.Optional(
    Type.Number({ description: "Maximum number of results to return" }),
  ),
});

const MemoryStoreSchema = Type.Object({
  key: Type.String({ description: "Memory key or topic" }),
  content: Type.String({ description: "Content to store in memory" }),
  tags: Type.Optional(
    Type.Array(Type.String(), { description: "Tags for categorization" }),
  ),
});

export function createMemorySearchTool(_options: ToolOptions) {
  return {
    name: "my_memory_search",
    description:
      "Search custom memory store for prior context, decisions, and preferences.",
    parameters: MemorySearchSchema,
    async execute(_toolCallId: string, params: { query: string; maxResults?: number }) {
      const { query, maxResults = 10 } = params;

      // TODO: Implement your custom memory search logic here
      // Example: query a vector DB, external API, or custom file store
      const results = await searchMemory(query, maxResults);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ results, query }, null, 2),
          },
        ],
      };
    },
  };
}

export function createMemoryStoreTool(_options: ToolOptions) {
  return {
    name: "my_memory_store",
    description: "Store a new memory entry in the custom memory backend.",
    parameters: MemoryStoreSchema,
    async execute(
      _toolCallId: string,
      params: { key: string; content: string; tags?: string[] },
    ) {
      const { key, content, tags } = params;

      // TODO: Implement your custom memory store logic here
      await storeMemory(key, content, tags);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ stored: true, key }, null, 2),
          },
        ],
      };
    },
  };
}

// --- Custom memory backend stubs ---

interface MemoryEntry {
  key: string;
  content: string;
  tags: string[];
  timestamp: number;
}

const memoryStore: Map<string, MemoryEntry> = new Map();

async function searchMemory(
  query: string,
  maxResults: number,
): Promise<MemoryEntry[]> {
  const queryLower = query.toLowerCase();
  const matches: MemoryEntry[] = [];

  for (const entry of memoryStore.values()) {
    if (
      entry.content.toLowerCase().includes(queryLower) ||
      entry.key.toLowerCase().includes(queryLower) ||
      entry.tags.some((t) => t.toLowerCase().includes(queryLower))
    ) {
      matches.push(entry);
    }
    if (matches.length >= maxResults) break;
  }

  return matches;
}

async function storeMemory(
  key: string,
  content: string,
  tags?: string[],
): Promise<void> {
  memoryStore.set(key, {
    key,
    content,
    tags: tags ?? [],
    timestamp: Date.now(),
  });
}

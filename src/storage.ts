/**
 * File-based Memory Storage
 *
 * 메모리를 파일시스템에 영구 저장하고 읽어오는 모듈입니다.
 * 세션별로 디렉토리를 분리하여 저장합니다.
 *
 * 저장 구조:
 *   ~/.openclaw/workspace/memory/                    ← 공유 메모리
 *   ~/.openclaw/workspace/memory/sessions/<session>/ ← 세션별 메모리
 */

import fs from "node:fs";
import path from "node:path";

export interface MemoryEntry {
  key: string;
  content: string;
  tags: string[];
  timestamp: number;
  sessionDir: string | null; // null = 공유 메모리
}

/**
 * 메모리 엔트리를 마크다운 파일에 append 합니다.
 *
 * 파일이 없으면 생성하고, 있으면 뒤에 이어 씁니다.
 * 각 엔트리는 다음 형식으로 저장:
 *
 * ## key (2026-04-03 14:30:00)
 * content here
 * > tags: tag1, tag2
 */
export async function appendMemoryToFile(
  workspaceDir: string,
  relativePath: string,
  entry: Omit<MemoryEntry, "sessionDir">,
): Promise<void> {
  const filePath = path.join(workspaceDir, relativePath);
  const dir = path.dirname(filePath);

  // 디렉토리 생성 (재귀)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const date = new Date(entry.timestamp);
  const timeStr = date.toISOString().replace("T", " ").slice(0, 19);

  let block = `\n## ${entry.key} (${timeStr})\n\n${entry.content}\n`;
  if (entry.tags.length > 0) {
    block += `\n> tags: ${entry.tags.join(", ")}\n`;
  }

  fs.appendFileSync(filePath, block, "utf-8");
}

/**
 * 메모리 디렉토리에서 모든 .md 파일을 읽어 엔트리로 파싱합니다.
 *
 * @param memoryDir  검색할 디렉토리 (절대 경로)
 * @returns 파싱된 메모리 엔트리 배열
 */
export function readMemoryEntries(memoryDir: string): MemoryEntry[] {
  if (!fs.existsSync(memoryDir)) return [];

  const entries: MemoryEntry[] = [];
  const files = listMarkdownFiles(memoryDir);

  for (const filePath of files) {
    const content = fs.readFileSync(filePath, "utf-8");
    const parsed = parseMemoryFile(content, memoryDir, filePath);
    entries.push(...parsed);
  }

  return entries;
}

/**
 * 디렉토리 내 모든 .md 파일을 재귀적으로 찾습니다.
 */
function listMarkdownFiles(dir: string): string[] {
  const results: string[] = [];

  if (!fs.existsSync(dir)) return results;

  const items = fs.readdirSync(dir, { withFileTypes: true });
  for (const item of items) {
    const fullPath = path.join(dir, item.name);
    if (item.isDirectory()) {
      results.push(...listMarkdownFiles(fullPath));
    } else if (item.name.endsWith(".md")) {
      results.push(fullPath);
    }
  }

  return results;
}

/**
 * 마크다운 파일 내용을 파싱하여 메모리 엔트리를 추출합니다.
 *
 * 형식:
 *   ## key (2026-04-03 14:30:00)
 *   content
 *   > tags: tag1, tag2
 */
function parseMemoryFile(
  content: string,
  baseDir: string,
  filePath: string,
): MemoryEntry[] {
  const entries: MemoryEntry[] = [];

  // ## heading (timestamp) 패턴으로 분할
  const headingPattern = /^## (.+?) \((\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\)$/gm;
  const headings: { key: string; timestamp: number; index: number }[] = [];

  let match: RegExpExecArray | null;
  while ((match = headingPattern.exec(content)) !== null) {
    headings.push({
      key: match[1],
      timestamp: new Date(match[2] + "Z").getTime(),
      index: match.index + match[0].length,
    });
  }

  // 세션 디렉토리 판별
  const relative = path.relative(baseDir, filePath);
  const sessionDir = relative.startsWith(`sessions${path.sep}`)
    ? relative.split(path.sep)[1]
    : null;

  for (let i = 0; i < headings.length; i++) {
    const start = headings[i].index;
    const end = i + 1 < headings.length
      ? content.lastIndexOf("\n## ", headings[i + 1].index)
      : content.length;

    const body = content.slice(start, end).trim();

    // tags 라인 추출
    const tagsMatch = body.match(/^> tags: (.+)$/m);
    const tags = tagsMatch
      ? tagsMatch[1].split(",").map((t) => t.trim()).filter(Boolean)
      : [];

    // tags 라인을 제거한 순수 content
    const entryContent = body
      .replace(/^> tags: .+$/m, "")
      .trim();

    entries.push({
      key: headings[i].key,
      content: entryContent,
      tags,
      timestamp: headings[i].timestamp,
      sessionDir,
    });
  }

  return entries;
}

/**
 * 현재 날짜를 YYYY-MM-DD 형식으로 반환합니다.
 */
export function getDateStamp(nowMs?: number): string {
  const date = new Date(nowMs ?? Date.now());
  return date.toISOString().slice(0, 10);
}

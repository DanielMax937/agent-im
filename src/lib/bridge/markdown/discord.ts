/**
 * Discord markdown chunking — splits long markdown text into Discord-safe
 * chunks (≤2000 chars) with code fence balancing.
 *
 * Discord supports native markdown, so no IR→HTML conversion is needed.
 * The only concern is the 2000-char message limit.
 */

export interface DiscordChunk {
  text: string;
}

/** Soft limit — leave room for fence repair overhead. */
const SOFT_LIMIT = 1900;

/**
 * Collapse 3+ consecutive newlines to 2 in prose only (paragraph break).
 * Leaves fenced code regions (triple-backtick lines) unchanged so spacing in code is preserved.
 * Uses the same fence toggle rule as chunking: line-start triple backtick opens/closes.
 */
export function collapseExtraNewlinesOutsideFences(text: string): string {
  const lines = text.split(/\r?\n/);
  let result = '';
  const proseLines: string[] = [];
  const fenceLines: string[] = [];
  let inFence = false;

  const flushProse = (): void => {
    if (proseLines.length === 0) return;
    const collapsed = proseLines.join('\n').replace(/\n{3,}/g, '\n\n');
    if (result !== '') result += '\n';
    result += collapsed;
    proseLines.length = 0;
  };

  for (const line of lines) {
    const fenceMatch = line.match(/^(`{3,})([\w]*)/);
    if (fenceMatch) {
      if (inFence) {
        fenceLines.push(line);
        const fence = fenceLines.join('\n');
        if (result !== '') result += '\n';
        result += fence;
        fenceLines.length = 0;
        inFence = false;
      } else {
        flushProse();
        inFence = true;
        fenceLines.push(line);
      }
    } else if (inFence) {
      fenceLines.push(line);
    } else {
      proseLines.push(line);
    }
  }

  if (inFence) {
    if (result !== '') result += '\n';
    result += fenceLines.join('\n');
  } else {
    flushProse();
  }

  return result;
}

/**
 * Split markdown into Discord-safe chunks.
 * Splits at line boundaries and rebalances open code fences at split points.
 */
export function markdownToDiscordChunks(
  markdown: string,
  limit = 2000,
): DiscordChunk[] {
  if (!markdown) return [];

  const normalized = collapseExtraNewlinesOutsideFences(markdown);
  const softLimit = Math.min(limit - 100, SOFT_LIMIT);

  // Fast path: fits in one message
  if (normalized.length <= limit) {
    return [{ text: normalized }];
  }

  const lines = normalized.split('\n');
  const chunks: DiscordChunk[] = [];
  let currentLines: string[] = [];
  let currentLen = 0;
  let openFence: string | null = null; // Tracks the opening fence (e.g., "```ts")

  for (const line of lines) {
    const lineLen = line.length + 1; // +1 for newline

    // Check if this line toggles a fence
    const fenceMatch = line.match(/^(`{3,})([\w]*)/);

    if (currentLen + lineLen > softLimit && currentLines.length > 0) {
      // Need to split here
      let chunkText = currentLines.join('\n');

      // If we're inside a fence, close it at the end of this chunk
      if (openFence) {
        chunkText += '\n```';
      }

      chunks.push({ text: chunkText });

      // Start new chunk — if we were inside a fence, reopen it
      currentLines = [];
      currentLen = 0;

      if (openFence) {
        currentLines.push(openFence);
        currentLen = openFence.length + 1;
      }
    }

    currentLines.push(line);
    currentLen += lineLen;

    // Track fence state
    if (fenceMatch) {
      if (openFence) {
        // Closing fence
        openFence = null;
      } else {
        // Opening fence — remember the full opening line for re-opening
        openFence = fenceMatch[0];
      }
    }
  }

  // Flush remaining
  if (currentLines.length > 0) {
    let chunkText = currentLines.join('\n');
    // If still inside an unclosed fence, close it
    if (openFence) {
      chunkText += '\n```';
    }
    chunks.push({ text: chunkText });
  }

  // Hard split: if any chunk still exceeds limit, force-split by chars
  const result: DiscordChunk[] = [];
  for (const chunk of chunks) {
    if (chunk.text.length <= limit) {
      result.push(chunk);
    } else {
      // Hard split at limit boundaries
      let remaining = chunk.text;
      while (remaining.length > limit) {
        result.push({ text: remaining.slice(0, limit) });
        remaining = remaining.slice(limit);
      }
      if (remaining) {
        result.push({ text: remaining });
      }
    }
  }

  return result;
}

export type ExtractionPath = 1 | 2 | 3;

export interface ExtractResult {
  value: unknown;
  path: ExtractionPath;
}

export function extractJson(raw: string): ExtractResult | null {
  const trimmed = raw.trim();

  try {
    const value = JSON.parse(trimmed);
    return { value, path: 1 };
  } catch {
    // Fall through to the next extraction path.
  }

  const fenced = /```(?:json)?\s*\n?([\s\S]*?)\n?```/.exec(raw);
  if (fenced?.[1]) {
    try {
      return { value: JSON.parse(fenced[1].trim()), path: 2 };
    } catch {
      // Fall through to the next extraction path.
    }
  }

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch !== '{' && ch !== '[') {
      continue;
    }

    const extracted = scanBalanced(raw, i);
    if (extracted) {
      try {
        return { value: JSON.parse(extracted), path: 3 };
      } catch {
        // Keep scanning for the next balanced candidate.
      }
    }
  }

  return null;
}

function scanBalanced(src: string, start: number): string | null {
  const open = src[start];
  const close = open === '{' ? '}' : open === '[' ? ']' : null;
  if (!close) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < src.length; i++) {
    const ch = src[i];

    if (escape) {
      escape = false;
      continue;
    }

    if (inString) {
      if (ch === '\\') {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === open) {
      depth += 1;
    } else if (ch === close) {
      depth -= 1;
      if (depth === 0) {
        return src.slice(start, i + 1);
      }
    }
  }

  return null;
}

import { parseDocument } from "yaml";

export interface ParsedMarkdown {
  data: Record<string, unknown>;
  body: string;
  html: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function safeHref(value: string): string {
  const decoded = value.trim();
  if (/^(?:https?:\/\/|mailto:|tel:|\/|#|\.\.?\/)/i.test(decoded)) return escapeHtml(decoded);
  return "#";
}

function renderInline(source: string): string {
  const tokens: string[] = [];
  const token = (html: string): string => {
    const index = tokens.push(html) - 1;
    return `\u0000${index}\u0000`;
  };

  let value = source.replace(/`([^`\n]+)`/g, (_match, code: string) => token(`<code>${escapeHtml(code)}</code>`));
  value = value.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_match, label: string, href: string) => {
    return token(`<a href="${safeHref(href)}">${escapeHtml(label)}</a>`);
  });
  value = escapeHtml(value);
  value = value.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  value = value.replace(/__([^_\n]+)__/g, "<strong>$1</strong>");
  value = value.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "<em>$1</em>");
  value = value.replace(/(?<!_)_([^_\n]+)_(?!_)/g, "<em>$1</em>");
  return value.replace(/\u0000(\d+)\u0000/g, (_match, index: string) => tokens[Number(index)] ?? "");
}

function isBlockStart(line: string): boolean {
  return /^\s*$/.test(line)
    || /^#{1,6}\s+/.test(line)
    || /^```/.test(line)
    || /^>\s?/.test(line)
    || /^[-*+]\s+/.test(line)
    || /^\d+\.\s+/.test(line)
    || /^\s*(?:---+|___+|\*\*\*+)\s*$/.test(line);
}

export function renderMarkdown(source: string): string {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (!line.trim()) { index++; continue; }

    const fence = line.match(/^```\s*([A-Za-z0-9_-]+)?\s*$/);
    if (fence) {
      const language = fence[1];
      const body: string[] = [];
      index++;
      while (index < lines.length && !/^```\s*$/.test(lines[index] ?? "")) {
        body.push(lines[index] ?? "");
        index++;
      }
      if (index < lines.length) index++;
      const className = language ? ` class="language-${escapeHtml(language)}"` : "";
      out.push(`<pre><code${className}>${escapeHtml(body.join("\n"))}</code></pre>`);
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      const level = heading[1]!.length;
      out.push(`<h${level}>${renderInline(heading[2] ?? "")}</h${level}>`);
      index++;
      continue;
    }

    if (/^\s*(?:---+|___+|\*\*\*+)\s*$/.test(line)) {
      out.push("<hr>");
      index++;
      continue;
    }

    if (/^>\s?/.test(line)) {
      const quote: string[] = [];
      while (index < lines.length && /^>\s?/.test(lines[index] ?? "")) {
        quote.push((lines[index] ?? "").replace(/^>\s?/, ""));
        index++;
      }
      out.push(`<blockquote>${renderMarkdown(quote.join("\n"))}</blockquote>`);
      continue;
    }

    if (/^[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length) {
        const match = (lines[index] ?? "").match(/^[-*+]\s+(.+)$/);
        if (!match) break;
        items.push(`<li>${renderInline(match[1] ?? "")}</li>`);
        index++;
      }
      out.push(`<ul>${items.join("")}</ul>`);
      continue;
    }

    if (/^\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length) {
        const match = (lines[index] ?? "").match(/^\d+\.\s+(.+)$/);
        if (!match) break;
        items.push(`<li>${renderInline(match[1] ?? "")}</li>`);
        index++;
      }
      out.push(`<ol>${items.join("")}</ol>`);
      continue;
    }

    const paragraph: string[] = [line.trim()];
    index++;
    while (index < lines.length && !isBlockStart(lines[index] ?? "")) {
      paragraph.push((lines[index] ?? "").trim());
      index++;
    }
    out.push(`<p>${renderInline(paragraph.join(" "))}</p>`);
  }

  return out.join("\n");
}

export function parseMarkdown(source: string): ParsedMarkdown {
  const normalized = source.replace(/\r\n?/g, "\n");
  let data: Record<string, unknown> = {};
  let body = normalized;

  if (normalized.startsWith("---\n")) {
    const closing = /\n---(?:\n|$)/g;
    closing.lastIndex = 4;
    const match = closing.exec(normalized);
    const end = match?.index ?? -1;
    if (end < 0) throw new Error("Markdown frontmatter is missing its closing --- delimiter.");
    const frontmatter = normalized.slice(4, end);
    const doc = parseDocument(frontmatter, { uniqueKeys: true });
    if (doc.errors.length) throw new Error(doc.errors.map((error: { message: string }) => error.message).join("; "));
    const parsed = doc.toJS();
    if (parsed !== null && !isPlainObject(parsed)) throw new Error("Markdown frontmatter must be a YAML object.");
    data = (parsed ?? {}) as Record<string, unknown>;
    body = normalized.slice(end + (match?.[0].endsWith("\n") ? 5 : 4));
  }

  return { data, body, html: renderMarkdown(body) };
}

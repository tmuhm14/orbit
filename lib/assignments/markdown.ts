// Turns the executor's markdown result into a Tiptap document that the note
// editor (StarterKit plus task lists) can open, so an accepted artifact can be
// saved as a document item without conversion (U-05). Only a small, safe
// subset is recognised: headings, paragraphs, bullet, numbered and task lists,
// block quotes, fenced code, horizontal rules, and bold, italic and inline
// code marks. Everything else stays literal text. Links and HTML are never
// interpreted, so executor output can't inject markup or URLs into the editor.

type Mark = { type: "bold" | "italic" | "code" };
export type TiptapNode = {
  type: string;
  attrs?: Record<string, unknown>;
  content?: TiptapNode[];
  text?: string;
  marks?: Mark[];
};
export type TiptapDoc = { type: "doc"; content: TiptapNode[] };

const INLINE = /(\*\*[^*\n]+\*\*|__[^_\n]+__|`[^`\n]+`|\*[^*\n]+\*|_[^_\n]+_)/g;

/** Text nodes with bold, italic and code marks. Empty text yields no nodes. */
export function inlineNodes(text: string): TiptapNode[] {
  const nodes: TiptapNode[] = [];
  let last = 0;
  for (const match of text.matchAll(INLINE)) {
    const index = match.index ?? 0;
    if (index > last) nodes.push({ type: "text", text: text.slice(last, index) });
    const token = match[0];
    const [mark, inner] = token.startsWith("**") || token.startsWith("__")
      ? (["bold", token.slice(2, -2)] as const)
      : token.startsWith("`")
        ? (["code", token.slice(1, -1)] as const)
        : (["italic", token.slice(1, -1)] as const);
    if (inner) nodes.push({ type: "text", text: inner, marks: [{ type: mark }] });
    last = index + token.length;
  }
  if (last < text.length) nodes.push({ type: "text", text: text.slice(last) });
  return nodes;
}

const paragraph = (text: string): TiptapNode => {
  const content = inlineNodes(text);
  return content.length ? { type: "paragraph", content } : { type: "paragraph" };
};

type ListKind = "bulletList" | "orderedList" | "taskList";
const LIST_ITEM = /^\s{0,3}(?:([-*+])|(\d{1,9})[.)])\s+(.*)$/;
const TASK = /^\[( |x|X)\]\s+(.*)$/;

function listKind(line: string): ListKind | null {
  const match = LIST_ITEM.exec(line);
  if (!match) return null;
  if (match[2]) return "orderedList";
  return TASK.test(match[3]) ? "taskList" : "bulletList";
}

/** Converts markdown to a Tiptap doc. Always returns at least one paragraph. */
export function markdownToDoc(markdown: string): TiptapDoc {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const content: TiptapNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    const fence = /^\s{0,3}(```|~~~)\s*([\w-]{0,20})\s*$/.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith(fence[1])) body.push(lines[i++]);
      i++; // closing fence (or end of input)
      const text = body.join("\n");
      content.push({
        type: "codeBlock",
        attrs: { language: fence[2] || null },
        ...(text ? { content: [{ type: "text", text }] } : {}),
      });
      continue;
    }
    const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      const level = Math.min(heading[1].length, 3);
      const inline = inlineNodes(heading[2]);
      content.push({ type: "heading", attrs: { level }, ...(inline.length ? { content: inline } : {}) });
      i++;
      continue;
    }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      content.push({ type: "horizontalRule" });
      i++;
      continue;
    }
    if (/^\s{0,3}>/.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length && /^\s{0,3}>/.test(lines[i])) quoted.push(lines[i++].replace(/^\s{0,3}>\s?/, ""));
      content.push({ type: "blockquote", content: markdownToDoc(quoted.join("\n")).content });
      continue;
    }
    const kind = listKind(line);
    if (kind) {
      const items: TiptapNode[] = [];
      while (i < lines.length && listKind(lines[i]) === kind) {
        const text = LIST_ITEM.exec(lines[i])![3];
        i++;
        if (kind === "taskList") {
          const task = TASK.exec(text)!;
          items.push({ type: "taskItem", attrs: { checked: task[1] !== " " }, content: [paragraph(task[2])] });
        } else {
          items.push({ type: "listItem", content: [paragraph(text)] });
        }
      }
      content.push({ type: kind, ...(kind === "orderedList" ? { attrs: { start: 1 } } : {}), content: items });
      continue;
    }
    const block: string[] = [];
    while (
      i < lines.length && lines[i].trim() && !listKind(lines[i]) &&
      !/^\s{0,3}(#{1,6}\s|>|```|~~~)/.test(lines[i])
    ) block.push(lines[i++].trim());
    content.push(paragraph(block.join(" ")));
  }
  return { type: "doc", content: content.length ? content : [{ type: "paragraph" }] };
}

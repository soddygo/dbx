import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createAiShikiCodeHighlighter } from "../../apps/desktop/src/lib/aiCodeHighlighter.ts";
import { createAiMessageRenderer } from "../../apps/desktop/src/lib/aiMessageRender.ts";

test("reuses rendered AI message segments for unchanged content", () => {
  let markdownCalls = 0;
  const renderer = createAiMessageRenderer({
    markdown: (text) => {
      markdownCalls++;
      return `<p>${text}</p>`;
    },
  });

  const first = renderer.render("hello **dbx**\n```sql\nSELECT 1\n```");
  const second = renderer.render("hello **dbx**\n```sql\nSELECT 1\n```");

  assert.equal(markdownCalls, 1);
  assert.strictEqual(second, first);
  assert.deepEqual(second, [
    { type: "text", content: "hello **dbx**", html: "<p>hello **dbx**</p>" },
    {
      type: "code",
      content: "SELECT 1",
      html: "SELECT 1",
      lang: "SQL",
      isSql: true,
    },
  ]);
});

test("evicts older rendered AI message cache entries", () => {
  let markdownCalls = 0;
  const renderer = createAiMessageRenderer({
    maxEntries: 2,
    markdown: (text) => {
      markdownCalls++;
      return text;
    },
  });

  renderer.render("one");
  renderer.render("two");
  renderer.render("one");
  renderer.render("three");
  renderer.render("two");

  assert.equal(markdownCalls, 4);
});

test("escapes code blocks before the async highlighter is ready", () => {
  const renderer = createAiMessageRenderer({ markdown: (text) => text });

  const [segment] = renderer.render("```sql\nSELECT '<script>' AS name FROM users WHERE active = true;\n```");

  assert.equal(segment.type, "code");
  if (segment.type !== "code") return;
  assert.equal(segment.lang, "SQL");
  assert.equal(segment.isSql, true);
  assert.match(segment.html, /&lt;script&gt;/);
  assert.doesNotMatch(segment.html, /<script>/);
});

test("uses an injected code highlighter for rendered code segments", () => {
  const renderer = createAiMessageRenderer({
    markdown: (text) => text,
    highlightCode: (content, lang) => `<span data-lang="${lang}">${content}</span>`,
  });

  const [segment] = renderer.render("```sql\nSELECT 1\n```");

  assert.equal(segment.type, "code");
  if (segment.type !== "code") return;
  assert.equal(segment.html, '<span data-lang="SQL">SELECT 1</span>');
});

test("parses shell code fences as non-SQL code", () => {
  const renderer = createAiMessageRenderer({
    markdown: (text) => text,
    highlightCode: (content, lang) => `<span data-lang="${lang}">${content}</span>`,
  });

  const [segment] = renderer.render("```bash\ndocker compose up -d\n```");

  assert.equal(segment.type, "code");
  if (segment.type !== "code") return;
  assert.equal(segment.lang, "BASH");
  assert.equal(segment.isSql, false);
  assert.equal(segment.html, '<span data-lang="BASH">docker compose up -d</span>');
});

test("AI assistant renders Shiki-highlighted code and gates SQL actions", () => {
  const source = readFileSync("apps/desktop/src/components/editor/AiAssistant.vue", "utf8");

  assert.match(source, /createAiShikiCodeHighlighter/);
  assert.match(source, /shikiCodeHighlighter/);
  assert.match(source, /v-html="seg\.html"/);
  assert.match(source, /v-if="seg\.isSql"/);
  assert.doesNotMatch(source, /<code>{{ seg\.content }}<\/code>/);
  assert.doesNotMatch(source, /ai-code-keyword/);
});

test("Shiki AI code highlighter returns inline escaped HTML", async () => {
  const highlight = await createAiShikiCodeHighlighter({ appearance: () => "dark" });

  const html = highlight("SELECT '<script>' AS name", "SQL");

  assert.match(html, /style=/);
  assert.match(html, /(?:&lt;|&#x3C;)script(?:&gt;|>)/);
  assert.doesNotMatch(html, /<script>/);
  assert.doesNotMatch(html, /<pre/);
});

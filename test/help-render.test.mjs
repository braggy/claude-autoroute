// The dashboard's HELP.md renderer, run against a minimal fake DOM. It builds nodes
// (never innerHTML), and only https: and in-app #help/ links may become clickable.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

class Node_ {
  constructor(tag, text) { this.tagName = tag?.toUpperCase(); this.children = []; this.textContent = text ?? ""; }
  append(...kids) { this.children.push(...kids); }
  get text() { return this.children.length ? this.children.map((c) => c.text).join("") : this.textContent; }
}
globalThis.document = {
  createElement: (t) => new Node_(t),
  createTextNode: (t) => new Node_(undefined, t),
};
const { parseHelp, slug } = await import("../src/ui/help.js");
const all = (nodes) => nodes.flatMap((n) => [n, ...all(n.children || [])]);

test("help: sections, questions, paragraphs and search text", () => {
  const [s] = parseHelp("# Title\n\n## Section\n\nIntro.\n\n### How do I start?\n\nRun it.\nTwice.\n");
  assert.equal(s.title, "Section");
  assert.equal(s.intro[0].text, "Intro.");
  const q = s.items[0];
  assert.equal(q.id, "how-do-i-start");
  assert.equal(q.body[0].tagName, "P");
  assert.equal(q.body[0].text, "Run it. Twice.");
  assert.match(q.text, /How do I start\? Run it\. Twice\./);
});

test("help: inline code, bold and lists; numbering continues after a code block", () => {
  const [s] = parseHelp("## S\n### Q\n1. Use `autoroute init`\n2. **Then** check\n\n```\nnpm test\n```\n3. Done\n- a bullet\n");
  const [ol, pre, ol2, ul] = s.items[0].body;
  assert.equal(ol.tagName, "OL"); assert.equal(ol.children.length, 2);
  assert.equal(all([ol]).find((n) => n.tagName === "CODE").textContent, "autoroute init");
  assert.equal(all([ol]).find((n) => n.tagName === "STRONG").textContent, "Then");
  assert.equal(pre.tagName, "PRE"); assert.equal(pre.children[0].textContent, "npm test");
  assert.equal(ol2.start, 3);
  assert.equal(ul.tagName, "UL");
});

test("help: only https and #help/ links are clickable, and outside links open safely", () => {
  const md = "## S\n### Q\n[docs](https://example.com/a) [local](#help/other) [bad](javascript:alert(1)) [data](data:text/html,x) [http](http://example.com) see https://example.com/b.\n";
  const links = all(parseHelp(md)[0].items[0].body).filter((n) => n.tagName === "A");
  assert.deepEqual(links.map((a) => a.href), ["https://example.com/a", "#help/other", "https://example.com/b"]);
  for (const a of links.filter((l) => l.href.startsWith("https:"))) { assert.equal(a.target, "_blank"); assert.equal(a.rel, "noopener noreferrer"); }
  assert.equal(links[1].target, undefined, "in-app links stay in the tab");
  const text = all(parseHelp(md)[0].items[0].body).map((n) => n.textContent).join(" ");
  assert.match(text, /bad/); assert.match(text, /data/, "unsafe links keep their label as plain text");
});

test("help: markup in the text is never interpreted", () => {
  const nodes = all(parseHelp("## S\n### Q\n<img src=x onerror=alert(1)> **<b>bold</b>**\n")[0].items[0].body);
  assert.ok(nodes.every((n) => !["IMG", "B", "SCRIPT"].includes(n.tagName)));
  assert.equal(nodes.find((n) => n.tagName === "STRONG").textContent, "<b>bold</b>");
});

test("help: the real HELP.md parses into unique, linkable questions", () => {
  const sections = parseHelp(fs.readFileSync(new URL("../HELP.md", import.meta.url), "utf8"));
  const ids = sections.flatMap((s) => s.items.map((i) => i.id));
  assert.ok(sections.length >= 6 && ids.length >= 40);
  assert.equal(new Set(ids).size, ids.length, "question ids are unique");
  assert.ok(ids.includes("what-is-the-regret-rate"));
  assert.equal(slug("What's this? (v2)"), "whats-this-v2");
});

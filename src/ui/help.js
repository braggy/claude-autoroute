// Renders HELP.md into the dashboard. A deliberately tiny Markdown subset
// (headings, paragraphs, lists, code, bold, links) built as DOM nodes, never
// innerHTML, so nothing in the file can inject script.

export function slug(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9 -]/g, "").trim().replace(/\s+/g, "-");
}

function inline(text) {
  const out = [];
  const re = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)\s]+\)|https:\/\/[^\s),]+[^\s),.])/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(document.createTextNode(text.slice(last, m.index)));
    const t = m[0];
    if (t.startsWith("`")) { const c = document.createElement("code"); c.textContent = t.slice(1, -1); out.push(c); }
    else if (t.startsWith("**")) { const b = document.createElement("strong"); b.textContent = t.slice(2, -2); out.push(b); }
    else if (t.startsWith("https://")) {
      const a = document.createElement("a");
      a.textContent = t; a.href = t; a.target = "_blank"; a.rel = "noopener noreferrer";
      out.push(a);
    } else {
      const [, label, href] = t.match(/\[([^\]]+)\]\(([^)\s]+)\)/);
      if (/^https:\/\//.test(href) || href.startsWith("#help/")) {
        const a = document.createElement("a");
        a.textContent = label; a.href = href;
        if (href.startsWith("https://")) { a.target = "_blank"; a.rel = "noopener noreferrer"; }
        out.push(a);
      } else out.push(document.createTextNode(label));
    }
    last = re.lastIndex;
  }
  if (last < text.length) out.push(document.createTextNode(text.slice(last)));
  return out;
}

/** Parse HELP.md into [{ title, intro: Node[], items: [{ id, question, body: Node[], text }] }]. */
export function parseHelp(md) {
  const sections = [];
  let section = null, item = null, para = [], list = null, code = null;
  const target = () => (item ? item.body : section ? section.intro : null);
  const flushPara = () => {
    if (para.length && target()) { const p = document.createElement("p"); p.append(...inline(para.join(" "))); target().push(p); }
    para = [];
  };
  const flushList = () => { if (list && target()) target().push(list); list = null; };
  for (const raw of md.split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (code) {
      if (line.startsWith("```")) { const pre = document.createElement("pre"); const c = document.createElement("code"); c.textContent = code.join("\n"); pre.append(c); target()?.push(pre); code = null; }
      else code.push(raw);
      continue;
    }
    if (line.startsWith("```")) { flushPara(); flushList(); code = []; continue; }
    if (line.startsWith("# ")) continue;
    if (line.startsWith("## ")) { flushPara(); flushList(); item = null; section = { title: line.slice(3), intro: [], items: [] }; sections.push(section); continue; }
    if (line.startsWith("### ")) {
      flushPara(); flushList();
      const q = line.slice(4);
      item = { id: slug(q), question: q, body: [], text: q };
      section?.items.push(item);
      continue;
    }
    const li = line.match(/^(\s*)(-|\d+\.)\s+(.*)$/);
    if (li) {
      flushPara();
      const ordered = /\d/.test(li[2]);
      if (!list || (list.tagName === "OL") !== ordered) {
        flushList(); list = document.createElement(ordered ? "ol" : "ul");
        if (ordered && parseInt(li[2], 10) > 1) list.start = parseInt(li[2], 10); // numbering continues after a code block
      }
      const el = document.createElement("li"); el.append(...inline(li[3])); list.append(el);
      if (item) item.text += " " + li[3];
      continue;
    }
    if (!line.trim()) { flushPara(); flushList(); continue; }
    flushList();
    para.push(line.trim());
    if (item) item.text += " " + line.trim();
  }
  flushPara(); flushList();
  return sections;
}

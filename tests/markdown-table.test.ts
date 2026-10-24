import { expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { markdownTableComponents } from "../client/src/components/chat/markdown-table";
it("verdict tables scroll instead of wrapping letter by letter", () => {
  const md = "| Expert | Stance | Confidence | Position |\n|---|---|---|---|\n| Agronomist | **agree** | 4/5 | Rotate fescue |";
  const html = renderToStaticMarkup(createElement("div", { className: "[overflow-wrap:anywhere]" },
    createElement(ReactMarkdown, { remarkPlugins: [remarkGfm], components: markdownTableComponents }, md)));
  expect(html).toContain("overflow-x-auto");
  expect(html).toMatch(/<th class="[^"]*\[overflow-wrap:normal\][^"]*min-w-\[5\.5rem\]/);
  expect(html).toContain("<strong>agree</strong>");
});

import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TableCellMarkdown } from "../client/src/components/artifacts/TableCellMarkdown";
const render = (value: string) => renderToStaticMarkup(createElement(TableCellMarkdown, { value }));
describe("table cell markdown", () => {
  it("renders bold instead of raw asterisks", () => {
    const html = render("**Bud break** (Mar)");
    expect(html).toContain("<strong>Bud break</strong>");
    expect(html).not.toContain("**");
  });
  it("drops non-http links and images", () => {
    const html = render("[x](javascript:alert(1)) ![i](http://a/b.png)");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("<img");
  });
});

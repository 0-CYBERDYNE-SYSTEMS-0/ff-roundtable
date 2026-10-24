import { createElement, Fragment, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

type Kids = { children?: ReactNode };
const frag = ({ children }: Kids) => createElement(Fragment, null, children);

/** Renders inline markdown (bold, italics, code, links) inside a table cell. Written without JSX so tests can import it. */
export function TableCellMarkdown({ value }: { value: string }) {
  return createElement(ReactMarkdown, {
    remarkPlugins: [remarkGfm],
    components: {
      p: frag,
      a: ({ href, children }: Kids & { href?: string }) => href && /^https?:\/\//i.test(href)
        ? createElement("a", { href, target: "_blank", rel: "noopener noreferrer", className: "underline" }, children)
        : createElement(Fragment, null, children),
      img: ({ alt }: { alt?: string }) => createElement(Fragment, null, alt || ""),
    },
  }, value);
}

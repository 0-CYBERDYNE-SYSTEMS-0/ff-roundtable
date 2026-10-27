import { createElement, type ReactNode } from "react";

type Kids = { children?: ReactNode };
// Message bodies use overflow-wrap:anywhere for long URLs; inside tables that
// lets columns collapse to one character. Tables scroll instead, and cells wrap
// only at word boundaries. px-3 padding plus a 0.25rem column gap keeps
// adjacent cells ("Specialist" | "conditional") visibly apart. The table is
// full width (not w-max) so long prose cells like Position wrap instead of
// forcing a horizontal scroll; per-cell minimums still stop letter-wrapping.
const cell = "border border-neutral-200 px-3 py-1.5 whitespace-normal align-top text-left [overflow-wrap:normal] [word-break:normal] min-w-[5.5rem]";

export const markdownTableComponents = {
  table: ({ children }: Kids) => createElement("div", { className: "my-2 max-w-full overflow-x-auto" },
    createElement("table", { className: "w-full border-separate border-spacing-x-1 border-spacing-y-0 text-sm" }, children)),
  th: ({ children }: Kids) => createElement("th", { className: `${cell} bg-neutral-100 font-semibold` }, children),
  td: ({ children }: Kids) => createElement("td", { className: cell }, children),
};

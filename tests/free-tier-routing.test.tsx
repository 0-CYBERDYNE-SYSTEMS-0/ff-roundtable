import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { beforeEach, describe, expect, it, vi } from "vitest";

const auth = { user: null as null | { tier: string | null; subscriptionStatus: string }, isLoading: false };

// The server-oriented Vitest config preserves JSX. Compile this client route
// locally so the regression runs without changing shared test configuration.
const source = readFileSync(new URL("../client/src/lib/protected-route.tsx", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React },
});
const router = {
  Route: ({ component: Component, children }: { component?: React.ComponentType; children?: React.ReactNode }) =>
    Component ? React.createElement(Component) : children,
  Redirect: ({ to }: { to: string }) => React.createElement("span", { "data-redirect": to }),
};
const exports: { ProtectedRoute?: React.ComponentType<{ path: string; component: React.ComponentType }> } = {};
new Function("require", "exports", "React", outputText)((name: string) => {
  if (name === "@/hooks/use-auth") return { useAuth: () => auth };
  if (name === "wouter") return router;
  if (name === "lucide-react") return { Loader2: () => React.createElement("span", null, "Loading") };
  throw new Error(`Unexpected route dependency: ${name}`);
}, exports, React);
const ProtectedRoute = exports.ProtectedRoute!;

function renderRoute() {
  return renderToStaticMarkup(
    React.createElement(ProtectedRoute, { path: "/", component: () => React.createElement("main", null, "Farm workspace") }),
  );
}

describe("Free-tier app routing", () => {
  beforeEach(() => {
    auth.user = null;
    auth.isLoading = false;
  });

  it.each([null, "free", "pro"])("lets signed-in %s users enter without an active subscription", (tier) => {
    auth.user = { tier, subscriptionStatus: "inactive" };
    expect(renderRoute()).toContain("Farm workspace");
    expect(renderRoute()).not.toContain('data-redirect="/subscribe"');
  });

  it("keeps signed-out users behind sign-in", () => {
    expect(renderRoute()).toContain('data-redirect="/auth"');
  });

  it("waits for authentication before rendering the workspace", () => {
    auth.isLoading = true;
    expect(renderRoute()).not.toContain("Farm workspace");
    expect(renderRoute()).not.toContain("data-redirect");
  });
});

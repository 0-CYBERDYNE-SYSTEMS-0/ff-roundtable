import { expect, it, vi } from "vitest";
const { constructor } = vi.hoisted(() => ({ constructor: vi.fn() }));
vi.mock("pg", () => ({ Pool: class { constructor(options: unknown) { constructor(options); } } }));
import { getDatabasePool } from "../server/database-pool";

it("reuses one shared pool with the original UTC and connection-limit settings", () => {
  const first = getDatabasePool("postgresql://localhost/test");
  expect(getDatabasePool()).toBe(first);
  expect(constructor).toHaveBeenCalledOnce();
  expect(constructor).toHaveBeenCalledWith({
    connectionString: "postgresql://localhost/test", max: 10, options: "-c timezone=UTC",
  });
});

import { Pool } from "pg";

let sharedPool: Pool | undefined;

/** One pool for application storage, sessions and the Free spend ledger. */
export function getDatabasePool(databaseUrl = process.env.DATABASE_URL): Pool {
  if (sharedPool) return sharedPool;
  if (!databaseUrl) throw new Error("Database is not configured");
  return sharedPool ??= new Pool({
    connectionString: databaseUrl,
    max: 10,
    options: "-c timezone=UTC",
  });
}

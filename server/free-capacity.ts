import { getDatabasePool } from "./database-pool";
import { FREE_DAILY_SPEND_USD, pacificSpendDay } from "@shared/free-plan";
import { UsageCapError } from "./usage-caps";

// Short transactions on the shared pool; no lock held during a provider call.
export const FREE_CALL_RESERVATION_USD = 0.1;
export const freeCapacityDenial = () => new UsageCapError({
  status: 429, code: "free_capacity_used",
  message: "Free capacity is used up for today, try tomorrow or upgrade to Pro",
  upgradeUrl: "/subscribe",
});

export async function assertFreeCapacity(): Promise<void> {
  const { rows } = await getDatabasePool().query("SELECT charged_usd FROM free_spend_days WHERE day = $1", [pacificSpendDay()]);
  if (Number(rows[0]?.charged_usd ?? 0) + FREE_CALL_RESERVATION_USD > FREE_DAILY_SPEND_USD + 1e-9) throw freeCapacityDenial();
}

export async function reserveFreeCall(id: string, userId: number, model: string): Promise<void> {
  const client = await getDatabasePool().connect();
  try {
    await client.query("BEGIN");
    const day = pacificSpendDay();
    await client.query("INSERT INTO free_spend_days(day) VALUES ($1) ON CONFLICT DO NOTHING", [day]);
    const admitted = await client.query(
      "UPDATE free_spend_days SET charged_usd = charged_usd + $2 WHERE day = $1 AND charged_usd + $2 <= $3 + 0.000000001 RETURNING day",
      [day, FREE_CALL_RESERVATION_USD, FREE_DAILY_SPEND_USD],
    );
    if (!admitted.rowCount) throw freeCapacityDenial();
    await client.query("INSERT INTO free_ai_calls(id, day, user_id, model, reserved_usd) VALUES ($1,$2,$3,$4,$5)",
      [id, day, userId, model, FREE_CALL_RESERVATION_USD]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}

export async function settleFreeCall(id: string, result: string, usage: any, metadata: {
  generationId?: string; responseModel?: string;
}): Promise<void> {
  const raw = usage?.cost ?? usage?.total_cost ?? usage?.totalCost;
  const cost = raw !== null && raw !== undefined && Number.isFinite(Number(raw)) && Number(raw) >= 0 ? Number(raw) : null;
  const client = await getDatabasePool().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `UPDATE free_ai_calls SET result=$2, cost_usd=$3, actual_model=$4, generation_id=$5,
       prompt_tokens=$6, completion_tokens=$7, reasoning_tokens=$8
       WHERE id=$1 AND result='pending' RETURNING day,reserved_usd`,
      [id, result, cost, metadata.responseModel ?? null, metadata.generationId ?? null,
        usage?.prompt_tokens ?? null, usage?.completion_tokens ?? null,
        usage?.completion_tokens_details?.reasoning_tokens ?? null],
    );
    if (rows[0] && (cost !== null || result === "failed")) {
      await client.query("UPDATE free_spend_days SET charged_usd = charged_usd + $2 WHERE day=$1",
        [rows[0].day, (cost ?? 0) - Number(rows[0].reserved_usd)]);
      if (result === "failed") {
        await client.query("UPDATE free_ai_calls SET reserved_usd=0 WHERE id=$1", [id]);
      }
    }
    // Failed calls release reservations; reported real cost still counts.
    // Successful calls with missing cost retain their reservation.
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}

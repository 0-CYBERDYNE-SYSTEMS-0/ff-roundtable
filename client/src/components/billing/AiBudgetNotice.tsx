import { useQuery } from "@tanstack/react-query";

type TierInfo = { aiBudgetExhausted?: boolean; aiBudgetNotice?: string };

/**
 * Friendly notice shown when a Pro user's monthly AI budget is spent. Paid
 * calls fall back to free models server-side, so nothing is broken; this just
 * explains why answers may feel different until the 1st.
 */
export default function AiBudgetNotice() {
  const { data } = useQuery<TierInfo | null>({
    queryKey: ["/api/user/tier"],
    queryFn: async () => {
      const res = await fetch("/api/user/tier", { credentials: "include" });
      return res.ok ? res.json() : null;
    },
    refetchInterval: 60_000,
  });
  if (!data?.aiBudgetExhausted) return null;
  return (
    <div role="status" className="mx-4 mt-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
      {data.aiBudgetNotice || "You've used this month's included fast models; experts are on free models until the 1st."}
    </div>
  );
}

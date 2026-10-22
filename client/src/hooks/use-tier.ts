import { useQuery } from "@tanstack/react-query";

export interface UserTierResponse {
  tier: string;
  limits?: {
    maxExperts?: number;
    maxMessages?: number;
    allowPaidModels?: boolean;
    name?: string;
    messagesPerMinute?: number;
    messagesPerDay?: number;
    maxMessagesPerMinute?: number;
    maxMessagesPerDay?: number;
  };
  usage?: {
    period?: string;
    messages?: number;
  };
}

export function useTier() {
  return useQuery<UserTierResponse>({
    queryKey: ["/api/user/tier"],
    queryFn: async () => {
      const response = await fetch("/api/user/tier", { credentials: "include" });
      if (!response.ok) throw new Error("Unable to load plan usage");
      return response.json() as Promise<UserTierResponse>;
    },
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    staleTime: 30_000,
  });
}

export function friendlyLimitError(error: unknown): { message: string; isLimit: boolean } {
  const raw = error instanceof Error ? error.message : "";
  let body: { code?: string; message?: string; upgradeUrl?: string } | undefined;
  const firstBrace = raw.indexOf("{");
  if (firstBrace >= 0) {
    try {
      body = JSON.parse(raw.slice(firstBrace)) as { code?: string; message?: string; upgradeUrl?: string };
    } catch {
      body = undefined;
    }
  }
  const messages: Record<string, string> = {
    free_minute_limit: "You’ve reached the Free plan’s 10 messages per minute. Take a short pause, then try again.",
    free_daily_limit: "You’ve used today’s 25 Free messages. Your daily allowance resets at midnight UTC.",
    message_limit_reached: "You’ve used the 100 messages included each month on Free. Upgrade to Pro to keep the roundtable going.",
    TIER_LIMIT_EXPERTS: "The Free plan includes up to 3 experts in a roundtable. Upgrade to Pro for up to 8.",
    TIER_LIMIT_MODEL: "That model is available on Pro. Choose a free model or upgrade your plan.",
  };
  if (body?.code && messages[body.code]) return { message: body.message || messages[body.code], isLimit: true };
  return {
    message: body?.message || raw.replace(/^\d{3}:\s*/, "") || "Something went wrong. Please try again.",
    isLimit: Boolean(body?.upgradeUrl),
  };
}

/** Exact house-key models included in the Free trial. Not the Pro allowlist. */
export const FREE_EXPERT_MODELS = [
  "anthropic/claude-haiku-5.5",
  "minimax/minimax-m3.1-flash",
  "z-ai/glm-5.3-flash",
] as const;
export const FREE_MODERATOR_MODEL = "xiaomi/mimo-v2.6-pro";
export const FREE_ALLOWED_MODELS: readonly string[] = [...FREE_EXPERT_MODELS, FREE_MODERATOR_MODEL];
export const FREE_ROUNDTABLES_PER_MONTH = 30;
export const FREE_DAILY_SPEND_USD = 5;
export function isFreeExpertModel(model: string): boolean {
  return (FREE_EXPERT_MODELS as readonly string[]).includes(model);
}
export function pacificSpendDay(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const part = (type: string) => parts.find(p => p.type === type)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

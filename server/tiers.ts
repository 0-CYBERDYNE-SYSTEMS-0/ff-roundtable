export const TIERS = {
  free: {
    maxExperts: 3,
    maxMessages: 100,
    allowPaidModels: false,
    name: "Free",
  },
  pro: {
    maxExperts: 8,
    maxMessages: 1000,
    allowPaidModels: true,
    name: "Pro",
  },
  enterprise: {
    maxExperts: 999,
    maxMessages: 999999,
    allowPaidModels: true,
    name: "Enterprise",
  },
} as const;

export type TierKey = keyof typeof TIERS;

export type TierLimits = {
  maxExperts: number;
  maxMessages: number;
  allowPaidModels: boolean;
  name: string;
};

export function getTierLimits(tier: string): TierLimits {
  const key = tier as TierKey;
  const t = TIERS[key] ?? TIERS.free;
  return { ...t };
}

export function isPaidModel(modelId: string): boolean {
  return !modelId.endsWith(":free");
}

export function isFreeModel(modelId: string): boolean {
  return modelId.endsWith(":free");
}

import { Link } from "wouter";
import { useTier } from "@/hooks/use-tier";
import UpgradeToProButton from "@/components/billing/UpgradeToProButton";

export default function UsageMeter() {
  const { data: tier, isLoading, isError } = useTier();
  if (isLoading) {
    return <div className="h-8 w-36 animate-pulse rounded-full bg-white/15" aria-label="Loading plan usage" />;
  }
  if (isError || !tier) return null;
  const isFree = tier.tier.toLowerCase() === "free";
  const limit = tier.limits?.maxMessages;
  const used = tier.usage?.messages ?? 0;
  if (!isFree || !limit) {
    return (
      <Link href="/subscribe" className="hidden rounded-full border border-white/25 px-3 py-1.5 text-xs font-medium text-white/90 transition-colors hover:bg-white/10 sm:inline-flex">
        {tier.limits?.name || tier.tier} plan
      </Link>
    );
  }
  const percentage = Math.min(100, Math.round((used / limit) * 100));
  return (
    <div className="flex items-center gap-2.5 rounded-full border border-white/20 bg-black/10 px-2.5 py-1.5 text-white sm:px-3" aria-label={`${used} of ${limit} monthly messages used`}>
      <span className="whitespace-nowrap text-[11px] font-medium sm:text-xs">{used} / {limit}<span className="hidden sm:inline"> messages</span></span>
      <span className="hidden h-1.5 w-12 overflow-hidden rounded-full bg-white/25 sm:block" aria-hidden="true">
        <span className="block h-full rounded-full bg-[#e7c17d] transition-[width] duration-300" style={{ width: `${percentage}%` }} />
      </span>
      <UpgradeToProButton label="Pro" className="h-7 rounded-full bg-[#f2eee1] px-2.5 text-[11px] text-[#24372b] hover:bg-white" />
    </div>
  );
}

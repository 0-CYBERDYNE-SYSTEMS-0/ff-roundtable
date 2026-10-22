import { useState } from "react";
import { Link } from "wouter";
import { useAuth } from "@/hooks/use-auth";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { ArrowRight, CheckCircle2, Loader2 } from "lucide-react";

type BillingInterval = "month" | "year";
const ENTERPRISE_CONTACT_URL = import.meta.env.VITE_ENTERPRISE_CONTACT_URL as string | undefined;
const PLAN_FEATURES = {
  free: ["Up to 3 farm experts in a roundtable", "100 messages each month", "25 messages per day · 10 per minute", "Free AI models"],
  pro: [
    "Up to 8 specialized AI agricultural experts",
    "1,000 messages a month",
    "$4/month premium-AI budget, then gracefully switches to free models",
    "File creation, web research and markdown export",
    "Any other model with your own OpenRouter key",
  ],
  enterprise: ["Unlimited experts and messages", "Custom models and tailored workflows", "Support for your operation"],
};

function FeatureList({ features }: { features: string[] }) {
  return <ul className="ff-plan-list">{features.map((feature) => (
    <li key={feature}><CheckCircle2 className="ff-check" size={16} aria-hidden="true" /><span>{feature}</span></li>
  ))}</ul>;
}

function billingError(error: unknown) {
  const raw = error instanceof Error ? error.message : "";
  const brace = raw.indexOf("{");
  if (brace >= 0) {
    try {
      const body = JSON.parse(raw.slice(brace)) as { message?: string };
      if (body.message) return body.message;
    } catch { /* Use the readable fallback below. */ }
  }
  return raw.replace(/^\d{3}:\s*/, "") || "Subscriptions are temporarily unavailable. Please try again later.";
}

export default function PricingPlans({ embedded = false }: { embedded?: boolean }) {
  const { user, isLoading } = useAuth();
  const { toast } = useToast();
  const [interval, setInterval] = useState<BillingInterval>("month");
  const [isRedirecting, setIsRedirecting] = useState(false);

  const startCheckout = async () => {
    if (!user || isRedirecting) return;
    setIsRedirecting(true);
    try {
      const response = await apiRequest("POST", "/api/create-checkout-session", { interval });
      const data = await response.json() as { url?: string; message?: string };
      if (!data.url) throw new Error(data.message || "No checkout URL was returned.");
      window.location.assign(data.url);
    } catch (error) {
      toast({ title: "Subscriptions unavailable", description: billingError(error), variant: "destructive" });
      setIsRedirecting(false);
    }
  };
  const startFree = user ? <Button className="ff-button" asChild><Link href="/">Go to your roundtable <ArrowRight size={15} aria-hidden="true" /></Link></Button>
    : <Button className="ff-button" asChild><Link href="/sign-up">Start free <ArrowRight size={15} aria-hidden="true" /></Link></Button>;
  const proAction = user
    ? <Button className="ff-button ff-button-dark" onClick={startCheckout} disabled={isLoading || isRedirecting}>{isRedirecting ? <><Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />Opening checkout…</> : "Choose Pro"}</Button>
    : <Button className="ff-button ff-button-dark" asChild><Link href="/sign-up">Start with Pro <ArrowRight size={15} aria-hidden="true" /></Link></Button>;
  const contactAction = ENTERPRISE_CONTACT_URL
    ? <Button className="ff-button ff-button-dark" asChild><a href={ENTERPRISE_CONTACT_URL} target="_blank" rel="noreferrer">Contact us <ArrowRight size={15} aria-hidden="true" /></a></Button>
    : <Button className="ff-button ff-button-dark" asChild><a href="mailto:admin@farm-friend.com?subject=FarmFriend%20Roundtable%20Enterprise">Contact us</a></Button>;

  return (
    <>
      <div className={embedded ? "ff-pricing-intro" : "ff-pricing-intro"}>
        <div className="ff-section-kicker">{embedded ? "A good place to begin" : "Plans for every season"}</div>
        <h1>{embedded ? "Start with what you need." : "Good advice, on your terms."}</h1>
        <p>{embedded ? "Try the roundtable free, then bring more voices to the table when your operation is ready." : "Bring more expertise to the table with Pro, or talk to us about your operation."}</p>
        {!embedded && <p className="ff-pricing-free-note">Free to start. No card needed.</p>}
        <div className="ff-billing-toggle" role="group" aria-label="Pro billing interval">
          <button type="button" aria-pressed={interval === "month"} onClick={() => setInterval("month")}>Monthly</button>
          <button type="button" aria-pressed={interval === "year"} onClick={() => setInterval("year")}>Annual <span className="ff-billing-savings">2 months free</span></button>
        </div>
      </div>
      <section className="ff-plan-grid ff-plan-grid-three" aria-label="Available plans">
        <article className="ff-plan ff-plan-free">
          <h2>Free</h2>
          <p className="ff-plan-description">A thoughtful second opinion for the work at hand.</p>
          <p className="ff-plan-price">$0 <span>/ always</span></p>
          <p className="ff-plan-note">No card needed.</p>
          <FeatureList features={PLAN_FEATURES.free} />
          {startFree}
        </article>
        <article className="ff-plan ff-plan-pro">
          <div className="ff-popular">Most popular</div>
          <h2>Pro</h2>
          <p className="ff-plan-description">More voices at the table for bigger questions.</p>
          <p className="ff-plan-price">{interval === "month" ? "$10" : "$96"} <span>{interval === "month" ? "/ month" : "/ year"}</span></p>
          <p className="ff-plan-note">{interval === "month" ? "Billed monthly. Cancel anytime." : "Billed yearly. 2 months free."}</p>
          <FeatureList features={PLAN_FEATURES.pro} />
          {proAction}
        </article>
        <article className="ff-plan ff-plan-enterprise">
          <h2>Enterprise</h2>
          <p className="ff-plan-description">A plan shaped around the needs of your operation.</p>
          <p className="ff-plan-price">Let’s talk</p>
          <p className="ff-plan-note">Custom scope and support.</p>
          <FeatureList features={PLAN_FEATURES.enterprise} />
          {contactAction}
        </article>
      </section>
      <p className="ff-pricing-note">Pro includes a $4 monthly premium-AI budget; after it is used, conversations continue on free models within your Pro subscription.</p>
    </>
  );
}

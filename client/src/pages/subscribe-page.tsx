import { useState } from "react";
import { Link } from "wouter";
import { useAuth } from "@/hooks/use-auth";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ArrowLeft, Check, CheckCircle2, Loader2 } from "lucide-react";
import "../styles/public-pages.css";

type BillingInterval = "month" | "year";
const PLAN_LABELS: Record<BillingInterval, { price: string; note: string }> = {
  month: { price: "$10/month", note: "Billed monthly. Cancel anytime." },
  year: { price: "$96/year", note: "Billed yearly." },
};
const ENTERPRISE_CONTACT_URL = import.meta.env.VITE_ENTERPRISE_CONTACT_URL as string | undefined;
const FREE_FEATURES = [
  "Up to 3 specialized farm experts",
  "100 messages each month",
  "Free AI models",
  "Saved sessions and rich answers",
];
const PRO_FEATURES = [
  "Up to 8 specialized AI agricultural experts",
  "1,000 messages a month",
  "$4/month premium-AI budget, then gracefully switches to free models",
  "File creation, web research and markdown export",
  "Any other model with your own OpenRouter key",
];
const ENTERPRISE_FEATURES = [
  "Unlimited experts and messages",
  "Custom models and tailored workflows",
  "Support for your operation",
];

function friendlyBillingMessage(err: unknown): string {
  const fallback = "Subscriptions are temporarily unavailable. You can keep using the free plan; please try again later.";
  const text = err instanceof Error ? err.message : "";
  const json = text.slice(text.indexOf("{"));
  try {
    const body = JSON.parse(json);
    if (typeof body?.message === "string") return body.message;
  } catch { /* not JSON */ }
  return fallback;
}

function FeatureList({ features }: { features: string[] }) {
  return (
    <ul className="ff-plan-list">
      {features.map((feature) => (
        <li key={feature}><CheckCircle2 className="ff-check" size={16} aria-hidden="true" /><span>{feature}</span></li>
      ))}
    </ul>
  );
}

export default function SubscribePage() {
  const { user, isLoading: isAuthLoading } = useAuth();
  const { toast } = useToast();
  const [isRedirecting, setIsRedirecting] = useState(false);
  const [interval, setBillingInterval] = useState<BillingInterval>("month");
  const [contactOpen, setContactOpen] = useState(false);
  const plan = PLAN_LABELS[interval];

  const startCheckout = async () => {
    if (!user) return;
    setIsRedirecting(true);
    try {
      const res = await apiRequest("POST", "/api/create-checkout-session", { interval });
      const data = await res.json();
      if (data?.url) {
        window.location.href = data.url;
        return;
      }
      throw new Error(data?.message || "No checkout URL returned");
    } catch (err) {
      toast({ title: "Subscriptions unavailable", description: friendlyBillingMessage(err), variant: "destructive" });
      setIsRedirecting(false);
    }
  };

  const proAction = !user
    ? <Button className="ff-button ff-button-dark" asChild><Link href="/sign-up">Start with Pro</Link></Button>
    : <Button className="ff-button ff-button-dark" onClick={startCheckout} disabled={isAuthLoading || isRedirecting}>
        {isRedirecting ? <><Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />Opening checkout…</> : `Choose Pro · ${plan.price}`}
      </Button>;

  return (
    <main className="ff-public ff-pricing-page">
      <header className="ff-pricing-header">
        <div className="ff-pricing-header-inner">
          <Link href="/" className="ff-pricing-brand"><img src="/logo.jpeg" alt="" /><span>Farm Friend Roundtable</span></Link>
          {user ? <Link className="ff-button ff-button-dark" href="/">Go to your farm <ArrowLeft size={14} aria-hidden="true" /></Link> : <Link className="ff-button ff-button-dark" href="/sign-in">Sign in</Link>}
        </div>
      </header>
      <section className="ff-pricing-intro">
        <div className="ff-section-kicker">Plans for every season</div>
        <h1>Good advice, on your terms.</h1>
        <p>Start free and bring more expertise to the table when your work calls for it.</p>
        <div className="ff-billing-toggle" role="group" aria-label="Billing interval">
          <button type="button" aria-pressed={interval === "month"} onClick={() => setBillingInterval("month")}>Monthly</button>
          <button type="button" aria-pressed={interval === "year"} onClick={() => setBillingInterval("year")}>Annual <span className="ff-billing-savings">2 months free</span></button>
        </div>
      </section>
      <section className="ff-plan-grid" aria-label="Available plans">
        <article className="ff-plan">
          <h2>Free</h2>
          <p className="ff-plan-description">A solid place to begin exploring farm questions.</p>
          <p className="ff-plan-price">$0 <span>/ forever</span></p>
          <p className="ff-plan-note">No card required.</p>
          <FeatureList features={FREE_FEATURES} />
          <Button className="ff-button ff-button-dark" asChild><Link href={user ? "/" : "/sign-up"}>{user ? "Your current starting point" : "Get started free"}</Link></Button>
        </article>
        <article className="ff-plan ff-plan-pro">
          <div className="ff-popular">Most popular</div>
          <h2>Pro</h2>
          <p className="ff-plan-description">More voices at the table for bigger questions.</p>
          <p className="ff-plan-price">{interval === "month" ? "$10" : "$96"} <span>{interval === "month" ? "/ month" : "/ year"}</span></p>
          <p className="ff-plan-note">{interval === "month" ? PLAN_LABELS.month.note : `${PLAN_LABELS.year.note} 2 months free.`}</p>
          <FeatureList features={PRO_FEATURES} />
          {proAction}
        </article>
        <article className="ff-plan">
          <h2>Enterprise</h2>
          <p className="ff-plan-description">A plan shaped around the needs of your operation.</p>
          <p className="ff-plan-price">Let’s talk</p>
          <p className="ff-plan-note">Custom scope and support.</p>
          <FeatureList features={ENTERPRISE_FEATURES} />
          {ENTERPRISE_CONTACT_URL
            ? <Button className="ff-button ff-button-dark" asChild><a href={ENTERPRISE_CONTACT_URL} target="_blank" rel="noreferrer">Contact us</a></Button>
            : <Button className="ff-button ff-button-dark" onClick={() => setContactOpen(true)}>Contact us</Button>}
        </article>
      </section>
      <p className="ff-pricing-note">The Free plan remains available whether you choose Pro or not. Pro includes a $4 monthly premium-AI budget; after it is used, conversations continue on free models.</p>
      <footer className="ff-footer">
        <div className="ff-footer-inner"><Link href="/">Back to Farm Friend</Link><span>Practical perspective for the work ahead.</span></div>
      </footer>
      <Dialog open={contactOpen} onOpenChange={setContactOpen}>
        <DialogContent className="ff-contact-dialog">
          <DialogHeader>
            <DialogTitle>Let’s talk about your operation.</DialogTitle>
            <DialogDescription>
              Enterprise plans are tailored around your team, models and workflow. A contact destination has not been configured for this site yet, so we can’t open an email or booking request here.
            </DialogDescription>
          </DialogHeader>
          <p>In the meantime, you can create a free account or choose Pro to explore the roundtable with your farm questions.</p>
          <DialogFooter className="ff-dialog-actions">
            <Button variant="outline" onClick={() => setContactOpen(false)}>Close</Button>
            {!user && <Button asChild className="ff-button ff-button-dark"><Link href="/sign-up"><Check size={15} aria-hidden="true" />Start free</Link></Button>}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  );
}

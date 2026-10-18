import { useState } from 'react';
import { useAuth } from '@/hooks/use-auth';
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Loader2, CheckCircle2 } from "lucide-react";
import { Redirect } from 'wouter';
import Header from "@/components/layout/Header";

// Pro checkout goes through Stripe Checkout (/api/create-checkout-session).
// The client sends only an interval; the server maps it to
// STRIPE_PRICE_ID_PRO (monthly) or STRIPE_PRICE_ID_PRO_ANNUAL (yearly).
type BillingInterval = "month" | "year";
const PLAN_LABELS: Record<BillingInterval, { price: string; note: string }> = {
  month: { price: "$10/month", note: "Billed monthly. Cancel anytime." },
  year: { price: "$96/year", note: "Save 20% (equal to $8/month). Billed yearly." },
};

// Enterprise is sales-led. TODO: set VITE_ENTERPRISE_CONTACT_URL to a
// mailto: or Calendly link; no contact link exists in the repo yet.
const ENTERPRISE_CONTACT_URL = import.meta.env.VITE_ENTERPRISE_CONTACT_URL as string | undefined;

// apiRequest throws "<status>: <body>". Only ever show the server's
// friendly `message` field, never raw provider text.
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

const PRO_FEATURES = [
  "Up to 8 specialized AI agricultural experts",
  "1,000 messages a month (one message = one question you send)",
  "Included fast models: GLM 5.3 Flash, DeepSeek V4.1 Flash, MiMo V2.6 Flash, GPT-6 Luna (monthly allowance; free models after that)",
  "Any other model with your own OpenRouter key",
  "File creation, web research and markdown export",
];

export default function SubscribePage() {
  const { user, isLoading: isAuthLoading } = useAuth();
  const { toast } = useToast();
  const [isRedirecting, setIsRedirecting] = useState(false);
  const [interval, setBillingInterval] = useState<BillingInterval>("month");
  const plan = PLAN_LABELS[interval];

  if (!isAuthLoading && !user) {
    return <Redirect to="/auth" />;
  }

  const startCheckout = async () => {
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

  return (
    <div className="min-h-screen flex flex-col">
      <Header />
      <div className="flex flex-grow">
        <div className="container mx-auto grid md:grid-cols-2 gap-8 p-6 items-start">
          <Card>
            <CardHeader>
              <CardTitle>Pro</CardTitle>
              <div className="inline-flex rounded-md border p-1 w-fit" role="group" aria-label="Billing interval">
                {(["month", "year"] as const).map((value) => (
                  <Button
                    key={value}
                    type="button"
                    size="sm"
                    variant={interval === value ? "default" : "ghost"}
                    aria-pressed={interval === value}
                    onClick={() => setBillingInterval(value)}
                  >
                    {value === "month" ? "Monthly" : "Annual (save 20%)"}
                  </Button>
                ))}
              </div>
              <CardDescription>
                <span className="text-2xl font-semibold text-foreground">{plan.price}</span>{" "}
                {plan.note} No free trial; the Free plan stays free.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ul className="space-y-3">
                {PRO_FEATURES.map((feature) => (
                  <li key={feature} className="flex items-start">
                    <CheckCircle2 className="h-5 w-5 text-primary mr-2 mt-0.5" />
                    <span>{feature}</span>
                  </li>
                ))}
              </ul>
            </CardContent>
            <CardFooter>
              <Button className="w-full" onClick={startCheckout} disabled={isAuthLoading || isRedirecting}>
                {isRedirecting ? (<><Loader2 className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none" />Opening checkout...</>) : `Subscribe - ${plan.price}`}
              </Button>
            </CardFooter>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Enterprise</CardTitle>
              <CardDescription>Unlimited experts and messages, custom models and support.</CardDescription>
            </CardHeader>
            <CardFooter>
              {ENTERPRISE_CONTACT_URL ? (
                <Button asChild variant="outline" className="w-full">
                  <a href={ENTERPRISE_CONTACT_URL}>Contact us</a>
                </Button>
              ) : (
                <Button variant="outline" className="w-full" disabled>Contact us</Button>
              )}
            </CardFooter>
          </Card>
        </div>
      </div>
    </div>
  );
}

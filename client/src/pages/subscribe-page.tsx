import { useState } from 'react';
import { useAuth } from '@/hooks/use-auth';
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Loader2, CheckCircle2 } from "lucide-react";
import { Redirect } from 'wouter';
import Header from "@/components/layout/Header";

// Pro checkout goes through Stripe Checkout (/api/create-checkout-session,
// STRIPE_PRICE_ID_PRO). The old in-page PaymentElement flow
// (/api/create-subscription) is retired.
const PRO_PRICE_LABEL = "$20/month";

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
  "Included fast models: GLM 5.3 Flash, DeepSeek V4.1 Flash, MiMo V2.6 Flash, GPT-6 Luna",
  "Any other model with your own OpenRouter key",
  "File creation, web research and markdown export",
];

export default function SubscribePage() {
  const { user, isLoading: isAuthLoading } = useAuth();
  const { toast } = useToast();
  const [isRedirecting, setIsRedirecting] = useState(false);

  if (!isAuthLoading && !user) {
    return <Redirect to="/auth" />;
  }

  const startCheckout = async () => {
    setIsRedirecting(true);
    try {
      const res = await apiRequest("POST", "/api/create-checkout-session");
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
              <CardDescription>{PRO_PRICE_LABEL}. Cancel anytime. No free trial; the Free plan stays free.</CardDescription>
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
                {isRedirecting ? (<><Loader2 className="mr-2 h-4 w-4 animate-spin" />Opening checkout...</>) : `Subscribe - ${PRO_PRICE_LABEL}`}
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

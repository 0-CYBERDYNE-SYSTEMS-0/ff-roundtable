import { useEffect, useState } from 'react';
import { useAuth } from '@/hooks/use-auth';
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Loader2, CheckCircle2, AlertTriangle } from "lucide-react";
import { useStripe, Elements, PaymentElement, useElements } from '@stripe/react-stripe-js';
import { loadStripe } from '@stripe/stripe-js';
import { Redirect } from 'wouter';
import Header from "@/components/layout/Header";
import { queryClient } from '@/lib/queryClient';

// Development mode flag - uses Vite's env to determine dev vs production
const DEVELOPMENT_MODE = import.meta.env.DEV;

// Check for Stripe public key
const stripeKey = import.meta.env.VITE_STRIPE_PUBLIC_KEY;
if (!stripeKey && !DEVELOPMENT_MODE) {
  console.error('Missing required Stripe key: VITE_STRIPE_PUBLIC_KEY');
}

// Initialize Stripe outside component render
const stripePromise = stripeKey ? loadStripe(stripeKey) : null;

function PaymentForm() {
  const stripe = useStripe();
  const elements = useElements();
  const { toast } = useToast();
  const [isLoading, setIsLoading] = useState(false);
  const [isCompleted, setIsCompleted] = useState(false);
  
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!stripe || !elements) {
      return;
    }

    setIsLoading(true);

    const { error } = await stripe.confirmPayment({
      elements,
      confirmParams: {
        return_url: window.location.origin,
      },
      redirect: 'if_required'
    });

    if (error) {
      toast({
        title: "Payment Failed",
        description: error.message,
        variant: "destructive",
      });
      setIsLoading(false);
    } else {
      toast({
        title: "Payment Successful",
        description: "Thank you for subscribing to Farm Friend Roundtable!",
      });
      setIsCompleted(true);
      // Wait 2 seconds before redirecting to home page
      setTimeout(() => {
        window.location.href = '/';
      }, 2000);
    }
  }

  if (isCompleted) {
    return (
      <div className="text-center py-8">
        <CheckCircle2 className="w-16 h-16 text-green-500 mx-auto mb-4" />
        <h3 className="text-xl font-bold">Payment Successful!</h3>
        <p className="mb-4">Thank you for subscribing to Farm Friend Roundtable.</p>
        <p className="text-sm text-neutral-500">Redirecting to dashboard...</p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit}>
      <PaymentElement className="mb-6" />
      <Button 
        type="submit" 
        className="w-full" 
        disabled={!stripe || isLoading}
      >
        {isLoading ? (
          <>
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Processing...
          </>
        ) : (
          "Subscribe Now - $10/month"
        )}
      </Button>
    </form>
  );
}

export default function SubscribePage() {
  const { user, isLoading: isAuthLoading } = useAuth();
  const [clientSecret, setClientSecret] = useState("");
  const [isLoadingSecret, setIsLoadingSecret] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { toast } = useToast();

  useEffect(() => {
    if (user) {
      // Create subscription
      setIsLoadingSecret(true);
      apiRequest("POST", "/api/create-subscription")
        .then((res) => res.json())
        .then((data) => {
          if (data.clientSecret) {
            setClientSecret(data.clientSecret);
          } else if (data.message) {
            setError(data.message);
            toast({
              title: "Subscription Error",
              description: data.message,
              variant: "destructive",
            });
          }
          setIsLoadingSecret(false);
        })
        .catch((err) => {
          console.error("Subscription error:", err);
          setError(err.message || "Failed to create subscription. Please try again.");
          toast({
            title: "Subscription Error",
            description: err.message || "Failed to create subscription",
            variant: "destructive",
          });
          setIsLoadingSecret(false);
        });
    }
  }, [user, toast]);

  // Redirect to auth if not logged in
  if (!isAuthLoading && !user) {
    return <Redirect to="/auth" />;
  }

  // Show loading state
  if (isAuthLoading || isLoadingSecret) {
    return (
      <div className="min-h-screen flex flex-col">
        <Header />
        <div className="flex flex-grow items-center justify-center">
          <div className="text-center">
            <Loader2 className="h-12 w-12 animate-spin text-primary mx-auto mb-4" />
            <p className="text-lg">Preparing subscription details...</p>
          </div>
        </div>
      </div>
    );
  }

  // Show error state
  if (error) {
    return (
      <div className="min-h-screen flex flex-col">
        <Header />
        <div className="flex flex-grow items-center justify-center p-4">
          <Card className="w-full max-w-lg">
            <CardHeader>
              <CardTitle className="flex items-center">
                <AlertTriangle className="text-red-500 mr-2 h-6 w-6" />
                Subscription Error
              </CardTitle>
              <CardDescription>
                We encountered a problem setting up your subscription.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <p className="text-red-600">{error}</p>
            </CardContent>
            <CardFooter>
              <Button onClick={() => window.location.reload()} className="w-full">
                Try Again
              </Button>
            </CardFooter>
          </Card>
        </div>
      </div>
    );
  }

  // Handle development mode subscription
  const handleDevSubscription = async () => {
    try {
      // Mock a successful subscription by updating the user cache
      const updatedUser = { ...user, subscriptionStatus: "active" };
      queryClient.setQueryData(["/api/user"], updatedUser);
      
      toast({
        title: "Development Mode",
        description: "Subscription activated for development purposes",
      });
      
      // Redirect to home page
      setTimeout(() => {
        window.location.href = '/';
      }, 1000);
    } catch (error) {
      console.error("Dev subscription error:", error);
      toast({
        title: "Error",
        description: "Failed to activate development subscription",
        variant: "destructive",
      });
    }
  };
  
  // If no Stripe is available
  if (!stripePromise) {
    return (
      <div className="min-h-screen flex flex-col">
        <Header />
        <div className="flex flex-grow items-center justify-center p-4">
          <Card className="w-full max-w-lg">
            <CardHeader>
              <CardTitle className="flex items-center">
                {DEVELOPMENT_MODE ? (
                  <>Development Mode</>
                ) : (
                  <>
                    <AlertTriangle className="text-red-500 mr-2 h-6 w-6" />
                    Configuration Error
                  </>
                )}
              </CardTitle>
              <CardDescription>
                {DEVELOPMENT_MODE ? 
                  "Use the development mode subscription option below." :
                  "The payment system is not properly configured."}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {DEVELOPMENT_MODE ? (
                <div className="text-center">
                  <Button 
                    onClick={handleDevSubscription}
                    className="bg-green-600 hover:bg-green-700 text-white"
                  >
                    Activate Development Subscription
                  </Button>
                  <p className="mt-4 text-sm text-gray-600">
                    This will bypass the payment process for development purposes.
                  </p>
                </div>
              ) : (
                <p>Stripe integration is not available. Please contact support.</p>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col">
      <Header />
      <div className="flex flex-grow">
        <div className="container mx-auto grid md:grid-cols-2 gap-8 p-6 items-center">
          {/* Subscription information */}
          <div>
            <h1 className="text-3xl font-serif font-bold text-primary mb-4">
              Subscribe to Farm Friend Roundtable
            </h1>
            <p className="mb-6 text-lg">
              Unlock the full power of agricultural AI expertise with your subscription.
            </p>
            
            <div className="bg-neutral-100 p-6 rounded-lg mb-6">
              <h2 className="text-xl font-medium mb-4">What's included:</h2>
              <ul className="space-y-3">
                <li className="flex items-start">
                  <CheckCircle2 className="h-5 w-5 text-primary mr-2 mt-0.5" />
                  <span>Access to 8 specialized AI agricultural experts</span>
                </li>
                <li className="flex items-start">
                  <CheckCircle2 className="h-5 w-5 text-primary mr-2 mt-0.5" />
                  <span>File creation and download capabilities</span>
                </li>
                <li className="flex items-start">
                  <CheckCircle2 className="h-5 w-5 text-primary mr-2 mt-0.5" />
                  <span>Internet search integration for up-to-date information</span>
                </li>
                <li className="flex items-start">
                  <CheckCircle2 className="h-5 w-5 text-primary mr-2 mt-0.5" />
                  <span>Agricultural image generation</span>
                </li>
                <li className="flex items-start">
                  <CheckCircle2 className="h-5 w-5 text-primary mr-2 mt-0.5" />
                  <span>Unlimited agricultural roundtable sessions</span>
                </li>
                <li className="flex items-start">
                  <CheckCircle2 className="h-5 w-5 text-primary mr-2 mt-0.5" />
                  <span>Export conversations as markdown</span>
                </li>
              </ul>
            </div>
            
            <div className="text-sm text-neutral-600">
              <p>Only $10 per month. Cancel anytime.</p>
            </div>
          </div>
          
          {/* Payment form */}
          <div>
            <Card>
              <CardHeader>
                <CardTitle>Complete your subscription</CardTitle>
                <CardDescription>
                  Enter your payment information below to start your subscription.
                </CardDescription>
              </CardHeader>
              <CardContent>
                {clientSecret && (
                  <Elements 
                    stripe={stripePromise} 
                    options={{ clientSecret, appearance: { theme: 'stripe' } }}
                  >
                    <PaymentForm />
                  </Elements>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}

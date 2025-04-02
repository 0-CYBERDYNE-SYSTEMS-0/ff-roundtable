import { useAuth } from "@/hooks/use-auth";
import { Loader2 } from "lucide-react";
import { Redirect, Route } from "wouter";
import { useEffect, useState } from "react";
import { useToast } from "@/hooks/use-toast";

// Set to true to bypass subscription checks during development
const DEVELOPMENT_MODE = true;

export function ProtectedRoute({
  path,
  component: Component,
}: {
  path: string;
  component: () => React.JSX.Element;
}) {
  const { user, isLoading } = useAuth();
  const [isCheckingSubscription, setIsCheckingSubscription] = useState(true);
  const [isSubscribed, setIsSubscribed] = useState(false);
  const { toast } = useToast();

  useEffect(() => {
    if (user) {
      if (DEVELOPMENT_MODE) {
        // Skip subscription check in development mode
        setIsSubscribed(true);
        setIsCheckingSubscription(false);
      } else {
        // Check subscription status
        setIsCheckingSubscription(true);
        fetch("/api/subscription-status", {
          credentials: "include"
        })
          .then(res => res.json())
          .then(data => {
            setIsSubscribed(data.subscribed);
            setIsCheckingSubscription(false);
            
            if (!data.subscribed) {
              toast({
                title: "Subscription Required",
                description: "You need an active subscription to access this feature.",
                variant: "destructive",
              });
            }
          })
          .catch(err => {
            console.error("Error checking subscription:", err);
            setIsCheckingSubscription(false);
            // In development mode, set as subscribed even if check fails
            setIsSubscribed(DEVELOPMENT_MODE);
          });
      }
    } else if (!isLoading) {
      setIsCheckingSubscription(false);
    }
  }, [user, isLoading, toast]);

  if (isLoading || (user && isCheckingSubscription)) {
    return (
      <Route path={path}>
        <div className="flex items-center justify-center min-h-screen">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </div>
      </Route>
    );
  }

  if (!user) {
    return (
      <Route path={path}>
        <Redirect to="/auth" />
      </Route>
    );
  }

  // In development mode, skip subscription check
  if (!isSubscribed && !DEVELOPMENT_MODE) {
    return (
      <Route path={path}>
        <Redirect to="/subscribe" />
      </Route>
    );
  }

  return <Route path={path} component={Component} />;
}

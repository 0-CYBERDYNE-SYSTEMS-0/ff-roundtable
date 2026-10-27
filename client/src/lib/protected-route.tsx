import { useAuth } from "@/hooks/use-auth";
import { Loader2 } from "lucide-react";
import { Redirect, Route } from "wouter";

export function ProtectedRoute({
  path,
  component: Component,
}: {
  path: string;
  component: () => React.JSX.Element;
}) {
  const { user, isLoading } = useAuth();
  if (isLoading) {
    return (
      <Route path={path}>
        <div className="flex items-center justify-center min-h-screen">
          <Loader2 className="h-8 w-8 animate-spin motion-reduce:animate-none text-primary" />
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

  // Free accounts enter directly; retain the existing production paid-account gate.
  if (!import.meta.env.DEV && (user.tier || "free") !== "free" && user.subscriptionStatus !== "active") {
    return <Route path={path}><Redirect to="/subscribe" /></Route>;
  }

  return <Route path={path} component={Component} />;
}

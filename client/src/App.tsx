import { Component, type ErrorInfo, type ReactNode } from "react";
import { Switch, Route } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { AuthProvider } from "@/hooks/use-auth";
import { Wheat } from "lucide-react";
import { Button } from "@/components/ui/button";
import NotFound from "@/pages/not-found";
import HomePage from "@/pages/home-page";
import AuthPage from "@/pages/auth-page";
import SubscribePage from "@/pages/subscribe-page";
import LandingPage from "@/pages/landing-page";
import { ProtectedRoute } from "./lib/protected-route";
import { useAuth } from "@/hooks/use-auth";

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error("ErrorBoundary caught an error:", error, errorInfo);
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen flex flex-col items-center justify-center bg-neutral-50 p-8">
          <div className="max-w-md w-full bg-white rounded-xl shadow-lg p-8 text-center">
            <Wheat className="mx-auto mb-4 h-16 w-16 text-farm-dark-green" aria-hidden="true" />
            <h1 className="text-2xl font-serif font-bold text-farm-blue mb-2">Something went wrong</h1>
            <p className="text-neutral-600 mb-6">
              Farm Friend Roundtable encountered an unexpected error. Please try reloading the application.
            </p>
            <Button
              className="bg-farm-blue hover:bg-farm-dark-green text-white"
              onClick={() => window.location.reload()}
            >
              Reload
            </Button>
            {this.state.error && (
              <details className="mt-4 text-left">
                <summary className="text-sm text-neutral-500 cursor-pointer">Error details</summary>
                <pre className="mt-2 text-xs text-red-600 bg-red-50 p-2 rounded overflow-x-auto">
                  {this.state.error.message}
                </pre>
              </details>
            )}
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

function Router() {
  return (
    <Switch>
      <Route path="/" component={PublicHomeRoute} />
      <Route path="/auth" component={AuthPage} />
      <Route path="/sign-in" component={AuthPage} />
      <Route path="/sign-up" component={AuthPage} />
      <Route path="/pricing" component={SubscribePage} />
      <Route path="/subscribe" component={SubscribePage} />
      <Route component={NotFound} />
    </Switch>
  );
}

function PublicHomeRoute() {
  const { user, isLoading } = useAuth();
  if (isLoading) {
    return (
      <div className="min-h-[100dvh] bg-[#f2f1e8] p-8" aria-label="Loading Farm Friend">
        <div className="mx-auto mt-24 h-10 max-w-3xl animate-pulse rounded-lg bg-[#e0e3d8]" />
        <div className="mx-auto mt-5 h-56 max-w-3xl animate-pulse rounded-2xl bg-[#e7e8df]" />
      </div>
    );
  }
  return user ? <ProtectedRoute path="/" component={HomePage} /> : <LandingPage />;
}

function App() {
  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <Router />
          <Toaster />
        </AuthProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}

export default App;

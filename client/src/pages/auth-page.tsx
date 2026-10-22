import { useAuth } from "@/hooks/use-auth";
import { Link, Redirect, useLocation } from "wouter";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { insertUserSchema } from "@shared/schema";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { ArrowLeft, Loader2 } from "lucide-react";
import { queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import "../styles/public-pages.css";

const loginSchema = z.object({
  username: z.string().min(1, "Username is required"),
  password: z.string().min(1, "Password is required"),
});

const registerSchema = insertUserSchema.extend({
  username: z.string().min(1, "Username is required"),
  password: z.string().min(6, "Password must be at least 6 characters"),
  confirmPassword: z.string().min(1, "Please confirm your password"),
  email: z.string().email("Please enter a valid email"),
}).refine((data) => data.password === data.confirmPassword, {
  message: "Passwords don't match",
  path: ["confirmPassword"],
});

type LoginFormValues = z.infer<typeof loginSchema>;
type RegisterFormValues = z.infer<typeof registerSchema>;

// Development mode flag - uses Vite's env to determine dev vs production
const DEVELOPMENT_MODE = import.meta.env.DEV;

export default function AuthPage() {
  const { user, isLoading, loginMutation, registerMutation } = useAuth();
  const { toast } = useToast();
  const [, setLocation] = useLocation();
  const initialTab = typeof window !== "undefined" && (window.location.pathname === "/sign-up" || new URLSearchParams(window.location.search).get("tab") === "register")
    ? "register"
    : "login";
  const [activeTab, setActiveTab] = useState<"login" | "register">(initialTab);
  
  const loginForm = useForm<LoginFormValues>({
    resolver: zodResolver(loginSchema),
    defaultValues: {
      username: "",
      password: "",
    },
  });
  
  const registerForm = useForm<RegisterFormValues>({
    resolver: zodResolver(registerSchema),
    defaultValues: {
      username: "",
      email: "",
      password: "",
      confirmPassword: "",
    },
  });
  
  const onLoginSubmit = async (values: LoginFormValues) => {
    loginMutation.mutate(values);
  };
  
  const onRegisterSubmit = async (values: RegisterFormValues) => {
    const { confirmPassword, ...userInfo } = values;
    registerMutation.mutate(userInfo);
  };
  
  // Handle dev login - uses direct API endpoint for super simple login
  const handleDevLogin = async () => {
    try {
      // Use the special development login endpoint
      const response = await fetch("/api/dev-login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include"
      });
      
      if (!response.ok) {
        throw new Error(`Login failed: ${response.statusText}`);
      }
      
      // Get the user data
      const user = await response.json();
      
      // Update the cache
      queryClient.setQueryData(["/api/user"], user);
      
      // Redirect to home (handled by our component)
    } catch (error: any) {
      console.error("Development login failed:", error);
      toast({
        title: "Development Login Failed",
        description: error.message,
        variant: "destructive",
      });
    }
  };
  
  // Redirect if user is already logged in
  if (user) {
    return <Redirect to="/" />;
  }
  
  const changeTab = (value: string) => {
    const next = value === "register" ? "register" : "login";
    setActiveTab(next);
    setLocation(next === "register" ? "/sign-up" : "/sign-in");
  };

  return (
    <main className="ff-public ff-auth-shell">
      <section className="ff-auth-card" aria-label="Farm Friend account access">
        <Link href="/" className="ff-auth-brand">
          <img src="/logo.jpeg" alt="" />
          <span>Farm Friend Roundtable</span>
        </Link>
        <h1 className="ff-auth-heading">{activeTab === "login" ? "Welcome back." : "Make room at the table."}</h1>
        <p className="ff-auth-subhead">{activeTab === "login" ? "Sign in to pick up where your farm left off." : "Create an account to bring a panel of farm expertise to your next question."}</p>
        <Tabs value={activeTab} onValueChange={changeTab} className="w-full">
          <TabsList className="grid w-full grid-cols-2 mb-5">
            <TabsTrigger value="login">Sign in</TabsTrigger>
            <TabsTrigger value="register">Create account</TabsTrigger>
          </TabsList>
          <TabsContent value="login">
            <Card className="auth-form-card">
              <CardHeader><CardTitle>Sign in to your account</CardTitle><CardDescription>Enter your username and password to continue.</CardDescription></CardHeader>
              <CardContent>
                <Form {...loginForm}>
                  <form id="login-form" onSubmit={loginForm.handleSubmit(onLoginSubmit)} className="space-y-4">
                    <FormField control={loginForm.control} name="username" render={({ field }) => (
                      <FormItem><FormLabel>Username</FormLabel><FormControl><Input autoComplete="username" placeholder="Your username" {...field} /></FormControl><FormMessage /></FormItem>
                    )} />
                    <FormField control={loginForm.control} name="password" render={({ field }) => (
                      <FormItem><FormLabel>Password</FormLabel><FormControl><Input autoComplete="current-password" type="password" placeholder="Your password" {...field} /></FormControl><FormMessage /></FormItem>
                    )} />
                  </form>
                </Form>
              </CardContent>
              <CardFooter>
                <Button type="submit" form="login-form" className="w-full" disabled={loginMutation.isPending}>
                  {loginMutation.isPending ? <><Loader2 className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none" />Signing in…</> : "Sign in"}
                </Button>
              </CardFooter>
              {DEVELOPMENT_MODE && <div className="mt-4 border-t border-[#e2e5dc] pt-4">
                <Button type="button" variant="outline" className="w-full" onClick={handleDevLogin}>Quick development login</Button>
                <p className="mt-2 text-center text-xs text-muted-foreground">Available in development only.</p>
              </div>}
            </Card>
          </TabsContent>
          <TabsContent value="register">
            <Card className="auth-form-card">
              <CardHeader><CardTitle>Create your account</CardTitle><CardDescription>A better-informed next step starts with a good question.</CardDescription></CardHeader>
              <CardContent>
                <Form {...registerForm}>
                  <form id="register-form" onSubmit={registerForm.handleSubmit(onRegisterSubmit)} className="space-y-3">
                    <FormField control={registerForm.control} name="username" render={({ field }) => (
                      <FormItem><FormLabel>Username</FormLabel><FormControl><Input autoComplete="username" placeholder="Choose a username" {...field} /></FormControl><FormMessage /></FormItem>
                    )} />
                    <FormField control={registerForm.control} name="email" render={({ field }) => (
                      <FormItem><FormLabel>Email</FormLabel><FormControl><Input autoComplete="email" type="email" placeholder="you@example.com" {...field} /></FormControl><FormMessage /></FormItem>
                    )} />
                    <FormField control={registerForm.control} name="password" render={({ field }) => (
                      <FormItem><FormLabel>Password</FormLabel><FormControl><Input autoComplete="new-password" type="password" placeholder="At least 6 characters" {...field} /></FormControl><FormMessage /></FormItem>
                    )} />
                    <FormField control={registerForm.control} name="confirmPassword" render={({ field }) => (
                      <FormItem><FormLabel>Confirm password</FormLabel><FormControl><Input autoComplete="new-password" type="password" placeholder="Enter your password again" {...field} /></FormControl><FormMessage /></FormItem>
                    )} />
                  </form>
                </Form>
              </CardContent>
              <CardFooter>
                <Button type="submit" form="register-form" className="w-full" disabled={registerMutation.isPending}>
                  {registerMutation.isPending ? <><Loader2 className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none" />Creating account…</> : "Create account"}
                </Button>
              </CardFooter>
            </Card>
          </TabsContent>
        </Tabs>
        <Link className="ff-auth-back" href="/"><ArrowLeft size={14} className="mr-2" aria-hidden="true" />Back to Farm Friend</Link>
      </section>
      <div className="ff-auth-tagline">A thoughtful second opinion for the work ahead.</div>
    </main>
  );
}

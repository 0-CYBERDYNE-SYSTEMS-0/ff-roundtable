import { useAuth } from "@/hooks/use-auth";
import { Redirect } from "wouter";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { insertUserSchema } from "@shared/schema";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Loader2 } from "lucide-react";
import { queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

const loginSchema = z.object({
  username: z.string().min(1, "Username is required"),
  password: z.string().min(1, "Password is required"),
});

const registerSchema = insertUserSchema.extend({
  password: z.string().min(6, "Password must be at least 6 characters"),
  confirmPassword: z.string().min(1, "Please confirm your password"),
  email: z.string().email("Please enter a valid email"),
}).refine((data) => data.password === data.confirmPassword, {
  message: "Passwords don't match",
  path: ["confirmPassword"],
});

type LoginFormValues = z.infer<typeof loginSchema>;
type RegisterFormValues = z.infer<typeof registerSchema>;

// Development mode flag - set to true to enable quick login for dev
const DEVELOPMENT_MODE = true;

export default function AuthPage() {
  const { user, isLoading, loginMutation, registerMutation } = useAuth();
  const { toast } = useToast();
  
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
  
  return (
    <div className="min-h-screen flex items-center justify-center bg-neutral-100 p-4">
      <div className="flex flex-col md:flex-row w-full max-w-6xl bg-white rounded-lg shadow-md overflow-hidden">
        {/* Left side - Forms */}
        <div className="w-full md:w-1/2 p-6">
          <div className="flex items-center mb-6">
            <img 
              src="https://images.unsplash.com/photo-1515150144380-bca9f1650ed9?ixlib=rb-1.2.1&auto=format&fit=crop&w=40&h=40&q=80" 
              alt="Farm Friend Logo" 
              className="h-10 w-10 rounded-full mr-3"
            />
            <h1 className="font-serif text-2xl font-bold text-primary">Farm Friend Roundtable</h1>
          </div>
          
          <Tabs defaultValue="login" className="w-full">
            <TabsList className="grid w-full grid-cols-2 mb-6">
              <TabsTrigger value="login">Login</TabsTrigger>
              <TabsTrigger value="register">Register</TabsTrigger>
            </TabsList>
            
            <TabsContent value="login">
              <Card>
                <CardHeader>
                  <CardTitle>Login to your account</CardTitle>
                  <CardDescription>
                    Enter your credentials to access your Farm Friend Roundtable.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <Form {...loginForm}>
                    <form id="login-form" onSubmit={loginForm.handleSubmit(onLoginSubmit)} className="space-y-4">
                      <FormField
                        control={loginForm.control}
                        name="username"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Username</FormLabel>
                            <FormControl>
                              <Input placeholder="username" {...field} />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                      <FormField
                        control={loginForm.control}
                        name="password"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Password</FormLabel>
                            <FormControl>
                              <Input type="password" placeholder="••••••••" {...field} />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                    </form>
                  </Form>
                </CardContent>
                <CardFooter>
                  <Button 
                    type="submit" 
                    form="login-form" 
                    className="w-full" 
                    disabled={loginMutation.isPending}
                  >
                    {loginMutation.isPending ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Logging in...
                      </>
                    ) : (
                      "Login"
                    )}
                  </Button>
                </CardFooter>
                {DEVELOPMENT_MODE && (
                  <div className="mt-4 pt-4 border-t border-gray-200">
                    <Button 
                      type="button" 
                      variant="outline"
                      className="w-full bg-green-50 hover:bg-green-100 border-green-200"
                      onClick={handleDevLogin}
                    >
                      Quick Development Login
                    </Button>
                    <p className="text-xs text-center mt-2 text-gray-500">
                      For development purposes only
                    </p>
                  </div>
                )}
              </Card>
            </TabsContent>
            
            <TabsContent value="register">
              <Card>
                <CardHeader>
                  <CardTitle>Create an account</CardTitle>
                  <CardDescription>
                    Join Farm Friend Roundtable to access AI-powered agricultural expertise.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <Form {...registerForm}>
                    <form id="register-form" onSubmit={registerForm.handleSubmit(onRegisterSubmit)} className="space-y-4">
                      <FormField
                        control={registerForm.control}
                        name="username"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Username</FormLabel>
                            <FormControl>
                              <Input placeholder="username" {...field} />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                      <FormField
                        control={registerForm.control}
                        name="email"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Email</FormLabel>
                            <FormControl>
                              <Input type="email" placeholder="email@example.com" {...field} />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                      <FormField
                        control={registerForm.control}
                        name="password"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Password</FormLabel>
                            <FormControl>
                              <Input type="password" placeholder="••••••••" {...field} />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                      <FormField
                        control={registerForm.control}
                        name="confirmPassword"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Confirm Password</FormLabel>
                            <FormControl>
                              <Input type="password" placeholder="••••••••" {...field} />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                    </form>
                  </Form>
                </CardContent>
                <CardFooter>
                  <Button 
                    type="submit" 
                    form="register-form" 
                    className="w-full" 
                    disabled={registerMutation.isPending}
                  >
                    {registerMutation.isPending ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Creating account...
                      </>
                    ) : (
                      "Register"
                    )}
                  </Button>
                </CardFooter>
              </Card>
            </TabsContent>
          </Tabs>
        </div>
        
        {/* Right side - Hero section */}
        <div className="w-full md:w-1/2 bg-gradient-to-br from-primary-light to-primary-dark text-white p-8 flex flex-col justify-center">
          <h2 className="text-3xl font-serif font-bold mb-4">Expert Agricultural Advice at Your Fingertips</h2>
          <p className="mb-6">Join Farm Friend Roundtable and connect with AI experts in soil science, crop management, irrigation, pest control, and more.</p>
          
          <div className="space-y-4">
            <div className="flex items-start">
              <div className="bg-white bg-opacity-20 p-2 rounded-full mr-4">
                <span className="material-icons">groups</span>
              </div>
              <div>
                <h3 className="font-medium text-lg">Interactive Roundtable</h3>
                <p className="text-sm opacity-90">Engage with 4-8 AI experts in a virtual roundtable format.</p>
              </div>
            </div>
            
            <div className="flex items-start">
              <div className="bg-white bg-opacity-20 p-2 rounded-full mr-4">
                <span className="material-icons">search</span>
              </div>
              <div>
                <h3 className="font-medium text-lg">Research & Insights</h3>
                <p className="text-sm opacity-90">Get real-time research and summaries of key agricultural insights.</p>
              </div>
            </div>
            
            <div className="flex items-start">
              <div className="bg-white bg-opacity-20 p-2 rounded-full mr-4">
                <span className="material-icons">file_present</span>
              </div>
              <div>
                <h3 className="font-medium text-lg">File Generation</h3>
                <p className="text-sm opacity-90">Create custom reports, schedules, and scripts based on your needs.</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

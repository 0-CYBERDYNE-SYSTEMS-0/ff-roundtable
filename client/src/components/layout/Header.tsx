import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { 
  DropdownMenu, 
  DropdownMenuContent, 
  DropdownMenuItem, 
  DropdownMenuSeparator, 
  DropdownMenuTrigger 
} from "@/components/ui/dropdown-menu";
import { ChevronDown, LogOut } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { useState, useEffect } from "react";

export default function Header() {
  const { user, logoutMutation } = useAuth();
  const [subscriptionStatus, setSubscriptionStatus] = useState<string>("checking");
  
  // Check subscription status
  useEffect(() => {
    if (user) {
      fetch("/api/subscription-status", {
        credentials: "include"
      })
        .then(res => res.json())
        .then(data => {
          setSubscriptionStatus(data.status || "inactive");
        })
        .catch(err => {
          console.error("Error checking subscription:", err);
          setSubscriptionStatus("error");
        });
    }
  }, [user]);
  
  return (
    <header className="bg-gradient-to-r from-farm-blue to-farm-dark-green px-3 py-2 sm:px-6 sm:py-3 text-white flex justify-between items-center gap-2 shadow-lg z-10">
      <div className="flex min-w-0 flex-1 items-center gap-2 sm:gap-3">
        <img
          src="/logo.jpeg"
          alt="Farm Friend Logo"
          className="h-9 w-9 shrink-0 sm:h-12 sm:w-12 object-contain bg-white rounded-lg ring-2 ring-white/30 p-1"
        />
        <h1 className="min-w-0 font-serif text-base leading-tight font-bold tracking-tight sm:text-2xl">
          <span className="sm:hidden">Farm Friend<br />Roundtable</span>
          <span className="hidden sm:inline">Farm Friend Roundtable</span>
        </h1>
      </div>

      {user && (
        <div className="flex shrink-0 items-center space-x-1.5 sm:space-x-3">
          <span className={`px-2 py-1 sm:px-3 sm:py-1.5 ${subscriptionStatus === 'active' ? 'bg-farm-green' : 'bg-farm-yellow'} rounded-full text-[10px] sm:text-xs font-semibold flex items-center shadow-md ${subscriptionStatus === 'active' ? 'text-white' : 'text-neutral-800'}`}>
            <span className={`block w-2 h-2 ${subscriptionStatus === 'active' ? 'bg-white' : 'bg-neutral-800'} rounded-full mr-1.5 animate-pulse`}></span>
            {subscriptionStatus === 'active' ? 'Subscribed' : 'Inactive'}
          </span>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                aria-label={`Account menu for ${user.username}`}
                className="flex items-center space-x-1 sm:space-x-2 hover:bg-white/10 rounded-lg px-1.5 py-1.5 sm:px-3 sm:py-2 h-auto transition-all duration-200"
              >
                <Avatar className="h-8 w-8 sm:h-9 sm:w-9 ring-2 ring-white/30">
                  <AvatarImage src="https://images.unsplash.com/photo-1610216705422-caa3fcb6d158?ixlib=rb-1.2.1&auto=format&fit=crop&w=32&h=32&q=80" />
                  <AvatarFallback className="bg-farm-powder text-farm-blue font-semibold">{user.username.charAt(0).toUpperCase()}</AvatarFallback>
                </Avatar>
                <span className="hidden sm:inline font-medium">{user.username}</span>
                <ChevronDown className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="flex items-center cursor-pointer text-red-600 hover:bg-red-50"
                onClick={() => logoutMutation.mutate()}
              >
                <LogOut className="mr-2 h-4 w-4" />
                <span>Logout</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}
    </header>
  );
}

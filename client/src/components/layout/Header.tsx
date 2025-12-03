import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { 
  DropdownMenu, 
  DropdownMenuContent, 
  DropdownMenuItem, 
  DropdownMenuSeparator, 
  DropdownMenuTrigger 
} from "@/components/ui/dropdown-menu";
import { ChevronDown, LogOut, Settings, User } from "lucide-react";
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
    <header className="bg-gradient-to-r from-farm-blue to-farm-dark-green px-6 py-3 text-white flex justify-between items-center shadow-lg z-10">
      <div className="flex items-center gap-3">
        <img
          src="https://images.unsplash.com/photo-1515150144380-bca9f1650ed9?ixlib=rb-1.2.1&auto=format&fit=crop&w=40&h=40&q=80"
          alt="Farm Friend Logo"
          className="h-10 w-10 rounded-full ring-2 ring-white/30"
        />
        <h1 className="font-serif text-2xl font-bold tracking-tight">Farm Friend Roundtable</h1>
      </div>

      {user && (
        <div className="flex items-center space-x-3">
          <span className={`px-3 py-1.5 ${subscriptionStatus === 'active' ? 'bg-farm-green' : 'bg-farm-yellow'} rounded-full text-xs font-semibold flex items-center shadow-md ${subscriptionStatus === 'active' ? 'text-white' : 'text-neutral-800'}`}>
            <span className={`block w-2 h-2 ${subscriptionStatus === 'active' ? 'bg-white' : 'bg-neutral-800'} rounded-full mr-1.5 animate-pulse`}></span>
            {subscriptionStatus === 'active' ? 'Subscribed' : 'Inactive'}
          </span>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" className="flex items-center space-x-2 hover:bg-white/10 rounded-lg px-3 py-2 h-auto transition-all duration-200">
                <Avatar className="h-9 w-9 ring-2 ring-white/30">
                  <AvatarImage src="https://images.unsplash.com/photo-1610216705422-caa3fcb6d158?ixlib=rb-1.2.1&auto=format&fit=crop&w=32&h=32&q=80" />
                  <AvatarFallback className="bg-farm-powder text-farm-blue font-semibold">{user.username.charAt(0).toUpperCase()}</AvatarFallback>
                </Avatar>
                <span className="font-medium">{user.username}</span>
                <ChevronDown className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuItem className="flex items-center cursor-pointer hover:bg-farm-powder/20">
                <User className="mr-2 h-4 w-4 text-farm-blue" />
                <span>Profile</span>
              </DropdownMenuItem>
              <DropdownMenuItem className="flex items-center cursor-pointer hover:bg-farm-powder/20">
                <Settings className="mr-2 h-4 w-4 text-farm-blue" />
                <span>Settings</span>
              </DropdownMenuItem>
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

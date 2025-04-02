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
    <header className="bg-primary px-4 py-2 text-white flex justify-between items-center shadow-md z-10">
      <div className="flex items-center">
        <img 
          src="https://images.unsplash.com/photo-1515150144380-bca9f1650ed9?ixlib=rb-1.2.1&auto=format&fit=crop&w=40&h=40&q=80" 
          alt="Farm Friend Logo"
          className="h-8 w-8 rounded-full mr-2"
        />
        <h1 className="font-serif text-xl font-bold">Farm Friend Roundtable</h1>
      </div>
      
      {user && (
        <div className="flex items-center space-x-2">
          <span className={`px-2 py-1 ${subscriptionStatus === 'active' ? 'bg-green-700' : 'bg-yellow-600'} rounded-full text-xs flex items-center`}>
            <span className={`block w-2 h-2 ${subscriptionStatus === 'active' ? 'bg-green-300' : 'bg-yellow-300'} rounded-full mr-1`}></span>
            {subscriptionStatus === 'active' ? 'Subscribed' : 'Inactive'}
          </span>
          
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" className="flex items-center space-x-1 hover:bg-primary-dark rounded px-2 py-1 h-auto">
                <Avatar className="h-8 w-8">
                  <AvatarImage src="https://images.unsplash.com/photo-1610216705422-caa3fcb6d158?ixlib=rb-1.2.1&auto=format&fit=crop&w=32&h=32&q=80" />
                  <AvatarFallback>{user.username.charAt(0).toUpperCase()}</AvatarFallback>
                </Avatar>
                <span>{user.username}</span>
                <ChevronDown className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem className="flex items-center cursor-pointer">
                <User className="mr-2 h-4 w-4" />
                <span>Profile</span>
              </DropdownMenuItem>
              <DropdownMenuItem className="flex items-center cursor-pointer">
                <Settings className="mr-2 h-4 w-4" />
                <span>Settings</span>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem 
                className="flex items-center cursor-pointer text-red-600"
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

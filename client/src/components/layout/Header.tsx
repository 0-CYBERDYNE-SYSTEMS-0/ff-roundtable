import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ChevronDown, CreditCard, LogOut, Menu, Wheat } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { useLocation } from "wouter";
import type { RefObject } from "react";

interface HeaderProps {
  onOpenFarmProfile?: () => void;
  onToggleSidebar?: () => void;
  isSidebarOpen?: boolean;
  sidebarToggleRef?: RefObject<HTMLButtonElement>;
}

export default function Header({ onOpenFarmProfile, onToggleSidebar, isSidebarOpen = false, sidebarToggleRef }: HeaderProps) {
  const { user, logoutMutation } = useAuth();
  const [, navigate] = useLocation();
  const initials = user?.username.trim().split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase();

  return (
    <header className="bg-gradient-to-r from-farm-blue to-farm-dark-green px-3 py-2 sm:px-6 sm:py-3 text-white flex justify-between items-center gap-2 shadow-lg z-10">
      <div className="flex min-w-0 flex-1 items-center gap-2 sm:gap-3">
        {user && onToggleSidebar && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            ref={sidebarToggleRef}
            className="shrink-0 text-white hover:bg-white/10 hover:text-white sm:hidden motion-reduce:transition-none"
            onClick={onToggleSidebar}
            aria-label={isSidebarOpen ? "Close navigation menu" : "Open navigation menu"}
            aria-expanded={isSidebarOpen}
            aria-controls="left-sidebar-drawer"
          >
            <Menu className="h-5 w-5" />
          </Button>
        )}
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
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                aria-label={`Account menu for ${user.username}`}
                className="flex items-center space-x-1 sm:space-x-2 hover:bg-white/10 rounded-lg px-1.5 py-1.5 sm:px-3 sm:py-2 h-auto motion-reduce:transition-none"
              >
                <Avatar className="h-8 w-8 sm:h-9 sm:w-9 ring-2 ring-white/30">
                  <AvatarFallback className="bg-farm-powder text-farm-blue font-semibold">{initials || "?"}</AvatarFallback>
                </Avatar>
                <span className="hidden sm:inline font-medium">{user.username}</span>
                <ChevronDown className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              <DropdownMenuLabel>{user.username}</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {onOpenFarmProfile && (
                <DropdownMenuItem onSelect={onOpenFarmProfile}>
                  <Wheat className="h-4 w-4" />
                  <span>Farm profile</span>
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onSelect={() => navigate("/subscribe")}>
                <CreditCard className="h-4 w-4" />
                <span>Plan &amp; billing</span>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="text-red-600 hover:bg-red-50"
                onSelect={() => logoutMutation.mutate()}
              >
                <LogOut className="h-4 w-4" />
                <span>Logout</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}
    </header>
  );
}

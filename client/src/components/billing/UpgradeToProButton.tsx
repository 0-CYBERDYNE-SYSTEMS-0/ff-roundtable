import { useState } from "react";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { ArrowUpRight, Loader2 } from "lucide-react";

interface UpgradeToProButtonProps {
  className?: string;
  label?: string;
  size?: "default" | "sm" | "lg";
}

export default function UpgradeToProButton({ className, label = "Upgrade to Pro", size = "sm" }: UpgradeToProButtonProps) {
  const { toast } = useToast();
  const [isOpening, setIsOpening] = useState(false);
  const openCheckout = async () => {
    if (isOpening) return;
    setIsOpening(true);
    try {
      const response = await apiRequest("POST", "/api/create-checkout-session", { interval: "month" });
      const data = await response.json() as { url?: string; message?: string };
      if (!data.url) throw new Error(data.message || "Checkout could not be opened. Please try again.");
      window.location.assign(data.url);
    } catch (error) {
      const raw = error instanceof Error ? error.message : "";
      let message = raw.replace(/^\d{3}:\s*/, "") || "Please try again later.";
      const jsonStart = message.indexOf("{");
      if (jsonStart >= 0) {
        try {
          const body = JSON.parse(message.slice(jsonStart)) as { message?: string };
          if (body.message) message = body.message;
        } catch {
          // Keep the readable status text when the response body is not JSON.
        }
      }
      toast({ title: "Unable to open checkout", description: message, variant: "destructive" });
      setIsOpening(false);
    }
  };
  return (
    <Button type="button" size={size} onClick={openCheckout} disabled={isOpening} className={className}>
      {isOpening ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin motion-reduce:animate-none" /> : <ArrowUpRight className="mr-1 h-4 w-4" />}
      {isOpening ? "Opening checkout…" : label}
    </Button>
  );
}

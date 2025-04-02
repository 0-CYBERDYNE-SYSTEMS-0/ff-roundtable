import { Badge } from "@/components/ui/badge";
import { getModelDisplayName } from "@/lib/ai-service";
import { AIModel } from "@/types";

interface ModelBadgeProps {
  modelId: string;
  size?: "sm" | "md";
}

export default function ModelBadge({ modelId, size = "md" }: ModelBadgeProps) {
  // Get display name
  const displayName = getModelDisplayName(modelId);
  
  // Determine model category and appropriate color
  let variant: "default" | "secondary" | "destructive" | "outline" = "outline";
  
  if (modelId.includes("claude")) {
    variant = "default"; // Purple for Claude models
  } else if (modelId.includes("gpt")) {
    variant = "secondary"; // Gray for OpenAI models
  } else if (modelId.includes("llama")) {
    variant = "destructive"; // Red for Meta models
  }
  
  return (
    <Badge 
      variant={variant}
      className={`font-normal ${size === "sm" ? "text-xs px-1.5 py-0 h-5" : ""}`}
    >
      {displayName}
    </Badge>
  );
}
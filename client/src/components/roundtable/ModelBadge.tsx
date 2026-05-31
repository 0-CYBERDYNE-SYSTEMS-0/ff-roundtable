import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

// Expanded props to include optional name and showId flag
interface ModelBadgeProps {
  modelId: string;
  modelName?: string; // Optional: Display name for the model
  size?: "sm" | "default";
  showId?: boolean; // Optional: Force showing the ID even if name exists (defaults to false)
  className?: string;
}

// Helper to format model ID for display if name isn't available
function formatModelId(id: string): string {
  // Simple formatting: remove common prefixes and replace slashes/dashes
  return id
    .replace(/^(anthropic|openai|google|meta-llama|mistralai|local)\//, '') // Remove common provider prefixes
    .replace(/[-_]/g, ' ') // Replace separators with spaces
    .split(' ')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1)) // Capitalize words
    .join(' ');
}

// Get provider logo (emoji) for visual identification
function getProviderLogo(modelId: string): string {
  const id = modelId.toLowerCase();
  if (id.startsWith('openai')) return '🟢'; // OpenAI
  if (id.startsWith('anthropic')) return '🟠'; // Anthropic
  if (id.startsWith('meta') || id.includes('llama')) return '🔵'; // Meta/Llama
  if (id.startsWith('google') || id.includes('gemini')) return '🔴'; // Google
  if (id.startsWith('mistral')) return '🟡'; // Mistral
  if (id.startsWith('cohere')) return '🟣'; // Cohere
  if (id.startsWith('local')) return '🖥️'; // Local
  return '⚪'; // Default
}

// Get more detailed model information (version, size, etc.)
function getModelDetails(modelId: string): string | null {
  const id = modelId.toLowerCase();
  
  // Extract version number
  const versionMatch = id.match(/[.-](\d+(?:\.\d+)?b)/i);
  if (versionMatch) return versionMatch[1].toUpperCase(); // Return size like "70B"
  
  // Extract other identifiers
  if (id.includes('turbo')) return 'Turbo';
  if (id.includes('haiku')) return 'Haiku';
  if (id.includes('sonnet')) return 'Sonnet';
  if (id.includes('opus')) return 'Opus';
  if (id.includes('vision')) return 'Vision';
  
  return null;
}

export default function ModelBadge({ 
  modelId, 
  modelName,
  size = "default", 
  showId = false,
  className 
}: ModelBadgeProps) {
  
  let bgColor = "bg-neutral-100";
  let textColor = "text-neutral-700";
  let borderColor = "border-neutral-200";
  
  // Enhanced color coding based on provider
  if (modelId.startsWith("anthropic/")) {
    bgColor = "bg-orange-50";
    textColor = "text-orange-800";
    borderColor = "border-orange-200";
  } else if (modelId.startsWith("openai/")) {
    bgColor = "bg-emerald-50";
    textColor = "text-emerald-800";
    borderColor = "border-emerald-200";
  } else if (modelId.startsWith("google/")) {
    bgColor = "bg-blue-50";
    textColor = "text-blue-800";
    borderColor = "border-blue-200";
  } else if (modelId.startsWith("meta-llama/")) {
    bgColor = "bg-indigo-50";
    textColor = "text-indigo-800";
    borderColor = "border-indigo-200";
  } else if (modelId.includes("mistral")) {
     bgColor = "bg-yellow-50";
     textColor = "text-yellow-800";
     borderColor = "border-yellow-200";
  } else if (modelId.includes("cohere")) {
     bgColor = "bg-purple-50";
     textColor = "text-purple-800";
     borderColor = "border-purple-200";
  } else if (modelId.startsWith("local/")) {
    bgColor = "bg-purple-50";
    textColor = "text-purple-800";
    borderColor = "border-purple-200";
  }

  const sizeClasses = size === "sm" 
    ? "px-1.5 py-0.5 text-xs" 
    : "px-2 py-1 text-sm";

  // Determine display text: Use name if available, otherwise format ID
  const displayName = modelName || formatModelId(modelId);
  
  // Get model details like size or version
  const modelDetails = getModelDetails(modelId);
  
  // Get provider logo
  const providerLogo = getProviderLogo(modelId);
  
  // Optionally append ID if showId is true and name exists
  const fullText = modelName && showId 
    ? `${modelName} (${formatModelId(modelId)})` 
    : displayName;

  return (
    <Badge 
      className={cn(
        bgColor, 
        textColor,
        borderColor,
        sizeClasses,
        "font-medium border whitespace-nowrap flex items-center gap-1", 
        className
      )}
      title={modelId} // Show full ID on hover
    >
      <span>{providerLogo}</span>
      <span>{fullText}</span>
      {modelDetails && <span className="bg-white bg-opacity-50 rounded px-1 text-[0.65rem] font-medium">{modelDetails}</span>}
    </Badge>
  );
}
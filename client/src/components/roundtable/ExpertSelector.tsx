import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { X, Info, CheckCircle, ChevronDown, Filter } from "lucide-react";
import { Expert } from "@shared/schema";
import ExpertCard from "./ExpertCard";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { 
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { EXPERT_CATALOG, avatarDataUri, CUSTOM_EXPERT_EMOJI } from "@shared/expert-catalog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { withRequestedOpenRouterModels } from "@/lib/openrouter-model-options";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

// --- Define type for OpenRouter Model ---
interface OpenRouterModel {
  id: string;
  name: string;
  description: string;
  context_length?: number;
  isFree?: boolean;
  provider?: string;
  pricing?: { prompt?: string; completion?: string };
}

// Keep in sync with isPaidModel() in server/tiers.ts: free models are exactly
// the ones whose id ends with ":free" (the OpenRouter API has no isFree field).
const isFreeModelId = (model: OpenRouterModel) =>
  model.id.endsWith(":free") ||
  (model.pricing?.prompt === "0" && model.pricing?.completion === "0");

// --- Define reliable fallback models when OpenRouter API fails ---
const FALLBACK_MODELS: OpenRouterModel[] = [
  { id: "nvidia/nemotron-3-super-120b-a12b:free", name: "Nemotron 3 Super (free)", description: "NVIDIA Nemotron 3 Super 120B", isFree: true },
  { id: "nvidia/nemotron-3.5-super-vl:free", name: "Nemotron 3.5 Super VL (free)", description: "Vision-capable Nemotron", isFree: true },
  { id: "google/gemma-4-31b-it:free", name: "Gemma 4 31B (free)", description: "Google Gemma 4 31B", isFree: true },
  { id: "google/gemma-4-26b-a4b-it:free", name: "Gemma 4 26B (free)", description: "Google Gemma 4 26B MoE", isFree: true },
  { id: "local/llama3", name: "Llama 3 (Local)", description: "Local Llama 3 via ollama/LM Studio/llama.cpp", isFree: true },
];

// Expert categories for better organization
const EXPERT_CATEGORIES = {
  AGRICULTURE: "Agriculture",
  LIVESTOCK: "Livestock",
  BUSINESS: "Business",
  OPERATIONS: "Operations",
  RESEARCH: "Research & Analysis",
  SUPPORT: "Support",
  CUSTOM: "Custom",
};

// --- Built-in experts come from the shared catalog (20 roles) ---
type SelectableExpert = {
  role: string;
  description: string;
  defaultModel: string;
  avatarUrl: string;
  category: string;
  recommended?: boolean;
  name?: string;
  customInstructions?: string;
};
const availableExperts: SelectableExpert[] = EXPERT_CATALOG.map(e => ({
  role: e.role,
  description: e.description,
  defaultModel: e.defaultModel,
  avatarUrl: avatarDataUri(e.emoji, e.color),
  category: e.category,
  recommended: e.recommended,
}));

// Preset expert combinations for quick selection
const EXPERT_PRESETS = [
  {
    name: "Field Assessment Team",
    description: "Perfect for soil testing, crop inspection, and field surveys",
    experts: ["Soil Scientist", "Crop Specialist", "Imagery Specialist"],
  },
  {
    name: "Problem Solving Team",
    description: "Ideal for diagnosing issues and developing action plans",
    experts: ["Pest Management", "Irrigation Engineer", "Research Analyst", "File Creator"],
  },
  {
    name: "Research & Planning Team",
    description: "Best for long-term planning and strategy development",
    experts: ["Meteorologist", "Research Analyst", "Crop Specialist"],
  }
];

interface ExpertSelectorProps {
  onClose: () => void;
  onAddExperts: (experts: { name: string; role: string; model: string; avatarUrl: string; customInstructions?: string }[]) => void;
  selectedExperts: Expert[];
}

interface SelectedExpertState {
  expertIndex: number;
  model: string; // Model ID will be a string from OpenRouter
}

export default function ExpertSelector({ onClose, onAddExperts, selectedExperts }: ExpertSelectorProps) {
  const [localSelectedExperts, setLocalSelectedExperts] = useState<SelectedExpertState[]>([]);
  const [openRouterModels, setOpenRouterModels] = useState<OpenRouterModel[]>([]);
  const [isLoadingModels, setIsLoadingModels] = useState(true);
  const [errorLoadingModels, setErrorLoadingModels] = useState<string | null>(null);
  const [currentTab, setCurrentTab] = useState<string>(EXPERT_CATEGORIES.AGRICULTURE);
  const [selectedPreset, setSelectedPreset] = useState<string | null>(null);
  const [selectionNotice, setSelectionNotice] = useState<{ unavailable: string[]; alreadyAdded: string[]; capped: string[] } | null>(null);
  const [userTier, setUserTier] = useState<string>("free");
  const [maxExperts, setMaxExperts] = useState<number>(3);
  const [customExperts, setCustomExperts] = useState<SelectableExpert[]>([]);
  const [customName, setCustomName] = useState("");
  const [customRole, setCustomRole] = useState("");
  const [customInstructions, setCustomInstructions] = useState("");
  const allExperts: SelectableExpert[] = [...availableExperts, ...customExperts];
  const customRoleTaken = (role: string) =>
    allExperts.some(e => e.role.toLowerCase() === role.trim().toLowerCase()) ||
    selectedExperts.some(e => e.role.toLowerCase() === role.trim().toLowerCase());
  const addCustomExpert = () => {
    const role = customRole.trim();
    if (!role || role.length > 60 || customRoleTaken(role)) return;
    setCustomExperts(prev => [...prev, {
      role,
      name: customName.trim() || role,
      description: customInstructions.trim().slice(0, 140) || "Custom expert",
      defaultModel: availableExperts[0].defaultModel,
      avatarUrl: avatarDataUri(CUSTOM_EXPERT_EMOJI, "#7A8B5A"),
      category: EXPERT_CATEGORIES.CUSTOM,
      customInstructions: customInstructions.trim().slice(0, 2000),
    }]);
    setCustomName(""); setCustomRole(""); setCustomInstructions("");
  };

  // --- Fetch OpenRouter Models ---
  useEffect(() => {
    const fetchModels = async () => {
      setIsLoadingModels(true);
      setErrorLoadingModels(null);
      try {
        const response = await fetch("https://openrouter.ai/api/v1/models");
        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }
        const data = await response.json();
        if (data && Array.isArray(data.data)) {
           setOpenRouterModels(withRequestedOpenRouterModels(data.data));
        } else {
          throw new Error("Unexpected API response structure");
        }
      } catch (error) {
        console.error("Failed to fetch OpenRouter models:", error);
        setErrorLoadingModels(error instanceof Error ? error.message : "An unknown error occurred");
        setOpenRouterModels(withRequestedOpenRouterModels(FALLBACK_MODELS));
      } finally {
        setIsLoadingModels(false);
      }
    };

    fetchModels();
  }, []);

  // --- Fetch user tier ---
  useEffect(() => {
    const fetchTier = async () => {
      try {
        const res = await fetch("/api/user/tier");
        if (res.ok) {
          const data = await res.json();
          setUserTier(data.tier || "free");
          if (typeof data.limits?.maxExperts === "number") {
            setMaxExperts(data.limits.maxExperts);
          }
        }
      } catch (error) {
        console.error("Failed to fetch user tier:", error);
      }
    };
    fetchTier();
  }, []);

  // Check if we already have some experts selected
  const expertRoles = new Set(selectedExperts.map(e => e.role));

  const modelExists = (modelId: string | undefined) =>
    !!modelId && openRouterModels.some(m => m.id === modelId);

  // Resolve the model for a newly added expert. Falls back to tier-appropriate
  // preferences so free users don't get a paid model the server will reject.
  const resolveDefaultModel = (expertIndex: number): string => {
    const preferredPaid = [
      "anthropic/claude-3-sonnet",
      "openai/gpt-4",
      "anthropic/claude-3-haiku",
      "openai/gpt-3.5-turbo"
    ];
    const preferredFree = [
      "deepseek/deepseek-v3.2:free",
      "anthropic/claude-3-haiku:free",
      "meta-llama/llama-3-8b-instruct:free",
      "google/gemini-pro:free"
    ];

    let defaultModelId = allExperts[expertIndex]?.defaultModel;

    if (!modelExists(defaultModelId)) {
      const preferred = userTier === "free" ? preferredFree : preferredPaid;
      for (const modelId of preferred) {
        if (modelExists(modelId)) {
          defaultModelId = modelId;
          break;
        }
      }

      if (!modelExists(defaultModelId)) {
        const fallbackPool = userTier === "free"
          ? openRouterModels.filter(isFreeModelId)
          : openRouterModels;
        defaultModelId = fallbackPool[0]?.id || openRouterModels[0]?.id || "openai/gpt-3.5-turbo";
      }
    }

    return defaultModelId!;
  };

  // Handle selecting an expert
  const remainingSlots = Math.max(0, maxExperts - selectedExperts.length);

  const toggleExpert = (index: number) => {
    setSelectionNotice(null);
    const existingIndex = localSelectedExperts.findIndex(e => e.expertIndex === index);

    if (existingIndex !== -1) {
      // Remove expert
      setLocalSelectedExperts(prev =>
        prev.filter(item => item.expertIndex !== index)
      );
      // Clear preset selection when manually changing experts
      setSelectedPreset(null);
    } else {
      if (localSelectedExperts.length >= remainingSlots) return;

      setLocalSelectedExperts(prev => [
        ...prev,
        {
          expertIndex: index,
          model: resolveDefaultModel(index)
        }
      ]);

      // Clear preset selection when manually changing experts
      setSelectedPreset(null);
    }
  };

  // Handle selecting a preset
  const applyPreset = (presetName: string) => {
    const preset = EXPERT_PRESETS.find(p => p.name === presetName);
    if (!preset) return;

    // Clear existing selections
    setLocalSelectedExperts([]);

    // Add all experts in the preset
    const newSelectedExperts: SelectedExpertState[] = [];
    const unavailable: string[] = [];
    const alreadyAdded: string[] = [];
    const capped: string[] = [];

    preset.experts.forEach(expertRole => {
      const expertIndex = allExperts.findIndex(e => e.role === expertRole);
      if (expertIndex === -1) {
        unavailable.push(expertRole);
        return;
      }
      if (expertRoles.has(expertRole)) {
        alreadyAdded.push(expertRole);
        return;
      }
      if (newSelectedExperts.length >= remainingSlots) {
        capped.push(expertRole);
        return;
      }

      newSelectedExperts.push({
        expertIndex,
        model: resolveDefaultModel(expertIndex)
      });
    });

    setLocalSelectedExperts(newSelectedExperts);
    setSelectedPreset(presetName);
    setSelectionNotice(unavailable.length || alreadyAdded.length || capped.length
      ? { unavailable, alreadyAdded, capped }
      : null);
  };

  // Handle changing model for an expert
  const changeExpertModel = (expertIndex: number, newModel: string) => {
    setLocalSelectedExperts(prev => 
      prev.map(expert => 
        expert.expertIndex === expertIndex 
          ? { ...expert, model: newModel } 
          : expert
      )
    );

    // Clear preset selection when manually changing models
    setSelectedPreset(null);
    setSelectionNotice(null);
  };

  // Handle adding experts to conversation
  const handleAddExperts = () => {
    const selectedExpertData = localSelectedExperts.map(({ expertIndex, model }) => {
      const expert = allExperts[expertIndex];

      if (expert.category === EXPERT_CATEGORIES.CUSTOM) {
        return { name: expert.name || expert.role, role: expert.role, model, avatarUrl: expert.avatarUrl, customInstructions: expert.customInstructions };
      }
      // Generate a name based on the role
      let name;
      switch (expert.role) {
        case "Soil Scientist":
          name = "Dr. Soil";
          break;
        case "Crop Specialist":
          name = "Crop Master";
          break;
        case "Irrigation Engineer":
          name = "Hydro Engineer";
          break;
        case "Pest Management":
          name = "Pest Pro";
          break;
        case "Meteorologist":
          name = "Weather Wiz";
          break;
        case "File Creator":
          name = "Document Builder";
          break;
        case "Research Analyst":
          name = "Research Scout";
          break;
        case "Imagery Specialist":
          name = "Vision Artist";
          break;
        default:
          name = expert.role;
      }

      return {
        name,
        role: expert.role,
        model: model,
        avatarUrl: expert.avatarUrl
      };
    });

    onAddExperts(selectedExpertData);
  };

  const selectedCount = localSelectedExperts.length;
  const selectedTotalCount = selectedExperts.length + selectedCount;
  const isAtLimit = selectedTotalCount >= maxExperts;
  const limitReason = `Your plan allows ${maxExperts} experts. Upgrade to add more.`;

  // Check if an expert is selected
  const isExpertSelected = (index: number) => {
    return localSelectedExperts.some(e => e.expertIndex === index);
  };

  // Get currently selected model for an expert
  const getSelectedModel = (expertIndex: number) => {
    const found = localSelectedExperts.find(e => e.expertIndex === expertIndex);
    if (found) return found.model;

    // If not in selected experts, determine default model
    return resolveDefaultModel(expertIndex);
  };

  // Filter experts by the current category tab
  const filteredExperts = allExperts.filter(expert => expert.category === currentTab);

  // Filter models by tier — free users only see models the server will accept
  const visibleModels = userTier === "free"
    ? openRouterModels.filter(isFreeModelId)
    : openRouterModels;

  return (
    <Dialog open={true} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto p-4 md:p-6">
      <DialogHeader className="mb-2">
        <DialogTitle className="font-serif text-xl font-bold md:text-2xl">Select Your Expert Team</DialogTitle>
      </DialogHeader>

      <div className="flex items-center space-x-2 mb-4">
        <p className="text-sm text-gray-600">Choose AI experts for your agricultural roundtable. Each expert brings specialized knowledge and capabilities.</p>
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="icon" className="h-6 w-6">
              <Info className="h-4 w-4" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-80 p-4">
            <h4 className="text-sm font-semibold mb-2">About Expert Selection</h4>
            <p className="text-sm text-gray-600 mb-3">Each expert uses a specialized AI model configured for their domain. You can customize which model powers each expert.</p>
            <h5 className="text-xs font-semibold mb-1">Tips:</h5>
            <ul className="text-xs text-gray-600 space-y-1">
              <li>• Select 3-5 experts for balanced discussions</li>
              <li>• Choose experts from different categories for comprehensive insights</li>
              <li>• Use recommended presets for common scenarios</li>
            </ul>
          </PopoverContent>
        </Popover>
      </div>

      {/* Quick Preset Selection */}
      <div className="mb-4">
        <h3 className="text-sm font-semibold mb-2">Recommended Presets</h3>
        <div className="flex flex-wrap gap-2">
          {EXPERT_PRESETS.map(preset => (
            <Button
              key={preset.name}
              size="sm"
              variant={selectedPreset === preset.name ? "default" : "outline"}
              className={selectedPreset === preset.name ? "border-2 border-primary" : ""}
              onClick={() => applyPreset(preset.name)}
            >
              {preset.name}
              {selectedPreset === preset.name && <CheckCircle className="ml-1 h-3 w-3" />}
            </Button>
          ))}
        </div>
        {selectedPreset && (
          <p className="text-xs text-gray-500 mt-1">
            {EXPERT_PRESETS.find(p => p.name === selectedPreset)?.description}
          </p>
        )}
      </div>

      {(selectedExperts.length > 0 || localSelectedExperts.length > 0) && (
        <div className="mb-4 rounded-md border border-neutral-200 bg-neutral-50 p-2">
          <p className="mb-2 text-xs font-medium text-neutral-700">In this roundtable or selected to add</p>
          <div className="flex flex-wrap gap-2">
            {selectedExperts.map((expert) => (
              <Badge key={`existing-${expert.id}`} variant="secondary">{expert.role}</Badge>
            ))}
            {localSelectedExperts.map(({ expertIndex }) => (
              <span key={expertIndex} className="inline-flex items-center gap-1 rounded-full border border-neutral-300 bg-card pl-2 text-xs text-neutral-700">
                {allExperts[expertIndex]?.role}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 rounded-full"
                  aria-label={`Remove ${allExperts[expertIndex]?.role} from selection`}
                  onClick={() => toggleExpert(expertIndex)}
                >
                  <X className="h-3 w-3" />
                </Button>
              </span>
            ))}
          </div>
        </div>
      )}

      {selectionNotice && (
        <div role="status" className="mb-4 space-y-1 rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-neutral-800 dark:border-amber-800 dark:bg-amber-950/40">
          {selectionNotice.unavailable.length > 0 && <p>Preset roles not available: {selectionNotice.unavailable.join(", ")}.</p>}
          {selectionNotice.alreadyAdded.length > 0 && <p>Already in this roundtable: {selectionNotice.alreadyAdded.join(", ")}.</p>}
          {selectionNotice.capped.length > 0 && (
            <p>
              Your plan allows {maxExperts} experts. {selectionNotice.capped.join(", ")} {selectionNotice.capped.length === 1 ? "was" : "were"} not added. <a className="font-semibold text-farm-dark-green underline" href="/subscribe">Upgrade your plan</a>.
            </p>
          )}
        </div>
      )}

      {isAtLimit && (
        <p className="mb-3 text-xs text-neutral-700" role="status">
          Your plan allows {maxExperts} experts. Remove one or <a className="font-semibold text-farm-dark-green underline" href="/subscribe">upgrade your plan</a> to add another.
        </p>
      )}

      {/* Loading/Error States */}
      {isLoadingModels && (
        <div className="flex items-center justify-center py-4">
          <div className="animate-spin motion-reduce:animate-none mr-2">
            <div className="h-5 w-5 border-2 border-primary border-t-transparent rounded-full"></div>
          </div>
          <span className="text-sm">Loading AI models...</span>
        </div>
      )}

      {errorLoadingModels && (
        <div className="bg-red-50 text-red-600 p-3 rounded-md text-sm mb-4">
          Error loading models: {errorLoadingModels}. Using default selection.
        </div>
      )}

      {/* Main Expert Selection Area */}
      {(!isLoadingModels || errorLoadingModels) && (
        <Tabs value={currentTab} onValueChange={setCurrentTab} className="flex-1 flex flex-col">
          <div className="flex justify-between items-center mb-1">
            <TabsList className="mb-2 flex-wrap h-auto">
              {Object.values(EXPERT_CATEGORIES).map(category => (
                <TabsTrigger key={category} value={category} className="text-sm">
                  {category}
                </TabsTrigger>
              ))}
            </TabsList>

            <div className="flex items-center">
              <span className="text-xs text-gray-500 mr-2">Selected:</span>
              <Badge variant="outline" className="font-medium">
                {selectedTotalCount}/{maxExperts}
              </Badge>
            </div>
          </div>

          <div className="flex-1 overflow-hidden">
            <ScrollArea className="h-full px-1">
              {currentTab === EXPERT_CATEGORIES.CUSTOM && (
                <div className="border rounded-md p-3 mb-3 space-y-2" data-testid="custom-expert-form">
                  <p className="text-sm font-medium">Create your own expert</p>
                  <Input placeholder="Name (e.g. Grandpa Joe)" value={customName} maxLength={60} onChange={e => setCustomName(e.target.value)} />
                  <Input placeholder="Role (e.g. Beekeeper)" value={customRole} maxLength={60} onChange={e => setCustomRole(e.target.value)} />
                  <Textarea placeholder="Instructions: what this expert knows, how they should answer" value={customInstructions} maxLength={2000} onChange={e => setCustomInstructions(e.target.value)} />
                  {customRole.trim() && customRoleTaken(customRole) && <p className="text-xs text-red-600">That role already exists.</p>}
                  <Button size="sm" onClick={addCustomExpert} disabled={!customRole.trim() || customRoleTaken(customRole)}>Create expert</Button>
                </div>
              )}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pb-1">
                {filteredExperts.map((expert) => {
                  const actualIndex = allExperts.findIndex(e => e.role === expert.role);
                  const isSelected = isExpertSelected(actualIndex);
                  const isAlreadyAdded = expertRoles.has(expert.role);
                  const selectedModel = getSelectedModel(actualIndex);

                  return (
                    <ExpertCard
                      key={actualIndex}
                      expertData={expert}
                      isSelected={isSelected}
                      isAlreadyAdded={isAlreadyAdded}
                      selectedModel={selectedModel}
                      availableModels={visibleModels}
                      isLoadingModels={isLoadingModels}
                      onToggle={() => toggleExpert(actualIndex)}
                      onChangeModel={(newModel) => changeExpertModel(actualIndex, newModel)}
                      userTier={userTier}
                      isAtLimit={isAtLimit}
                      limitReason={limitReason}
                    />
                  );
                })}
              </div>
            </ScrollArea>
          </div>
        </Tabs>
      )}

      {/* Footer Controls */}
      <div className="mt-4 pt-4 border-t border-neutral-300 flex flex-col sm:flex-row justify-between items-center gap-3">
        <div className="text-center sm:text-left w-full sm:w-auto">
          {selectedCount === 0 ? (
            <p className="text-sm text-amber-700">Please select at least one expert</p>
          ) : (
            <p className="text-sm text-farm-dark-green">Your team is ready to join the conversation</p>
          )}
        </div>
        <Button
          onClick={handleAddExperts}
          disabled={selectedCount < 1 || selectedTotalCount > maxExperts || isLoadingModels}
          className="bg-primary hover:bg-primary/90 px-6 w-full sm:w-auto"
        >
          Add {selectedCount > 0 ? `${selectedCount} ` : ''}Expert{selectedCount !== 1 ? 's' : ''} to Roundtable
        </Button>
      </div>
      </DialogContent>
    </Dialog>
  );
}

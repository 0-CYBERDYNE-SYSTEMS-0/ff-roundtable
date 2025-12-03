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

// --- Define type for OpenRouter Model ---
interface OpenRouterModel {
  id: string;
  name: string;
  description: string; 
  context_length?: number; 
  // Add other relevant fields if needed from OpenRouter API response
}

// --- Define reliable fallback models when OpenRouter API fails ---
const FALLBACK_MODELS: OpenRouterModel[] = [
  { id: "deepseek/deepseek-v3.2", name: "⚡ Quick Test", description: "DeepSeek V3.2 - Fast and efficient model" },
  { id: "openai/gpt-3.5-turbo", name: "GPT-3.5 Turbo", description: "OpenAI's GPT-3.5 Turbo model" },
  { id: "openai/gpt-4", name: "GPT-4", description: "OpenAI's GPT-4 model" },
  { id: "anthropic/claude-3-haiku", name: "Claude 3 Haiku", description: "Anthropic's Claude 3 Haiku model" },
  { id: "anthropic/claude-3-sonnet", name: "Claude 3 Sonnet", description: "Anthropic's Claude 3 Sonnet model" },
  { id: "meta-llama/llama-3-8b-instruct", name: "Llama 3 8B", description: "Meta's Llama 3 8B model" },
  { id: "google/gemini-pro", name: "Gemini Pro", description: "Google's Gemini Pro model" },
];

// Expert categories for better organization
const EXPERT_CATEGORIES = {
  AGRICULTURE: "Agriculture",
  RESEARCH: "Research & Analysis",
  SUPPORT: "Support"
};

// --- Define available experts data with categories ---
const availableExperts = [
  {
    role: "Soil Scientist",
    description: "Specializes in soil health, composition analysis, and fertilization recommendations.",
    defaultModel: "deepseek/deepseek-v3.2",
    avatarUrl: "https://images.unsplash.com/photo-1560365163-3e8d64e762ef?ixlib=rb-1.2.1&auto=format&fit=crop&w=48&h=48&q=80",
    category: EXPERT_CATEGORIES.AGRICULTURE,
    recommended: true
  },
  {
    role: "Crop Specialist",
    description: "Expert in crop varieties, rotation strategies, and yield optimization techniques.",
    defaultModel: "deepseek/deepseek-v3.2",
    avatarUrl: "https://images.unsplash.com/photo-1530836369250-ef72a3f5cda8?ixlib=rb-1.2.1&auto=format&fit=crop&w=48&h=48&q=80",
    category: EXPERT_CATEGORIES.AGRICULTURE,
    recommended: true
  },
  {
    role: "Irrigation Engineer",
    description: "Specializes in water management systems, irrigation scheduling, and water conservation.",
    defaultModel: "deepseek/deepseek-v3.2",
    avatarUrl: "https://images.unsplash.com/photo-1584824188625-0d6dd2183f9e?ixlib=rb-1.2.1&auto=format&fit=crop&w=48&h=48&q=80",
    category: EXPERT_CATEGORIES.AGRICULTURE
  },
  {
    role: "Pest Management",
    description: "Advises on insect, disease, and weed control strategies using integrated pest management.",
    defaultModel: "anthropic/claude-3.5-sonnet",
    avatarUrl: "https://images.unsplash.com/photo-1580852300654-2d5a84ba2603?ixlib=rb-1.2.1&auto=format&fit=crop&w=48&h=48&q=80",
    category: EXPERT_CATEGORIES.AGRICULTURE
  },
  {
    role: "Meteorologist",
    description: "Provides weather analysis, forecasting, and climate pattern insights for farm planning.",
    defaultModel: "anthropic/claude-3.5-sonnet",
    avatarUrl: "https://images.unsplash.com/photo-1590552515252-3a5a1bce7bed?ixlib=rb-1.2.1&auto=format&fit=crop&w=48&h=48&q=80",
    category: EXPERT_CATEGORIES.RESEARCH
  },
  {
    role: "File Creator",
    description: "Helps draft reports, field notes, action plans, and documentation with a focus on clarity.",
    defaultModel: "openai/gpt-4o",
    avatarUrl: "https://images.unsplash.com/photo-1506097425191-7ad538b29cef?ixlib=rb-1.2.1&auto=format&fit=crop&w=48&h=48&q=80",
    category: EXPERT_CATEGORIES.SUPPORT,
    recommended: true
  },
  {
    role: "Research Analyst",
    description: "Conducts literature reviews, analyzes trends, and provides evidence-based recommendations.",
    defaultModel: "anthropic/claude-3.5-sonnet",
    avatarUrl: "https://images.unsplash.com/photo-1551836022-d5d88e9218df?ixlib=rb-1.2.1&auto=format&fit=crop&w=48&h=48&q=80",
    category: EXPERT_CATEGORIES.RESEARCH
  },
  {
    role: "Imagery Specialist",
    description: "Analyzes satellite, drone, and field imagery to provide visual insights and recommendations.",
    defaultModel: "openai/gpt-4o-vision",
    avatarUrl: "https://images.unsplash.com/photo-1562408590-e32931084e23?ixlib=rb-1.2.1&auto=format&fit=crop&w=48&h=48&q=80",
    category: EXPERT_CATEGORIES.RESEARCH,
    recommended: true
  },
  {
    role: "Moderator",
    description: "Manages conversation summaries and context, providing key insights and bullet points.",
    defaultModel: "anthropic/claude-3.5-sonnet",
    avatarUrl: "https://images.unsplash.com/photo-1506794778202-cad84cf45f1d?ixlib=rb-1.2.1&auto=format&fit=crop&w=48&h=48&q=80",
    category: EXPERT_CATEGORIES.SUPPORT,
    recommended: true
  }
];

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
    experts: ["Meteorologist", "Research Analyst", "Crop Specialist", "Moderator"],
  }
];

interface ExpertSelectorProps {
  onClose: () => void;
  onAddExperts: (experts: { name: string; role: string; model: string; avatarUrl: string }[]) => void;
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
        // Assuming the data structure is { data: OpenRouterModel[] }
        if (data && Array.isArray(data.data)) {
           setOpenRouterModels(data.data);
        } else {
          throw new Error("Unexpected API response structure");
        }
      } catch (error) {
        console.error("Failed to fetch OpenRouter models:", error);
        setErrorLoadingModels(error instanceof Error ? error.message : "An unknown error occurred");
        // Use fallback models instead of empty array
        setOpenRouterModels(FALLBACK_MODELS);
      } finally {
        setIsLoadingModels(false);
      }
    };

    fetchModels();
  }, []); // Empty dependency array ensures this runs only once on mount

  // Check if we already have some experts selected
  const expertRoles = new Set(selectedExperts.map(e => e.role));

  // Handle selecting an expert
  const toggleExpert = (index: number) => {
    const existingIndex = localSelectedExperts.findIndex(e => e.expertIndex === index);

    if (existingIndex !== -1) {
      // Remove expert
      setLocalSelectedExperts(prev => 
        prev.filter(item => item.expertIndex !== index)
      );
      // Clear preset selection when manually changing experts
      setSelectedPreset(null);
    } else {
      // Add expert with default model (ensure default model exists or handle fallback)
      let defaultModelId = availableExperts[index]?.defaultModel;

      // Find the most reliable model based on availability
      if (!defaultModelId || !openRouterModels.some(m => m.id === defaultModelId)) {
        console.warn(`Model ${defaultModelId} not found or not specified for ${availableExperts[index].role}. Using fallback.`);

        // Try to find a good match from our available models
        const preferredModels = [
          "anthropic/claude-3-sonnet", 
          "openai/gpt-4", 
          "anthropic/claude-3-haiku", 
          "openai/gpt-3.5-turbo"
        ];

        for (const modelId of preferredModels) {
          if (openRouterModels.some(m => m.id === modelId)) {
            defaultModelId = modelId;
            break;
          }
        }

        // If still no match, use the first available model
        if (!defaultModelId && openRouterModels.length > 0) {
          defaultModelId = openRouterModels[0].id;
        } else if (!defaultModelId) {
          // Last resort fallback
          defaultModelId = "openai/gpt-3.5-turbo"; 
        }
      }

      setLocalSelectedExperts(prev => [
        ...prev, 
        { 
          expertIndex: index, 
          model: defaultModelId
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

    preset.experts.forEach(expertRole => {
      const expertIndex = availableExperts.findIndex(e => e.role === expertRole);
      if (expertIndex === -1) return;

      let defaultModelId = availableExperts[expertIndex]?.defaultModel;
      // Apply same model fallback logic as toggleExpert
      if (!defaultModelId || !openRouterModels.some(m => m.id === defaultModelId)) {
        const preferredModels = [
          "anthropic/claude-3-sonnet", 
          "openai/gpt-4", 
          "anthropic/claude-3-haiku", 
          "openai/gpt-3.5-turbo"
        ];

        for (const modelId of preferredModels) {
          if (openRouterModels.some(m => m.id === modelId)) {
            defaultModelId = modelId;
            break;
          }
        }

        if (!defaultModelId && openRouterModels.length > 0) {
          defaultModelId = openRouterModels[0].id;
        } else if (!defaultModelId) {
          defaultModelId = "openai/gpt-3.5-turbo"; 
        }
      }

      newSelectedExperts.push({
        expertIndex,
        model: defaultModelId
      });
    });

    setLocalSelectedExperts(newSelectedExperts);
    setSelectedPreset(presetName);
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
  };

  // Handle adding experts to conversation
  const handleAddExperts = () => {
    const selectedExpertData = localSelectedExperts.map(({ expertIndex, model }) => {
      const expert = availableExperts[expertIndex];

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
        case "Moderator":
          name = "Moderator";
          break;
        default:
          name = `${expert.role.split(' ')[0]} Expert`;
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

  // Check if an expert is selected
  const isExpertSelected = (index: number) => {
    return localSelectedExperts.some(e => e.expertIndex === index);
  };

  // Get currently selected model for an expert
  const getSelectedModel = (expertIndex: number) => {
    const found = localSelectedExperts.find(e => e.expertIndex === expertIndex);
    if (found) return found.model;

    // If not in selected experts, determine default model
    let defaultModelId = availableExperts[expertIndex]?.defaultModel;

    // Find the most reliable model based on availability
    if (!defaultModelId || !openRouterModels.some(m => m.id === defaultModelId)) {
      // Try to find a good match from our available models
      const preferredModels = [
        "anthropic/claude-3-sonnet", 
        "openai/gpt-4", 
        "anthropic/claude-3-haiku", 
        "openai/gpt-3.5-turbo"
      ];

      for (const modelId of preferredModels) {
        if (openRouterModels.some(m => m.id === modelId)) {
          defaultModelId = modelId;
          break;
        }
      }

      // If still no match, use the first available model
      if (!defaultModelId && openRouterModels.length > 0) {
        defaultModelId = openRouterModels[0].id;
      } else if (!defaultModelId) {
        // Last resort fallback
        defaultModelId = "openai/gpt-3.5-turbo"; 
      }
    }

    return defaultModelId;
  };

  // Filter experts by the current category tab
  const filteredExperts = availableExperts.filter(expert => expert.category === currentTab);

  // Get recommended experts
  const recommendedExperts = availableExperts.filter(expert => expert.recommended);

  return (
    <div className="absolute inset-0 bg-white bg-opacity-95 z-10 flex flex-col p-4 md:p-6">
      <div className="flex justify-between items-center mb-2">
        <h2 className="font-serif font-bold text-xl md:text-2xl">Select Your Expert Team</h2>
        <Button variant="ghost" size="icon" onClick={onClose}>
          <X className="h-5 w-5" />
        </Button>
      </div>

      <div className="flex items-center space-x-2 mb-4">
        <p className="text-sm text-gray-600">Choose AI experts for your agricultural roundtable. Each expert brings specialized knowledge and capabilities.</p>
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="icon" className="h-6 w-6">
              <Info className="h-4 w-4" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-80 p-4">
            <h4 className="font-medium mb-2">About Expert Selection</h4>
            <p className="text-sm text-gray-600 mb-3">Each expert uses a specialized AI model configured for their domain. You can customize which model powers each expert.</p>
            <h5 className="font-medium text-xs mb-1">Tips:</h5>
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
        <h3 className="text-sm font-medium mb-2">Recommended Presets</h3>
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

      {/* Loading/Error States */}
      {isLoadingModels && (
        <div className="flex items-center justify-center py-4">
          <div className="animate-spin mr-2">
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
            <TabsList className="mb-2">
              {Object.values(EXPERT_CATEGORIES).map(category => (
                <TabsTrigger key={category} value={category} className="text-sm">
                  {category}
                </TabsTrigger>
              ))}
            </TabsList>

            <div className="flex items-center">
              <span className="text-xs text-gray-500 mr-2">Selected:</span>
              <Badge variant="outline" className="font-medium">
                {selectedCount}/8
              </Badge>
            </div>
          </div>

          <div className="flex-1 overflow-hidden">
            {currentTab === "recommended" ? (
              <ScrollArea className="h-full px-1">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pb-1">
                  {recommendedExperts.map((expert, expertIndex) => {
                    const actualIndex = availableExperts.findIndex(e => e.role === expert.role);
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
                        availableModels={openRouterModels}
                        isLoadingModels={isLoadingModels}
                        onToggle={() => toggleExpert(actualIndex)}
                        onChangeModel={(newModel) => changeExpertModel(actualIndex, newModel)}
                      />
                    );
                  })}
                </div>
              </ScrollArea>
            ) : (
              <ScrollArea className="h-full px-1">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pb-1">
                  {filteredExperts.map((expert, index) => {
                    const actualIndex = availableExperts.findIndex(e => e.role === expert.role);
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
                        availableModels={openRouterModels}
                        isLoadingModels={isLoadingModels}
                        onToggle={() => toggleExpert(actualIndex)}
                        onChangeModel={(newModel) => changeExpertModel(actualIndex, newModel)}
                      />
                    );
                  })}
                </div>
              </ScrollArea>
            )}
          </div>
        </Tabs>
      )}

      {/* Footer Controls */}
      <div className="mt-4 pt-4 border-t border-neutral-300 flex flex-col sm:flex-row justify-between items-center gap-3">
        <div className="text-center sm:text-left w-full sm:w-auto">
          {selectedCount === 0 ? (
            <p className="text-sm text-amber-600">Please select at least one expert</p>
          ) : selectedCount > 8 ? (
            <p className="text-sm text-red-600">Maximum 8 experts allowed</p>
          ) : (
            <p className="text-sm text-green-600">Your team is ready to join the conversation</p>
          )}
        </div>
        <Button 
          onClick={handleAddExperts}
          disabled={selectedCount < 1 || selectedCount > 8 || isLoadingModels}
          className="bg-primary hover:bg-primary-dark px-6 w-full sm:w-auto"
        >
          Add {selectedCount > 0 ? `${selectedCount} ` : ''}Expert{selectedCount !== 1 ? 's' : ''} to Roundtable
        </Button>
      </div>
    </div>
  );
}
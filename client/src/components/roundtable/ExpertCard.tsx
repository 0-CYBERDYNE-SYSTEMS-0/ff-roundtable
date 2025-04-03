import { useState, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Check, Search, Star, Zap, Clock, Cpu, ChevronDown } from "lucide-react";
import ModelBadge from "./ModelBadge";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";

// --- Define type for OpenRouter Model (Matching ExpertSelector) ---
interface OpenRouterModel {
  id: string;
  name: string;
  description: string; 
  context_length?: number; 
}

interface ExpertData {
  role: string;
  description: string;
  defaultModel: string;
  avatarUrl: string;
  category?: string;
  recommended?: boolean;
}

interface ExpertCardProps {
  expertData: ExpertData;
  isSelected: boolean;
  isAlreadyAdded: boolean;
  selectedModel: string;
  availableModels: OpenRouterModel[];
  isLoadingModels: boolean;
  onToggle: () => void;
  onChangeModel: (newModel: string) => void;
}

// Helper to get model performance metrics (would be replaced with actual data in a production app)
const getModelPerformance = (modelId: string) => {
  // This is sample data - in a real app, you would have actual performance metrics
  if (modelId.includes('gpt-4')) {
    return { speed: 'Medium', quality: 'High', cost: 'High' };
  } else if (modelId.includes('gpt-3.5')) {
    return { speed: 'Fast', quality: 'Medium', cost: 'Low' };
  } else if (modelId.includes('claude-3-sonnet')) {
    return { speed: 'Medium', quality: 'High', cost: 'Medium' };
  } else if (modelId.includes('claude-3-haiku')) {
    return { speed: 'Fast', quality: 'Medium', cost: 'Low' };
  } else if (modelId.includes('llama-3')) {
    return { speed: 'Medium', quality: 'Medium', cost: 'Low' };
  } else if (modelId.includes('gemini')) {
    return { speed: 'Medium', quality: 'Medium', cost: 'Medium' };
  }
  return { speed: 'Medium', quality: 'Medium', cost: 'Medium' };
};

// Helper to categorize models for better organization
const categorizeModel = (model: OpenRouterModel) => {
  const id = model.id.toLowerCase();
  if (id.includes('openai')) return 'OpenAI';
  if (id.includes('anthropic')) return 'Anthropic';
  if (id.includes('meta') || id.includes('llama')) return 'Meta';
  if (id.includes('google') || id.includes('gemini')) return 'Google';
  if (id.includes('mistral')) return 'Mistral';
  if (id.includes('cohere')) return 'Cohere';
  return 'Other';
};

export default function ExpertCard({
  expertData,
  isSelected,
  isAlreadyAdded,
  selectedModel,
  availableModels,
  isLoadingModels,
  onToggle,
  onChangeModel,
}: ExpertCardProps) {
  const [searchTerm, setSearchTerm] = useState("");
  const [modelCategory, setModelCategory] = useState<string | null>(null);
  const [isModelPickerOpen, setIsModelPickerOpen] = useState(false);

  const cardClasses = `border rounded-lg p-3 transition-all ${
    isSelected 
      ? 'border-primary border-2 bg-primary-light bg-opacity-10 shadow-sm' 
      : isAlreadyAdded 
        ? 'border-neutral-300 bg-neutral-50 opacity-75' 
        : 'border-neutral-200 hover:border-primary hover:shadow-sm'
  }`;

  // Filter models based on search term and optional category filter
  const filteredModels = availableModels.filter(model => {
    const matchesSearch = model.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
                         model.id.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesCategory = !modelCategory || categorizeModel(model) === modelCategory;
    return matchesSearch && matchesCategory;
  });

  // Group models by provider
  const modelsByProvider: Record<string, OpenRouterModel[]> = {};
  filteredModels.forEach(model => {
    const provider = categorizeModel(model);
    if (!modelsByProvider[provider]) {
      modelsByProvider[provider] = [];
    }
    modelsByProvider[provider].push(model);
  });

  // Get performance metrics for the selected model
  const performance = getModelPerformance(selectedModel);
  
  // Get categories present in filtered models
  const availableCategories = Array.from(
    new Set(filteredModels.map(model => categorizeModel(model)))
  ).sort();

  // Handle model selection
  const handleSelectModel = (modelId: string) => {
    onChangeModel(modelId);
    setIsModelPickerOpen(false);
  };

  // Get details of selected model
  const selectedModelDetails = availableModels.find(m => m.id === selectedModel);

  return (
    <div className={cardClasses}>
      <div className="flex items-center mb-2">
        <div className="relative">
          <img 
            src={expertData.avatarUrl} 
            alt={expertData.role} 
            className="w-12 h-12 rounded-full mr-3 object-cover border border-neutral-200"
          />
          {expertData.recommended && (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <div className="absolute -top-1 -right-1 bg-amber-400 rounded-full p-0.5">
                    <Star className="h-3 w-3 text-white" fill="white" />
                  </div>
                </TooltipTrigger>
                <TooltipContent>
                  <p className="text-xs">Recommended Expert</p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
        </div>
        <div className="flex-1">
          <h3 className="font-medium">{expertData.role}</h3>
          {expertData.category && (
            <Badge variant="outline" className="text-xs font-normal mt-0.5">
              {expertData.category}
            </Badge>
          )}
        </div>
        
        {!isAlreadyAdded && (
          <Button 
            variant={isSelected ? "outline" : "default"} 
            size="sm"
            onClick={onToggle}
            disabled={isLoadingModels}
            className={isSelected ? "border-primary text-primary" : ""}
          >
            {isSelected ? "Remove" : "Add"}
          </Button>
        )}
      </div>
      <p className="text-sm text-gray-600 mb-2">{expertData.description}</p>
      
      {isSelected && !isAlreadyAdded && (
        <div className="mt-3 border-t pt-3">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium">AI Model:</span>
            
            {/* Model Selector - Using Popover instead of Select for better control */}
            <Popover 
              open={isModelPickerOpen} 
              onOpenChange={(open) => {
                setIsModelPickerOpen(open);
                if (!open) setSearchTerm("");
              }}
            >
              <PopoverTrigger asChild>
                <Button 
                  variant="outline" 
                  size="sm" 
                  className="h-8 px-3 w-[220px] justify-between"
                  disabled={isLoadingModels}
                >
                  <ModelBadge 
                    modelId={selectedModel} 
                    modelName={selectedModelDetails?.name} 
                    size="sm" 
                  />
                  <ChevronDown className="h-4 w-4 opacity-50 ml-1" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-[300px] p-0" align="end">
                {/* Search & Filter Controls */}
                <div className="p-3 border-b">
                  <div className="relative mb-2">
                    <Search className="absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground pointer-events-none" />
                    <Input 
                      placeholder="Search models..."
                      value={searchTerm}
                      onChange={(e) => setSearchTerm(e.target.value)}
                      className="pl-8 h-8 text-xs w-full"
                      autoComplete="off"
                      autoFocus
                    />
                  </div>
                  
                  {availableCategories.length > 1 && (
                    <div className="flex flex-wrap gap-1 mt-2">
                      <Badge 
                        variant={!modelCategory ? "default" : "outline"} 
                        className="cursor-pointer text-xs"
                        onClick={() => setModelCategory(null)}
                      >
                        All
                      </Badge>
                      {availableCategories.map(category => (
                        <Badge 
                          key={category}
                          variant={modelCategory === category ? "default" : "outline"} 
                          className="cursor-pointer text-xs"
                          onClick={() => setModelCategory(category === modelCategory ? null : category)}
                        >
                          {category}
                        </Badge>
                      ))}
                    </div>
                  )}
                </div>
                
                {/* Model List */}
                <ScrollArea className="h-[280px]">
                  {isLoadingModels ? (
                    <div className="p-3 text-center text-sm text-muted-foreground">
                      Loading models...
                    </div>
                  ) : filteredModels.length > 0 ? (
                    <div>
                      {Object.entries(modelsByProvider).map(([provider, models], idx) => (
                        <div key={provider}>
                          {idx > 0 && <Separator />}
                          <div className="p-1">
                            <h4 className="text-xs font-medium px-2 py-1 text-muted-foreground">
                              {provider}
                            </h4>
                            <div>
                              {models.map((model) => (
                                <div 
                                  key={model.id}
                                  className={`
                                    flex items-center justify-between w-full p-2 text-left hover:bg-muted rounded-md cursor-pointer
                                    ${selectedModel === model.id ? 'bg-muted' : ''}
                                  `}
                                  onClick={() => handleSelectModel(model.id)}
                                >
                                  <div>
                                    <ModelBadge modelId={model.id} modelName={model.name} size="sm" showId={false} />
                                    <p className="text-xs text-gray-500 mt-0.5">{model.description?.substring(0, 60)}{model.description?.length > 60 ? '...' : ''}</p>
                                  </div>
                                  {selectedModel === model.id && (
                                    <Check className="h-4 w-4 text-primary ml-2 flex-shrink-0" />
                                  )}
                                </div>
                              ))}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="p-3 text-center text-sm text-muted-foreground">
                      No models found.
                    </div>
                  )}
                </ScrollArea>
              </PopoverContent>
            </Popover>
          </div>
          
          {/* Model Performance Indicators */}
          <div className="flex items-center justify-between mt-1 text-xs text-gray-600">
            <div className="flex items-center" title="Processing Speed">
              <Clock className="h-3 w-3 mr-1" />
              <span>{performance.speed}</span>
            </div>
            <div className="flex items-center" title="Output Quality">
              <Star className="h-3 w-3 mr-1" />
              <span>{performance.quality}</span>
            </div>
            <div className="flex items-center" title="Relative Cost">
              <Zap className="h-3 w-3 mr-1" />
              <span>{performance.cost}</span>
            </div>
          </div>
        </div>
      )}
      
      {isAlreadyAdded && (
        <div className="text-xs text-primary mt-2 font-medium flex items-center">
          <Check className="h-3 w-3 mr-1" />
          Already added to this conversation
        </div>
      )}
    </div>
  );
} 
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { X, ChevronDown, Settings, Check } from "lucide-react";
import { Expert } from "@shared/schema";
import { 
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { AIModel } from "@/types";
import ModelBadge from "./ModelBadge";

// Define available experts data with default models
const availableExperts = [
  {
    role: "Soil Scientist",
    description: "Specializes in soil health, composition analysis, and fertilization recommendations.",
    defaultModel: AIModel.Claude3Sonnet,
    avatarUrl: "https://images.unsplash.com/photo-1560365163-3e8d64e762ef?ixlib=rb-1.2.1&auto=format&fit=crop&w=48&h=48&q=80"
  },
  {
    role: "Crop Specialist",
    description: "Expert in crop varieties, rotation strategies, and yield optimization techniques.",
    defaultModel: AIModel.GPT4,
    avatarUrl: "https://images.unsplash.com/photo-1530836369250-ef72a3f5cda8?ixlib=rb-1.2.1&auto=format&fit=crop&w=48&h=48&q=80"
  },
  {
    role: "Irrigation Engineer",
    description: "Specializes in water management systems, irrigation scheduling, and water conservation.",
    defaultModel: AIModel.Llama2,
    avatarUrl: "https://images.unsplash.com/photo-1584824188625-0d6dd2183f9e?ixlib=rb-1.2.1&auto=format&fit=crop&w=48&h=48&q=80"
  },
  {
    role: "Pest Management",
    description: "Expert in identifying and managing pests, diseases, and implementing IPM strategies.",
    defaultModel: AIModel.Claude3Haiku,
    avatarUrl: "https://images.unsplash.com/photo-1570913149827-d2ac84ab3f9a?ixlib=rb-1.2.1&auto=format&fit=crop&w=48&h=48&q=80"
  },
  {
    role: "Meteorologist",
    description: "Specializes in weather patterns, climate impacts on agriculture, and seasonal forecasting.",
    defaultModel: AIModel.GPT35Turbo,
    avatarUrl: "https://images.unsplash.com/photo-1564939558297-fc396f18e5c7?ixlib=rb-1.2.1&auto=format&fit=crop&w=48&h=48&q=80"
  },
  {
    role: "File Creator",
    description: "Creates useful files like spreadsheets, reports, and scripts based on discussion needs.",
    defaultModel: AIModel.GPT4,
    avatarUrl: "https://images.unsplash.com/photo-1598300042247-d088f8ab3a91?ixlib=rb-1.2.1&auto=format&fit=crop&w=48&h=48&q=80"
  },
  {
    role: "Research Analyst",
    description: "Accesses and analyzes current agricultural research, market trends, and industry news.",
    defaultModel: AIModel.Llama3Sonar,
    avatarUrl: "https://images.unsplash.com/photo-1501504905252-473c47e087f8?ixlib=rb-1.2.1&auto=format&fit=crop&w=48&h=48&q=80"
  },
  {
    role: "Imagery Specialist",
    description: "Generates agricultural visualizations, crop imagery, and visual planning aids.",
    defaultModel: AIModel.GeminiFlash,
    avatarUrl: "https://images.unsplash.com/photo-1607000975631-8094b497b327?ixlib=rb-1.2.1&auto=format&fit=crop&w=48&h=48&q=80"
  },
  {
    role: "Moderator",
    description: "Manages conversation summaries and context, providing key insights and bullet points.",
    defaultModel: AIModel.Claude3Opus,
    avatarUrl: "https://images.unsplash.com/photo-1506794778202-cad84cf45f1d?ixlib=rb-1.2.1&auto=format&fit=crop&w=48&h=48&q=80"
  }
];

// Get readable model names
function getModelDisplayName(modelId: string): string {
  switch(modelId) {
    case AIModel.Claude3Haiku:
      return "Claude 3 Haiku";
    case AIModel.Claude3Sonnet:
      return "Claude 3 Sonnet";
    case AIModel.Claude3Opus:
      return "Claude 3 Opus";
    case AIModel.GPT35Turbo:
      return "GPT-3.5 Turbo";
    case AIModel.GPT4:
      return "GPT-4";
    case AIModel.Llama2:
      return "Llama 2 (70B)";
    case AIModel.Llama3Sonar:
      return "Llama 3.1 Sonar";
    case AIModel.GeminiFlash:
      return "Gemini Flash 2.0";
    default:
      return modelId.split('/').pop() || modelId;
  }
}

interface ExpertSelectorProps {
  onClose: () => void;
  onAddExperts: (experts: { name: string; role: string; model: string; avatarUrl: string }[]) => void;
  selectedExperts: Expert[];
}

interface SelectedExpertState {
  expertIndex: number;
  model: string;
}

export default function ExpertSelector({ onClose, onAddExperts, selectedExperts }: ExpertSelectorProps) {
  const [localSelectedExperts, setLocalSelectedExperts] = useState<SelectedExpertState[]>([]);
  
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
    } else {
      // Add expert with default model
      setLocalSelectedExperts(prev => [
        ...prev, 
        { 
          expertIndex: index, 
          model: availableExperts[index].defaultModel 
        }
      ]);
    }
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
    return found ? found.model : availableExperts[expertIndex].defaultModel;
  };
  
  return (
    <div className="absolute inset-0 bg-white bg-opacity-95 z-10 flex flex-col p-4">
      <div className="flex justify-between items-center mb-4">
        <h2 className="font-serif font-bold text-xl">Select Your Experts</h2>
        <Button variant="ghost" size="icon" onClick={onClose}>
          <X className="h-5 w-5" />
        </Button>
      </div>
      
      <p className="mb-4">Choose 4-8 AI experts to join your agricultural roundtable discussion. Customize each expert's AI model based on your needs.</p>
      
      <ScrollArea className="flex-1">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {availableExperts.map((expert, index) => {
            const isSelected = isExpertSelected(index);
            const isAlreadyAdded = expertRoles.has(expert.role);
            const selectedModel = getSelectedModel(index);
            
            return (
              <div
                key={index}
                className={`border rounded-lg p-3 transition-colors ${
                  isSelected ? 'border-primary bg-primary-light bg-opacity-10' : 
                  isAlreadyAdded ? 'border-neutral-400 bg-neutral-100 opacity-60' : 'border-neutral-300 hover:border-primary'
                }`}
              >
                <div className="flex items-center mb-2">
                  <img 
                    src={expert.avatarUrl} 
                    alt={expert.role} 
                    className="w-12 h-12 rounded-full mr-3"
                  />
                  <div className="flex-1">
                    <h3 className="font-medium">{expert.role}</h3>
                    <div className="flex items-center mt-1">
                      <ModelBadge modelId={selectedModel} size="sm" />
                      
                      {!isAlreadyAdded && isSelected && (
                        <Popover>
                          <PopoverTrigger asChild>
                            <Button variant="ghost" size="sm" className="h-6 p-0 ml-2">
                              <Settings className="h-3.5 w-3.5 text-neutral-500" />
                            </Button>
                          </PopoverTrigger>
                          <PopoverContent className="w-[220px] p-2" side="bottom">
                            <div className="flex flex-col space-y-1">
                              <div className="px-2 py-1.5 text-sm font-medium text-neutral-700">Select AI Model</div>
                              {Object.values(AIModel).map((modelId) => (
                                <Button
                                  key={modelId}
                                  variant="ghost"
                                  className="justify-start px-2 py-1.5 h-auto text-sm"
                                  onClick={() => changeExpertModel(index, modelId)}
                                >
                                  <div className="flex items-center w-full">
                                    <div className="flex-1 flex items-center">
                                      <ModelBadge modelId={modelId} size="sm" />
                                    </div>
                                    {selectedModel === modelId && (
                                      <Check className="h-4 w-4 text-primary ml-2" />
                                    )}
                                  </div>
                                </Button>
                              ))}
                            </div>
                          </PopoverContent>
                        </Popover>
                      )}
                    </div>
                  </div>
                  
                  {!isAlreadyAdded && (
                    <Button 
                      variant={isSelected ? "outline" : "default"} 
                      size="sm"
                      onClick={() => toggleExpert(index)}
                    >
                      {isSelected ? "Remove" : "Add"}
                    </Button>
                  )}
                </div>
                <p className="text-sm">{expert.description}</p>
                
                {isAlreadyAdded && (
                  <div className="text-xs text-primary mt-2 font-medium">
                    Already added to this conversation
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </ScrollArea>
      
      <div className="mt-4 pt-4 border-t border-neutral-300 flex justify-between">
        <div>
          <span className="text-sm text-neutral-600">Selected: </span>
          <span className="font-medium">{selectedCount}</span>
          <span className="text-sm text-neutral-600"> / 8 experts</span>
        </div>
        <Button 
          onClick={handleAddExperts}
          disabled={selectedCount < 1 || selectedCount > 8}
          className="bg-primary hover:bg-primary-dark"
        >
          Add Experts
        </Button>
      </div>
    </div>
  );
}

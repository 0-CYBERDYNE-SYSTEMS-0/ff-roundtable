import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { X } from "lucide-react";
import { Expert } from "@shared/schema";

// Define available experts data
const availableExperts = [
  {
    role: "Soil Scientist",
    description: "Specializes in soil health, composition analysis, and fertilization recommendations.",
    model: "claude-3-sonnet-20240229",
    avatarUrl: "https://images.unsplash.com/photo-1560365163-3e8d64e762ef?ixlib=rb-1.2.1&auto=format&fit=crop&w=48&h=48&q=80"
  },
  {
    role: "Crop Specialist",
    description: "Expert in crop varieties, rotation strategies, and yield optimization techniques.",
    model: "gpt-4-0613",
    avatarUrl: "https://images.unsplash.com/photo-1530836369250-ef72a3f5cda8?ixlib=rb-1.2.1&auto=format&fit=crop&w=48&h=48&q=80"
  },
  {
    role: "Irrigation Engineer",
    description: "Specializes in water management systems, irrigation scheduling, and water conservation.",
    model: "meta-llama/llama-2-70b-chat",
    avatarUrl: "https://images.unsplash.com/photo-1584824188625-0d6dd2183f9e?ixlib=rb-1.2.1&auto=format&fit=crop&w=48&h=48&q=80"
  },
  {
    role: "Pest Management",
    description: "Expert in identifying and managing pests, diseases, and implementing IPM strategies.",
    model: "claude-3-haiku-20240307",
    avatarUrl: "https://images.unsplash.com/photo-1570913149827-d2ac84ab3f9a?ixlib=rb-1.2.1&auto=format&fit=crop&w=48&h=48&q=80"
  },
  {
    role: "Meteorologist",
    description: "Specializes in weather patterns, climate impacts on agriculture, and seasonal forecasting.",
    model: "gpt-3.5-turbo",
    avatarUrl: "https://images.unsplash.com/photo-1564939558297-fc396f18e5c7?ixlib=rb-1.2.1&auto=format&fit=crop&w=48&h=48&q=80"
  },
  {
    role: "File Creator",
    description: "Creates useful files like spreadsheets, reports, and scripts based on discussion needs.",
    model: "gpt-4-0613",
    avatarUrl: "https://images.unsplash.com/photo-1598300042247-d088f8ab3a91?ixlib=rb-1.2.1&auto=format&fit=crop&w=48&h=48&q=80"
  },
  {
    role: "Research Analyst",
    description: "Accesses and analyzes current agricultural research, market trends, and industry news.",
    model: "perplexity/llama-3.1-sonar-small-128k-online",
    avatarUrl: "https://images.unsplash.com/photo-1501504905252-473c47e087f8?ixlib=rb-1.2.1&auto=format&fit=crop&w=48&h=48&q=80"
  },
  {
    role: "Imagery Specialist",
    description: "Generates agricultural visualizations, crop imagery, and visual planning aids.",
    model: "gemini/flash-2-0",
    avatarUrl: "https://images.unsplash.com/photo-1607000975631-8094b497b327?ixlib=rb-1.2.1&auto=format&fit=crop&w=48&h=48&q=80"
  },
  {
    role: "Moderator",
    description: "Manages conversation summaries and context, providing key insights and bullet points.",
    model: "claude-3-opus-20240229",
    avatarUrl: "https://images.unsplash.com/photo-1506794778202-cad84cf45f1d?ixlib=rb-1.2.1&auto=format&fit=crop&w=48&h=48&q=80"
  }
];

interface ExpertSelectorProps {
  onClose: () => void;
  onAddExperts: (experts: { name: string; role: string; model: string; avatarUrl: string }[]) => void;
  selectedExperts: Expert[];
}

export default function ExpertSelector({ onClose, onAddExperts, selectedExperts }: ExpertSelectorProps) {
  const [localSelectedExperts, setLocalSelectedExperts] = useState<Set<number>>(new Set());
  
  // Check if we already have some experts selected
  const expertRoles = new Set(selectedExperts.map(e => e.role));
  
  // Handle selecting an expert
  const toggleExpert = (index: number) => {
    const newSelected = new Set(localSelectedExperts);
    
    if (newSelected.has(index)) {
      newSelected.delete(index);
    } else {
      newSelected.add(index);
    }
    
    setLocalSelectedExperts(newSelected);
  };
  
  // Handle adding experts to conversation
  const handleAddExperts = () => {
    const selectedExpertData = Array.from(localSelectedExperts).map(index => {
      const expert = availableExperts[index];
      
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
        model: expert.model,
        avatarUrl: expert.avatarUrl
      };
    });
    
    onAddExperts(selectedExpertData);
  };
  
  const selectedCount = localSelectedExperts.size;
  
  return (
    <div className="absolute inset-0 bg-white bg-opacity-95 z-10 flex flex-col p-4">
      <div className="flex justify-between items-center mb-4">
        <h2 className="font-serif font-bold text-xl">Select Your Experts</h2>
        <Button variant="ghost" size="icon" onClick={onClose}>
          <X className="h-5 w-5" />
        </Button>
      </div>
      
      <p className="mb-4">Choose 4-8 AI experts to join your agricultural roundtable discussion.</p>
      
      <ScrollArea className="flex-1">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {availableExperts.map((expert, index) => {
            const isSelected = localSelectedExperts.has(index);
            const isAlreadyAdded = expertRoles.has(expert.role);
            
            return (
              <div
                key={index}
                className={`border rounded-lg p-3 cursor-pointer transition-colors ${
                  isSelected ? 'border-primary bg-primary-light bg-opacity-10' : 
                  isAlreadyAdded ? 'border-neutral-400 bg-neutral-100 opacity-60' : 'border-neutral-300 hover:border-primary'
                }`}
                onClick={() => !isAlreadyAdded && toggleExpert(index)}
              >
                <div className="flex items-center mb-2">
                  <img 
                    src={expert.avatarUrl} 
                    alt={expert.role} 
                    className="w-12 h-12 rounded-full mr-3"
                  />
                  <div>
                    <h3 className="font-medium">{expert.role}</h3>
                    <p className="text-xs text-neutral-600">{expert.model.split('/').pop()}</p>
                  </div>
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

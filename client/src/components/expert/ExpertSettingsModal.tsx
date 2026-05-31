import { useState } from "react";
import { Expert } from "@shared/schema";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Save, X } from "lucide-react";

interface ExpertSettingsModalProps {
  expert: Expert | null;
  isOpen: boolean;
  onClose: () => void;
  onSave: (expertId: number, updates: Partial<Expert>) => void;
}

export default function ExpertSettingsModal({
  expert,
  isOpen,
  onClose,
  onSave
}: ExpertSettingsModalProps) {
  const [customInstructions, setCustomInstructions] = useState("");
  const [name, setName] = useState(expert?.name || "");
  const [model, setModel] = useState(expert?.model || "");

  if (!expert) return null;

  const handleSave = () => {
    onSave(expert.id, {
      name,
      model,
    });
    onClose();
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="text-farm-blue flex items-center gap-2">
            <div className="w-8 h-8 rounded-full bg-farm-green text-white flex items-center justify-center text-sm font-semibold">
              {expert.name.charAt(0)}
            </div>
            Edit Expert: {expert.role}
          </DialogTitle>
          <DialogDescription>
            Customize this expert's behavior, instructions, and settings
          </DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="instructions" className="flex-1 flex flex-col overflow-hidden">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="instructions">Custom Instructions</TabsTrigger>
            <TabsTrigger value="settings">Settings</TabsTrigger>
          </TabsList>

          <TabsContent value="instructions" className="flex-1 overflow-auto space-y-4 mt-4">
            <div className="space-y-2">
              <Label htmlFor="custom-instructions" className="text-sm font-medium">
                Custom Instructions
              </Label>
              <p className="text-xs text-neutral-600">
                Add specific instructions to customize how this expert responds. These will be added to the expert's system prompt.
              </p>
              <Textarea
                id="custom-instructions"
                placeholder={`Example for ${expert.role}:\n\n• Focus on sustainable practices\n• Provide cost-benefit analysis\n• Include regional considerations\n• Reference recent studies`}
                value={customInstructions}
                onChange={(e) => setCustomInstructions(e.target.value)}
                className="min-h-[300px] font-mono text-sm"
              />
              <p className="text-xs text-neutral-500">
                {customInstructions.length} characters
              </p>
            </div>
          </TabsContent>

          <TabsContent value="settings" className="flex-1 overflow-auto space-y-4 mt-4">
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="expert-name" className="text-sm font-medium">
                  Expert Name
                </Label>
                <Input
                  id="expert-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g., Dr. Smith"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="expert-role" className="text-sm font-medium">
                  Role
                </Label>
                <Input
                  id="expert-role"
                  value={expert.role}
                  disabled
                  className="bg-neutral-50 cursor-not-allowed"
                />
                <p className="text-xs text-neutral-500">Role cannot be changed</p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="expert-model" className="text-sm font-medium">
                  AI Model
                </Label>
                <Select value={model} onValueChange={setModel}>
                  <SelectTrigger id="expert-model">
                    <SelectValue placeholder="Select a model" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="anthropic/claude-3.5-sonnet">Claude 3.5 Sonnet (Recommended)</SelectItem>
                    <SelectItem value="anthropic/claude-3-opus">Claude 3 Opus (Most Capable)</SelectItem>
                    <SelectItem value="anthropic/claude-3-haiku">Claude 3 Haiku (Fast)</SelectItem>
                    <SelectItem value="openai/gpt-4o">GPT-4o</SelectItem>
                    <SelectItem value="openai/gpt-4-turbo">GPT-4 Turbo</SelectItem>
                    <SelectItem value="google/gemini-pro-1.5">Gemini Pro 1.5</SelectItem>
                    <SelectItem value="meta-llama/llama-3.1-70b-instruct">Llama 3.1 70B</SelectItem>
                    <SelectItem value="mistralai/mistral-large">Mistral Large</SelectItem>
                    <SelectItem value="deepseek/deepseek-v3.2">DeepSeek V3.2</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="p-4 bg-farm-powder/30 rounded-lg border border-farm-tan/30">
                <h4 className="text-sm font-medium text-farm-blue mb-2">Expert Info</h4>
                <div className="space-y-1 text-xs text-neutral-600">
                  <p><strong>Conversation ID:</strong> {expert.conversationId}</p>
                  <p><strong>Expert ID:</strong> {expert.id}</p>
                </div>
              </div>
            </div>
          </TabsContent>
        </Tabs>

        <div className="flex justify-end gap-2 pt-4 border-t">
          <Button variant="outline" onClick={onClose} className="gap-2">
            <X className="w-4 h-4" />
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            className="bg-farm-green hover:bg-farm-dark-green text-white gap-2"
          >
            <Save className="w-4 h-4" />
            Save Changes
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

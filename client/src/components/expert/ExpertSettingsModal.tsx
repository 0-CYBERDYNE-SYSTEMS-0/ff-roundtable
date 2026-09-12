import { useEffect, useState } from "react";
import { Expert } from "@shared/schema";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Save, X } from "lucide-react";

// Keep in sync with isPaidModel() in server/tiers.ts
const isFreeModelId = (id: string) => id.endsWith(":free");

const MODEL_OPTIONS = [
  { id: "anthropic/claude-3.5-sonnet", label: "Claude 3.5 Sonnet (Recommended)" },
  { id: "anthropic/claude-3-opus", label: "Claude 3 Opus (Most Capable)" },
  { id: "anthropic/claude-3-haiku", label: "Claude 3 Haiku (Fast)" },
  { id: "openai/gpt-4o", label: "GPT-4o" },
  { id: "openai/gpt-4-turbo", label: "GPT-4 Turbo" },
  { id: "google/gemini-pro-1.5", label: "Gemini Pro 1.5" },
  { id: "meta-llama/llama-3.1-70b-instruct", label: "Llama 3.1 70B" },
  { id: "mistralai/mistral-large", label: "Mistral Large" },
  { id: "deepseek/deepseek-v3.2", label: "DeepSeek V3.2" },
  // Free-tier options — the server rejects paid models for free users
  { id: "deepseek/deepseek-v3.2:free", label: "DeepSeek V3.2 (Free)" },
  { id: "meta-llama/llama-3.1-70b-instruct:free", label: "Llama 3.1 70B (Free)" },
];

interface ExpertSettingsModalProps {
  expert: Expert | null;
  isOpen: boolean;
  onClose: () => void;
  onSave: (expertId: number, updates: Partial<Expert>) => Promise<void> | void;
}

export default function ExpertSettingsModal({
  expert,
  isOpen,
  onClose,
  onSave
}: ExpertSettingsModalProps) {
  const [isSaving, setIsSaving] = useState(false);
  const [customInstructions, setCustomInstructions] = useState("");
  const [name, setName] = useState(expert?.name || "");
  const [model, setModel] = useState(expert?.model || "");
  const [userTier, setUserTier] = useState<string | null>(null);

  useEffect(() => {
    if (!expert) return;
    setName(expert.name);
    setModel(expert.model);
    setCustomInstructions(expert.customInstructions || "");
  }, [expert]);

  // The server blocks paid models for free-tier users (PATCH /api/experts/:id),
  // so the picker only offers paid models once the tier is known to allow them.
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    fetch("/api/user/tier", { credentials: "include" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!cancelled && data?.tier) setUserTier(data.tier);
      })
      .catch(() => {
        // Tier unknown — show the full list and let the server enforce limits.
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen]);

  if (!expert) return null;

  const modelOptions =
    userTier === "free"
      ? MODEL_OPTIONS.filter((option) => isFreeModelId(option.id))
      : MODEL_OPTIONS;

  // Always offer the expert's current model, even when it isn't in the
  // standard list (e.g. dev-config models), so it stays visible and selectable.
  const optionsWithCurrent =
    model && !modelOptions.some((option) => option.id === model)
      ? [{ id: model, label: `${model} (current)` }, ...modelOptions]
      : modelOptions;

  const handleSave = async () => {
    if (!name.trim() || isSaving) return;
    setIsSaving(true);
    try {
      await onSave(expert.id, {
        name: name.trim(),
        model,
        customInstructions: customInstructions.trim(),
      });
      onClose();
    } catch {
      // The caller already surfaced the failure via toast; keep the modal
      // open so the user's edits are not lost.
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && !isSaving && onClose()}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-hidden grid grid-rows-[auto_minmax(0,1fr)_auto] gap-4">
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

        <Tabs defaultValue="instructions" className="min-h-0 flex flex-col overflow-hidden">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="instructions">Custom Instructions</TabsTrigger>
            <TabsTrigger value="settings">Settings</TabsTrigger>
          </TabsList>

          <TabsContent value="instructions" className="flex-1 min-h-0 overflow-auto space-y-4 mt-4">
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

          <TabsContent value="settings" className="flex-1 min-h-0 overflow-auto space-y-4 mt-4">
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
                    {optionsWithCurrent.map((option) => (
                      <SelectItem key={option.id} value={option.id}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {userTier === "free" && (
                  <p className="text-xs text-neutral-500">
                    Your free tier includes free models. Upgrade to Pro for Claude, GPT-4o and other premium models.
                  </p>
                )}
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
          <Button variant="outline" onClick={onClose} disabled={isSaving} className="gap-2">
            <X className="w-4 h-4" />
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            disabled={isSaving || !name.trim() || !model}
            className="bg-farm-green hover:bg-farm-dark-green text-white gap-2"
          >
            {isSaving ? <span className="text-sm">Saving…</span> : <><Save className="w-4 h-4" />Save Changes</>}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

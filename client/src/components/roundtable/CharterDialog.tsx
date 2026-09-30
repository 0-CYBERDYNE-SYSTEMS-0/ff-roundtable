import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Loader2, ScrollText } from "lucide-react";

// Mirrors the server-side hard cap on conversations.charter.
const CHARTER_MAX_LENGTH = 2000;
const DEFAULT_TURN_BUDGET = 25;
const MAX_TURN_BUDGET = 100;

interface CharterDialogProps {
  open: boolean;
  conversationId: number | null;
  currentCharter: string | null;
  currentTurnBudget?: number | null;
  onClose: () => void;
}

export default function CharterDialog({
  open,
  conversationId,
  currentCharter,
  currentTurnBudget,
  onClose,
}: CharterDialogProps) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [draft, setDraft] = useState("");
  const [budgetDraft, setBudgetDraft] = useState(String(DEFAULT_TURN_BUDGET));
  const [letItRun, setLetItRun] = useState(false);

  // Pre-fill from the conversation's current charter each time it opens.
  useEffect(() => {
    if (open) {
      setDraft(currentCharter ?? "");
      setLetItRun(currentTurnBudget === null);
      setBudgetDraft(
        typeof currentTurnBudget === "number" &&
          Number.isInteger(currentTurnBudget) &&
          currentTurnBudget >= 1 &&
          currentTurnBudget <= MAX_TURN_BUDGET
          ? String(currentTurnBudget)
          : String(DEFAULT_TURN_BUDGET),
      );
    }
  }, [open, currentCharter, currentTurnBudget]);

  const saveCharterMutation = useMutation({
    mutationFn: async ({ charter, turnBudget }: { charter: string; turnBudget: number | null }) => {
      if (!conversationId) throw new Error("No active conversation");
      await apiRequest("PUT", `/api/protected/conversations/${conversationId}`, { charter, turnBudget });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/protected/conversations"] });
      toast({ title: "Charter saved" });
      onClose();
    },
    onError: (error: Error) => {
      toast({
        title: "Failed to save charter",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const overLimit = draft.length > CHARTER_MAX_LENGTH;
  const parsedBudget = /^\d+$/.test(budgetDraft) ? Number(budgetDraft) : NaN;
  const budgetIsValid = letItRun || (
    Number.isInteger(parsedBudget) && parsedBudget >= 1 && parsedBudget <= MAX_TURN_BUDGET
  );

  const handleSave = () => {
    if (!conversationId || overLimit || !budgetIsValid || saveCharterMutation.isPending) return;
    saveCharterMutation.mutate({
      charter: draft,
      turnBudget: letItRun ? null : parsedBudget,
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-farm-blue">
            <ScrollText className="h-5 w-5 text-farm-green" />
            Council Charter
          </DialogTitle>
          <DialogDescription>
            Give your experts a shared goal, depth, and stopping criteria so they pull in the
            same direction — and know when the discussion is done.
          </DialogDescription>
        </DialogHeader>
        <Textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={8}
          placeholder="e.g. Advise on transitioning 40 acres to an organic vegetable rotation. Practical steps with costs. Conclude once there is an agreed season-by-season plan."
          className="border-farm-tan/40 focus:border-farm-blue focus:ring-farm-blue/20 resize-y"
          aria-label="Council charter"
        />
        <p
          className={`text-xs ${overLimit ? "font-medium text-red-600" : "text-neutral-500"}`}
          aria-live="polite"
        >
          {draft.length} / {CHARTER_MAX_LENGTH}
        </p>
        <fieldset className="mt-4 space-y-3" disabled={saveCharterMutation.isPending}>
          <legend className="text-sm font-semibold text-farm-blue">Discussion budget</legend>
          <label className="flex items-center gap-2 text-sm text-neutral-700">
            <input
              type="radio"
              name="turn-budget-mode"
              checked={!letItRun}
              onChange={() => setLetItRun(false)}
              aria-label="Set a turn limit"
            />
            Set a turn limit
          </label>
          <div className="ml-6 flex items-center gap-2">
            <input
              type="number"
              min={1}
              max={MAX_TURN_BUDGET}
              step={1}
              value={budgetDraft}
              onChange={(event) => setBudgetDraft(event.target.value)}
              disabled={letItRun || saveCharterMutation.isPending}
              aria-label="Expert turn limit"
              aria-invalid={!letItRun && !budgetIsValid}
              aria-describedby={!letItRun && !budgetIsValid ? "turn-budget-error" : undefined}
              className="w-24 rounded-md border border-farm-tan/40 px-3 py-2 text-sm focus:border-farm-blue focus:outline-none focus:ring-2 focus:ring-farm-blue/20 disabled:bg-neutral-100"
            />
            <span className="text-sm text-neutral-600">expert turns (1–{MAX_TURN_BUDGET})</span>
          </div>
          {!letItRun && !budgetIsValid && (
            <p id="turn-budget-error" className="ml-6 text-xs text-red-600" role="alert">
              Enter a whole number from 1 to {MAX_TURN_BUDGET}.
            </p>
          )}
          <label className="flex items-start gap-2 text-sm text-neutral-700">
            <input
              type="radio"
              name="turn-budget-mode"
              checked={letItRun}
              onChange={() => setLetItRun(true)}
              aria-label="Let it run"
              className="mt-0.5"
            />
            <span>
              <span className="block font-medium">Let it run</span>
              <span className="block text-xs text-neutral-500">
                Continue until the council concludes, up to 100 expert turns.
              </span>
            </span>
          </label>
        </fieldset>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saveCharterMutation.isPending}>
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            disabled={saveCharterMutation.isPending || overLimit || !budgetIsValid}
            className="bg-farm-green text-white hover:bg-farm-dark-green"
          >
            {saveCharterMutation.isPending && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

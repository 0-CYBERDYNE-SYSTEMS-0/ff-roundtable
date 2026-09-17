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

interface CharterDialogProps {
  open: boolean;
  conversationId: number | null;
  currentCharter: string | null;
  onClose: () => void;
}

export default function CharterDialog({
  open,
  conversationId,
  currentCharter,
  onClose,
}: CharterDialogProps) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [draft, setDraft] = useState("");

  // Pre-fill from the conversation's current charter each time it opens.
  useEffect(() => {
    if (open) {
      setDraft(currentCharter ?? "");
    }
  }, [open, currentCharter]);

  const saveCharterMutation = useMutation({
    mutationFn: async (charter: string) => {
      if (!conversationId) throw new Error("No active conversation");
      await apiRequest("PUT", `/api/protected/conversations/${conversationId}`, { charter });
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

  const handleSave = () => {
    if (!conversationId || overLimit || saveCharterMutation.isPending) return;
    saveCharterMutation.mutate(draft);
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
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saveCharterMutation.isPending}>
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            disabled={saveCharterMutation.isPending || overLimit}
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

import { useState, useEffect, useRef } from "react";
import { useAuth } from "@/hooks/use-auth";
import { useIsMobile } from "@/hooks/use-mobile";
import Header from "@/components/layout/Header";
import SidebarPanel from "@/components/sidebar/SidebarPanel";
import ChatInterface from "@/components/chat/ChatInterface";
import ExpertSelector from "@/components/roundtable/ExpertSelector";
import CharterDialog from "@/components/roundtable/CharterDialog";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Expert, Message, Insight, File as FileType, Conversation, FarmProfile, OpenQuestion } from "@shared/schema";
import FarmProfileModal from "@/components/farm/FarmProfileModal";
import { useWebSocket, sendWebSocketSubscription, sendWebSocketUnsubscription } from "@/lib/websocket-utils";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { PauseIcon, PlayIcon, ScrollText, XIcon, ChevronLeft, ChevronRight } from "lucide-react";
import { parseNewCommand } from "@/lib/new-command";

// G9 quiet console: per-event chatter is gated behind a debug flag so the
// browser console stays readable in production. Force it per-tab with
// localStorage.setItem("ffDebug", "1"). console.error/console.warn for
// genuine failures are never gated.
const ffDebug =
  import.meta.env.DEV ||
  (typeof localStorage !== "undefined" && localStorage.getItem("ffDebug") === "1");

const debugLog = (...args: unknown[]) => {
  if (ffDebug) console.log(...args);
};

// Define the type for interaction modes matching the backend
type InteractionMode = 
    | "idle" 
    | "processing_sequential" 
    | "paused" 
    | "autonomous";

const DEFAULT_LEFT_SIDEBAR_WIDTH = 288;
const MIN_LEFT_SIDEBAR_WIDTH = 288;
const MAX_LEFT_SIDEBAR_WIDTH = 400;
const COLLAPSED_SIDEBAR_RAIL_WIDTH = 40;

function getMaxLeftSidebarWidth() {
  const viewportWidth = typeof window === "undefined" ? MAX_LEFT_SIDEBAR_WIDTH : window.innerWidth;
  return Math.max(MIN_LEFT_SIDEBAR_WIDTH, Math.min(MAX_LEFT_SIDEBAR_WIDTH, Math.floor(viewportWidth * 0.3)));
}

function readLeftSidebarWidth() {
  try {
    const storedWidth = Number(localStorage.getItem("ffLeftSidebarWidth"));
    if (Number.isFinite(storedWidth) && storedWidth >= MIN_LEFT_SIDEBAR_WIDTH) {
      return Math.max(MIN_LEFT_SIDEBAR_WIDTH, Math.min(getMaxLeftSidebarWidth(), storedWidth));
    }
  } catch {
    // Use the default width when browser storage is unavailable.
  }
  return Math.min(DEFAULT_LEFT_SIDEBAR_WIDTH, getMaxLeftSidebarWidth());
}

function readLeftSidebarCollapsed() {
  try {
    return localStorage.getItem("ffLeftSidebarCollapsed") === "1";
  } catch {
    return false;
  }
}

export default function HomePage() {
  const { user } = useAuth();
  const { toast } = useToast();
  const isMobile = useIsMobile();
  const [activeConversation, setActiveConversation] = useState<number | null>(null);
  const [selectedExperts, setSelectedExperts] = useState<Expert[]>([]);
  const [showExpertSelector, setShowExpertSelector] = useState(false);
  const [showFarmProfileModal, setShowFarmProfileModal] = useState(false);
  const [farmProfileModalDismissed, setFarmProfileModalDismissed] = useState(() => {
    try {
      return localStorage.getItem("ffFarmProfileDismissed") === "1";
    } catch {
      return false;
    }
  });
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [isLeftSidebarCollapsed, setIsLeftSidebarCollapsed] = useState(readLeftSidebarCollapsed);
  const [leftSidebarWidth, setLeftSidebarWidth] = useState(readLeftSidebarWidth);
  const [maxLeftSidebarWidth, setMaxLeftSidebarWidth] = useState(() => getMaxLeftSidebarWidth());
  const [isResizingLeftSidebar, setIsResizingLeftSidebar] = useState(false);
  const leftSidebarResizeRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const sidebarDrawerRef = useRef<HTMLDivElement>(null);
  const sidebarToggleRef = useRef<HTMLButtonElement>(null);

  const dismissFarmProfileModal = () => {
    setShowFarmProfileModal(false);
    setFarmProfileModalDismissed(true);
    try {
      localStorage.setItem("ffFarmProfileDismissed", "1");
    } catch {
      // Keep the modal dismissed for this session when storage is unavailable.
    }
  };

  useEffect(() => {
    const updateSidebarMaxWidth = () => {
      const maxWidth = getMaxLeftSidebarWidth();
      setMaxLeftSidebarWidth(maxWidth);
      setLeftSidebarWidth((width) => Math.min(width, maxWidth));
    };
    window.addEventListener("resize", updateSidebarMaxWidth);
    return () => window.removeEventListener("resize", updateSidebarMaxWidth);
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem("ffLeftSidebarCollapsed", isLeftSidebarCollapsed ? "1" : "0");
    } catch {
      // Keep the current layout for this session when storage is unavailable.
    }
  }, [isLeftSidebarCollapsed]);

  useEffect(() => {
    try {
      localStorage.setItem("ffLeftSidebarWidth", String(leftSidebarWidth));
    } catch {
      // Keep the current layout for this session when storage is unavailable.
    }
  }, [leftSidebarWidth]);

  const handleLeftSidebarResizeStart = (event: React.PointerEvent<HTMLDivElement>) => {
    if (isMobile) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    leftSidebarResizeRef.current = { startX: event.clientX, startWidth: leftSidebarWidth };
    setIsResizingLeftSidebar(true);
  };

  const handleLeftSidebarResizeMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const resize = leftSidebarResizeRef.current;
    if (!resize) return;
    const width = resize.startWidth + event.clientX - resize.startX;
    setLeftSidebarWidth(Math.max(MIN_LEFT_SIDEBAR_WIDTH, Math.min(maxLeftSidebarWidth, width)));
  };

  const stopLeftSidebarResize = () => {
    leftSidebarResizeRef.current = null;
    setIsResizingLeftSidebar(false);
  };

  const handleLeftSidebarResizeKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      const delta = event.key === "ArrowRight" ? 16 : -16;
      setLeftSidebarWidth((width) => Math.max(MIN_LEFT_SIDEBAR_WIDTH, Math.min(maxLeftSidebarWidth, width + delta)));
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      setLeftSidebarWidth(event.key === "Home" ? MIN_LEFT_SIDEBAR_WIDTH : maxLeftSidebarWidth);
    }
  };

  useEffect(() => {
    const drawer = sidebarDrawerRef.current;
    if (!drawer) return;
    if (isMobile && !sidebarOpen) {
      drawer.setAttribute("inert", "");
      if (drawer.contains(document.activeElement)) sidebarToggleRef.current?.focus();
    } else {
      drawer.removeAttribute("inert");
    }
  }, [isMobile, sidebarOpen]);
  
  // Add state for interaction control
  const [interactionMode, setInteractionMode] = useState<InteractionMode>("idle");
  const [isAutonomousEnabled, setIsAutonomousEnabled] = useState<boolean>(true); // Default to true initially
  const [isProcessing, setIsProcessing] = useState<boolean>(false); // Track if experts are currently responding
  const [expertTurnCounts, setExpertTurnCounts] = useState<{ consumed: number; remaining: number } | null>(null);

  // A busy discussion may queue farmer input for the next Moderator route.
  // Keep it visible until pickup; an idle state after exhausted recovery means
  // the stored message is waiting for the user to retry or explicitly restart.
  const [hasQueuedMessage, setHasQueuedMessage] = useState<boolean>(false);

  // G5: the Moderator decided the discussion is done and is delivering the
  // closing synthesis. Cleared alongside the other transient flags.
  const [isConcluding, setIsConcluding] = useState<boolean>(false);

  // G6: council charter editor + one-time nudge. The dismissal is persisted
  // so the nudge never comes back once dismissed.
  const [charterDialogOpen, setCharterDialogOpen] = useState<boolean>(false);
  const [charterNudgeDismissed, setCharterNudgeDismissed] = useState<boolean>(() => {
    try {
      return localStorage.getItem("ffCharterNudgeDismissed") === "1";
    } catch {
      return false;
    }
  });

  // Streaming state
  const [streamingMessages, setStreamingMessages] = useState<Map<number | null, { content: string; expertName: string; expertRole: string }>>(new Map());
  const [typingExpertIds, setTypingExpertIds] = useState<Set<number | null>>(new Set());

  // G9: expert announced by the server's next_speaker broadcast — the Expert
  // Panel shows an "up next" treatment on their row until their stream starts
  // (typing state takes over) or the round/session resets.
  const [upNextExpertId, setUpNextExpertId] = useState<number | null>(null);

  // WebSocket connection for real-time updates
  const { socket, status: socketStatus, reconnectAttempts } = useWebSocket();
  
  // Fetch user's conversations
  const {
    data: conversations,
    isLoading: isLoadingConversations,
    isError: conversationsError,
  } = useQuery<Conversation[]>({
    queryKey: ["/api/protected/conversations"],
    enabled: !!user,
  });

  // Fetch farm profile — auto-open modal on first login when no profile exists
  const farmProfileQuery = useQuery<{ profile: FarmProfile | null; weather: string | null }>({
    queryKey: ["/api/protected/farm-profile"],
    enabled: !!user,
  });
  const farmProfile = farmProfileQuery.data?.profile ?? null;
  
  // Create a new conversation
  const createConversationMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/protected/conversations", { title: "New Conversation" });
      return await res.json();
    },
    onSuccess: (newConversation) => {
      queryClient.invalidateQueries({ queryKey: ["/api/protected/conversations"] });
      setHasQueuedMessage(false);
      setActiveConversation(newConversation.id);
    },
    onError: (error: Error) => {
      toast({
        title: "Failed to create conversation",
        description: error.message,
        variant: "destructive",
      });
    },
  });
  
  // Quick setup for development
  const quickSetupMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/dev/quick-setup", {});
      return await res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/protected/conversations"] });
      setHasQueuedMessage(false);
      setActiveConversation(data.conversationId);
    },
    onError: (error: Error) => {
      toast({
        title: "Quick setup failed",
        description: error.message,
        variant: "destructive",
      });
    },
  });
  
  // Add expert to conversation
  const addExpertMutation = useMutation({
    mutationFn: async (expert: { name: string; role: string; model: string; avatarUrl: string; customInstructions?: string }) => {
      if (!activeConversation) throw new Error("No active conversation");
      const res = await apiRequest("POST", `/api/protected/conversations/${activeConversation}/experts`, expert);
      return await res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/protected/conversations/${activeConversation}/experts`] });
    },
    onError: (error: Error) => {
      toast({
        title: "Failed to add expert",
        description: error.message,
        variant: "destructive",
      });
    },
  });
  
  // Fetch experts for active conversation
  const {
    data: experts,
    isLoading: isLoadingExperts,
    isError: expertsError,
  } = useQuery<Expert[]>({
    queryKey: [`/api/protected/conversations/${activeConversation}/experts`],
    enabled: !!activeConversation,
  });
  
  // Fetch messages for active conversation
  const {
    data: messages,
    isLoading: isLoadingMessages,
    isError: messagesError,
  } = useQuery<Message[]>({
    queryKey: [`/api/protected/conversations/${activeConversation}/messages`],
    enabled: !!activeConversation,
  });

  // Open questions are stored separately from the transcript so they remain
  // actionable when a farmer comes back to a discussion hours later.
  const { data: openQuestions = [] } = useQuery<OpenQuestion[]>({
    queryKey: [`/api/protected/conversations/${activeConversation}/open-questions`],
    enabled: !!activeConversation,
  });
  
  // Fetch insights for active conversation
  const {
    data: insights,
    isLoading: isLoadingInsights,
    isError: insightsError,
  } = useQuery<Insight[]>({
    queryKey: [`/api/protected/conversations/${activeConversation}/insights`],
    enabled: !!activeConversation,
  });
  
  // Fetch files for active conversation
  const {
    data: files,
    isLoading: isLoadingFiles,
    isError: filesError,
  } = useQuery<FileType[]>({
    queryKey: [`/api/protected/conversations/${activeConversation}/files`],
    enabled: !!activeConversation,
  });
  
  // Send message mutation
  const sendMessageMutation = useMutation<
    Message,
    Error,
    { content: string; answersQuestionId?: number },
    { previousMessages?: Message[]; tempId?: number; conversationId?: number }
  >({
    mutationFn: async ({ content, answersQuestionId }) => {
      if (!activeConversation) throw new Error("No active conversation");
      if (!user) throw new Error("User not authenticated");

      const path = answersQuestionId
        ? `/api/protected/conversations/${activeConversation}/open-questions/${answersQuestionId}/answer`
        : `/api/protected/conversations/${activeConversation}/messages`;
      const res = await apiRequest("POST", path, { content, userId: user.id });

      if (!res.ok) {
        const errorData = await res.json();
        throw new Error(errorData.message || 'Failed to send message');
      }

      return await res.json();
    },
    onMutate: async ({ content: newMessageContent, answersQuestionId }) => {
      if (!activeConversation || !user) return {};

      const conversationId = activeConversation;
      const messagesQueryKey = [`/api/protected/conversations/${conversationId}/messages`];

      await queryClient.cancelQueries({ queryKey: messagesQueryKey });

      const previousMessages = queryClient.getQueryData<Message[]>(messagesQueryKey);
      const tempId = Date.now();

      queryClient.setQueryData<Message[]>(messagesQueryKey, (old = []) => [
        ...old,
        {
          id: tempId,
          conversationId,
          userId: user.id,
          expertId: null,
          content: newMessageContent,
          role: "user",
          expertName: null,
          expertRole: null,
          answersQuestionId: answersQuestionId ?? (openQuestions.length === 1 ? openQuestions[0].id : null),
          timestamp: new Date(),
        },
      ]);

      // Capture the conversation id — the settle-time callbacks must touch the
      // cache this message belongs to, even if the user switches conversations
      // while the POST is in flight.
      return { previousMessages, tempId, conversationId };
    },
    onSuccess: (storedMessage, _content, context) => {
      // Swap the optimistic temp message for the stored one. The WebSocket
      // copy may have landed first, so tolerate both orderings.
      if (!context?.conversationId || !context?.tempId) return;
      const messagesQueryKey = [`/api/protected/conversations/${context.conversationId}/messages`];
      queryClient.setQueryData<Message[]>(messagesQueryKey, (old = []) => {
        const withoutTemp = old.filter(m => m.id !== context.tempId);
        if (withoutTemp.some(m => m.id === storedMessage.id)) return withoutTemp;
        return [...withoutTemp, storedMessage];
      });
      queryClient.invalidateQueries({ queryKey: [`/api/protected/conversations/${context.conversationId}/open-questions`] });
    },
    onError: (err, _newMessageContent, context) => {
      if (!context?.conversationId) return;
      const messagesQueryKey = [`/api/protected/conversations/${context.conversationId}/messages`];

      if (context.previousMessages) {
        queryClient.setQueryData(messagesQueryKey, context.previousMessages);
      } else if (context.tempId) {
        queryClient.setQueryData<Message[]>(messagesQueryKey, (old = []) =>
          old.filter(m => m.id !== context.tempId)
        );
      }
      queryClient.invalidateQueries({ queryKey: [`/api/protected/conversations/${context.conversationId}/open-questions`] });
      toast({
        title: "Failed to send message",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  // `/new [topic]` explicitly restarts the current conversation. It has its
  // own endpoint so the command itself is never stored as a chat message.
  const restartConversationMutation = useMutation({
    mutationFn: async ({ conversationId, topic }: { conversationId: number; topic?: string }) => {
      const res = await apiRequest(
        "POST",
        `/api/protected/conversations/${conversationId}/restart`,
        topic ? { topic } : {},
      );
      if (!res.ok) {
        let message = "Failed to restart discussion";
        try {
          const errorData = await res.json();
          message = errorData.message || message;
        } catch {
          // Keep the fallback message if the API response has no JSON body.
        }
        throw new Error(message);
      }
      return conversationId;
    },
    onSuccess: (conversationId) => {
      setHasQueuedMessage(false);
      queryClient.invalidateQueries({ queryKey: [`/api/protected/conversations/${conversationId}/messages`] });
      queryClient.invalidateQueries({ queryKey: [`/api/protected/conversations/${conversationId}`] });
      queryClient.invalidateQueries({ queryKey: ["/api/protected/conversations"] });
    },
    onError: (error: Error) => {
      toast({
        title: "Failed to restart discussion",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  // Normal messages are sent immediately and the server decides whether busy
  // input should wait for the next Moderator route. `/new` is the explicit
  // same-conversation restart command.
  const handleSendMessage = (content: string, answersQuestionId?: number) => {
    const topic = parseNewCommand(content);
    if (topic !== null) {
      if (!activeConversation) return;
      restartConversationMutation.mutate({
        conversationId: activeConversation,
        ...(topic ? { topic } : {}),
      });
      return;
    }
    sendMessageMutation.mutate({ content, answersQuestionId });
  };

  // Upload file mutation
  const uploadFileMutation = useMutation({
    mutationFn: async (formData: FormData) => {
      if (!activeConversation) throw new Error("No active conversation");
      const res = await fetch(`/api/protected/conversations/${activeConversation}/files`, {
        method: "POST",
        body: formData,
        credentials: "include"
      });
      if (!res.ok) {
        const errorText = await res.text();
        throw new Error(errorText);
      }
      return await res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/protected/conversations/${activeConversation}/files`] });
      // The server stores an "[Uploaded file: …]" chat message — refresh the
      // transcript so it appears without waiting for a conversation switch.
      queryClient.invalidateQueries({ queryKey: [`/api/protected/conversations/${activeConversation}/messages`] });
    },
    onError: (error: Error) => {
      toast({
        title: "Failed to upload file",
        description: error.message,
        variant: "destructive",
      });
    },
  });
  
  // Generate insights mutation
  const generateInsightsMutation = useMutation({
    mutationFn: async () => {
      if (!activeConversation) throw new Error("No active conversation");
      const res = await apiRequest("POST", `/api/protected/conversations/${activeConversation}/generate-insights`);
      return await res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/protected/conversations/${activeConversation}/insights`] });
    },
    onError: (error: Error) => {
      toast({
        title: "Failed to generate insights",
        description: error.message,
        variant: "destructive",
      });
    },
  });
  
  // --- Interaction Control Mutations ---

  // Enable Autonomous Mode mutation
  const enableAutoMutation = useMutation({
    // Takes an optional number for maxTurns
    mutationFn: async (maxTurns?: number) => { 
      if (!activeConversation) throw new Error("No active conversation");
      const body: { maxTurns?: number } = {};
      if (typeof maxTurns === 'number') {
        body.maxTurns = maxTurns;
      }
      const res = await apiRequest("POST", `/api/protected/conversations/${activeConversation}/autonomous/enable`, body);
      if (!res.ok) throw new Error((await res.json()).message || "Failed to enable autonomous mode.");
      return await res.json();
    },
    onSuccess: () => {
      setIsAutonomousEnabled(true);
       // State update will come via WebSocket
    },
    onError: (error: Error) => {
      toast({
        title: "Failed to enable autonomous mode",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  // Disable Autonomous Mode mutation
  const disableAutoMutation = useMutation({
    mutationFn: async () => {
      if (!activeConversation) throw new Error("No active conversation");
      const res = await apiRequest("POST", `/api/protected/conversations/${activeConversation}/autonomous/disable`, {});
      if (!res.ok) throw new Error((await res.json()).message || "Failed to disable autonomous mode.");
      return await res.json();
    },
    onSuccess: () => {
      setIsAutonomousEnabled(false);
       // State update will come via WebSocket
    },
    onError: (error: Error) => {
      toast({
        title: "Failed to disable autonomous mode",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  // Pause the running round — the current expert finishes, then the council
  // parks. A paused round is escapable via Resume or by sending a message.
  const pauseMutation = useMutation({
    mutationFn: async () => {
      if (!activeConversation) throw new Error("No active conversation");
      const res = await apiRequest("POST", `/api/protected/conversations/${activeConversation}/pause`);
      return await res.json();
    },
    // No success toast: the paused state arrives via WebSocket state_update.
    onError: (error: Error) => {
      toast({
        title: "Failed to pause",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  // Resume a parked round.
  const resumeMutation = useMutation({
    mutationFn: async () => {
      if (!activeConversation) throw new Error("No active conversation");
      const res = await apiRequest("POST", `/api/protected/conversations/${activeConversation}/resume`);
      return await res.json();
    },
    // No success toast: the resumed state arrives via WebSocket state_update.
    onError: (error: Error) => {
      toast({
        title: "Failed to resume",
        description: error.message,
        variant: "destructive",
      });
    },
  });
  
  // Export conversation as markdown
  const exportMarkdown = () => {
    if (!activeConversation) {
      toast({
        title: "No active conversation",
        description: "Start a conversation first",
        variant: "destructive",
      });
      return;
    }
    
    window.open(`/api/protected/conversations/${activeConversation}/export`, "_blank");
  };

  // Export the conversation's week-by-week plan as an .ics calendar.
  // Uploaded reference files cannot produce calendar events; only plan-like
  // artifacts and current Expert-generated Markdown are candidates.
  const hasSchedulableSource =
    (messages ?? []).some((m) => (m.artifacts?.length ?? 0) > 0) ||
    (files ?? []).some((file) =>
      !file.supersededAt &&
      file.uploadedBy.startsWith("Expert:") &&
      file.filename.toLowerCase().endsWith(".md")
    );

  // The active conversation's record from the list query (title, charter).
  const activeConversationData =
    conversations?.find((conversation) => conversation.id === activeConversation) ?? null;
  useEffect(() => {
    setExpertTurnCounts(null);
  }, [activeConversation]);
  useEffect(() => {
    const snapshot = activeConversationData?.orchestratorState;
    setIsAutonomousEnabled(typeof snapshot?.isAutonomousEnabled === "boolean" ? snapshot.isAutonomousEnabled : true);
  }, [activeConversation, activeConversationData?.orchestratorState]);
  // G13: older conversation responses may omit turnBudget; the dialog applies
  // the standard 25-turn default in that case. Null means "Let it run".
  const activeTurnBudget = (
    activeConversationData as (typeof activeConversationData & { turnBudget?: number | null }) | null
  )?.turnBudget;

  // Charter badge/nudge: a blank string counts as "no charter".
  const activeHasCharter = !!activeConversationData?.charter;
  const showCharterNudge =
    !charterNudgeDismissed &&
    !isLoadingConversations &&
    !charterDialogOpen &&
    !!activeConversationData &&
    (experts ?? []).length > 0 &&
    !activeHasCharter;

  const handleDismissCharterNudge = () => {
    setCharterNudgeDismissed(true);
    try {
      localStorage.setItem("ffCharterNudgeDismissed", "1");
    } catch {
      // Persistence is best-effort; the nudge stays hidden for this session.
    }
  };
  // Create the conversation before opening the selector so experts are added
  // to the new conversation rather than the previously active one.
  const handleStartNewSession = async () => {
    if (createConversationMutation.isPending) return;
    try {
      await createConversationMutation.mutateAsync();
      setShowExpertSelector(true);
    } catch {
      // The mutation owns the user-facing error toast.
    }
  };
  
  // Handle adding experts to conversation
  const handleAddExperts = (experts: { name: string; role: string; model: string; avatarUrl: string; customInstructions?: string }[]) => {
    experts.forEach(expert => {
      addExpertMutation.mutate(expert);
    });
    
    setShowExpertSelector(false);
  };
  
  // Handle uploading a file
  const handleFileUpload = (file: File) => {
    if (!file) return;

    // Match the server's multer limit so users get a friendly message instead
    // of a raw JSON error after a full 10MB+ upload.
    if (file.size > 10 * 1024 * 1024) {
      toast({
        title: "File too large",
        description: `"${file.name}" is larger than the 10 MB limit.`,
        variant: "destructive",
      });
      return;
    }

    const formData = new FormData();
    formData.append("file", file);

    uploadFileMutation.mutate(formData);
  };

  const handleSelectConversation = (conversationId: number) => {
    setActiveConversation(conversationId);
    setStreamingMessages(new Map());
    setTypingExpertIds(new Set());
    setUpNextExpertId(null);
    setInteractionMode("idle");
    setIsProcessing(false);
    setHasQueuedMessage(false);
    setIsConcluding(false);
    setSidebarOpen(false);
  };

  const renameConversationMutation = useMutation({
    mutationFn: async ({ conversationId, title }: { conversationId: number; title: string }) => {
      await apiRequest("PUT", `/api/protected/conversations/${conversationId}`, { title });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/protected/conversations"] });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to rename conversation", description: error.message, variant: "destructive" });
    },
  });

  const deleteConversationMutation = useMutation({
    mutationFn: async (conversationId: number) => {
      const response = await fetch(`/api/protected/conversations/${conversationId}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!response.ok) {
        let message = response.status === 404 ? "Conversation not found." : response.statusText;
        try {
          const body = await response.json() as { message?: string };
          message = body.message || message;
        } catch {
          // Keep the status-based message when no JSON error body is returned.
        }
        throw new Error(message || "Failed to delete conversation.");
      }
      return conversationId;
    },
    onSuccess: (_deletedId, conversationId) => {
      const conversationQueryKey = ["/api/protected/conversations"];
      const remaining = (queryClient.getQueryData<Conversation[]>(conversationQueryKey) ?? conversations ?? [])
        .filter((conversation) => conversation.id !== conversationId);
      queryClient.setQueryData<Conversation[]>(conversationQueryKey, remaining);
      for (const section of ["messages", "experts", "insights", "files", "open-questions"]) {
        queryClient.removeQueries({ queryKey: [`/api/protected/conversations/${conversationId}/${section}`] });
      }
      if (activeConversation === conversationId) {
        if (remaining.length > 0) {
          handleSelectConversation(remaining[0].id);
        } else {
          setActiveConversation(null);
          setSelectedExperts([]);
          setStreamingMessages(new Map());
          setTypingExpertIds(new Set());
          setUpNextExpertId(null);
          setInteractionMode("idle");
          setIsProcessing(false);
          setHasQueuedMessage(false);
          setIsConcluding(false);
        }
      }
      queryClient.invalidateQueries({ queryKey: conversationQueryKey });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to delete conversation", description: error.message, variant: "destructive" });
    },
  });

  const removeExpertMutation = useMutation({
    mutationFn: async ({ conversationId, expertId }: { conversationId: number; expertId: number }) => {
      const response = await fetch(`/api/protected/conversations/${conversationId}/experts/${expertId}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!response.ok) {
        let message = response.status === 404 ? "Expert not found in this conversation." : response.statusText;
        try {
          const body = await response.json() as { message?: string };
          message = body.message || message;
        } catch {
          // Keep the status-based message when no JSON error body is returned.
        }
        throw new Error(message || "Failed to remove expert.");
      }
      return conversationId;
    },
    onSuccess: (_conversationId, variables) => {
      queryClient.invalidateQueries({ queryKey: [`/api/protected/conversations/${variables.conversationId}/experts`] });
      queryClient.invalidateQueries({ queryKey: [`/api/protected/conversations/${variables.conversationId}/messages`] });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to remove expert", description: error.message, variant: "destructive" });
    },
  });

  const handleManageExperts = () => {
    if (activeConversation) setShowExpertSelector(true);
  };

  const handleRemoveExpert = (expertId: number) => {
    if (activeConversation) removeExpertMutation.mutate({ conversationId: activeConversation, expertId });
  };
  
  // Effect to set active conversation if none is selected but conversations exist
  useEffect(() => {
    if (!activeConversation && conversations && conversations.length > 0) {
      setActiveConversation(conversations[0].id);
    }
  }, [activeConversation, conversations]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("openFarmProfile") === "1") {
      setShowFarmProfileModal(true);
      params.delete("openFarmProfile");
      const query = params.toString();
      window.history.replaceState(null, "", `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`);
    }
  }, []);

  // Effect to auto-open farm profile modal when no profile exists
  useEffect(() => {
    if (
      !farmProfileQuery.isLoading &&
      !farmProfile &&
      !farmProfileModalDismissed &&
      user
    ) {
      setShowFarmProfileModal(true);
    }
  }, [farmProfileQuery.isLoading, farmProfile, farmProfileModalDismissed, user]);
  
  // Effect to update selected experts when experts change
  useEffect(() => {
    if (experts) {
      setSelectedExperts(experts);
    }
  }, [experts]);

  // A dropped socket cannot deliver a completed stream. Clear transient UI
  // immediately, then refresh persisted data once the socket is back.
  useEffect(() => {
    if (!activeConversation) return;

    if (socketStatus === "connected") {
      queryClient.invalidateQueries({ queryKey: [`/api/protected/conversations/${activeConversation}/messages`] });
      queryClient.invalidateQueries({ queryKey: [`/api/protected/conversations/${activeConversation}/experts`] });
      queryClient.invalidateQueries({ queryKey: [`/api/protected/conversations/${activeConversation}/insights`] });
      queryClient.invalidateQueries({ queryKey: [`/api/protected/conversations/${activeConversation}/files`] });
      queryClient.invalidateQueries({ queryKey: [`/api/protected/conversations/${activeConversation}/open-questions`] });
      return;
    }

    setStreamingMessages(new Map());
    setTypingExpertIds(new Set());
    setUpNextExpertId(null);
    setIsProcessing(false);
    setInteractionMode("idle");
    setHasQueuedMessage(false);
    setIsConcluding(false);
  }, [socketStatus, activeConversation]);
  
  // === WebSocket Conversation Subscription (G3) ===
  // The server only broadcasts to sockets that subscribed to the conversation.
  // The useWebSocket hook creates a NEW WebSocket object on every reconnect,
  // so re-running this effect (socket change) re-subscribes the new socket.
  useEffect(() => {
    if (!socket || !activeConversation) return;
    const conversationId = activeConversation;
    let subscribed = false;

    const subscribe = () => {
      sendWebSocketSubscription(socket, conversationId);
      subscribed = true;
    };

    if (socket.readyState === WebSocket.OPEN) {
      subscribe();
    } else {
      socket.addEventListener("open", subscribe, { once: true });
    }

    // On conversation switch: unsubscribe the previous conversation. On socket
    // change/unmount the old socket is gone (the unsubscribe is a no-op there).
    return () => {
      socket.removeEventListener("open", subscribe);
      if (subscribed) {
        sendWebSocketUnsubscription(socket, conversationId);
      }
    };
  }, [socket, activeConversation]);

  // === WebSocket Message Handling ===
  useEffect(() => {
    if (!socket || !activeConversation) return;
    const activeSocket = socket;

    const handleWebSocketMessage = (event: MessageEvent) => {
      try {
        const parsedData = JSON.parse(event.data);
        debugLog("WebSocket received:", parsedData);

        // Check if the message is for the active conversation
        if (parsedData.conversationId !== activeConversation) {
            debugLog("WS message ignored (wrong conversation)");
            return;
        }

        // Handle different message types
        switch (parsedData.type) {
          case "messages_updated":
          case "message_error":
            if (parsedData.type === "message_error") {
              setTypingExpertIds(prev => {
                const next = new Set(prev);
                if (typeof parsedData.expertId === "number") next.delete(parsedData.expertId);
                else next.clear();
                return next;
              });
              setStreamingMessages(prev => {
                if (typeof parsedData.expertId !== "number") return new Map();
                const next = new Map(prev);
                next.delete(parsedData.expertId);
                return next;
              });
            }
            // Check if the message data exists in the payload
            if (parsedData.message && parsedData.message.id) {
              const newMessage: Message = parsedData.message;
              const messagesQueryKey = [`/api/protected/conversations/${activeConversation}/messages`];

              // Update the query cache directly
              queryClient.setQueryData<Message[]>(messagesQueryKey, (oldData) => {
                if (!oldData) return [newMessage]; // If cache is empty, start with new message
                // Avoid adding duplicates
                if (oldData.some(msg => msg.id === newMessage.id)) {
                  return oldData;
                }
                return [...oldData, newMessage];
              });
              // DON'T set isProcessing to false here - let state_update control it
              // The spinner should keep showing until mode changes to "idle"
            } else {
              // Fallback to invalidation if message payload is missing (shouldn't happen ideally)
              console.warn("WebSocket: messages_updated signal received without message payload. Invalidating query.");
              queryClient.invalidateQueries({ queryKey: [`/api/protected/conversations/${activeConversation}/messages`] });
            }
            break;
          
          case "state_update":
            debugLog("WebSocket: Received state_update signal", parsedData);
            if (parsedData.mode) {
              debugLog(`[UI State] Setting interactionMode to: ${parsedData.mode}`);
              setInteractionMode(parsedData.mode as InteractionMode);
              // Set isProcessing to true when entering processing_sequential or autonomous mode
              setIsProcessing(parsedData.mode === "processing_sequential" || parsedData.mode === "autonomous");
              // A stopped conversation clears queued feedback; pausing keeps
              // it visible because queued farmer input remains pending.
              // A pause landing mid-synthesis also ends the concluding window:
              // the council is parked, not concluding.
              if (parsedData.mode === "processing_sequential" || parsedData.mode === "idle" || parsedData.mode === "paused") {
                setIsConcluding(false);
              }
              // Clear streaming state when returning to idle
              if (parsedData.mode === "idle") {
                setStreamingMessages(new Map());
                setTypingExpertIds(new Set());
                setUpNextExpertId(null);
              }
            }
            if (typeof parsedData.isAutonomousEnabled === 'boolean') {
              debugLog(`[UI State] Setting isAutonomousEnabled to: ${parsedData.isAutonomousEnabled}`);
              setIsAutonomousEnabled(parsedData.isAutonomousEnabled);
            }
            if (Number.isInteger(parsedData.expertTurnsConsumed) && Number.isInteger(parsedData.expertTurnsRemaining)) {
              setExpertTurnCounts({
                consumed: parsedData.expertTurnsConsumed,
                remaining: parsedData.expertTurnsRemaining,
              });
            }
            break;

          case "message_queued":
            debugLog("WebSocket: Farmer message queued for pickup");
            setHasQueuedMessage(true);
            break;

          case "message_picked_up":
            debugLog("WebSocket: Queued farmer message picked up");
            setHasQueuedMessage(false);
            break;

          case "open_questions_updated":
            queryClient.invalidateQueries({ queryKey: [`/api/protected/conversations/${activeConversation}/open-questions`] });
            break;

          case "concluding":
            // G5: the Moderator decided the discussion is done. The closing
            // synthesis message follows through the normal stream flow.
            setIsConcluding(true);
            break;

          // --- Streaming message handlers ---
          case "expert_stream_start":
            debugLog(`[Stream] Expert ${parsedData.expertName} started typing`);
            // G9: the announced expert is now typing, so the "up next"
            // preview yields to the existing typing indicator.
            setUpNextExpertId(null);
            setTypingExpertIds(prev => new Set(prev).add(parsedData.expertId));
            setStreamingMessages(prev => {
              const next = new Map(prev);
              next.set(parsedData.expertId, {
                content: "",
                expertName: parsedData.expertName,
                expertRole: parsedData.expertRole,
              });
              return next;
            });
            break;

          case "expert_stream_token":
            setStreamingMessages(prev => {
              const next = new Map(prev);
              const existing = next.get(parsedData.expertId);
              if (existing) {
                next.set(parsedData.expertId, {
                  ...existing,
                  content: existing.content + parsedData.token,
                });
              }
              return next;
            });
            break;

          case "expert_stream_done":
            debugLog(`[Stream] Expert ${parsedData.expertId} done`);
            setTypingExpertIds(prev => {
              const next = new Set(prev);
              next.delete(parsedData.expertId);
              return next;
            });
            setStreamingMessages(prev => {
              const next = new Map(prev);
              next.delete(parsedData.expertId);
              return next;
            });
            // Add the completed message to the query cache
            if (parsedData.message && parsedData.message.id) {
              const messagesQueryKey = [`/api/protected/conversations/${activeConversation}/messages`];
              queryClient.setQueryData<Message[]>(messagesQueryKey, (oldData) => {
                if (!oldData) return [parsedData.message];
                if (oldData.some(msg => msg.id === parsedData.message.id)) return oldData;
                return [...oldData, parsedData.message];
              });
              queryClient.invalidateQueries({ queryKey: [`/api/protected/conversations/${activeConversation}/files`] });
            }
            break;

          case "insights":
             debugLog("WebSocket: Received insights signal");
             queryClient.invalidateQueries({ queryKey: [`/api/protected/conversations/${activeConversation}/insights`] });
             break;

          case "error":
            // Pipeline-level failure: tell the user and unstick the UI,
            // otherwise isProcessing stays true and skeletons never clear.
            console.error("WebSocket: Pipeline error:", parsedData.message);
            toast({
              title: "Something went wrong",
              description: parsedData.message || "The experts couldn't process that. Please try again.",
              variant: "destructive",
            });
            setStreamingMessages(new Map());
            setTypingExpertIds(new Set());
            setUpNextExpertId(null);
            setIsProcessing(false);
            setInteractionMode("idle");
            setIsConcluding(false);
            break;

          // G8: the Moderator's auxiliary call failed and the server fell
          // back (e.g. round-robin). Ephemeral toast only — never a chat
          // message, and no pipeline state is touched.
          case "notice":
            toast({ description: parsedData.message });
            break;

          // G9: the next expert turn is announced before its stream starts —
          // the Expert Panel previews it until expert_stream_start arrives.
          case "next_speaker":
            setUpNextExpertId(parsedData.expertId);
            break;

          // Handle other types like connection confirmation, file updates etc. if needed
          case "connection":
            debugLog("WebSocket: Connection confirmed.");
            break;

          case "subscribed":
            // Acknowledgment only; a state_update replay follows separately
            // when orchestrator state exists for the conversation.
            break;

          case "subscribe_denied":
            // The server refused the subscription (not the owner or the
            // conversation no longer exists) — broadcasts will not arrive.
            console.warn("WebSocket: Subscription denied for conversation", parsedData.conversationId);
            toast({
              title: "Couldn't subscribe to conversation updates",
              variant: "destructive",
            });
            break;

          default:
            debugLog("WebSocket: Received unhandled message type:", parsedData.type);
        }
      } catch (error) {
        console.error("Error processing WebSocket message:", error);
      }
    };

    activeSocket.addEventListener("message", handleWebSocketMessage);

    // Cleanup function
    return () => {
      activeSocket.removeEventListener("message", handleWebSocketMessage);
    };
  }, [socket, activeConversation]); // Re-run effect if socket or active conversation changes
  
  // === Control Handlers ===
  // REMOVED handlePause and handleResume

  // Handler specifically for Enabling Auto Mode
  const handleEnableAutonomous = () => {
    debugLog("[UI Click] Handle Enable Autonomous triggered.");
    if (activeConversation) {
        debugLog("[UI Click] Calling enableAutoMutation.mutate(undefined)");
        enableAutoMutation.mutate(undefined);
    } else {
         debugLog("[UI Click] Enable Autonomous condition not met (no active conversation).");
    }
  };

  // Handler specifically for Disabling Auto Mode
  const handleDisableAutonomous = () => {
    debugLog("[UI Click] Handle Disable Autonomous triggered.");
    if (activeConversation) {
        debugLog("[UI Click] Calling disableAutoMutation.mutate()");
        disableAutoMutation.mutate();
    } else {
         debugLog("[UI Click] Disable Autonomous condition not met (no active conversation).");
    }
  };

  const statusMessage = socketStatus !== "connected"
    ? `${socketStatus === "reconnecting" ? "Connection interrupted. Reconnecting…" : "Connecting to the roundtable…"}${reconnectAttempts > 0 ? ` Attempt ${reconnectAttempts}.` : ""}`
    : isConcluding
      ? "The council is concluding…"
      : hasQueuedMessage
        ? interactionMode === "idle" ? "The discussion stopped; your message is saved." : "The council will pick this up next."
        : interactionMode === "paused"
          ? "Paused"
          : interactionMode === "processing_sequential" || interactionMode === "autonomous"
            ? "Experts are discussing…"
            : "Waiting for you";
  
  return (
    <div className="flex flex-col h-screen">
      <Header
        onOpenFarmProfile={() => setShowFarmProfileModal(true)}
        onToggleSidebar={() => setSidebarOpen((open) => !open)}
        isSidebarOpen={sidebarOpen}
        sidebarToggleRef={sidebarToggleRef}
      />
      
      <div className="flex-1 flex min-h-0 overflow-hidden relative">
        {/* Left Sidebar - hidden on mobile unless toggled */}
        <div
          ref={sidebarDrawerRef}
          id="left-sidebar-drawer"
          className={`h-full min-h-0 shrink-0 ${isMobile ? 'absolute inset-y-0 left-0 z-30 transition-transform duration-300' : 'relative'} ${isMobile && !sidebarOpen ? '-translate-x-full' : ''}`}
          style={{ width: isMobile ? DEFAULT_LEFT_SIDEBAR_WIDTH : isLeftSidebarCollapsed ? COLLAPSED_SIDEBAR_RAIL_WIDTH : leftSidebarWidth }}
          aria-hidden={isMobile && !sidebarOpen}
        >
          {!isMobile && isLeftSidebarCollapsed ? (
            <div className="flex h-full justify-center border-r border-farm-tan/30 bg-white">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="mt-2 h-9 w-9 shrink-0"
                aria-label="Expand left sidebar"
                aria-controls="left-sidebar-drawer"
                aria-expanded={false}
                title="Expand left sidebar"
                onClick={() => setIsLeftSidebarCollapsed(false)}
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          ) : (
            <SidebarPanel
              conversations={conversations || []}
              files={files || []}
              onStartNewSession={handleStartNewSession}
              onExportMarkdown={exportMarkdown}
              canExportIcs={hasSchedulableSource}
              onFileUpload={handleFileUpload}
              onSelectConversation={handleSelectConversation}
              onRenameConversation={(conversationId, title) => renameConversationMutation.mutate({ conversationId, title })}
              onDeleteConversation={(conversationId) => deleteConversationMutation.mutate(conversationId)}
              activeConversationId={activeConversation}
              isLoadingConversations={isLoadingConversations}
              conversationsError={conversationsError}
              isLoadingFiles={isLoadingFiles}
              filesError={filesError}
              isStartingNewSession={createConversationMutation.isPending}
              isUploading={uploadFileMutation.isPending}
              onCollapse={!isMobile ? () => setIsLeftSidebarCollapsed(true) : undefined}
            />
          )}
          {!isMobile && !isLeftSidebarCollapsed && (
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize left sidebar"
              aria-controls="left-sidebar-drawer"
              aria-valuemin={MIN_LEFT_SIDEBAR_WIDTH}
              aria-valuemax={maxLeftSidebarWidth}
              aria-valuenow={leftSidebarWidth}
              tabIndex={0}
              onPointerDown={handleLeftSidebarResizeStart}
              onPointerMove={handleLeftSidebarResizeMove}
              onPointerUp={stopLeftSidebarResize}
              onPointerCancel={stopLeftSidebarResize}
              onKeyDown={handleLeftSidebarResizeKeyDown}
              className={`absolute -right-1 top-0 z-20 h-full w-2 cursor-col-resize touch-none select-none transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-farm-blue hover:bg-farm-blue/30 ${isResizingLeftSidebar ? "bg-farm-blue/50" : "bg-transparent"}`}
              title="Drag or use the arrow keys to resize the left sidebar"
            />
          )}
        </div>

        {/* Mobile sidebar overlay */}
        {isMobile && sidebarOpen && (
          <div 
            className="absolute inset-0 bg-black/50 z-20"
            onClick={() => setSidebarOpen(false)}
          />
        )}
        
        {/* Main Content Area */}
        <div className="flex-1 flex flex-col overflow-hidden min-h-0">
            {(socketStatus !== "connected" || activeConversation) && (
              <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border bg-white px-3 py-2 md:px-6">
                <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2 text-sm">
                  <span role="status" aria-live="polite" className="font-medium text-neutral-800">{statusMessage}</span>
                  {expertTurnCounts && (
                    <span className="text-xs text-neutral-600" aria-live="polite">
                      Expert turns: {expertTurnCounts.consumed} used · {expertTurnCounts.remaining} remaining
                    </span>
                  )}
                  {showCharterNudge && (
                    <span className="flex items-center gap-1 text-xs text-neutral-700">
                      <ScrollText className="h-3.5 w-3.5 shrink-0" />
                      Set a council charter so your experts share one goal.
                      <button
                        type="button"
                        onClick={handleDismissCharterNudge}
                        aria-label="Dismiss charter suggestion"
                        className="rounded p-1 hover:bg-muted motion-reduce:transition-none"
                      >
                        <XIcon className="h-3.5 w-3.5" />
                      </button>
                    </span>
                  )}
                </div>
                {activeConversation && (
                  <div className="flex flex-wrap items-center gap-2 md:gap-3" role="group" aria-label="Roundtable controls">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setCharterDialogOpen(true)}
                      aria-label="Edit the council charter"
                      className="border-farm-tan/60 text-yellow-900 hover:bg-farm-tan/40 hover:text-neutral-900 transition-all duration-200 font-medium"
                    >
                      <ScrollText className="mr-1.5 h-4 w-4" />
                      Charter
                    </Button>
                    {(interactionMode === "processing_sequential" || interactionMode === "autonomous") && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => pauseMutation.mutate()}
                        disabled={pauseMutation.isPending}
                        aria-label="Pause the roundtable"
                        className="border-farm-yellow text-yellow-800 hover:bg-farm-yellow hover:text-neutral-900 transition-all duration-200 font-medium"
                      >
                        <PauseIcon className="mr-1.5 h-4 w-4" />
                        Pause
                      </Button>
                    )}
                    {interactionMode === "paused" && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => resumeMutation.mutate()}
                        disabled={resumeMutation.isPending}
                        aria-label="Resume the roundtable"
                        className="border-farm-dark-green text-farm-dark-green hover:bg-farm-dark-green hover:text-white transition-all duration-200 font-medium"
                      >
                        <PlayIcon className="mr-1.5 h-4 w-4" />
                        Resume
                      </Button>
                    )}
                    <label htmlFor="autonomous-mode-switch" title="When enabled, experts can continue discussing without waiting for a new message." className="flex items-center gap-2 text-sm font-medium text-neutral-800">
                      <span>Autonomous mode</span>
                      <Switch
                        id="autonomous-mode-switch"
                        checked={isAutonomousEnabled}
                        disabled={enableAutoMutation.isPending || disableAutoMutation.isPending}
                        onCheckedChange={(enabled) => enabled ? handleEnableAutonomous() : handleDisableAutonomous()}
                      />
                    </label>
                  </div>
                )}
              </div>
            )}

            {/* === Chat Area (Takes remaining space) === */}
             <div className="flex-1 overflow-y-auto">
                 {activeConversation ? (
                    <ChatInterface
                        messages={messages || []}
                        experts={experts || []}
                        openQuestions={openQuestions}
                        onSendMessage={handleSendMessage}
                        onUploadFile={handleFileUpload}
                        isUploading={uploadFileMutation.isPending}
                        isLoading={sendMessageMutation.isPending || restartConversationMutation.isPending || isProcessing}
                        isLoadingMessages={isLoadingMessages}
                        messagesError={messagesError}
                        user={user}
                        insights={insights || []}
                        visualizations={[]}
                        streamingMessages={streamingMessages}
                        typingExpertIds={typingExpertIds}
                        upNextExpertId={upNextExpertId}
                        onManageExperts={handleManageExperts}
                        onRemoveExpert={handleRemoveExpert}
                        onRefreshInsights={() => generateInsightsMutation.mutate()}
                        isRefreshingInsights={generateInsightsMutation.isPending}
                    />
                ) : (
                    <div className="flex-1 flex items-center justify-center bg-gradient-to-br from-farm-powder/10 via-white to-farm-tan/10">
                        <div className="text-center max-w-2xl px-8">
                            <h2 className="text-3xl font-bold text-farm-blue mb-3 tracking-tight">Welcome to Farm Friend Roundtable</h2>
                            <p className="text-lg text-neutral-600 mb-8 leading-relaxed">Start a new conversation to begin chatting with agricultural experts who can help with your farming needs</p>
                            <div className="flex gap-4 justify-center">
                                <button
                                    onClick={handleStartNewSession}
                                    disabled={createConversationMutation.isPending}
                                    className="bg-farm-dark-green text-white px-6 py-3 rounded-lg hover:bg-farm-blue transition-all duration-200 shadow-md hover:shadow-lg font-semibold"
                                >
                                    Start New Roundtable
                                </button>
                                {import.meta.env.DEV && (
                                  <button
                                      onClick={() => quickSetupMutation.mutate()}
                                      disabled={quickSetupMutation.isPending}
                                      className="bg-farm-yellow text-neutral-800 px-6 py-3 rounded-lg hover:bg-yellow-400 transition-all duration-200 shadow-md hover:shadow-lg disabled:opacity-50 flex items-center gap-2 font-semibold"
                                  >
                                      Quick Test
                                  </button>
                                )}
                            </div>
                        </div>
                    </div>
                )}
             </div>
        </div>
      </div>

      {/* Expert Selector Modal */}
      {showExpertSelector && (
        <ExpertSelector
          onClose={() => setShowExpertSelector(false)}
          onAddExperts={handleAddExperts}
          selectedExperts={selectedExperts}
        />
      )}

      {/* Farm Profile Modal — shown on first login when no profile exists */}
      <FarmProfileModal
        isOpen={showFarmProfileModal}
        onClose={dismissFarmProfileModal}
        onSaved={() => {
          dismissFarmProfileModal();
          queryClient.invalidateQueries({ queryKey: ["/api/protected/farm-profile"] });
        }}
      />

      {/* G6: council charter editor for the active conversation */}
      <CharterDialog
        open={charterDialogOpen}
        conversationId={activeConversation}
        currentCharter={activeConversationData?.charter ?? null}
        currentTurnBudget={activeTurnBudget}
        onClose={() => setCharterDialogOpen(false)}
      />
    </div>
  );
}

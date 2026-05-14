import { useState, useEffect } from "react";
import { useAuth } from "@/hooks/use-auth";
import Header from "@/components/layout/Header";
import SidebarPanel from "@/components/sidebar/SidebarPanel";
import ChatInterface from "@/components/chat/ChatInterface";
import ExpertSelector from "@/components/roundtable/ExpertSelector";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Expert, Message, Insight, File as FileType, Conversation, FarmProfile } from "@shared/schema";
import FarmProfileModal from "@/components/farm/FarmProfileModal";
import { useWebSocket } from "@/lib/websocket-utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { PlayIcon, PauseIcon, SettingsIcon, ZapIcon, ZapOffIcon, Zap } from "lucide-react";

// Define the type for interaction modes matching the backend
type InteractionMode = 
    | "idle" 
    | "processing_sequential" 
    | "paused" 
    | "autonomous";

export default function HomePage() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [activeConversation, setActiveConversation] = useState<number | null>(null);
  const [selectedExperts, setSelectedExperts] = useState<Expert[]>([]);
  const [showExpertSelector, setShowExpertSelector] = useState(false);
  const [showFarmProfileModal, setShowFarmProfileModal] = useState(false);
  const [farmProfileModalDismissed, setFarmProfileModalDismissed] = useState(false);
  
  // Add state for interaction control
  const [interactionMode, setInteractionMode] = useState<InteractionMode>("idle");
  const [isAutonomousEnabled, setIsAutonomousEnabled] = useState<boolean>(true); // Default to true initially
  const [isProcessing, setIsProcessing] = useState<boolean>(false); // Track if experts are currently responding
  // We might also want to store maxAutonomousTurns if we allow setting it from UI
  // const [maxAutonomousTurns, setMaxAutonomousTurns] = useState<number>(0);

  // Message queue state for continuous input
  const [pendingMessages, setPendingMessages] = useState<string[]>([]);
  const [isQueueProcessing, setIsQueueProcessing] = useState(false);

  // Streaming state
  const [streamingMessages, setStreamingMessages] = useState<Map<number, { content: string; expertName: string; expertRole: string }>>(new Map());
  const [typingExpertIds, setTypingExpertIds] = useState<Set<number>>(new Set());

  // WebSocket connection for real-time updates
  const socket = useWebSocket();
  
  // Fetch user's conversations
  const { data: conversations, isLoading: isLoadingConversations } = useQuery<Conversation[]>({
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
      setActiveConversation(newConversation.id);
      toast({
        title: "New conversation created",
      });
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
      setActiveConversation(data.conversationId);
      toast({
        title: "Roundtable ready",
        description: `Loaded ${data.expertCount} experts`,
      });
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
    mutationFn: async (expert: { name: string; role: string; model: string; avatarUrl: string }) => {
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
  const { data: experts, isLoading: isLoadingExperts } = useQuery<Expert[]>({
    queryKey: [`/api/protected/conversations/${activeConversation}/experts`],
    enabled: !!activeConversation,
  });
  
  // Fetch messages for active conversation
  const { data: messages, isLoading: isLoadingMessages } = useQuery<Message[]>({
    queryKey: [`/api/protected/conversations/${activeConversation}/messages`],
    enabled: !!activeConversation,
  });
  
  // Fetch insights for active conversation
  const { data: insights, isLoading: isLoadingInsights } = useQuery<Insight[]>({
    queryKey: [`/api/protected/conversations/${activeConversation}/insights`],
    enabled: !!activeConversation,
  });
  
  // Fetch files for active conversation
  const { data: files, isLoading: isLoadingFiles } = useQuery<FileType[]>({
    queryKey: [`/api/protected/conversations/${activeConversation}/files`],
    enabled: !!activeConversation,
  });
  
  // Send message mutation
  const sendMessageMutation = useMutation<
    Message,
    Error,
    string,
    { previousMessages?: Message[] }
  >({
    mutationFn: async (content: string) => {
      if (!activeConversation) throw new Error("No active conversation");
      if (!user) throw new Error("User not authenticated");

      const res = await apiRequest("POST", `/api/protected/conversations/${activeConversation}/messages`, { 
        content, 
        userId: user.id
      });
      
      if (!res.ok) {
        const errorData = await res.json();
        throw new Error(errorData.message || 'Failed to send message');
      }
      
      return await res.json();
    },
    onMutate: async (newMessageContent: string) => {
      if (!activeConversation || !user) return;

      const messagesQueryKey = [`/api/protected/conversations/${activeConversation}/messages`];

      await queryClient.cancelQueries({ queryKey: messagesQueryKey });

      const previousMessages = queryClient.getQueryData<Message[]>(messagesQueryKey);

      queryClient.setQueryData<Message[]>(messagesQueryKey, (old = []) => [
        ...old,
        {
          id: Date.now(),
          conversationId: activeConversation,
          userId: user.id,
          expertId: null,
          content: newMessageContent,
          role: "user",
          expertName: null,
          expertRole: null,
          timestamp: new Date(),
        },
      ]);

      return { previousMessages };
    },
    onError: (err, newMessageContent, context) => {
      if (!activeConversation) return;
      const messagesQueryKey = [`/api/protected/conversations/${activeConversation}/messages`];
      
      if (context?.previousMessages) {
        queryClient.setQueryData(messagesQueryKey, context.previousMessages);
      }
      toast({
        title: "Failed to send message",
        description: err.message,
        variant: "destructive",
      });
    },
    onSettled: () => {
      if (!activeConversation) return;
      // const messagesQueryKey = [`/api/protected/conversations/${activeConversation}/messages`];
      
      console.log("Message mutation settled. Update will come via WebSocket.");
      // Remove the invalidation call here
      // queryClient.invalidateQueries({ queryKey: messagesQueryKey }); 
    },
  });

  // Queue-aware send message handler
  const handleSendMessage = (content: string) => {
    if (isProcessing || sendMessageMutation.isPending) {
      // Queue the message instead of blocking
      setPendingMessages(prev => [...prev, content]);
    } else {
      // Send immediately if idle
      sendMessageMutation.mutate(content);
    }
  };

  // Queue processor - auto-process queued messages when system is idle
  useEffect(() => {
    if (!isProcessing &&
        !sendMessageMutation.isPending &&
        pendingMessages.length > 0 &&
        !isQueueProcessing) {
      setIsQueueProcessing(true);
      const nextMessage = pendingMessages[0];
      setPendingMessages(prev => prev.slice(1));
      sendMessageMutation.mutate(nextMessage, {
        onSettled: () => setIsQueueProcessing(false)
      });
    }
  }, [isProcessing, sendMessageMutation.isPending, pendingMessages, isQueueProcessing]);

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
      toast({
        title: "File uploaded successfully",
      });
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
      toast({
        title: "Insights generated",
      });
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
      return await res.json();
    },
    onSuccess: () => {
      toast({
        title: "Autonomous mode enabled",
      });
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
      return await res.json();
    },
    onSuccess: () => {
      toast({
        title: "Autonomous mode disabled",
      });
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
  
  // Handle starting a new roundtable session
  const handleStartNewSession = () => {
    createConversationMutation.mutate();
    setShowExpertSelector(true);
  };
  
  // Handle adding experts to conversation
  const handleAddExperts = (experts: { name: string; role: string; model: string; avatarUrl: string }[]) => {
    experts.forEach(expert => {
      addExpertMutation.mutate(expert);
    });
    
    setShowExpertSelector(false);
  };
  
  // Handle uploading a file
  const handleFileUpload = (file: File) => {
    if (!file) return;
    
    const formData = new FormData();
    formData.append("file", file);
    
    uploadFileMutation.mutate(formData);
  };
  
  // Effect to set active conversation if none is selected but conversations exist
  useEffect(() => {
    if (!activeConversation && conversations && conversations.length > 0) {
      setActiveConversation(conversations[0].id);
    }
  }, [activeConversation, conversations]);

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
  
  // === WebSocket Message Handling ===
  useEffect(() => {
    if (!socket || !activeConversation) return;

    const handleWebSocketMessage = (event: MessageEvent) => {
      try {
        const parsedData = JSON.parse(event.data);
        console.log("WebSocket received:", parsedData);

        // Check if the message is for the active conversation
        if (parsedData.conversationId !== activeConversation) {
            console.log("WS message ignored (wrong conversation)");
            return;
        }

        // Handle different message types
        switch (parsedData.type) {
          case "messages_updated":
          case "message_error": // Handle errors similarly to new messages for display
            // Check if the message data exists in the payload
            if (parsedData.message && parsedData.message.id) {
              const newMessage: Message = parsedData.message;
              const messagesQueryKey = [`/api/protected/conversations/${activeConversation}/messages`];
              
              // DEBUG: Check if artifacts are in the message
              console.log("WebSocket message received:", {
                id: newMessage.id,
                hasArtifacts: !!newMessage.artifacts,
                artifactsLength: newMessage.artifacts?.length || 0,
                artifacts: newMessage.artifacts
              });
              
              // Update the query cache directly
              queryClient.setQueryData<Message[]>(messagesQueryKey, (oldData) => {
                if (!oldData) return [newMessage]; // If cache is empty, start with new message
                // Avoid adding duplicates
                if (oldData.some(msg => msg.id === newMessage.id)) {
                  return oldData;
                }
                return [...oldData, newMessage];
              });
              console.log("WebSocket: Added/updated message in cache.", newMessage.id);
              // DON'T set isProcessing to false here - let state_update control it
              // The spinner should keep showing until mode changes to "idle"
            } else {
              // Fallback to invalidation if message payload is missing (shouldn't happen ideally)
              console.warn("WebSocket: messages_updated signal received without message payload. Invalidating query.");
              queryClient.invalidateQueries({ queryKey: [`/api/protected/conversations/${activeConversation}/messages`] });
            }
            break;
          
          case "state_update":
            console.log("WebSocket: Received state_update signal", parsedData);
            if (parsedData.mode) {
              console.log(`[UI State] Setting interactionMode to: ${parsedData.mode}`);
              setInteractionMode(parsedData.mode as InteractionMode);
              // Set isProcessing to true when entering processing_sequential or autonomous mode
              setIsProcessing(parsedData.mode === "processing_sequential" || parsedData.mode === "autonomous");
              // Clear streaming state when returning to idle
              if (parsedData.mode === "idle") {
                setStreamingMessages(new Map());
                setTypingExpertIds(new Set());
              }
            }
            if (typeof parsedData.isAutonomousEnabled === 'boolean') {
              console.log(`[UI State] Setting isAutonomousEnabled to: ${parsedData.isAutonomousEnabled}`);
              setIsAutonomousEnabled(parsedData.isAutonomousEnabled);
            }
            break;

          // --- Streaming message handlers ---
          case "expert_stream_start":
            console.log(`[Stream] Expert ${parsedData.expertName} started typing`);
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
            console.log(`[Stream] Expert ${parsedData.expertId} done`);
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
            }
            break;

          case "insights":
             console.log("WebSocket: Received insights signal");
             queryClient.invalidateQueries({ queryKey: [`/api/protected/conversations/${activeConversation}/insights`] });
             break;

          // Handle other types like connection confirmation, file updates etc. if needed
          case "connection":
            console.log("WebSocket: Connection confirmed.");
            break;

          default:
            console.log("WebSocket: Received unhandled message type:", parsedData.type);
        }
      } catch (error) {
        console.error("Error processing WebSocket message:", error);
      }
    };

    socket.addEventListener("message", handleWebSocketMessage);

    // Cleanup function
    return () => {
      socket.removeEventListener("message", handleWebSocketMessage);
    };
  }, [socket, activeConversation]); // Re-run effect if socket or active conversation changes
  
  // === Control Handlers ===
  // REMOVED handlePause and handleResume

  // Handler specifically for Enabling Auto Mode
  const handleEnableAutonomous = () => {
    console.log("[UI Click] Handle Enable Autonomous triggered.");
    if (activeConversation) {
        console.log("[UI Click] Calling enableAutoMutation.mutate(undefined)");
        enableAutoMutation.mutate(undefined); 
    } else {
         console.log("[UI Click] Enable Autonomous condition not met (no active conversation).");
    }
  };

  // Handler specifically for Disabling Auto Mode
  const handleDisableAutonomous = () => {
    console.log("[UI Click] Handle Disable Autonomous triggered.");
    if (activeConversation) {
        console.log("[UI Click] Calling disableAutoMutation.mutate()");
        disableAutoMutation.mutate();
    } else {
         console.log("[UI Click] Disable Autonomous condition not met (no active conversation).");
    }
  };
  
  return (
    <div className="flex flex-col h-screen">
      <Header />
      
      <div className="flex-1 flex overflow-hidden">
        {/* Left Sidebar */}
        <SidebarPanel
          conversations={conversations || []}
          insights={insights || []}
          files={files || []}
          onStartNewSession={handleStartNewSession}
          onExportMarkdown={exportMarkdown}
          onFileUpload={handleFileUpload}
          onSelectConversation={setActiveConversation}
          activeConversationId={activeConversation}
          onRefreshInsights={() => generateInsightsMutation.mutate()}
          isLoadingInsights={generateInsightsMutation.isPending}
          experts={experts || []}
        />
        
        {/* Main Content Area */}
        <div className="flex-1 flex flex-col overflow-hidden min-h-0">
            {/* Log state values just before rendering controls - Corrected JSX */} 
            {activeConversation && (() => { 
                console.log(`[Render Check] Mode: ${interactionMode}, AutoEnabled: ${isAutonomousEnabled}, EnablePending: ${enableAutoMutation.isPending}, DisablePending: ${disableAutoMutation.isPending}`);
                return null; // Return null to render nothing
            })()}
            {/* === Interaction Control Bar (Positioned at the top of this column) === */}
            {activeConversation && (
                 <div className="flex-shrink-0 flex items-center justify-between px-6 py-3 border-b border-farm-tan/30 bg-gradient-to-r from-farm-powder/20 to-white shadow-sm">
                     <div className="flex items-center gap-3">
                         <span className="text-sm font-semibold text-farm-blue">Status:</span>
                         <Badge variant={interactionMode === 'paused' ? 'secondary' : interactionMode === 'idle' ? 'outline' : 'default'}
                                className={`${interactionMode === 'autonomous' || interactionMode === 'processing_sequential' ? 'bg-farm-green/20 text-farm-dark-green border-farm-green' : ''}
                                          ${interactionMode === 'paused' ? 'bg-farm-yellow/20 text-yellow-800 border-farm-yellow' : ''}
                                          font-medium capitalize`}>
                             {interactionMode.replace('_', ' ')}
                         </Badge>
                          <span className="text-sm font-semibold text-farm-blue ml-4">Autonomous:</span>
                         <Badge variant={isAutonomousEnabled ? 'default' : 'secondary'}
                                className={`${isAutonomousEnabled ? 'bg-farm-blue/20 text-farm-blue border-farm-blue' : 'bg-neutral-200 text-neutral-600'} font-medium`}>
                             {isAutonomousEnabled ? 'Enabled' : 'Disabled'}
                         </Badge>
                         {pendingMessages.length > 0 && (
                           <Badge variant="outline" className="ml-2 bg-farm-yellow/20 text-yellow-800 border-farm-yellow font-medium">
                             {pendingMessages.length} queued
                           </Badge>
                         )}
                     </div>
                     <div className="flex items-center gap-3">
                          {/* Buttons moved here, removed pause/resume */}
                          {/* Conditionally Render Disable Button */}
                         {isAutonomousEnabled && (
                            <Button
                                variant="outline"
                                size="sm"
                                onClick={handleDisableAutonomous}
                                disabled={disableAutoMutation.isPending}
                                aria-label="Disable Autonomous Mode"
                                className="border-farm-blue text-farm-blue hover:bg-farm-blue hover:text-white transition-all duration-200 font-medium"
                                >
                                <ZapOffIcon className="h-4 w-4 mr-1.5" />
                                Disable Auto
                            </Button>
                         )}

                         {/* Conditionally Render Enable Button */}
                         {!isAutonomousEnabled && (
                             <Button
                                 variant="outline"
                                 size="sm"
                                 onClick={handleEnableAutonomous}
                                 disabled={enableAutoMutation.isPending}
                                 aria-label="Enable Autonomous Mode"
                                 className="border-farm-green text-farm-green hover:bg-farm-green hover:text-white transition-all duration-200 font-medium"
                                 >
                                 <ZapIcon className="h-4 w-4 mr-1.5" />
                                 Enable Auto
                             </Button>
                         )}
                     </div>
                 </div>
            )}

            {/* === Chat Area (Takes remaining space) === */} 
             <div className="flex-1 overflow-y-auto">
                 {activeConversation ? (
                    <ChatInterface
                        messages={messages || []}
                        experts={experts || []}
                        onSendMessage={handleSendMessage}
                        onUploadFile={handleFileUpload}
                        isLoading={sendMessageMutation.isPending || isProcessing}
                        user={user}
                        insights={insights || []}
                        visualizations={[]}
                        streamingMessages={streamingMessages}
                        typingExpertIds={typingExpertIds}
                    />
                ) : (
                    <div className="flex-1 flex items-center justify-center bg-gradient-to-br from-farm-powder/10 via-white to-farm-tan/10">
                        <div className="text-center max-w-2xl px-8">
                            <h2 className="text-3xl font-bold text-farm-blue mb-3 tracking-tight">Welcome to Farm Friend Roundtable</h2>
                            <p className="text-lg text-neutral-600 mb-8 leading-relaxed">Start a new conversation to begin chatting with agricultural experts who can help with your farming needs</p>
                            <div className="flex gap-4 justify-center">
                                <button
                                    onClick={handleStartNewSession}
                                    className="bg-farm-green text-white px-6 py-3 rounded-lg hover:bg-farm-dark-green transition-all duration-200 shadow-md hover:shadow-lg font-semibold"
                                >
                                    Start New Roundtable
                                </button>
                                <button
                                    onClick={() => quickSetupMutation.mutate()}
                                    disabled={quickSetupMutation.isPending}
                                    className="bg-farm-yellow text-neutral-800 px-6 py-3 rounded-lg hover:bg-yellow-400 transition-all duration-200 shadow-md hover:shadow-lg disabled:opacity-50 flex items-center gap-2 font-semibold"
                                >
                                    ⚡ Quick Test
                                </button>
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
        onClose={() => {
          setShowFarmProfileModal(false);
          setFarmProfileModalDismissed(true);
        }}
        onSaved={() => {
          setShowFarmProfileModal(false);
          queryClient.invalidateQueries({ queryKey: ["/api/protected/farm-profile"] });
        }}
      />
    </div>
  );
}

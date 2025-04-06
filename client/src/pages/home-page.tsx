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
import { Expert, Message, Insight, File as FileType, Conversation } from "@shared/schema";
import { useWebSocket } from "@/lib/websocket-utils";

export default function HomePage() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [activeConversation, setActiveConversation] = useState<number | null>(null);
  const [selectedExperts, setSelectedExperts] = useState<Expert[]>([]);
  const [showExpertSelector, setShowExpertSelector] = useState(false);
  
  // WebSocket connection for real-time updates
  const socket = useWebSocket();
  
  // Fetch user's conversations
  const { data: conversations, isLoading: isLoadingConversations } = useQuery<Conversation[]>({
    queryKey: ["/api/protected/conversations"],
    enabled: !!user,
  });
  
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
      const messagesQueryKey = [`/api/protected/conversations/${activeConversation}/messages`];
      
      console.log("Message mutation settled, invalidating messages query to sync with server.");
      queryClient.invalidateQueries({ queryKey: messagesQueryKey });
    },
  });
  
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
  
  // Effect to update selected experts when experts change
  useEffect(() => {
    if (experts) {
      setSelectedExperts(experts);
    }
  }, [experts]);
  
  // Effect to handle WebSocket messages
  useEffect(() => {
    if (socket) {
      socket.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          
          if (data.conversationId === activeConversation) {
            if (data.type === "messages_updated") {
              console.log("WebSocket: Received messages_updated signal");
              
              // Instead of just invalidating, which causes a refetch,
              // we'll directly update the cache if we have message data
              if (data.message) {
                // Get current messages from cache
                const messagesQueryKey = [`/api/protected/conversations/${activeConversation}/messages`];
                const currentMessages = queryClient.getQueryData<Message[]>(messagesQueryKey) || [];
                
                // Check if this message already exists in our cache
                const messageExists = currentMessages.some(msg => msg.id === data.message.id);
                
                if (!messageExists) {
                  // Add the new message to our cache immediately
                  queryClient.setQueryData<Message[]>(messagesQueryKey, 
                    [...currentMessages, data.message]
                  );
                  console.log("WebSocket: Added new message from expert to cache");
                }
              } else {
                // Fallback to invalidation if no message data is provided
                queryClient.invalidateQueries({ 
                  queryKey: [`/api/protected/conversations/${activeConversation}/messages`] 
                });
              }
            } else if (data.type === "insights") {
              console.log("WebSocket: Received insights update signal, invalidating insights query.");
              queryClient.invalidateQueries({ 
                queryKey: [`/api/protected/conversations/${activeConversation}/insights`] 
              });
            }
          }
        } catch (error) {
          console.error("Error parsing WebSocket message:", error);
        }
      };
    }
    
    return () => {
      if (socket) {
        socket.onmessage = null;
      }
    };
  }, [socket, activeConversation]);
  
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
        />
        
        {/* Main Content Area */}
        <div className="flex-1 flex flex-col">
          {activeConversation ? (
            <ChatInterface
              messages={messages || []}
              experts={experts || []}
              onSendMessage={(content) => sendMessageMutation.mutate(content)}
              onUploadFile={handleFileUpload}
              isLoading={sendMessageMutation.isPending}
              user={user}
              insights={insights || []}
              visualizations={[]} // We'll populate this with extracted visualizations
            />
          ) : (
            <div className="flex-1 flex items-center justify-center">
              <div className="text-center">
                <h2 className="text-xl font-semibold text-neutral-800 mb-2">Welcome to Farm Friend Roundtable</h2>
                <p className="text-neutral-600 mb-4">Start a new conversation to begin chatting with agricultural experts</p>
                <button
                  onClick={handleStartNewSession}
                  className="bg-primary text-white px-4 py-2 rounded-lg hover:bg-primary-dark transition-colors"
                >
                  Start New Roundtable
                </button>
              </div>
            </div>
          )}
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
    </div>
  );
}

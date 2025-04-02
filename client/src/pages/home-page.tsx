import { useState, useEffect } from "react";
import { useAuth } from "@/hooks/use-auth";
import Header from "@/components/layout/Header";
import SidebarPanel from "@/components/roundtable/SidebarPanel";
import RoundtableVisualization from "@/components/roundtable/RoundtableVisualization";
import ChatInterface from "@/components/roundtable/ChatInterface";
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
  const [showExpertSelector, setShowExpertSelector] = useState(false);
  const [activeConversation, setActiveConversation] = useState<number | null>(null);
  const [selectedExperts, setSelectedExperts] = useState<Expert[]>([]);
  
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
      setShowExpertSelector(true);
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
  const sendMessageMutation = useMutation({
    mutationFn: async (content: string) => {
      if (!activeConversation) throw new Error("No active conversation");
      const res = await apiRequest("POST", `/api/protected/conversations/${activeConversation}/messages`, { content });
      return await res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/protected/conversations/${activeConversation}/messages`] });
    },
    onError: (error: Error) => {
      toast({
        title: "Failed to send message",
        description: error.message,
        variant: "destructive",
      });
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
  };
  
  // Handle adding experts to conversation
  const handleAddExperts = (experts: { name: string; role: string; model: string; avatarUrl: string }[]) => {
    // Add each expert sequentially
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
            if (data.type === "message") {
              // Update messages
              queryClient.invalidateQueries({ queryKey: [`/api/protected/conversations/${activeConversation}/messages`] });
            } else if (data.type === "insights") {
              // Update insights
              queryClient.invalidateQueries({ queryKey: [`/api/protected/conversations/${activeConversation}/insights`] });
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
  
  // Check if a new conversation should show the expert selector
  useEffect(() => {
    if (activeConversation && experts && experts.length === 0) {
      setShowExpertSelector(true);
    }
  }, [activeConversation, experts]);
  
  return (
    <div className="flex flex-col h-screen bg-neutral-100">
      {/* Header */}
      <Header />
      
      {/* Main Content */}
      <main className="flex flex-1 overflow-hidden">
        {/* Sidebar */}
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
        
        {/* Main Visualization and Chat Area */}
        <div className="flex-1 flex flex-col md:flex-row h-full">
          {/* Roundtable Visualization */}
          <RoundtableVisualization 
            experts={selectedExperts} 
            showExpertSelector={showExpertSelector}
          />
          
          {/* Expert Selector (Modal) */}
          {showExpertSelector && (
            <ExpertSelector
              onClose={() => setShowExpertSelector(false)}
              onAddExperts={handleAddExperts}
              selectedExperts={selectedExperts}
            />
          )}
          
          {/* Chat Interface */}
          <ChatInterface
            messages={messages || []}
            experts={selectedExperts}
            onSendMessage={(content) => sendMessageMutation.mutate(content)}
            onUploadFile={handleFileUpload}
            isLoading={sendMessageMutation.isPending}
            user={user}
          />
        </div>
      </main>
    </div>
  );
}

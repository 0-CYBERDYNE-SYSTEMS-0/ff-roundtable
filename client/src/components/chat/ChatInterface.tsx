import { useState, useRef, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Paperclip, Send, Loader2 } from "lucide-react";
import { Message, Expert, User } from "@shared/schema";
import { format } from "date-fns";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { formatMessageDate } from "@/lib/file-utils";
import ModelBadge from "../roundtable/ModelBadge";
import ConversationSidebar from "../roundtable/ConversationSidebar";
import ArtifactDisplay from "../artifacts/ArtifactDisplay";
import ExpertSettingsModal from "../expert/ExpertSettingsModal";

interface ChatInterfaceProps {
  messages: Message[];
  experts: Expert[];
  onSendMessage: (content: string) => void;
  onUploadFile: (file: File) => void;
  isLoading: boolean;
  user: User | null;
  insights: any[];
  visualizations: any[];
  streamingMessages?: Map<number, { content: string; expertName: string; expertRole: string }>;
  typingExpertIds?: Set<number>;
}

export default function ChatInterface({
  messages,
  experts,
  onSendMessage,
  onUploadFile,
  isLoading,
  user,
  insights,
  visualizations,
  streamingMessages = new Map(),
  typingExpertIds = new Set(),
}: ChatInterfaceProps) {
  const [messageContent, setMessageContent] = useState("");
  const [expertsCollapsed, setExpertsCollapsed] = useState(false);
  const [rightSidebarWidth, setRightSidebarWidth] = useState(400);
  const [selectedExpert, setSelectedExpert] = useState<Expert | null>(null);
  const [isExpertModalOpen, setIsExpertModalOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Get background color for expert based on ID - using farm theme
  const getExpertBubbleColor = (expertId: number) => {
    const colors = [
      "bg-farm-powder/40 border-farm-blue/20",
      "bg-farm-green/20 border-farm-green/30",
      "bg-purple-100 border-purple-300/30",
      "bg-pink-100 border-pink-300/30",
      "bg-farm-yellow/20 border-farm-yellow/40",
      "bg-cyan-100 border-cyan-300/30",
      "bg-orange-100 border-orange-300/30",
      "bg-farm-tan/30 border-farm-tan/50",
    ];
    return colors[expertId % colors.length];
  };

  // Handle sending a message
  const handleSendMessage = () => {
    if (messageContent.trim() === "") return;
    
    onSendMessage(messageContent);
    setMessageContent("");
  };

  // Handle message input keydown
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  };

  // Handle file upload
  const handleFileUpload = () => {
    if (fileInputRef.current) {
      fileInputRef.current.click();
    }
  };

  // Handle file input change
  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      onUploadFile(e.target.files[0]);
    }
  };

  // Find expert by ID
  const findExpert = (expertId: number | null) => {
    if (!expertId) return null;
    return experts.find(expert => expert.id === expertId);
  };

  // Handle expert click to open settings modal
  const handleExpertClick = (expert: Expert) => {
    setSelectedExpert(expert);
    setIsExpertModalOpen(true);
  };

  // Handle expert settings save
  const handleExpertSave = async (expertId: number, updates: Partial<Expert>) => {
    try {
      const response = await fetch(`/api/experts/${expertId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
        credentials: 'include'
      });

      if (!response.ok) {
        throw new Error('Failed to update expert');
      }

      // Refresh the page or update local state
      window.location.reload();
    } catch (error) {
      console.error('Error updating expert:', error);
      alert('Failed to update expert. Please try again.');
    }
  };

  // Group messages by date for displaying date separators
  const messagesByDate: { [date: string]: Message[] } = {};
  messages.forEach(message => {
    // Ensure timestamp is a valid Date
    if (message.timestamp) {
      const date = formatMessageDate(message.timestamp);
      if (!messagesByDate[date]) {
        messagesByDate[date] = [];
      }
      
      // Check for duplicate messages (same content from same user/expert within 2 seconds)
      const lastMessage = messagesByDate[date][messagesByDate[date].length - 1];
      const isDuplicate = lastMessage && 
        lastMessage.content === message.content &&
        lastMessage.userId === message.userId &&
        lastMessage.expertId === message.expertId &&
        lastMessage.timestamp &&
        message.timestamp &&
        Math.abs(new Date(lastMessage.timestamp).getTime() - new Date(message.timestamp).getTime()) < 2000;
      
      if (!isDuplicate) {
        messagesByDate[date].push(message);
      }
    }
  });

  // Render welcome message if no messages
  const renderWelcomeMessage = () => {
    if (messages.length === 0 && experts.length > 0) {
      return (
        <div className="flex items-start mb-6">
          <div className="flex-shrink-0 mr-3">
            <div className="w-10 h-10 rounded-full bg-gradient-to-br from-farm-blue to-farm-green flex items-center justify-center text-white shadow-md">
              <span className="material-icons text-lg">smart_toy</span>
            </div>
          </div>
          <div className="bg-gradient-to-br from-farm-powder/30 to-farm-tan/20 border border-farm-tan/30 rounded-xl p-4 max-w-[85%] shadow-sm">
            <p className="text-base font-semibold text-farm-blue mb-2">Moderator</p>
            <div className="markdown-content text-sm mt-1 text-neutral-700 leading-relaxed">
              <p className="mb-2">Welcome to Farm Friend Roundtable! Your agricultural experts are ready to assist you. Here's who's at the table:</p>
              <ul className="list-disc list-inside space-y-1 mb-2">
                {experts.map(expert => (
                  <li key={expert.id}><strong className="text-farm-blue">{expert.name}</strong> - {expert.role}</li>
                ))}
              </ul>
              <p>What agricultural topic would you like to discuss today?</p>
            </div>
          </div>
        </div>
      );
    }
    return null;
  };

  // Enhanced loading indicator component
  const renderLoadingIndicator = () => {
    if (!isLoading) return null;

    return (
      <div className="space-y-4">
        {experts.map((expert, index) => (
          <div key={expert.id} className="flex items-start mb-4 animate-pulse">
            <div className="flex-shrink-0 mr-3">
              <Avatar className="h-10 w-10 ring-2 ring-farm-green/20">
                <AvatarImage src={expert.avatarUrl || ""} alt={expert.name} />
                <AvatarFallback className="bg-farm-green text-white font-semibold">{expert.name.charAt(0)}</AvatarFallback>
              </Avatar>
            </div>
            <div className="bg-farm-powder/20 border border-farm-tan/30 rounded-xl p-4 max-w-[85%] relative overflow-hidden shadow-sm">
              <div className="flex items-center justify-between mb-2">
                <p className="text-sm font-semibold text-farm-blue">{expert.name} <span className="text-neutral-600 font-normal">({expert.role})</span></p>
                <ModelBadge modelId={expert.model} size="sm" />
              </div>
              <div className="h-4 bg-farm-tan/20 rounded-lg w-3/4 mb-2"></div>
              <div className="h-4 bg-farm-tan/20 rounded-lg w-1/2"></div>
              <div className="absolute bottom-0 left-0 w-full h-1">
                <div
                  className="h-full bg-gradient-to-r from-farm-blue to-farm-green opacity-40"
                  style={{
                    width: '100%',
                    animation: 'loading 2s infinite ease-in-out',
                  }}
                ></div>
              </div>
            </div>
          </div>
        ))}
      </div>
    );
  };

  return (
    <div className="w-full flex h-full overflow-hidden">
      {/* Left Sidebar - Experts List */}
      <div className={`flex-shrink-0 bg-gradient-to-b from-farm-powder/30 to-white border-r border-neutral-200 transition-all duration-300 ${expertsCollapsed ? 'w-12' : 'w-64'}`}>
        <div className="h-full flex flex-col">
          <div className="p-3 border-b border-neutral-200 flex items-center justify-between">
            {!expertsCollapsed && <h3 className="font-semibold text-farm-blue text-sm">Expert Panel</h3>}
            <button
              onClick={() => setExpertsCollapsed(!expertsCollapsed)}
              className="p-1.5 hover:bg-farm-blue/10 rounded transition-colors"
              title={expertsCollapsed ? "Expand expert list" : "Collapse expert list"}
            >
              <svg className={`w-4 h-4 text-farm-blue transition-transform ${expertsCollapsed ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
            </button>
          </div>

          {!expertsCollapsed && (
            <ScrollArea className="flex-1 p-3">
              <div className="space-y-2">
                {experts.map((expert) => (
                  <button
                    key={expert.id}
                    onClick={() => handleExpertClick(expert)}
                    className="w-full p-3 bg-white rounded-lg border border-farm-tan/30 shadow-sm hover:shadow-md hover:border-farm-blue/40 transition-all cursor-pointer text-left group"
                  >
                    <div className="flex items-start gap-2">
                      <div className="relative">
                        <Avatar className="h-8 w-8 ring-2 ring-farm-green/20 flex-shrink-0 group-hover:ring-farm-blue/40 transition-all">
                          <AvatarImage src={expert.avatarUrl || ""} alt={expert.name} />
                          <AvatarFallback className="bg-farm-green text-white text-xs font-semibold">
                            {expert.name.charAt(0)}
                          </AvatarFallback>
                        </Avatar>
                        {typingExpertIds.has(expert.id) && (
                          <span className="absolute -bottom-0.5 -right-0.5 flex h-3 w-3">
                            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-farm-green opacity-75"></span>
                            <span className="relative inline-flex rounded-full h-3 w-3 bg-farm-green"></span>
                          </span>
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-semibold text-farm-blue truncate group-hover:text-farm-dark-green transition-colors">
                          {expert.name}
                        </p>
                        <p className="text-xs text-neutral-600 truncate">{expert.role}</p>
                      </div>
                      <svg className="w-4 h-4 text-neutral-400 group-hover:text-farm-blue transition-colors flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                      </svg>
                    </div>
                  </button>
                ))}
              </div>
            </ScrollArea>
          )}

          {expertsCollapsed && (
            <div className="flex-1 p-2 space-y-3 overflow-y-auto">
              {experts.map((expert) => (
                <button
                  key={expert.id}
                  onClick={() => handleExpertClick(expert)}
                  className="flex justify-center hover:bg-farm-powder/30 rounded-lg p-1 transition-colors w-full"
                  title={`${expert.name} - ${expert.role}\nClick to edit settings`}
                >
                  <Avatar className="h-8 w-8 ring-2 ring-farm-green/20 hover:ring-farm-blue/40 transition-all">
                    <AvatarImage src={expert.avatarUrl || ""} alt={expert.name} />
                    <AvatarFallback className="bg-farm-green text-white text-xs font-semibold">
                      {expert.name.charAt(0)}
                    </AvatarFallback>
                  </Avatar>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Main Chat Area */}
      <div className="flex-1 flex flex-col h-full bg-white border-r border-neutral-200 min-w-0">
        {/* Chat Messages */}
        <ScrollArea className="flex-1 p-4">
          {renderWelcomeMessage()}
          
          {Object.entries(messagesByDate).map(([date, dateMessages]) => (
            <div key={date}>
              <div className="text-center my-4">
                <span className="text-xs bg-farm-tan/30 text-farm-blue px-3 py-1.5 rounded-full font-medium shadow-sm">
                  {date}
                </span>
              </div>
              
              {dateMessages.map((message) => {
                // User message
                if (message.userId && !message.expertId) {
                  return (
                    <div key={message.id} className="flex items-start mb-4 justify-end">
                      <div className="bg-gradient-to-br from-farm-blue to-farm-dark-green text-white rounded-xl p-4 max-w-[85%] shadow-md">
                        <div className="markdown-content prose-sm prose-invert leading-relaxed">
                          <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
                        </div>
                      </div>
                      <div className="flex-shrink-0 ml-3">
                        <Avatar className="h-10 w-10 ring-2 ring-farm-blue/20">
                          <AvatarImage src="https://images.unsplash.com/photo-1610216705422-caa3fcb6d158?ixlib=rb-1.2.1&auto=format&fit=crop&w=32&h=32&q=80" />
                          <AvatarFallback className="bg-farm-blue text-white font-semibold">{user?.username.charAt(0).toUpperCase()}</AvatarFallback>
                        </Avatar>
                      </div>
                    </div>
                  );
                }
                
                // Expert message
                if (message.expertId) {
                  const expert = findExpert(message.expertId);
                  if (!expert) return null;

                  return (
                    <div key={message.id} className="flex items-start mb-4">
                      <div className="flex-shrink-0 mr-3">
                        <Avatar className="h-10 w-10 ring-2 ring-farm-green/20">
                          <AvatarImage src={expert.avatarUrl || ""} alt={expert.name} />
                          <AvatarFallback className="bg-farm-green text-white font-semibold">{expert.name.charAt(0)}</AvatarFallback>
                        </Avatar>
                      </div>
                      <div className="max-w-[85%] space-y-2">
                        <div className={`${getExpertBubbleColor(message.expertId)} rounded-xl p-4 border shadow-sm`}>
                          <div className="flex items-center justify-between mb-2">
                            <p className="text-sm font-semibold text-farm-blue">{expert.name} <span className="text-neutral-600 font-normal">({expert.role})</span></p>
                            <ModelBadge modelId={expert.model} size="sm" />
                          </div>
                          <div className="markdown-content text-sm leading-relaxed text-neutral-700">
                            <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
                          </div>
                        </div>
                        
                        {/* Render artifacts inline */}
                        {(() => {
                          console.log(`[ChatInterface] Message ${message.id}: artifacts=`, message.artifacts, `length=${message.artifacts?.length || 0}`);
                          return null;
                        })()}
                        {message.artifacts && message.artifacts.length > 0 && (
                          <div className="space-y-2" data-testid={`artifacts-message-${message.id}`}>
                            {(() => {
                              console.log(`[ChatInterface] RENDERING ${message.artifacts.length} artifacts for message ${message.id}`);
                              return null;
                            })()}
                            {message.artifacts.map((artifact, index) => (
                              <ArtifactDisplay
                                key={`${message.id}-artifact-${index}`}
                                artifact={artifact}
                                data-testid={`artifact-${artifact.type}-${index}`}
                              />
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                }
                
                return null;
              })}
            </div>
          ))}
          
          {/* Streaming messages (tokens arriving in real-time) */}
          {Array.from(streamingMessages.entries()).map(([expertId, stream]) => {
            const expert = findExpert(expertId);
            if (!expert) return null;
            return (
              <div key={`stream-${expertId}`} className="flex items-start mb-4">
                <div className="flex-shrink-0 mr-3">
                  <div className="relative">
                    <Avatar className="h-10 w-10 ring-2 ring-farm-green/20">
                      <AvatarImage src={expert.avatarUrl || ""} alt={expert.name} />
                      <AvatarFallback className="bg-farm-green text-white font-semibold">{expert.name.charAt(0)}</AvatarFallback>
                    </Avatar>
                    <span className="absolute -bottom-0.5 -right-0.5 flex h-3 w-3">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-farm-green opacity-75"></span>
                      <span className="relative inline-flex rounded-full h-3 w-3 bg-farm-green"></span>
                    </span>
                  </div>
                </div>
                <div className="max-w-[85%] space-y-2">
                  <div className={`${getExpertBubbleColor(expertId)} rounded-xl p-4 border shadow-sm`}>
                    <div className="flex items-center justify-between mb-2">
                      <p className="text-sm font-semibold text-farm-blue">
                        {stream.expertName} <span className="text-neutral-600 font-normal">({stream.expertRole})</span>
                      </p>
                      <ModelBadge modelId={expert.model} size="sm" />
                    </div>
                    <div className="markdown-content text-sm leading-relaxed text-neutral-700">
                      {stream.content ? (
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>{stream.content}</ReactMarkdown>
                      ) : (
                        <span className="inline-flex items-center gap-0.5">
                          <span className="animate-bounce [animation-delay:-0.3s]">.</span>
                          <span className="animate-bounce [animation-delay:-0.15s]">.</span>
                          <span className="animate-bounce">.</span>
                        </span>
                      )}
                      {/* Blinking cursor */}
                      <span className="inline-block w-0.5 h-4 bg-farm-blue ml-0.5 animate-pulse align-middle"></span>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
          
          {/* Enhanced loading indicators */}
          {renderLoadingIndicator()}
          
          <div ref={messagesEndRef} />
        </ScrollArea>
        
        {/* Input Area */}
        <div className="border-t border-farm-tan/30 bg-gradient-to-r from-white to-farm-powder/10 p-4">
          <div className="flex items-center gap-3">
            <input
              type="file"
              ref={fileInputRef}
              className="hidden"
              onChange={handleFileInputChange}
            />
            <Button
              variant="ghost"
              size="icon"
              className="text-farm-blue hover:text-farm-green hover:bg-farm-powder/30 transition-all duration-200"
              onClick={handleFileUpload}
              title="Upload File"
            >
              <Paperclip className="h-5 w-5" />
            </Button>
            <div className="relative flex-1">
              <Textarea
                placeholder="Type your message here..."
                value={messageContent}
                onChange={(e) => setMessageContent(e.target.value)}
                onKeyDown={handleKeyDown}
                className="min-h-[60px] resize-none pr-10 border-farm-tan/40 focus:border-farm-blue focus:ring-farm-blue/20"
                disabled={false}
              />
            </div>
            <Button
              className="bg-gradient-to-br from-farm-green to-farm-dark-green hover:from-farm-dark-green hover:to-farm-green text-white rounded-full p-2 ml-2 h-11 w-11 flex items-center justify-center shadow-md hover:shadow-lg transition-all duration-200 disabled:opacity-50"
              onClick={handleSendMessage}
              disabled={messageContent.trim() === ""}
            >
              <Send className="h-5 w-5" />
            </Button>
          </div>
        </div>
        
        {/* Loading indicator for pending expert responses */}
        {isLoading && (
          <div className="flex items-start mb-4">
            <div className="flex-shrink-0 mr-3">
              <div className="w-10 h-10 rounded-full bg-gradient-to-br from-farm-blue to-farm-green flex items-center justify-center shadow-md">
                <Loader2 className="h-5 w-5 animate-spin text-white" />
              </div>
            </div>
            <div className="bg-farm-powder/30 border border-farm-tan/30 rounded-xl p-3 shadow-sm">
              <p className="text-sm text-farm-blue font-medium">Experts are thinking...</p>
            </div>
          </div>
        )}
      </div>

      {/* Right Sidebar - Resizable */}
      <div
        className="flex-shrink-0 bg-white h-full overflow-hidden"
        style={{ width: `${rightSidebarWidth}px` }}
      >
        <ConversationSidebar
          messages={messages}
          experts={experts}
          insights={insights}
          visualizations={visualizations}
          onWidthChange={setRightSidebarWidth}
          currentWidth={rightSidebarWidth}
        />
      </div>

      {/* Expert Settings Modal */}
      <ExpertSettingsModal
        expert={selectedExpert}
        isOpen={isExpertModalOpen}
        onClose={() => {
          setIsExpertModalOpen(false);
          setSelectedExpert(null);
        }}
        onSave={handleExpertSave}
      />
    </div>
  );
}

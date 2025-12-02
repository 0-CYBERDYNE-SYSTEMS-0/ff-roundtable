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

interface ChatInterfaceProps {
  messages: Message[];
  experts: Expert[];
  onSendMessage: (content: string) => void;
  onUploadFile: (file: File) => void;
  isLoading: boolean;
  user: User | null;
  insights: any[];
  visualizations: any[];
}

export default function ChatInterface({
  messages,
  experts,
  onSendMessage,
  onUploadFile,
  isLoading,
  user,
  insights,
  visualizations
}: ChatInterfaceProps) {
  const [messageContent, setMessageContent] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Get background color for expert based on ID
  const getExpertBubbleColor = (expertId: number) => {
    const colors = [
      "bg-blue-100",
      "bg-green-100",
      "bg-purple-100",
      "bg-pink-100",
      "bg-yellow-100",
      "bg-cyan-100",
      "bg-orange-100",
      "bg-red-100",
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
        <div className="flex items-start mb-4">
          <div className="flex-shrink-0 mr-3">
            <div className="w-8 h-8 rounded-full bg-primary flex items-center justify-center text-white">
              <span className="material-icons text-sm">smart_toy</span>
            </div>
          </div>
          <div className="bg-neutral-200 rounded-lg p-3 max-w-[85%]">
            <p className="text-sm font-medium text-neutral-800">Moderator</p>
            <div className="markdown-content text-sm mt-1">
              <p>Welcome to Farm Friend Roundtable! Your agricultural experts are ready to assist you. Here's who's at the table:</p>
              <ul>
                {experts.map(expert => (
                  <li key={expert.id}><strong>{expert.name}</strong> - {expert.role}</li>
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
              <Avatar className="h-8 w-8">
                <AvatarImage src={expert.avatarUrl || ""} alt={expert.name} />
                <AvatarFallback>{expert.name.charAt(0)}</AvatarFallback>
              </Avatar>
            </div>
            <div className="bg-neutral-100 rounded-lg p-3 max-w-[85%] relative overflow-hidden">
              <div className="flex items-center justify-between mb-2">
                <p className="text-sm font-medium text-neutral-800">{expert.name} ({expert.role})</p>
                <ModelBadge modelId={expert.model} size="sm" />
              </div>
              <div className="h-4 bg-neutral-200 rounded w-3/4 mb-2"></div>
              <div className="h-4 bg-neutral-200 rounded w-1/2"></div>
              <div className="absolute bottom-0 left-0 w-full h-1">
                <div 
                  className="h-full bg-primary opacity-25"
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
    <div className="w-full flex h-full">
      {/* Main Chat Area */}
      <div className="flex-1 flex flex-col h-full bg-white border-r border-neutral-200">
        {/* Chat Messages */}
        <ScrollArea className="flex-1 p-4">
          {renderWelcomeMessage()}
          
          {Object.entries(messagesByDate).map(([date, dateMessages]) => (
            <div key={date}>
              <div className="text-center my-3">
                <span className="text-xs bg-neutral-200 text-neutral-600 px-2 py-1 rounded-full">
                  {date}
                </span>
              </div>
              
              {dateMessages.map((message) => {
                // User message
                if (message.userId && !message.expertId) {
                  return (
                    <div key={message.id} className="flex items-start mb-4 justify-end">
                      <div className="bg-primary text-white dark:bg-primary-dark rounded-lg p-3 max-w-[85%] shadow-sm">
                        <div className="markdown-content prose-sm prose-invert">
                          <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
                        </div>
                      </div>
                      <div className="flex-shrink-0 ml-3">
                        <Avatar className="h-8 w-8">
                          <AvatarImage src="https://images.unsplash.com/photo-1610216705422-caa3fcb6d158?ixlib=rb-1.2.1&auto=format&fit=crop&w=32&h=32&q=80" />
                          <AvatarFallback>{user?.username.charAt(0).toUpperCase()}</AvatarFallback>
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
                        <Avatar className="h-8 w-8">
                          <AvatarImage src={expert.avatarUrl || ""} alt={expert.name} />
                          <AvatarFallback>{expert.name.charAt(0)}</AvatarFallback>
                        </Avatar>
                      </div>
                      <div className="max-w-[85%] space-y-2">
                        <div className={`${getExpertBubbleColor(message.expertId)} rounded-lg p-3`}>
                          <div className="flex items-center justify-between">
                            <p className="text-sm font-medium text-neutral-800">{expert.name} ({expert.role})</p>
                            <ModelBadge modelId={expert.model} size="sm" />
                          </div>
                          <div className="markdown-content text-sm mt-1">
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
          
          {/* Enhanced loading indicators */}
          {renderLoadingIndicator()}
          
          <div ref={messagesEndRef} />
        </ScrollArea>
        
        {/* Input Area */}
        <div className="border-t border-neutral-300 p-3">
          <div className="flex items-center">
            <input
              type="file"
              ref={fileInputRef}
              className="hidden"
              onChange={handleFileInputChange}
            />
            <Button 
              variant="ghost" 
              size="icon" 
              className="text-neutral-500 hover:text-primary mr-2"
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
                className="min-h-[60px] resize-none pr-10"
                disabled={isLoading}
              />
            </div>
            <Button 
              className="bg-primary hover:bg-primary-dark text-white rounded-full p-2 ml-2 h-10 w-10 flex items-center justify-center"
              onClick={handleSendMessage}
              disabled={messageContent.trim() === "" || isLoading}
            >
              <Send className="h-5 w-5" />
            </Button>
          </div>
        </div>
        
        {/* Loading indicator for pending expert responses */}
        {isLoading && (
          <div className="flex items-start mb-4">
            <div className="flex-shrink-0 mr-3">
              <div className="w-8 h-8 rounded-full bg-neutral-300 flex items-center justify-center">
                <Loader2 className="h-5 w-5 animate-spin text-neutral-600" />
              </div>
            </div>
            <div className="bg-neutral-200 rounded-lg p-3">
              <p className="text-sm text-neutral-600">Experts are thinking...</p>
            </div>
          </div>
        )}
      </div>

      {/* Dynamic Sidebar */}
      <div className="w-[400px] flex-shrink-0 bg-white h-full overflow-hidden">
        <ConversationSidebar 
          messages={messages}
          experts={experts}
          insights={insights}
          visualizations={visualizations}
        />
      </div>
    </div>
  );
}

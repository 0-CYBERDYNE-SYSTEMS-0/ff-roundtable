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
import ModelBadge from "./ModelBadge";

interface ChatInterfaceProps {
  messages: Message[];
  experts: Expert[];
  onSendMessage: (content: string) => void;
  onUploadFile: (file: File) => void;
  isLoading: boolean;
  user: User | null;
}

export default function ChatInterface({
  messages,
  experts,
  onSendMessage,
  onUploadFile,
  isLoading,
  user
}: ChatInterfaceProps) {
  const [messageContent, setMessageContent] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const [isInitialLoad, setIsInitialLoad] = useState(true);

  // Auto-scroll to bottom when new messages are added
  useEffect(() => {
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: isInitialLoad ? "auto" : "smooth" });
      if (isInitialLoad && messages.length > 0) {
        setIsInitialLoad(false);
      }
    }
  }, [messages, isInitialLoad]);

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
      messagesByDate[date].push(message);
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

  return (
    <div className="w-full md:w-1/2 flex flex-col h-full bg-white">
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
                    <div className="bg-primary-light text-white rounded-lg p-3 max-w-[85%]">
                      <div className="markdown-content">
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
                    <div className="bg-neutral-200 rounded-lg p-3 max-w-[85%]">
                      <div className="flex items-center justify-between">
                        <p className="text-sm font-medium text-neutral-800">{expert.name} ({expert.role})</p>
                        <ModelBadge modelId={expert.model} size="sm" />
                      </div>
                      <div className="markdown-content text-sm mt-1">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
                      </div>
                    </div>
                  </div>
                );
              }
              
              return null;
            })}
          </div>
        ))}
        
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
    </div>
  );
}

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Plus, RefreshCw, Download, Upload, FileDown, FileText, Image, ArrowRight } from "lucide-react";
import { Insight, File, Conversation } from "@shared/schema";
import { format } from "date-fns";

interface SidebarPanelProps {
  conversations: Conversation[];
  insights: Insight[];
  files: File[];
  onStartNewSession: () => void;
  onExportMarkdown: () => void;
  onFileUpload: (file: File) => void;
  onSelectConversation: (id: number) => void;
  activeConversationId: number | null;
  onRefreshInsights: () => void;
  isLoadingInsights: boolean;
}

export default function SidebarPanel({
  conversations,
  insights,
  files,
  onStartNewSession,
  onExportMarkdown,
  onFileUpload,
  onSelectConversation,
  activeConversationId,
  onRefreshInsights,
  isLoadingInsights
}: SidebarPanelProps) {
  const [activeTab, setActiveTab] = useState<'conversations' | 'insights' | 'files'>('insights');
  
  // Handle file upload
  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      onFileUpload(e.target.files[0]);
      // Clear the input value so the same file can be uploaded again if needed
      e.target.value = '';
    }
  };
  
  return (
    <aside className="w-72 bg-white border-r border-neutral-300 flex flex-col z-10 shadow-md">
      <div className="flex flex-col h-full">
        {/* Session Controls */}
        <div className="p-4 border-b border-neutral-300">
          <h2 className="font-serif font-bold text-lg mb-3">Current Session</h2>
          <Button 
            className="w-full bg-primary hover:bg-primary-dark text-white rounded px-4 py-2 flex items-center justify-center mb-2"
            onClick={onStartNewSession}
          >
            <Plus className="mr-1 h-4 w-4" />
            New Roundtable
          </Button>
          <Button 
            variant="outline"
            className="w-full border border-neutral-400 hover:bg-neutral-200 rounded px-4 py-2 flex items-center justify-center"
            onClick={onExportMarkdown}
          >
            <Download className="mr-1 h-4 w-4" />
            Export as Markdown
          </Button>
        </div>
        
        {/* Tabs */}
        <div className="flex border-b border-neutral-300">
          <button
            className={`flex-1 py-2 text-center font-medium ${activeTab === 'conversations' ? 'text-primary border-b-2 border-primary' : 'text-neutral-600'}`}
            onClick={() => setActiveTab('conversations')}
          >
            Conversations
          </button>
          <button
            className={`flex-1 py-2 text-center font-medium ${activeTab === 'insights' ? 'text-primary border-b-2 border-primary' : 'text-neutral-600'}`}
            onClick={() => setActiveTab('insights')}
          >
            Insights
          </button>
          <button
            className={`flex-1 py-2 text-center font-medium ${activeTab === 'files' ? 'text-primary border-b-2 border-primary' : 'text-neutral-600'}`}
            onClick={() => setActiveTab('files')}
          >
            Files
          </button>
        </div>
        
        {/* Tab Content */}
        <ScrollArea className="flex-1 p-4">
          {activeTab === 'conversations' && (
            <div>
              <div className="flex justify-between items-center mb-3">
                <h2 className="font-serif font-bold text-lg">Your Conversations</h2>
              </div>
              
              {conversations.length === 0 ? (
                <div className="text-center py-8 text-neutral-500">
                  <p>No conversations yet</p>
                  <p className="text-sm mt-2">Click "New Roundtable" to start</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {conversations.map(conversation => (
                    <div
                      key={conversation.id}
                      className={`p-3 rounded-lg cursor-pointer ${activeConversationId === conversation.id ? 'bg-primary bg-opacity-10 border border-primary' : 'bg-neutral-200 hover:bg-neutral-300'}`}
                      onClick={() => onSelectConversation(conversation.id)}
                    >
                      <h3 className="font-medium">{conversation.title}</h3>
                      <p className="text-xs text-neutral-600">
                        {format(new Date(conversation.createdAt), 'MMM d, yyyy • h:mm a')}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          
          {activeTab === 'insights' && (
            <div>
              <div className="flex justify-between items-center mb-3">
                <h2 className="font-serif font-bold text-lg">Key Insights</h2>
                <Button 
                  variant="ghost" 
                  size="icon" 
                  className="text-primary cursor-pointer h-8 w-8" 
                  title="Refresh insights"
                  onClick={onRefreshInsights}
                  disabled={isLoadingInsights}
                >
                  <RefreshCw className={`h-4 w-4 ${isLoadingInsights ? 'animate-spin' : ''}`} />
                </Button>
              </div>
              
              {insights.length === 0 ? (
                <div className="text-center py-8 text-neutral-500">
                  <p>No insights generated yet</p>
                  <p className="text-sm mt-2">Continue your conversation to generate insights</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {insights.map(insight => (
                    <div key={insight.id} className="bg-neutral-200 rounded-lg p-3 mb-3">
                      <h3 className="font-medium text-primary-dark">{insight.title}</h3>
                      <ul className="text-sm mt-1">
                        {insight.points.map((point, index) => (
                          <li key={index} className="flex items-start mb-1">
                            <ArrowRight className="text-secondary h-4 w-4 mr-1 mt-0.5 flex-shrink-0" />
                            <span>{point}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          
          {activeTab === 'files' && (
            <div>
              <div className="flex justify-between items-center mb-3">
                <h2 className="font-serif font-bold text-lg">Attachments</h2>
                <div>
                  <input
                    id="file-upload"
                    type="file"
                    className="hidden"
                    onChange={handleFileInputChange}
                  />
                  <label htmlFor="file-upload">
                    <Button 
                      variant="ghost" 
                      size="icon" 
                      className="text-primary cursor-pointer h-8 w-8" 
                      title="Upload File"
                      as="span"
                    >
                      <Upload className="h-4 w-4" />
                    </Button>
                  </label>
                </div>
              </div>
              
              {files.length === 0 ? (
                <div className="text-center py-8 text-neutral-500">
                  <p>No files uploaded yet</p>
                  <p className="text-sm mt-2">Click the upload button to add files</p>
                </div>
              ) : (
                <div>
                  {files.map(file => (
                    <div key={file.id} className="flex justify-between items-center p-2 hover:bg-neutral-200 rounded">
                      <div className="flex items-center">
                        {file.fileType.includes('image') ? (
                          <Image className="text-neutral-600 h-5 w-5 mr-2" />
                        ) : (
                          <FileText className="text-neutral-600 h-5 w-5 mr-2" />
                        )}
                        <span className="text-sm truncate max-w-[160px]">{file.filename}</span>
                      </div>
                      <a 
                        href={file.fileUrl} 
                        download 
                        className="text-neutral-600 hover:text-primary" 
                        title="Download File"
                      >
                        <FileDown className="h-4 w-4" />
                      </a>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </ScrollArea>
        
        {/* Version Info */}
        <div className="p-4 text-xs text-neutral-500 mt-auto border-t border-neutral-300">
          <p>Farm Friend Roundtable v1.0.0</p>
          <p>© 2023 Farm Friend Technologies</p>
        </div>
      </div>
    </aside>
  );
}

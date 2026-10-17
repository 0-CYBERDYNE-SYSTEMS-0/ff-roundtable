import { formatLocalDateTime } from "@/lib/format-local-time";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Plus, RefreshCw, Download, Upload, FileDown, FileText, Image, ArrowRight, CalendarDays, ChevronDown } from "lucide-react";
import { Insight, File as FileSchema, Conversation, Expert } from "@shared/schema";
import { addDays, format } from "date-fns";

type CalendarPreview = {
  eventCount: number;
  startDate: string;
  year: number;
  timeZone: string;
  scheduleVersion: string;
};

function nextMondayDate(): string {
  const today = new Date();
  return format(addDays(today, ((8 - today.getDay()) % 7) || 7), "yyyy-MM-dd");
}

function readCalendarStart(conversationId: number | null): string | null {
  if (!conversationId) return null;
  try {
    const value = localStorage.getItem(`farmFriendCalendarStart:${conversationId}`);
    return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
  } catch {
    return null;
  }
}

interface SidebarPanelProps {
  conversations: Conversation[];
  insights: Insight[];
  files: FileSchema[];
  onStartNewSession: () => void;
  onExportMarkdown: () => void;
  onExportIcs: (start: string) => void;
  canExportIcs?: boolean;
  onFileUpload: (file: File) => void;
  onSelectConversation: (id: number) => void;
  activeConversationId: number | null;
  onRefreshInsights: () => void;
  isLoadingInsights: boolean;
  isLoadingConversations?: boolean;
  conversationsError?: boolean;
  isLoadingInsightsData?: boolean;
  insightsError?: boolean;
  isLoadingFiles?: boolean;
  filesError?: boolean;
  isStartingNewSession?: boolean;
  isUploading?: boolean;
  experts?: Expert[];
}

export default function SidebarPanel({
  conversations,
  insights,
  files,
  onStartNewSession,
  onExportMarkdown,
  onExportIcs,
  canExportIcs = true,
  onFileUpload,
  onSelectConversation,
  activeConversationId,
  onRefreshInsights,
  isLoadingInsights,
  isLoadingConversations = false,
  conversationsError = false,
  isLoadingInsightsData = false,
  insightsError = false,
  isLoadingFiles = false,
  filesError = false,
  isStartingNewSession = false,
  isUploading = false,
  experts = []
}: SidebarPanelProps) {
  const [activeTab, setActiveTab] = useState<'conversations' | 'insights' | 'files'>('insights');
  const [calendarStart, setCalendarStart] = useState(() => readCalendarStart(activeConversationId) ?? nextMondayDate());
  const [calendarPreview, setCalendarPreview] = useState<CalendarPreview | null>(null);
  const [isLoadingCalendarPreview, setIsLoadingCalendarPreview] = useState(false);
  const [calendarPreviewError, setCalendarPreviewError] = useState<"empty" | "unavailable" | null>(null);
  const [isCalendarSectionOpen, setIsCalendarSectionOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setCalendarStart(readCalendarStart(activeConversationId) ?? nextMondayDate());
    setCalendarPreview(null);
    setIsLoadingCalendarPreview(false);
    setCalendarPreviewError(null);
    setIsCalendarSectionOpen(false);
  }, [activeConversationId, canExportIcs]);

  useEffect(() => {
    if (calendarPreview?.eventCount) setIsCalendarSectionOpen(true);
  }, [calendarPreview?.eventCount]);

  useEffect(() => {
    if (!activeConversationId || !canExportIcs || !calendarStart) {
      setCalendarPreview(null);
      setIsLoadingCalendarPreview(false);
      setCalendarPreviewError(null);
      return;
    }

    let cancelled = false;
    const timer = window.setTimeout(async () => {
      setIsLoadingCalendarPreview(true);
      setCalendarPreviewError(null);
      try {
        const response = await fetch(
          `/api/protected/conversations/${activeConversationId}/export.ics?preview=1&start=${encodeURIComponent(calendarStart)}`,
          { credentials: "include" },
        );
        if (!response.ok) {
          const result = await response.json().catch(() => ({})) as { error?: string };
          if (response.status === 422 && result.error?.includes("No schedulable items")) {
            if (!cancelled) {
              setCalendarPreview(null);
              setCalendarPreviewError("empty");
            }
            return;
          }
          throw new Error("Schedule preview unavailable");
        }
        const preview = await response.json() as CalendarPreview;
        if (!cancelled) {
          setCalendarPreview(preview);
          setCalendarPreviewError(null);
        }
      } catch {
        if (!cancelled) {
          setCalendarPreview(null);
          setCalendarPreviewError("unavailable");
        }
      } finally {
        if (!cancelled) setIsLoadingCalendarPreview(false);
      }
    }, 150);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [activeConversationId, canExportIcs, calendarStart, files]);

  const handleFileUploadClick = () => {
    fileInputRef.current?.click();
  };
  
  // Handle file upload
  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      onFileUpload(e.target.files[0]);
      // Clear the input value so the same file can be uploaded again if needed
      e.target.value = '';
    }
  };
  
  return (
    <aside className="w-full min-w-0 h-full min-h-0 overflow-hidden bg-white bg-gradient-to-b from-farm-powder/5 to-white border-r border-farm-tan/30 flex flex-col z-10 shadow-lg">
      <div className="flex flex-col h-full min-h-0">
        {/* Session Controls */}
        <div className="shrink-0 p-4 border-b border-farm-tan/30 [@media(max-height:500px)]:max-h-[45vh] [@media(max-height:500px)]:overflow-y-auto">
          <h2 className="font-serif font-bold text-lg mb-3 text-farm-blue">Current Session</h2>
          <Button
            className="w-full bg-gradient-to-r from-farm-green to-farm-dark-green hover:from-farm-dark-green hover:to-farm-green text-white rounded-lg px-4 py-2.5 flex items-center justify-center mb-2 shadow-md hover:shadow-lg transition-all duration-200 font-semibold"
            onClick={onStartNewSession}
            disabled={isStartingNewSession}
          >
            <Plus className="mr-2 h-4 w-4" />
            {isStartingNewSession ? "Creating…" : "New Roundtable"}
          </Button>
          <Button
            variant="outline"
            className="w-full border-2 border-farm-blue text-farm-blue hover:bg-farm-blue hover:text-white rounded-lg px-4 py-2.5 flex items-center justify-center transition-all duration-200 font-medium"
            onClick={onExportMarkdown}
          >
            <Download className="mr-2 h-4 w-4" />
            Export as Markdown
          </Button>
          <button
            type="button"
            aria-expanded={isCalendarSectionOpen}
            aria-controls="calendar-plan-controls"
            className="mt-3 flex w-full items-center justify-between rounded-md py-1 text-left text-sm font-semibold text-farm-blue hover:text-farm-green focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-farm-blue"
            onClick={() => setIsCalendarSectionOpen((open) => !open)}
          >
            <span className="flex items-center gap-2"><CalendarDays className="h-4 w-4" />Calendar plan</span>
            <ChevronDown className={`h-4 w-4 transition-transform ${isCalendarSectionOpen ? "rotate-180" : ""}`} />
          </button>
          <div id="calendar-plan-controls" hidden={!isCalendarSectionOpen}>
            <label className="block mt-2 text-sm text-farm-blue">
              Week 1 starts
              <input
                type="date"
                value={calendarStart}
                onChange={(event) => {
                  const value = event.target.value;
                  setCalendarStart(value);
                  setCalendarPreview(null);
                  setCalendarPreviewError(null);
                  if (activeConversationId) {
                    try {
                      localStorage.setItem(`farmFriendCalendarStart:${activeConversationId}`, value);
                    } catch {
                      // The selected anchor remains active for this session.
                    }
                  }
                }}
                className="block w-full mt-1 rounded border border-farm-tan/60 px-2 py-1 text-neutral-900"
              />
            </label>
            <p className="mt-1 text-xs text-neutral-600" aria-live="polite">
              {isLoadingCalendarPreview
                ? "Checking the current plan…"
                : calendarPreview
                  ? `${calendarPreview.scheduleVersion} · ${calendarPreview.eventCount} all-day events · starts ${calendarPreview.startDate} (${calendarPreview.year}) · ${calendarPreview.timeZone}`
                  : calendarPreviewError === "unavailable"
                    ? "Calendar preview is unavailable. Try again when the connection is restored."
                    : calendarPreviewError === "empty" || !canExportIcs || !activeConversationId
                      ? "No dated plan yet. Ask the council to create a week-by-week plan before exporting."
                      : "Checking the current plan…"}
            </p>
            <Button
              variant="outline"
              className="w-full mt-2 border-2 border-farm-green text-farm-green hover:bg-farm-green hover:text-white rounded-lg px-4 py-2.5 flex items-center justify-center transition-all duration-200 font-medium"
              onClick={() => onExportIcs(calendarStart)}
              disabled={!calendarPreview || !calendarStart || isLoadingCalendarPreview}
              title={calendarPreview ? "Export the week-by-week plan to your calendar (.ics)" : "Create a dated plan with the council before exporting"}
            >
              <CalendarDays className="mr-2 h-4 w-4" />
              Export .ics
            </Button>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex shrink-0 border-b border-farm-tan/30 bg-white">
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'conversations'}
            className={`flex-1 py-3 text-center font-semibold text-sm transition-all duration-200 ${activeTab === 'conversations' ? 'text-farm-blue border-b-2 border-farm-blue bg-farm-powder/10' : 'text-neutral-600 hover:text-farm-blue hover:bg-farm-powder/5'}`}
            onClick={() => setActiveTab('conversations')}
          >
            Conversations
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'insights'}
            className={`flex-1 py-3 text-center font-semibold text-sm transition-all duration-200 ${activeTab === 'insights' ? 'text-farm-blue border-b-2 border-farm-blue bg-farm-powder/10' : 'text-neutral-600 hover:text-farm-blue hover:bg-farm-powder/5'}`}
            onClick={() => setActiveTab('insights')}
          >
            Insights
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'files'}
            className={`flex-1 py-3 text-center font-semibold text-sm transition-all duration-200 ${activeTab === 'files' ? 'text-farm-blue border-b-2 border-farm-blue bg-farm-powder/10' : 'text-neutral-600 hover:text-farm-blue hover:bg-farm-powder/5'}`}
            onClick={() => setActiveTab('files')}
          >
            Files
          </button>
        </div>
        
        {/* Tab Content */}
        <ScrollArea className="flex-1 min-h-0 p-4">
          {activeTab === 'conversations' && (
            <div>
              <div className="flex justify-between items-center mb-4">
                <h2 className="font-serif font-bold text-lg text-farm-blue">Your Conversations</h2>
              </div>

              {isLoadingConversations ? (
                <p className="py-8 text-center text-sm text-neutral-500">Loading conversations…</p>
              ) : conversationsError ? (
                <p role="alert" className="py-8 text-center text-sm text-red-600">Couldn’t load conversations. Please refresh the page.</p>
              ) : conversations.length === 0 ? (
                <div className="text-center py-8 text-neutral-500 space-y-4">
                  <div className="bg-farm-powder/20 rounded-xl p-6 border border-farm-tan/30">
                    <div className="text-4xl mb-3">📋</div>
                    <p className="font-semibold text-farm-blue">No conversations yet</p>
                    <p className="text-sm mt-2 text-neutral-600">Click "New Roundtable" above to start your first conversation</p>
                  </div>
                  <div className="bg-farm-green/10 rounded-xl p-4 border border-farm-green/30">
                    <p className="text-xs text-farm-dark-green leading-relaxed">💡 Tip: Each roundtable brings together multiple experts to discuss your agricultural topics.</p>
                  </div>
                </div>
              ) : (
                <div className="space-y-2">
                  {conversations.map(conversation => (
                    <button
                      key={conversation.id}
                      type="button"
                      className={`w-full text-left p-3 rounded-lg cursor-pointer transition-all duration-200 ${activeConversationId === conversation.id ? 'bg-farm-powder/30 border-2 border-farm-blue shadow-md' : 'bg-white border border-farm-tan/30 hover:bg-farm-powder/10 hover:border-farm-blue/30'}`}
                      onClick={() => onSelectConversation(conversation.id)}
                    >
                      <h3 className="font-semibold text-farm-blue">{conversation.title}</h3>
                      <p className="text-xs text-neutral-600 mt-1">
                        {conversation.createdAt ? format(new Date(conversation.createdAt), 'MMM d, yyyy • h:mm a') : 'Unknown date'}
                      </p>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          
          {activeTab === 'insights' && (
            <div>
              <div className="flex justify-between items-center mb-4">
                <h2 className="font-serif font-bold text-lg text-farm-blue">Key Insights</h2>
                <Button
                  variant="ghost"
                  size="icon"
                  className="text-farm-blue hover:text-farm-green hover:bg-farm-powder/30 cursor-pointer h-8 w-8 transition-all duration-200"
                  title="Refresh insights"
                  onClick={onRefreshInsights}
                  disabled={isLoadingInsights || isLoadingInsightsData}
                  aria-label="Refresh insights"
                >
                  <RefreshCw className={`h-4 w-4 ${isLoadingInsights ? 'animate-spin' : ''}`} />
                </Button>
              </div>

              {isLoadingInsightsData ? (
                <p className="py-8 text-center text-sm text-neutral-500">Loading insights…</p>
              ) : insightsError ? (
                <p role="alert" className="py-8 text-center text-sm text-red-600">Couldn’t load insights. Please try refreshing.</p>
              ) : insights.length === 0 ? (
                <div className="text-center py-8 text-neutral-500 space-y-4">
                  <div className="bg-farm-powder/20 rounded-xl p-6 border border-farm-tan/30">
                    <div className="text-4xl mb-3">💡</div>
                    <p className="font-semibold text-farm-blue">No insights generated yet</p>
                    <p className="text-sm mt-2 text-neutral-600">Keep chatting with your experts to unlock valuable insights</p>
                  </div>
                  <div className="bg-farm-green/10 rounded-xl p-4 border border-farm-green/30">
                    <p className="text-xs text-farm-dark-green leading-relaxed">🌱 Insights automatically generate as conversations grow and patterns emerge.</p>
                  </div>
                </div>
              ) : (
                <div className="space-y-3">
                  {insights.map(insight => (
                    <div key={insight.id} className="bg-gradient-to-br from-farm-powder/20 to-white rounded-xl p-4 border border-farm-tan/30 shadow-sm hover:shadow-md transition-shadow">
                      <h3 className="font-semibold text-farm-blue mb-2">{insight.title}</h3>
                      <ul className="text-sm">
                        {insight.points && insight.points.map((point, index) => (
                          <li key={index} className="flex items-start mb-2">
                            <ArrowRight className="text-farm-green h-4 w-4 mr-2 mt-0.5 flex-shrink-0" />
                            <span className="text-neutral-700 leading-relaxed">{point}</span>
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
              <div className="flex justify-between items-center mb-4">
                <h2 className="font-serif font-bold text-lg text-farm-blue">Attachments</h2>
                <div>
                  <input
                    type="file"
                    ref={fileInputRef}
                    className="hidden"
                    onChange={handleFileInputChange}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="text-farm-blue hover:text-farm-green hover:bg-farm-powder/30 cursor-pointer h-8 w-8 transition-all duration-200"
                    title="Upload File"
                    onClick={handleFileUploadClick}
                    disabled={isUploading || !activeConversationId}
                    aria-label={isUploading ? "Uploading file" : "Upload file"}
                  >
                    <Upload className="h-4 w-4" />
                  </Button>
                </div>
              </div>

              {isLoadingFiles ? (
                <p className="py-8 text-center text-sm text-neutral-500">Loading files…</p>
              ) : filesError ? (
                <p role="alert" className="py-8 text-center text-sm text-red-600">Couldn’t load files. Please try again.</p>
              ) : files.length === 0 ? (
                <div className="text-center py-8 text-neutral-500 space-y-4">
                  <div className="bg-farm-powder/20 rounded-xl p-6 border border-farm-tan/30">
                    <div className="text-4xl mb-3">📁</div>
                    <p className="font-semibold text-farm-blue">No files uploaded yet</p>
                    <p className="text-sm mt-2 text-neutral-600">Click the upload button to add documents or images</p>
                  </div>
                  <div className="bg-farm-yellow/20 rounded-xl p-4 border border-farm-yellow/40">
                    <p className="text-xs text-neutral-700 leading-relaxed">📄 Share files with experts to get tailored advice based on your specific documents.</p>
                  </div>
                </div>
              ) : (
                <div className="space-y-2">
                  {files.map(file => (
                    <div key={file.id} className="flex justify-between items-center p-3 hover:bg-farm-powder/20 rounded-lg border border-farm-tan/30 bg-white transition-all duration-200">
                      <div className="flex items-center gap-2">
                        {file.fileType.includes('image') ? (
                          <Image className="text-farm-blue h-5 w-5" />
                        ) : (
                          <FileText className="text-farm-blue h-5 w-5" />
                        )}
                        <div className="min-w-0">
                          <span className="block text-sm truncate max-w-[160px] font-medium text-neutral-700">{file.filename}</span>
                          {file.deliverableId && file.version != null && (
                            <span className="block text-xs text-neutral-500">
                              v{file.version} · {file.supersededAt ? "Superseded" : "Current"} · {formatLocalDateTime(file.uploadedAt ?? Date.now())}
                            </span>
                          )}
                        </div>
                      </div>
                      <a
                        href={file.fileUrl}
                        download
                        className="text-farm-blue hover:text-farm-green transition-colors"
                        title="Download File"
                        aria-label={`Download ${file.filename}`}
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
        <div className="shrink-0 p-4 text-xs text-neutral-600 mt-auto border-t border-farm-tan/30 bg-gradient-to-br from-farm-powder/10 to-farm-tan/10 [@media(max-height:500px)]:hidden">
          <p className="font-semibold text-farm-blue">Farm Friend Roundtable v1.0.0</p>
          <p className="mt-1">© 2026 Farm Friend Technologies</p>
        </div>
      </div>
    </aside>
  );
}

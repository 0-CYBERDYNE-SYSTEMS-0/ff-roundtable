import { formatLocalDateTime } from "@/lib/format-local-time";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Plus, Download, Upload, FileDown, FileText, Image, CalendarDays, ChevronDown, ChevronLeft, Check, ClipboardList, FolderOpen, Lightbulb, Pencil, Search, Trash2, X } from "lucide-react";
import { File as FileSchema, Conversation } from "@shared/schema";
import { addDays, format } from "date-fns";
import CalendarPreviewDialog from "./CalendarPreviewDialog";
import type { CalendarDraft } from "@shared/calendar-draft";

type CalendarPreview = {
  eventCount: number;
  startDate: string;
  year: number;
  timeZone: string;
  scheduleVersion: string;
};


function readCalendarStart(conversationId: number | null): string | null {
  if (!conversationId) return null;
  try {
    const value = localStorage.getItem(`farmFriendCalendarStart:${conversationId}`);
    return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
  } catch {
    return null;
  }
}

// The conversations list API adds a computed updatedAt (latest message time).
export type ConversationSummary = Conversation & { updatedAt?: Date | string | null };

interface SidebarPanelProps {
  conversations: ConversationSummary[];
  files: FileSchema[];
  onStartNewSession: () => void;
  onExportMarkdown: () => void;
  onCollapse?: () => void;
  canExportIcs?: boolean;
  onFileUpload: (file: File) => void;
  onSelectConversation: (id: number) => void;
  onRenameConversation: (id: number, title: string) => void;
  onDeleteConversation: (id: number) => void;
  activeConversationId: number | null;
  isLoadingConversations?: boolean;
  conversationsError?: boolean;
  isLoadingFiles?: boolean;
  filesError?: boolean;
  isStartingNewSession?: boolean;
  isUploading?: boolean;
}

export default function SidebarPanel({
  conversations,
  files,
  onStartNewSession,
  onExportMarkdown,
  onCollapse,
  canExportIcs = true,
  onFileUpload,
  onSelectConversation,
  onRenameConversation,
  onDeleteConversation,
  activeConversationId,
  isLoadingConversations = false,
  conversationsError = false,
  isLoadingFiles = false,
  filesError = false,
  isStartingNewSession = false,
  isUploading = false,
}: SidebarPanelProps) {
  const [conversationSearch, setConversationSearch] = useState("");
  const [editingConversationId, setEditingConversationId] = useState<number | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<ConversationSummary | null>(null);
  const [calendarStart, setCalendarStart] = useState(() => readCalendarStart(activeConversationId) ?? '');
  const [calendarPreview, setCalendarPreview] = useState<CalendarPreview | null>(null);
  const [isLoadingCalendarPreview, setIsLoadingCalendarPreview] = useState(false);
  const [calendarPreviewError, setCalendarPreviewError] = useState<"empty" | "unavailable" | null>(null);
  const [isCalendarSectionOpen, setIsCalendarSectionOpen] = useState(false);
  const [openCalendar, setOpenCalendar] = useState<{ fileId?: number } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setCalendarStart(readCalendarStart(activeConversationId) ?? '');
    setCalendarPreview(null);
    setIsLoadingCalendarPreview(false);
    setCalendarPreviewError(null);
    setIsCalendarSectionOpen(false);
    setOpenCalendar(null);
  }, [activeConversationId]);

  useEffect(() => {
    if (calendarPreview?.eventCount) setIsCalendarSectionOpen(true);
  }, [calendarPreview?.eventCount]);

  useEffect(() => {
    if (!canExportIcs) setIsCalendarSectionOpen(false);
  }, [canExportIcs]);

  useEffect(() => {
    // Empty start = auto: the plan's stated anchor (next occurrence) or today, resolved server-side.
    if (!activeConversationId) {
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
          `/api/protected/conversations/${activeConversationId}/calendar?start=${encodeURIComponent(calendarStart)}`,
          { credentials: "include" },
        );
        if (!response.ok) {
          const result = await response.json().catch(() => ({})) as { message?: string; error?: string };
          if (response.status === 422 && (result.message ?? result.error)?.includes("No schedulable items")) {
            if (!cancelled) {
              setCalendarPreview(null);
              setCalendarPreviewError("empty");
            }
            return;
          }
          throw new Error("Schedule preview unavailable");
        }
        const draft = await response.json() as CalendarDraft & { empty?: boolean };
        if (draft.empty || draft.events.length === 0) {
          if (!cancelled) {
            setCalendarPreview(null);
            setCalendarPreviewError("empty");
          }
          return;
        }
        const startDate = draft.events.map(event => event.startDate).sort()[0];
        const preview: CalendarPreview = {
          eventCount: draft.events.length, startDate, year: Number(startDate.slice(0, 4)),
          timeZone: "All-day dates (timezone-neutral)", scheduleVersion: draft.version ? `Calendar v${draft.version}` : "Current conversation schedule",
        };
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

  // The search input only renders at 10+ conversations, so only filter then.
  const displayedConversations = conversations.length >= 10
    ? conversations.filter((conversation) =>
        (conversation.title ?? "").toLowerCase().includes(conversationSearch.trim().toLowerCase())
      )
    : conversations;
  
  return (
    <aside className="w-full min-w-0 h-full min-h-0 overflow-hidden bg-card bg-gradient-to-b from-farm-powder/5 to-card border-r border-farm-tan/30 flex flex-col z-10 shadow-lg">
      <div className="flex flex-col h-full min-h-0">
        {/* Session Controls */}
        <div className="shrink-0 p-4 border-b border-farm-tan/30 [@media(max-height:500px)]:max-h-[45vh] [@media(max-height:500px)]:overflow-y-auto">
          <div className="mb-3 flex items-center justify-between gap-2">
            <h2 className="font-serif font-bold text-lg text-farm-blue">Current Session</h2>
            {onCollapse && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-8 w-8 shrink-0"
                aria-label="Collapse left sidebar"
                aria-controls="left-sidebar-drawer"
                aria-expanded={true}
                title="Collapse left sidebar"
                onClick={onCollapse}
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
            )}
          </div>
          <Button
            className="w-full bg-farm-dark-green hover:bg-farm-blue text-white rounded-lg px-4 py-2.5 flex items-center justify-center mb-2 shadow-md hover:shadow-lg transition-all duration-200 font-semibold"
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
            className="mt-3 flex w-full items-center justify-between rounded-md py-1 text-left text-sm font-semibold text-farm-blue hover:text-farm-dark-green focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-farm-blue"
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
              className="w-full mt-2 border-2 border-farm-dark-green text-farm-dark-green hover:bg-farm-dark-green hover:text-white rounded-lg px-4 py-2.5 flex items-center justify-center transition-all duration-200 font-medium"
              onClick={() => setOpenCalendar({})}
              disabled={!activeConversationId || !calendarStart}
              title="Review and edit your calendar before exporting (.ics)"
            >
              <CalendarDays className="mr-2 h-4 w-4" />
              Preview calendar
            </Button>
          </div>
        </div>

        <Tabs defaultValue="conversations" className="flex min-h-0 flex-1 flex-col">
          <TabsList className="h-auto w-full shrink-0 rounded-none border-b border-farm-tan/30 bg-card p-0">
            <TabsTrigger value="conversations" className="flex-1 rounded-none py-3 font-semibold text-sm">Conversations</TabsTrigger>
            <TabsTrigger value="files" className="flex-1 rounded-none py-3 font-semibold text-sm">Files</TabsTrigger>
          </TabsList>

          <ScrollArea className="flex-1 min-h-0 p-4">
            <TabsContent value="conversations" className="m-0 focus-visible:ring-0">
              <div>
                <div className="flex justify-between items-center mb-4">
                  <h2 className="font-serif font-bold text-lg text-farm-blue">Your Conversations</h2>
                </div>

                {conversations.length >= 10 && (
                  <label className="relative mb-3 block">
                    <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-500" aria-hidden="true" />
                    <Input
                      type="search"
                      value={conversationSearch}
                      onChange={(event) => setConversationSearch(event.target.value)}
                      placeholder="Search conversations"
                      aria-label="Search conversations"
                      className="pl-9"
                    />
                  </label>
                )}

                {isLoadingConversations ? (
                  <p className="py-8 text-center text-sm text-neutral-500">Loading conversations…</p>
                ) : conversationsError ? (
                  <p role="alert" className="py-8 text-center text-sm text-red-600">Couldn’t load conversations. Please refresh the page.</p>
                ) : conversations.length === 0 ? (
                  <div className="text-center py-8 text-neutral-500 space-y-4">
                    <div className="bg-farm-powder/20 rounded-xl p-6 border border-farm-tan/30">
                      <ClipboardList className="mx-auto mb-3 h-8 w-8 text-farm-dark-green" aria-hidden="true" />
                      <p className="font-semibold text-farm-blue">No conversations yet</p>
                      <p className="text-sm mt-2 text-neutral-600">Click "New Roundtable" above to start your first conversation</p>
                    </div>
                    <div className="bg-farm-green/10 rounded-xl p-4 border border-farm-green/30">
                      <p className="flex items-start gap-2 text-xs text-farm-dark-green leading-relaxed"><Lightbulb className="h-4 w-4 shrink-0" aria-hidden="true" />Tip: Each roundtable brings together multiple experts to discuss your agricultural topics.</p>
                    </div>
                  </div>
                ) : displayedConversations.length === 0 ? (
                  <p className="py-8 text-center text-sm text-neutral-600">No conversations match that search.</p>
                ) : (
                  <div className="space-y-2">
                    {displayedConversations.map((conversation) => {
                      const lastActivity = conversation.updatedAt ?? conversation.createdAt;
                      const title = conversation.title || "Untitled conversation";
                      const rowClass = `flex items-center gap-1 rounded-lg border p-1 ${activeConversationId === conversation.id ? "border-farm-blue bg-farm-powder/30" : "border-border bg-card hover:bg-farm-powder/10"}`;

                      return (
                        <div key={conversation.id} className={rowClass}>
                          {editingConversationId === conversation.id ? (
                            <form
                              className="flex min-w-0 flex-1 items-center gap-1"
                              onSubmit={(event) => {
                                event.preventDefault();
                                const nextTitle = editingTitle.trim();
                                if (!nextTitle) return;
                                onRenameConversation(conversation.id, nextTitle);
                                setEditingConversationId(null);
                              }}
                            >
                              <Input
                                autoFocus
                                value={editingTitle}
                                onChange={(event) => setEditingTitle(event.target.value)}
                                aria-label="Conversation title"
                                className="h-9 min-w-0"
                              />
                              <Button type="submit" variant="ghost" size="icon" aria-label="Save conversation title" disabled={!editingTitle.trim()}>
                                <Check className="h-4 w-4" />
                              </Button>
                              <Button type="button" variant="ghost" size="icon" aria-label="Cancel rename" onClick={() => setEditingConversationId(null)}>
                                <X className="h-4 w-4" />
                              </Button>
                            </form>
                          ) : (
                            <>
                              <button
                                type="button"
                                className="min-w-0 flex-1 p-2 text-left"
                                onClick={() => onSelectConversation(conversation.id)}
                              >
                                <h3 className="truncate font-semibold text-farm-blue">{title}</h3>
                                <p className="mt-1 text-xs text-neutral-600">
                                  {lastActivity ? format(new Date(lastActivity), "MMM d, yyyy • h:mm a") : "Unknown date"}
                                </p>
                              </button>
                              <div className="flex shrink-0 items-center">
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon"
                                  aria-label={`Rename ${title}`}
                                  title="Rename conversation"
                                  onClick={() => {
                                    setEditingConversationId(conversation.id);
                                    setEditingTitle(conversation.title ?? "");
                                  }}
                                >
                                  <Pencil className="h-4 w-4" />
                                </Button>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon"
                                  aria-label={`Delete ${title}`}
                                  title="Delete conversation"
                                  onClick={() => setDeleteTarget(conversation)}
                                >
                                  <Trash2 className="h-4 w-4" />
                                </Button>
                              </div>
                            </>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </TabsContent>

            <TabsContent value="files" className="m-0 focus-visible:ring-0">
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
                      className="text-farm-blue hover:text-farm-dark-green hover:bg-farm-powder/30 cursor-pointer h-8 w-8 transition-all duration-200"
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
                      <FolderOpen className="mx-auto mb-3 h-8 w-8 text-farm-dark-green" aria-hidden="true" />
                      <p className="font-semibold text-farm-blue">No files uploaded yet</p>
                      <p className="text-sm mt-2 text-neutral-600">Click the upload button to add documents or images</p>
                    </div>
                    <div className="bg-farm-yellow/20 rounded-xl p-4 border border-farm-yellow/40">
                      <p className="flex items-start gap-2 text-xs text-neutral-700 leading-relaxed"><FileText className="h-4 w-4 shrink-0" aria-hidden="true" />Share files with experts to get tailored advice based on your specific documents.</p>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {files.map((file) => (
                      <div key={file.id} className="flex justify-between items-center p-3 hover:bg-farm-powder/20 rounded-lg border border-farm-tan/30 bg-card transition-all duration-200">
                        <div className="flex items-center gap-2">
                          {file.fileType.includes("image") ? (
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
                        {file.filename.toLowerCase().endsWith(".ics") && <Button size="sm" variant="ghost" onClick={() => setOpenCalendar({ fileId: file.id })}>Preview</Button>}
                        <a
                          href={file.fileUrl}
                          download
                          className="text-farm-blue hover:text-farm-dark-green transition-colors"
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
            </TabsContent>
          </ScrollArea>
        </Tabs>
      </div>
      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this conversation?</AlertDialogTitle>
            <AlertDialogDescription>
              “{deleteTarget?.title || "Untitled conversation"}” and its saved content will be deleted.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                if (deleteTarget) onDeleteConversation(deleteTarget.id);
                setDeleteTarget(null);
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {openCalendar && activeConversationId && <CalendarPreviewDialog key={`${activeConversationId}:${openCalendar.fileId ?? "plan"}`} conversationId={activeConversationId} start={calendarStart} fileId={openCalendar.fileId} onClose={() => setOpenCalendar(null)} />}
    </aside>
  );
}

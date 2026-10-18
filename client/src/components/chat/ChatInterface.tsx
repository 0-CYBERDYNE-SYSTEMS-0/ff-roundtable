import { useState, useRef, useEffect, useMemo } from "react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { AtSign, Bot, Paperclip, Send, Loader2, Users, ScrollText, ChevronLeft, ChevronDown, ChevronUp, X } from "lucide-react";
import { Message, Expert, User, OpenQuestion } from "@shared/schema";
import { format } from "date-fns";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { formatMessageDate } from "@/lib/file-utils";
import ModelBadge from "../roundtable/ModelBadge";
import ConversationSidebar from "../roundtable/ConversationSidebar";
import ArtifactDisplay from "../artifacts/ArtifactDisplay";
import ExpertSettingsModal from "../expert/ExpertSettingsModal";
import UserMessageContent from "./UserMessageContent";
import { useIsMobile } from "@/hooks/use-mobile";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { resolveExpertAvatar } from "@/lib/expert-avatar";

interface ChatInterfaceProps {
  messages: Message[];
  experts: Expert[];
  onSendMessage: (content: string, answersQuestionId?: number) => void;
  openQuestions: OpenQuestion[];
  onUploadFile: (file: File) => void;
  isLoading: boolean;
  isUploading?: boolean;
  isLoadingMessages?: boolean;
  messagesError?: boolean;
  user: User | null;
  insights: any[];
  streamingMessages?: Map<number | null, { content: string; expertName: string; expertRole: string }>;
  typingExpertIds?: Set<number | null>;
  onManageExperts: () => void;
  onRemoveExpert: (expertId: number) => void;
  onRefreshInsights: () => void;
  isRefreshingInsights: boolean;
  // G9: expert announced as the next turn — shown in the strip until their
  // stream starts. Distinct from the mention ring and typing indicator.
  upNextExpertId?: number | null;
}

// === G4 mention helpers (UI only — parsing/storage stays on the server) ===

// Case/whitespace-insensitive role comparison, matching shared/mentions.ts.
const normalizeRoleText = (role: string) => role.replace(/\s+/g, " ").trim().toLowerCase();

// Chip/pill palette mirroring getExpertBubbleColor's 8 slots (keyed by
// expertId % 8), but with solid light backgrounds so tags stay readable on
// both pastel expert bubbles and the dark user bubble gradient.
const getMentionColorClasses = (expertId: number) => {
  const colors = [
    "bg-farm-powder text-farm-blue border-farm-blue/30",
    "bg-emerald-100 text-emerald-800 border-emerald-300/60",
    "bg-purple-100 text-purple-800 border-purple-300/60",
    "bg-pink-100 text-pink-800 border-pink-300/60",
    "bg-yellow-100 text-yellow-900 border-yellow-400/60",
    "bg-cyan-100 text-cyan-800 border-cyan-300/60",
    "bg-orange-100 text-orange-800 border-orange-300/60",
    "bg-farm-tan text-yellow-900 border-yellow-700/30",
  ];
  return colors[expertId % colors.length];
};

// Ring palette for expert mentions in the strip, keyed by the same slots.
const getExpertRingColor = (expertId: number) => {
  const rings = [
    "ring-farm-powder",
    "ring-farm-green",
    "ring-purple-400",
    "ring-pink-400",
    "ring-farm-yellow",
    "ring-cyan-400",
    "ring-orange-400",
    "ring-farm-tan",
  ];
  return rings[expertId % rings.length];
};

const NEUTRAL_MENTION_CLASSES = "bg-neutral-100 text-neutral-600 border-neutral-300";
const STANCE_CHIP_CLASSES = {
  agree: "bg-emerald-100 text-emerald-800 border-emerald-300/60",
  disagree: "bg-rose-100 text-rose-800 border-rose-300/60",
  conditional: "bg-amber-100 text-amber-900 border-amber-300/60",
  abstain: "bg-neutral-100 text-neutral-700 border-neutral-300",
} as const;

const findExpertByRole = (experts: Expert[], role: string) =>
  experts.find((expert) => normalizeRoleText(expert.role) === normalizeRoleText(role));

// Row of small role-colored chips shown under a message bubble header when the
// server-parsed mentions list is non-empty. Neutral fallback for roles that no
// longer match a conversation expert.
function MentionChips({
  mentions,
  experts,
  className = "",
}: {
  mentions: string[] | null | undefined;
  experts: Expert[];
  className?: string;
}) {
  if (!mentions || mentions.length === 0) return null;
  return (
    <div className={`flex flex-wrap items-center gap-1.5 ${className}`} data-testid={`mention-chips-${mentions.join("-")}`}>
      {mentions.map((role) => {
        const expert = findExpertByRole(experts, role);
        const colorClasses = expert ? getMentionColorClasses(expert.id) : NEUTRAL_MENTION_CLASSES;
        return (
          <span
            key={role}
            className={`inline-flex items-center gap-0.5 rounded-full border px-2 py-0.5 text-xs font-medium leading-none ${colorClasses}`}
          >
            @{role}
          </span>
        );
      })}
    </div>
  );
}

function extractMarkdownText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractMarkdownText).join("");
  if (typeof node === "object" && "props" in node) {
    const element = node as { props?: { children?: ReactNode } };
    return extractMarkdownText(element.props?.children);
  }
  return "";
}

type MentionAwareCodeProps = React.ComponentPropsWithoutRef<"code"> & {
  node?: unknown;
  experts: Expert[];
};

// Markdown `code` override: render-time preprocessing wraps every canonical
// @[Role] tag in a code span (so it survives markdown structure), and this
// override turns those spans back into inline pills. Any other code node —
// including code the experts wrote themselves — falls through unchanged.
function MentionAwareCode({ children, className, node: _node, experts }: MentionAwareCodeProps) {
  const match = /^@\[([^\]]+)\]$/.exec(extractMarkdownText(children).trim());
  if (match) {
    const expert = findExpertByRole(experts, match[1]);
    const colorClasses = expert ? getMentionColorClasses(expert.id) : NEUTRAL_MENTION_CLASSES;
    return (
      <span
        className={`inline-flex items-center rounded-full border px-1.5 py-0.5 text-xs font-medium leading-none align-baseline ${colorClasses}`}
      >
        @{match[1]}
      </span>
    );
  }
  return <code className={className}>{children}</code>;
}

// Token typed after "@" for the composer autocomplete: starts at the "@",
// runs to the caret, terminated by whitespace or "]" (so an inserted
// "@[Role]" never re-opens the popover). Email-like "user@name" is ignored,
// matching the server parser.
const getMentionToken = (text: string, caret: number): { start: number; query: string } | null => {
  let i = caret;
  while (i > 0) {
    const ch = text[i - 1];
    if (ch === "@") {
      const prev = i >= 2 ? text[i - 2] : "";
      if (/[A-Za-z0-9_]/.test(prev)) return null;
      return { start: i - 1, query: text.slice(i, caret) };
    }
    if (/\s/.test(ch) || ch === "]") return null;
    i--;
  }
  return null;
};

export default function ChatInterface({
  messages,
  experts,
  onSendMessage,
  openQuestions,
  onUploadFile,
  isLoading,
  isUploading = false,
  isLoadingMessages = false,
  messagesError = false,
  user,
  insights,
  streamingMessages = new Map(),
  typingExpertIds = new Set(),
  upNextExpertId = null,
  onManageExperts,
  onRemoveExpert,
  onRefreshInsights,
  isRefreshingInsights,
}: ChatInterfaceProps) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [messageContent, setMessageContent] = useState("");
  const [expertsCollapsed, setExpertsCollapsed] = useState(() => {
    try {
      return window.localStorage.getItem("ffExpertStripCollapsed") === "1";
    } catch {
      return false;
    }
  });
  const [rightSidebarWidth, setRightSidebarWidth] = useState(() => {
    try {
      const savedWidth = Number(window.localStorage.getItem("ffRightSidebarWidth"));
      return Number.isFinite(savedWidth) && savedWidth >= 300 ? Math.min(savedWidth, 800) : 400;
    } catch {
      return 400;
    }
  });
  const [isRightSidebarCollapsed, setIsRightSidebarCollapsed] = useState(() => {
    try {
      return window.localStorage.getItem("ffRightSidebarCollapsed") === "1";
    } catch {
      return false;
    }
  });
  const [selectedExpert, setSelectedExpert] = useState<Expert | null>(null);
  const [isExpertModalOpen, setIsExpertModalOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const isNearBottomRef = useRef(true);
  const isMobile = useIsMobile();
  const [showMobileRightSidebar, setShowMobileRightSidebar] = useState(false);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const [mentionPulseActive, setMentionPulseActive] = useState(false);
  const [showOpenQuestions, setShowOpenQuestions] = useState(false);
  const [selectedQuestionId, setSelectedQuestionId] = useState<number | null>(null);
  const selectedQuestion = openQuestions.find(question => question.id === selectedQuestionId) ?? null;

  useEffect(() => {
    if (selectedQuestionId !== null && !openQuestions.some(question => question.id === selectedQuestionId)) {
      setSelectedQuestionId(null);
    }
  }, [openQuestions, selectedQuestionId]);

  // G4 composer @-autocomplete: the live "@token" before the caret, the query
  // text at the moment of an Escape dismissal, the highlighted match, and the
  // caret position at the time of the last edit.
  const [mentionToken, setMentionToken] = useState<{ start: number; query: string } | null>(null);
  const [dismissedTokenQuery, setDismissedTokenQuery] = useState<string | null>(null);
  const [mentionHighlight, setMentionHighlight] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const caretPosRef = useRef(0);
  const layoutRef = useRef<HTMLDivElement>(null);
  const [layoutWidth, setLayoutWidth] = useState(() =>
    typeof window === "undefined" ? 0 : window.innerWidth - (isMobile ? 0 : 288),
  );
  const isCompactLayout = isMobile || layoutWidth < 876;
  const minimumChatWidth = layoutWidth < 600 ? 256 : 560;
  const maximumRightSidebarWidth = isCompactLayout
    ? Math.max(300, Math.min(800, layoutWidth - 24))
    : Math.max(300, Math.min(800, layoutWidth - minimumChatWidth));
  const effectiveRightSidebarWidth = Math.min(rightSidebarWidth, maximumRightSidebarWidth);
  const isRightSidebarVisible = !isCompactLayout;

  useEffect(() => {
    const element = layoutRef.current;
    if (!element) return;

    const updateWidth = () => setLayoutWidth(element.clientWidth);
    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem("ffExpertStripCollapsed", expertsCollapsed ? "1" : "0");
    } catch {
      // Ignore unavailable storage.
    }
  }, [expertsCollapsed]);

  useEffect(() => {
    try {
      window.localStorage.setItem("ffRightSidebarWidth", String(rightSidebarWidth));
    } catch {
      // Ignore unavailable storage.
    }
  }, [rightSidebarWidth]);

  useEffect(() => {
    try {
      window.localStorage.setItem("ffRightSidebarCollapsed", isRightSidebarCollapsed ? "1" : "0");
    } catch {
      // Ignore unavailable storage.
    }
  }, [isRightSidebarCollapsed]);

  // Track whether the user is reading near the bottom so streaming tokens
  // don't yank the viewport down while they scroll back through history.
  useEffect(() => {
    const viewport = scrollAreaRef.current?.querySelector<HTMLElement>(
      "[data-radix-scroll-area-viewport]"
    );
    if (!viewport) return;
    const handleScroll = () => {
      isNearBottomRef.current =
        viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 120;
      setShowJumpToLatest(!isNearBottomRef.current);
    };
    handleScroll();
    viewport.addEventListener("scroll", handleScroll, { passive: true });
    return () => viewport.removeEventListener("scroll", handleScroll);
  }, []);

  useEffect(() => {
    // A fresh conversation load starts pinned to the latest message.
    if (isLoadingMessages) {
      isNearBottomRef.current = true;
    }
    if (isNearBottomRef.current) {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, [messages, streamingMessages, isLoading, isLoadingMessages]);
  // G4: the latest message's mentions drive the expert strip highlight.
  const latestMessage = messages.length > 0 ? messages[messages.length - 1] : null;
  const latestMentionedRoles = new Set(
    (latestMessage?.mentions ?? []).map((role) => normalizeRoleText(role))
  );
  useEffect(() => {
    if (!latestMessage?.mentions?.length) {
      setMentionPulseActive(false);
      return;
    }
    setMentionPulseActive(true);
    const timeout = window.setTimeout(() => setMentionPulseActive(false), 1200);
    return () => window.clearTimeout(timeout);
  }, [latestMessage?.id]);
  // Keep each speaker's latest persisted stance visible in the expert strip.
  // Legacy messages without a stance do not erase a prior one.
  const latestStanceByExpertId = useMemo(() => {
    const latest = new Map<number, NonNullable<Message["stance"]>>();
    for (const message of messages) {
      if (
        message.role === "assistant" &&
        message.expertId !== null &&
        !message.isSynthesis &&
        message.stance
      ) {
        latest.set(message.expertId, message.stance);
      }
    }
    return latest;
  }, [messages]);

  const stanceForExpert = (expert: Expert) => {
    if (["Moderator", "User", "Farmer"].includes(expert.role)) return null;
    return latestStanceByExpertId.get(expert.id) ?? null;
  };

  const renderStanceChip = (expert: Expert) => {
    const stance = stanceForExpert(expert);
    if (!stance) return null;
    const label = stance.stance.charAt(0).toUpperCase() + stance.stance.slice(1);
    return (
      <span
        className={`mt-1 inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-semibold leading-none ${STANCE_CHIP_CLASSES[stance.stance]}`}
        title={`${stance.position} (confidence ${stance.confidence} of 5)`}
        aria-label={`${label} stance, confidence ${stance.confidence} of 5`}
        data-testid={`expert-stance-${expert.id}`}
      >
        {label} · {stance.confidence}/5
      </span>
    );
  };

  const stanceTitle = (expert: Expert) => {
    const stance = stanceForExpert(expert);
    return stance ? `\nLatest stance: ${stance.stance} (${stance.confidence}/5)` : "";
  };
  const isExpertMentioned = (expert: Expert) =>
    latestMentionedRoles.has(normalizeRoleText(expert.role));

  // Autocomplete matches for the current "@token", case-insensitive prefix on
  // role or display name. Popover opens only while there is a live token that
  // was not just Escape-dismissed and at least one expert matches.
  const mentionQueryLower = mentionToken ? mentionToken.query.toLowerCase() : "";
  const mentionMatches = mentionToken
    ? experts.filter(
        (expert) =>
          expert.role.toLowerCase().startsWith(mentionQueryLower) ||
          expert.name.toLowerCase().startsWith(mentionQueryLower)
      )
    : [];
  const mentionOpen =
    mentionToken !== null &&
    mentionToken.query !== dismissedTokenQuery &&
    mentionMatches.length > 0;
  const activeMentionIndex =
    mentionMatches.length > 0 ? Math.min(mentionHighlight, mentionMatches.length - 1) : 0;

  // Recompute the live "@token" from the textarea value + caret. The token is
  // derived from the DOM at event time (not stored caret state) so arrows,
  // clicks, and edits all stay in sync.
  const updateMentionToken = (text: string, caret: number) => {
    caretPosRef.current = caret;
    const token = getMentionToken(text, caret);
    if (!token || !mentionToken || token.query !== mentionToken.query) {
      setMentionHighlight(0);
    }
    setMentionToken(token);
    // An Escape dismissal only stands until the typed query changes.
    if (!token || token.query !== dismissedTokenQuery) {
      setDismissedTokenQuery(null);
    }
  };

  // Insert the canonical bracketed form in place of the partial "@token",
  // then refocus and place the caret right after the insertion.
  const applyMentionSelection = (expert: Expert | undefined) => {
    if (!expert || !mentionToken) return;
    const insertion = `@[${expert.role}]`;
    const nextCaret = mentionToken.start + insertion.length + 1;
    setMessageContent(
      messageContent.slice(0, mentionToken.start) +
        insertion +
        " " +
        messageContent.slice(caretPosRef.current)
    );
    setMentionToken(null);
    setDismissedTokenQuery(null);
    const textarea = textareaRef.current;
    if (textarea) {
      requestAnimationFrame(() => {
        textarea.focus();
        textarea.setSelectionRange(nextCaret, nextCaret);
      });
    }
  };

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.max(60, Math.min(textarea.scrollHeight, 160))}px`;
  }, [messageContent]);

  // Handle message input change
  const handleMessageChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setMessageContent(e.target.value);
    updateMentionToken(e.target.value, e.target.selectionStart ?? e.target.value.length);
  };

  // Handle sending a message
  const handleSendMessage = () => {
    if (messageContent.trim() === "") return;

    onSendMessage(messageContent, selectedQuestionId ?? undefined);
    setMessageContent("");
  };

  // Handle message input keydown. While the mention popover is open the
  // arrow keys, Enter/Tab, and Escape belong to it; Enter-to-send only fires
  // when the popover is closed or has no matches.
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (mentionOpen && mentionToken) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const count = mentionMatches.length;
        const delta = e.key === "ArrowDown" ? 1 : -1;
        setMentionHighlight((activeMentionIndex + delta + count) % count);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        applyMentionSelection(mentionMatches[activeMentionIndex]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setDismissedTokenQuery(mentionToken.query);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  };

  // Render message content as markdown with canonical @[Role] tags styled as
  // pills. Tags are wrapped in code spans on the render-time copy only —
  // stored message content is never mutated — so they survive markdown
  // structure, and MentionAwareCode renders those spans as inline pills.
  const markdownComponents = useMemo(
    () => ({
      code: (props: React.ComponentPropsWithoutRef<"code"> & { node?: unknown }) => (
        <MentionAwareCode {...props} experts={experts} />
      ),
    }),
    [experts]
  );
  const synthesisMarkdownComponents = useMemo(
    () => ({
      ...markdownComponents,
      h1: ({ children }: { children?: ReactNode }) => (
        <h1 className="mb-2 border-b border-amber-200 pb-1 text-base font-bold text-amber-950">{children}</h1>
      ),
      h2: ({ children }: { children?: ReactNode }) => (
        <h2 className="mt-4 mb-1 border-b border-amber-100 pb-1 text-sm font-semibold text-amber-900">{children}</h2>
      ),
      h3: ({ children }: { children?: ReactNode }) => (
        <h3 className="mt-3 mb-1 text-sm font-semibold text-amber-900">{children}</h3>
      ),
    }),
    [markdownComponents]
  );
  const renderMessageBody = (content: string, isSynthesis = false) => {
    const prepared = content.replace(/@\[([^\]]+)\]/g, (tag) => `\`${tag}\``);
    return (
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={isSynthesis ? synthesisMarkdownComponents : markdownComponents}
      >
        {prepared}
      </ReactMarkdown>
    );
  };

  const getExpertBubbleColor = (expertId: number) => {
    const borderColors = [
      "border-l-farm-blue",
      "border-l-emerald-700",
      "border-l-purple-700",
      "border-l-pink-700",
      "border-l-amber-700",
      "border-l-cyan-800",
      "border-l-orange-700",
      "border-l-farm-dark-green",
    ];
    return `bg-neutral-50 border-neutral-200 border-l-4 ${borderColors[expertId % borderColors.length]}`;
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
      e.target.value = "";
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
        const responseText = await response.text();
        throw new Error(responseText || 'Failed to update expert');
      }

      // Invalidate the same query key used by HomePage.
      const expert = experts.find(e => e.id === expertId);
      if (expert) {
        queryClient.invalidateQueries({ queryKey: [`/api/protected/conversations/${expert.conversationId}/experts`] });
      }
    } catch (error) {
      console.error('Error updating expert:', error);
      toast({
        title: "Failed to update expert",
        description: error instanceof Error ? error.message : "Please try again.",
        variant: "destructive",
      });
      throw error;
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
      messagesByDate[date].push(message);
    }
  });

  // Render welcome message if no messages
  const renderWelcomeMessage = () => {
    if (messages.length === 0 && experts.length > 0) {
      return (
        <div className="flex items-start mb-6">
          <div className="flex-shrink-0 mr-3">
            <div className="w-10 h-10 rounded-full bg-gradient-to-br from-farm-blue to-farm-dark-green flex items-center justify-center text-white shadow-md">
              <Bot className="h-5 w-5" aria-hidden="true" />
            </div>
          </div>
          <div className="bg-gradient-to-br from-farm-powder/30 to-farm-tan/20 border border-farm-tan/30 rounded-xl p-4 max-w-[min(85%,calc(100%_-_52px))] shadow-sm">
            <p className="text-base font-semibold text-farm-blue mb-2">Moderator</p>
            <div className="markdown-content [overflow-wrap:anywhere] text-sm mt-1 text-neutral-700 leading-relaxed">
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
    const nextExpert = experts.find((expert) => expert.id === upNextExpertId);
    if (!isLoading || isLoadingMessages || messagesError || streamingMessages.size > 0 || !nextExpert) return null;

    return (
      <div className="flex items-start mb-4 animate-pulse motion-reduce:animate-none">
        <div className="flex-shrink-0 mr-3">
          <Avatar className="h-10 w-10 ring-2 ring-farm-green/20">
            <AvatarImage src={resolveExpertAvatar(nextExpert.role, nextExpert.avatarUrl)} alt={nextExpert.name} />
            <AvatarFallback className="bg-farm-dark-green text-white font-semibold">{nextExpert.name.charAt(0)}</AvatarFallback>
          </Avatar>
        </div>
        <div className={`${getExpertBubbleColor(nextExpert.id)} rounded-xl p-4 max-w-[min(85%,calc(100%_-_52px))] shadow-sm`}>
          <div className="flex items-center justify-between mb-2">
            <p className="text-sm font-semibold text-farm-blue">{nextExpert.name} <span className="text-neutral-600 font-normal">({nextExpert.role})</span></p>
            <ModelBadge modelId={nextExpert.model} size="sm" />
          </div>
          <div className="h-4 bg-neutral-200 rounded-lg w-3/4 mb-2"></div>
          <div className="h-4 bg-neutral-200 rounded-lg w-1/2"></div>
        </div>
      </div>
    );
  };

  return (
    <div ref={layoutRef} className="relative z-10 isolate w-full min-w-0 min-h-0 flex h-full overflow-hidden">
      {showOpenQuestions && (
        <aside
          role="complementary"
          aria-label="Open questions for you"
          className="absolute right-0 top-0 bottom-0 z-40 w-full max-w-sm border-l border-farm-tan/40 bg-white shadow-2xl flex flex-col"
        >
          <div className="flex items-center justify-between gap-3 border-b border-farm-tan/30 px-4 py-3">
            <div>
              <h3 className="text-sm font-semibold text-farm-blue">Questions for you</h3>
              <p className="text-xs text-neutral-500">Your council kept going while these were open.</p>
            </div>
            <button
              type="button"
              onClick={() => setShowOpenQuestions(false)}
              aria-label="Close open questions"
              className="rounded p-1.5 text-neutral-500 hover:bg-farm-powder/30"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
          <ScrollArea className="flex-1 p-3">
            <div className="space-y-3">
              {openQuestions.map(question => (
                <article key={question.id} className="rounded-lg border border-farm-tan/40 bg-farm-powder/10 p-3">
                  <p className="text-xs font-semibold uppercase tracking-wide text-farm-dark-green">{question.expertRole}</p>
                  <p className="mt-1 text-sm font-medium text-farm-blue">{question.question}</p>
                  <p className="mt-2 text-xs text-neutral-600">
                    <span className="font-semibold">Assumption:</span> {question.assumption || "The council is proceeding with an informed assumption."}
                  </p>
                  <Button
                    type="button"
                    size="sm"
                    className="mt-3 bg-farm-dark-green text-white hover:bg-farm-blue"
                    onClick={() => {
                      setSelectedQuestionId(question.id);
                      setShowOpenQuestions(false);
                      requestAnimationFrame(() => textareaRef.current?.focus());
                    }}
                  >
                    Answer in composer
                  </Button>
                </article>
              ))}
              {openQuestions.length === 0 && (
                <p className="p-3 text-sm text-neutral-500">No open questions right now.</p>
              )}
            </div>
          </ScrollArea>
        </aside>
      )}

      {/* Main Chat Area */}
      <div className="relative flex-1 flex flex-col h-full bg-white border-r border-neutral-200 min-w-0">
        <div className="flex-shrink-0 border-b border-neutral-200 bg-neutral-50 px-3 py-2">
          <div className="space-y-2">
            <div className="flex min-w-0 items-center gap-2">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-8 w-8 shrink-0"
                onClick={() => setExpertsCollapsed((collapsed) => !collapsed)}
                aria-label={expertsCollapsed ? "Expand expert strip" : "Collapse expert strip"}
                aria-expanded={!expertsCollapsed}
              >
                {expertsCollapsed ? <ChevronDown className="h-4 w-4" /> : <ChevronUp className="h-4 w-4" />}
              </Button>
              <span className="shrink-0 text-sm font-semibold text-farm-blue">
                {"Experts" + (experts.length > 0 ? " (" + experts.length + ")" : "")}
              </span>
              <div className="min-w-0 flex-1" />
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="shrink-0 gap-1.5 px-2 sm:px-3"
                onClick={onManageExperts}
                aria-label={experts.length === 0 ? "Add experts" : "Add or manage experts"}
              >
                <Users className="h-4 w-4" />
                <span className="hidden sm:inline">{experts.length === 0 ? "Add experts" : "Manage experts"}</span>
                <span className="sm:hidden">{experts.length === 0 ? "Add" : "Manage"}</span>
              </Button>
              {isCompactLayout && (
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="h-9 w-9 shrink-0"
                  onClick={() => setShowMobileRightSidebar((open) => !open)}
                  aria-controls="right-sidebar-panel"
                  aria-expanded={showMobileRightSidebar}
                  aria-label={showMobileRightSidebar ? "Close insights and artifacts" : "Open insights and artifacts"}
                  title="Insights and artifacts"
                >
                  <ScrollText className="h-4 w-4" />
                </Button>
              )}
            </div>
            {!expertsCollapsed && experts.length > 0 && (
              <div className="flex min-w-0 items-center gap-2 overflow-x-auto py-1" role="group" aria-label="Conversation experts">
                {experts.map((expert) => (
                  <button
                    key={expert.id}
                    type="button"
                    onClick={() => handleExpertClick(expert)}
                    className={[
                      "relative flex shrink-0 items-center gap-2 rounded-lg border bg-white px-2 py-1 text-left transition-colors hover:bg-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-farm-blue",
                      isExpertMentioned(expert) ? "ring-2 " + getExpertRingColor(expert.id) : "",
                      isExpertMentioned(expert) && mentionPulseActive ? "animate-pulse motion-reduce:animate-none" : "",
                    ].join(" ")}
                    title={(isExpertMentioned(expert) ? expert.name + " was mentioned in the latest message" : "Click to edit expert settings") + stanceTitle(expert)}
                  >
                    <span className="relative">
                      <Avatar className={["h-8 w-8 ring-2", upNextExpertId === expert.id ? "animate-pulse motion-reduce:animate-none " + getExpertRingColor(expert.id) : "ring-neutral-200"].join(" ")}>
                        <AvatarImage src={resolveExpertAvatar(expert.role, expert.avatarUrl)} alt={expert.name} />
                        <AvatarFallback className="bg-farm-dark-green text-white text-xs font-semibold">{expert.name.charAt(0)}</AvatarFallback>
                      </Avatar>
                      {typingExpertIds.has(expert.id) && (
                        <span className="absolute -bottom-0.5 -right-0.5 flex h-3 w-3">
                          <span className="absolute inline-flex h-full w-full animate-ping motion-reduce:animate-none rounded-full bg-farm-dark-green opacity-75" />
                          <span className="relative inline-flex h-3 w-3 rounded-full bg-farm-dark-green" />
                        </span>
                      )}
                    </span>
                    <span className="min-w-0">
                      <span className="block max-w-32 truncate text-xs font-semibold text-farm-blue">{expert.name}</span>
                      <span className="block max-w-32 truncate text-[10px] text-neutral-600">{expert.role}</span>
                      {renderStanceChip(expert)}
                      {upNextExpertId === expert.id && (
                        <span className="mt-1 inline-flex items-center rounded-full border border-farm-yellow/60 bg-farm-yellow/20 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide leading-none text-yellow-800">
                          Up next
                        </span>
                      )}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
        {/* Chat Messages */}
        <div className="relative min-h-0 flex-1">
        <ScrollArea ref={scrollAreaRef} className="h-full min-w-0 min-h-0 p-4">
          {isLoadingMessages && (
            <div role="status" className="flex items-center justify-center gap-2 py-8 text-sm text-neutral-500">
            <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
              Loading conversation…
            </div>
          )}
          {messagesError && (
            <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-4 text-center text-sm text-red-700">
              We couldn’t load this conversation. Please select it again or refresh the page.
            </div>
          )}
          {!isLoadingMessages && !messagesError && experts.length === 0 && (
            <div className="mx-auto my-8 max-w-md rounded-xl border border-neutral-200 bg-neutral-50 p-6 text-center">
              <Users className="mx-auto h-8 w-8 text-neutral-500" aria-hidden="true" />
              <p className="mt-3 text-sm font-semibold text-farm-blue">No experts in this roundtable yet</p>
              <p className="mt-1 text-sm text-neutral-600">Add experts to get advice for this conversation.</p>
              <Button type="button" className="mt-4 bg-farm-dark-green text-white hover:bg-farm-blue" onClick={onManageExperts}>
                Add experts
              </Button>
            </div>
          )}
          {!isLoadingMessages && !messagesError && renderWelcomeMessage()}
          {!isLoadingMessages && !messagesError && Object.entries(messagesByDate).map(([date, dateMessages]) => (
            <div key={date}>
              <div className="text-center my-4">
                <span className="text-xs bg-farm-tan/30 text-farm-blue px-3 py-1.5 rounded-full font-medium shadow-sm">
                  {date}
                </span>
              </div>
              
              {dateMessages.map((message) => {
                // User message
                if (message.role === "user") {
                  return (
                    <div key={message.id} className="flex items-start mb-4 justify-end">
                      <div className="bg-gradient-to-br from-farm-blue to-farm-dark-green text-white rounded-xl p-4 max-w-[min(85%,calc(100%_-_52px))] shadow-md">
                        {message.timestamp && <time className="mb-2 block text-right text-xs text-white/80" dateTime={message.timestamp.toISOString()}>{format(message.timestamp, "h:mm a")}</time>}
                        <MentionChips mentions={message.mentions} experts={experts} className="mb-2" />
                        <div className="markdown-content [overflow-wrap:anywhere] prose-sm prose-invert leading-relaxed">
                          <UserMessageContent content={message.content} renderBody={renderMessageBody} />
                        </div>
                      </div>
                      <div className="flex-shrink-0 ml-3">
                        <Avatar className="h-10 w-10 ring-2 ring-farm-blue/20">
                          <AvatarFallback className="bg-farm-blue text-white font-semibold">{user?.username?.charAt(0).toUpperCase() || "U"}</AvatarFallback>
                        </Avatar>
                      </div>
                    </div>
                  );
                }
                
                // Assistant messages stay visible after their expert is removed.
                const isSystemModeratorSynthesis =
                  message.expertId === null && message.expertRole === "Moderator" && message.isSynthesis === true;
                if (message.role === "assistant") {
                  const expert = message.expertId !== null ? findExpert(message.expertId) : null;
                  const speakerName = expert?.name ?? message.expertName ?? (isSystemModeratorSynthesis ? "Moderator" : "Expert");
                  const speakerRole = expert?.role ?? message.expertRole ?? (isSystemModeratorSynthesis ? "Moderator" : "Expert");
                  const speakerBubbleColor = expert
                    ? getExpertBubbleColor(expert.id)
                    : "bg-neutral-50 border-neutral-200 border-l-4 border-l-neutral-400";

                  return (
                    <div key={message.id} className="flex items-start mb-4">
                      <div className="flex-shrink-0 mr-3">
                        <Avatar className={`h-10 w-10 ring-2 ${expert ? "ring-farm-green/20" : "ring-neutral-200"}`}>
                          {expert && <AvatarImage src={resolveExpertAvatar(expert.role, expert.avatarUrl)} alt={speakerName} />}
                          <AvatarFallback className={expert ? "bg-farm-dark-green text-white font-semibold" : "bg-neutral-200 text-neutral-700 font-semibold"}>{speakerName.charAt(0)}</AvatarFallback>
                        </Avatar>
                      </div>
                      <div className="max-w-[min(85%,calc(100%_-_52px))] space-y-2">
                        <div className={`${speakerBubbleColor} ${message.isSynthesis ? "border-amber-300/70 bg-amber-50/70 shadow-md" : ""} rounded-xl p-4 border shadow-sm`}>
                          <div className="flex flex-wrap items-start justify-between gap-2 mb-2">
                            <div className="flex min-w-0 flex-wrap items-center gap-2">
                              <p className="min-w-0 break-words text-sm font-semibold text-farm-blue">{speakerName} <span className="text-neutral-600 font-normal">({speakerRole})</span></p>
                              {message.timestamp && <time className="text-xs text-neutral-600" dateTime={message.timestamp.toISOString()}>{format(message.timestamp, "h:mm a")}</time>}
                              {/* G5: the Moderator's closing synthesis of the roundtable */}
                              {message.isSynthesis && (
                                <span className="inline-flex items-center gap-1 rounded-full border border-amber-300/60 bg-amber-100 px-2 py-0.5 text-xs font-medium leading-none text-amber-800 flex-shrink-0">
                                  <ScrollText className="h-3 w-3" />
                                  Closing summary
                                </span>
                              )}
                            </div>
                            {expert && <ModelBadge modelId={expert.model} size="sm" />}
                          </div>
                          <MentionChips mentions={message.mentions} experts={experts} className="mb-2" />
                          {message.isSynthesis ? (
                            <section
                              aria-label="Council verdict"
                              data-testid={`council-verdict-${message.id}`}
                              className="rounded-lg border border-amber-300/60 bg-white/80 p-3 shadow-sm"
                            >
                              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-amber-900">
                                Council verdict
                              </h3>
                              <div className="markdown-content [overflow-wrap:anywhere] text-sm leading-relaxed text-neutral-700">
                                {renderMessageBody(message.content, true)}
                              </div>
                            </section>
                          ) : (
                            <div className="markdown-content [overflow-wrap:anywhere] text-sm leading-relaxed text-neutral-700">
                              {renderMessageBody(message.content)}
                            </div>
                          )}
                        </div>
                        
                        {/* Render artifacts inline */}
                        {message.artifacts && message.artifacts.length > 0 && (
                          <div className="space-y-2" data-testid={`artifacts-message-${message.id}`}>
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
            const expert = expertId === null ? null : findExpert(expertId);
            const isSystemModerator = expertId === null && stream.expertRole === "Moderator";
            if (!expert && !isSystemModerator) return null;
            const speakerName = expert?.name ?? stream.expertName;
            return (
              <div key={`stream-${expertId ?? "system-moderator"}`} className="flex items-start mb-4">
                <div className="flex-shrink-0 mr-3">
                  <div className="relative">
                    <Avatar className={`h-10 w-10 ring-2 ${expert ? "ring-farm-green/20" : "ring-neutral-200"}`}>
                      {expert && <AvatarImage src={resolveExpertAvatar(expert.role, expert.avatarUrl)} alt={speakerName} />}
                      <AvatarFallback className={expert ? "bg-farm-dark-green text-white font-semibold" : "bg-neutral-200 text-neutral-700 font-semibold"}>{speakerName.charAt(0)}</AvatarFallback>
                    </Avatar>
                    <span className="absolute -bottom-0.5 -right-0.5 flex h-3 w-3">
                      <span className="animate-ping motion-reduce:animate-none absolute inline-flex h-full w-full rounded-full bg-farm-dark-green opacity-75"></span>
                      <span className="relative inline-flex rounded-full h-3 w-3 bg-farm-dark-green"></span>
                    </span>
                  </div>
                </div>
                <div className="max-w-[min(85%,calc(100%_-_52px))] space-y-2">
                  <div className={`${getExpertBubbleColor(expert?.id ?? 0)} rounded-xl p-4 border shadow-sm`}>
                    <div className="flex items-center justify-between mb-2">
                      <p className="text-sm font-semibold text-farm-blue">
                        {stream.expertName} <span className="text-neutral-600 font-normal">({stream.expertRole})</span>
                      </p>
                      {expert && <ModelBadge modelId={expert.model} size="sm" />}
                    </div>
                    <div className="markdown-content [overflow-wrap:anywhere] text-sm leading-relaxed text-neutral-700">
                      {stream.content ? (
                        renderMessageBody(stream.content)
                      ) : (
                        <span className="inline-flex items-center gap-0.5">
                          <span className="animate-bounce motion-reduce:animate-none [animation-delay:-0.3s]">.</span>
                          <span className="animate-bounce motion-reduce:animate-none [animation-delay:-0.15s]">.</span>
                          <span className="animate-bounce motion-reduce:animate-none">.</span>
                        </span>
                      )}
                      {/* Blinking cursor */}
                      <span className="inline-block w-0.5 h-4 bg-farm-blue ml-0.5 animate-pulse motion-reduce:animate-none align-middle"></span>
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

        {showJumpToLatest && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="absolute bottom-4 left-1/2 z-20 -translate-x-1/2 rounded-full bg-white shadow-md"
            onClick={() => {
              isNearBottomRef.current = true;
              setShowJumpToLatest(false);
              messagesEndRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
            }}
            aria-label="New messages, jump to latest"
          >
            New messages ↓
          </Button>
        )}
        </div>
        
        {/* Input Area */}
        <div className="border-t border-farm-tan/30 bg-gradient-to-r from-white to-farm-powder/10 p-4">
          {(openQuestions.length > 0 || selectedQuestion) && (
            <div className="mb-3 flex items-center justify-between gap-2">
              {openQuestions.length > 0 ? (
                <button
                  type="button"
                  onClick={() => setShowOpenQuestions(value => !value)}
                  className="inline-flex items-center rounded-full border border-farm-blue/20 bg-farm-powder/30 px-3 py-1 text-xs font-semibold text-farm-blue hover:bg-farm-powder/50"
                  aria-expanded={showOpenQuestions}
                >
                  {openQuestions.length} {openQuestions.length === 1 ? "question" : "questions"} for you
                </button>
              ) : <span />}
              {selectedQuestion && (
                <div className="flex min-w-0 items-center gap-2 text-xs text-farm-blue" role="status">
                  <span className="truncate">Answering: {selectedQuestion.question}</span>
                  <button
                    type="button"
                    onClick={() => setSelectedQuestionId(null)}
                    className="flex-shrink-0 rounded px-1.5 py-0.5 text-neutral-500 hover:bg-farm-powder/40"
                    aria-label="Cancel answer selection"
                  >
                    Cancel
                  </button>
                </div>
              )}
            </div>
          )}
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
              className="text-farm-blue hover:text-farm-dark-green hover:bg-farm-powder/30 transition-all duration-200"
              onClick={handleFileUpload}
              title="Upload File"
              aria-label={isUploading ? "Uploading file" : "Upload file"}
              disabled={isUploading}
            >
              {isUploading ? <Loader2 className="h-5 w-5 animate-spin motion-reduce:animate-none" /> : <Paperclip className="h-5 w-5" />}
            </Button>
            <div className="relative flex-1">
              {mentionOpen && (
                <div className="absolute bottom-full mb-2 left-0 z-20 w-72 max-w-full rounded-lg border border-farm-tan/40 bg-white shadow-lg overflow-hidden">
                  <div className="px-3 py-1.5 text-[10px] font-medium uppercase tracking-wide text-neutral-400 border-b border-farm-tan/30">
                    Mention an expert
                  </div>
                  <div id="expert-mention-listbox" className="max-h-48 overflow-y-auto" role="listbox" aria-label="Experts to mention">
                    {mentionMatches.map((expert, index) => (
                      <button
                        key={expert.id}
                        id={`expert-mention-option-${expert.id}`}
                        type="button"
                        role="option"
                        aria-selected={index === activeMentionIndex}
                        className={`w-full flex items-center gap-2 px-3 py-2 text-left transition-colors ${index === activeMentionIndex ? "bg-farm-powder/40" : "hover:bg-farm-powder/20"}`}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => applyMentionSelection(expert)}
                      >
                        <Avatar className="h-6 w-6 flex-shrink-0">
                          <AvatarImage src={resolveExpertAvatar(expert.role, expert.avatarUrl)} alt={expert.name} />
                          <AvatarFallback className="bg-farm-dark-green text-white text-[10px] font-semibold">
                            {expert.name.charAt(0)}
                          </AvatarFallback>
                        </Avatar>
                        <span className="min-w-0 flex-1">
                          <span className="block text-sm font-medium text-farm-blue truncate">{expert.name}</span>
                          <span className="block text-xs text-neutral-500 truncate">{expert.role}</span>
                        </span>
                        <AtSign className="h-3.5 w-3.5 text-neutral-300 flex-shrink-0" />
                      </button>
                    ))}
                  </div>
                </div>
              )}
              <Textarea
                ref={textareaRef}
                placeholder={isLoading ? "Experts are discussing; your message will be queued…" : "Type your message here..."}
                value={messageContent}
                onChange={handleMessageChange}
                onKeyDown={handleKeyDown}
                onBlur={() => setMentionToken(null)}
                onSelect={(e) => {
                  const el = e.currentTarget;
                  updateMentionToken(el.value, el.selectionStart ?? el.value.length);
                }}
                className="min-h-[60px] max-h-40 overflow-y-auto resize-none border-farm-tan/40 focus:border-farm-blue focus:ring-farm-blue/20"
                aria-label="Message to the roundtable"
                role="combobox"
                aria-autocomplete="list"
                aria-haspopup="listbox"
                aria-expanded={mentionOpen}
                aria-controls={mentionOpen ? "expert-mention-listbox" : undefined}
                aria-activedescendant={mentionOpen ? `expert-mention-option-${mentionMatches[activeMentionIndex]?.id}` : undefined}
              />
            </div>
            <Button
              className="bg-farm-dark-green hover:bg-farm-blue text-white rounded-full p-2 ml-2 h-11 w-11 flex items-center justify-center shadow-md hover:shadow-lg transition-all duration-200 disabled:opacity-50"
              onClick={handleSendMessage}
              disabled={messageContent.trim() === ""}
              aria-label={selectedQuestion ? "Send answer" : "Send message"}
            >
              <Send className="h-5 w-5" />
            </Button>
          </div>
          <p className="mt-2 truncate text-[11px] text-neutral-600" title="Shift+Enter for a new line · @ to mention an expert · /new [topic] to restart the discussion">
            Shift+Enter for a new line · @ mention · /new [topic] restart
          </p>
        </div>
        
      </div>

      {/* Right Sidebar - Resizable */}
      <div
        id={isRightSidebarVisible ? "right-sidebar-panel" : undefined}
        className={`flex-shrink-0 h-full overflow-hidden ${isRightSidebarVisible ? "block" : "hidden"} ${isRightSidebarCollapsed ? "border-l border-neutral-200 bg-white" : "bg-white"}`}
        style={{ width: `${isRightSidebarCollapsed ? 40 : effectiveRightSidebarWidth}px` }}
      >
        {isRightSidebarCollapsed ? (
          <div className="flex h-full justify-center">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="mt-2 h-9 w-9 shrink-0"
              aria-label="Expand right sidebar"
              aria-controls="right-sidebar-panel"
              aria-expanded={false}
              title="Expand right sidebar"
              onClick={() => setIsRightSidebarCollapsed(false)}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
          </div>
        ) : (
          <ConversationSidebar
            messages={messages}
            insights={insights}
            onWidthChange={setRightSidebarWidth}
            onCollapse={() => setIsRightSidebarCollapsed(true)}
            currentWidth={effectiveRightSidebarWidth}
            minWidth={300}
            maxWidth={maximumRightSidebarWidth}
            onRefreshInsights={onRefreshInsights}
            isRefreshingInsights={isRefreshingInsights}
          />
        )}
      </div>

      {isCompactLayout && showMobileRightSidebar && (
        <>
          <button
            type="button"
            className="absolute inset-0 z-30 bg-black/40"
            aria-label="Close insights and artifacts"
            onClick={() => setShowMobileRightSidebar(false)}
          />
          <aside
            id="right-sidebar-panel"
            role="complementary"
            aria-label="Insights and artifacts"
            className="absolute inset-y-0 right-0 z-40 flex max-w-full flex-col bg-white shadow-2xl"
            style={{ width: `${effectiveRightSidebarWidth}px` }}
          >
            <ConversationSidebar
              messages={messages}
              insights={insights}
              onWidthChange={setRightSidebarWidth}
              onCollapse={() => setShowMobileRightSidebar(false)}
              currentWidth={effectiveRightSidebarWidth}
              minWidth={300}
              maxWidth={maximumRightSidebarWidth}
              onRefreshInsights={onRefreshInsights}
              isRefreshingInsights={isRefreshingInsights}
            />
          </aside>
        </>
      )}

      {/* Expert Settings Modal */}
      <ExpertSettingsModal
        expert={selectedExpert}
        isOpen={isExpertModalOpen}
        onClose={() => {
          setIsExpertModalOpen(false);
          setSelectedExpert(null);
        }}
        onSave={handleExpertSave}
        onRemoveExpert={onRemoveExpert}
      />
    </div>
  );
}

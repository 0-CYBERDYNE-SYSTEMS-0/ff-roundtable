import { useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Message, Artifact } from "@shared/schema";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { BarChart3, Code, ChevronRight, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import ArtifactDisplay from "../artifacts/ArtifactDisplay";

interface ConversationSidebarProps {
  messages: Message[];
  insights: any[];
  onWidthChange: (width: number) => void;
  onCollapse: () => void;
  currentWidth: number;
  minWidth: number;
  maxWidth: number;
  onRefreshInsights: () => void;
  isRefreshingInsights: boolean;
}

export default function ConversationSidebar({
  messages,
  insights,
  onWidthChange,
  onCollapse,
  currentWidth,
  minWidth,
  maxWidth,
  onRefreshInsights,
  isRefreshingInsights,
}: ConversationSidebarProps) {
  const [artifactFilter, setArtifactFilter] = useState<"all" | "chart">("all");
  const [isResizing, setIsResizing] = useState(false);
  const resizeStartRef = useRef<{ x: number; width: number } | null>(null);
  const compactTabs = currentWidth <= 340;
  const allArtifacts: Artifact[] = messages.flatMap((message) =>
    Array.isArray(message.artifacts) ? message.artifacts : []
  );
  const filteredArtifacts = artifactFilter === "chart"
    ? allArtifacts.filter((artifact) => artifact.type === "chart")
    : allArtifacts;

  const handleResizeStart = (event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    resizeStartRef.current = { x: event.clientX, width: currentWidth };
    setIsResizing(true);
  };

  const handleResizeMove = (event: PointerEvent<HTMLDivElement>) => {
    const start = resizeStartRef.current;
    if (!start) return;
    const width = start.width + start.x - event.clientX;
    onWidthChange(Math.max(minWidth, Math.min(maxWidth, width)));
  };

  const stopResizing = () => {
    resizeStartRef.current = null;
    setIsResizing(false);
  };

  const handleResizeKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      const delta = event.key === "ArrowLeft" ? 16 : -16;
      onWidthChange(Math.max(minWidth, Math.min(maxWidth, currentWidth + delta)));
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      onWidthChange(event.key === "Home" ? minWidth : maxWidth);
    }
  };

  return (
    <div className="relative flex h-full w-full flex-col">
      <Tabs defaultValue="insights" className="flex h-full w-full flex-col">
        <div className="flex flex-shrink-0 items-center gap-2 border-b border-neutral-200 px-3">
          <TabsList className={`mb-[-1px] min-w-0 flex-1 ${compactTabs ? "grid w-full grid-cols-2" : ""}`}>
            <TabsTrigger value="insights" className={compactTabs ? "min-w-0 w-full px-1 text-[11px]" : undefined}>
              Insights
            </TabsTrigger>
            <TabsTrigger value="artifacts" className={compactTabs ? "min-w-0 w-full px-1 text-[11px]" : undefined}>
              Artifacts ({allArtifacts.length})
            </TabsTrigger>
          </TabsList>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8 shrink-0 text-neutral-600 hover:bg-neutral-100 hover:text-farm-dark-green"
            onClick={onRefreshInsights}
            disabled={isRefreshingInsights}
            aria-label="Refresh insights"
            title="Refresh insights"
          >
            <RefreshCw className={`h-4 w-4 ${isRefreshingInsights ? "animate-spin motion-reduce:animate-none" : ""}`} />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8 shrink-0 text-neutral-600 hover:bg-neutral-100 hover:text-farm-dark-green"
            aria-label="Collapse right sidebar"
            aria-controls="right-sidebar-panel"
            aria-expanded={true}
            title="Collapse right sidebar"
            onClick={onCollapse}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>

        <TabsContent value="insights" className="mt-0 min-h-0 flex-1">
          <ScrollArea className="h-full w-full px-4">
            {insights && insights.length > 0 ? (
              insights.map((insight, index) => (
                <Card key={index} className="mb-4">
                  <CardHeader>
                    <CardTitle className="text-sm font-medium">{insight.title}</CardTitle>
                    <CardDescription className="text-xs text-neutral-600">Generated from conversation</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <ul className="list-disc list-inside space-y-1">
                      {insight.points.map((point: string, i: number) => (
                        <li key={i} className="text-sm text-neutral-700">{point}</li>
                      ))}
                    </ul>
                  </CardContent>
                </Card>
              ))
            ) : (
              <div className="mt-12 space-y-3 text-center text-neutral-600">
                <BarChart3 className="mx-auto h-8 w-8 text-neutral-500" aria-hidden="true" />
                <p className="text-sm font-medium">No insights yet</p>
                <p className="text-xs">Experts will generate key insights as your discussion progresses.</p>
              </div>
            )}
          </ScrollArea>
        </TabsContent>

        <TabsContent value="artifacts" className="mt-0 min-h-0 flex-1">
          <div className="flex h-full min-h-0 flex-col">
            <div className="flex items-center gap-2 px-4 py-3">
              <Button
                type="button"
                size="sm"
                variant={artifactFilter === "all" ? "default" : "outline"}
                aria-pressed={artifactFilter === "all"}
                onClick={() => setArtifactFilter("all")}
              >
                All ({allArtifacts.length})
              </Button>
              <Button
                type="button"
                size="sm"
                variant={artifactFilter === "chart" ? "default" : "outline"}
                aria-pressed={artifactFilter === "chart"}
                onClick={() => setArtifactFilter("chart")}
              >
                <BarChart3 className="mr-1.5 h-4 w-4" />
                Charts ({allArtifacts.filter((artifact) => artifact.type === "chart").length})
              </Button>
            </div>
            <ScrollArea className="min-h-0 w-full flex-1 px-4">
              {filteredArtifacts.length > 0 ? (
                filteredArtifacts.map((artifact, index) => (
                  <ArtifactDisplay key={`${artifact.title}-${index}`} artifact={artifact} />
                ))
              ) : (
                <div className="mt-8 flex flex-col items-center space-y-2 text-center text-neutral-600">
                  <Code className="h-6 w-6 text-neutral-500" aria-hidden="true" />
                  <p className="text-sm">{artifactFilter === "chart" ? "No charts generated yet." : "No artifacts generated yet."}</p>
                  <p className="text-xs">Artifacts from the discussion will appear here.</p>
                </div>
              )}
            </ScrollArea>
          </div>
        </TabsContent>
      </Tabs>

      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize right sidebar"
        aria-controls="right-sidebar-panel"
        aria-valuemin={minWidth}
        aria-valuemax={maxWidth}
        aria-valuenow={Math.round(currentWidth)}
        tabIndex={0}
        onPointerDown={handleResizeStart}
        onPointerMove={handleResizeMove}
        onPointerUp={stopResizing}
        onPointerCancel={stopResizing}
        onKeyDown={handleResizeKeyDown}
        className={`absolute -left-1 top-0 z-10 h-full w-2 touch-none cursor-col-resize select-none transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-farm-blue hover:bg-farm-blue/30 ${isResizing ? "bg-farm-blue/50" : "bg-transparent"}`}
        title="Drag or use arrow, Home, and End keys to resize the sidebar"
      />
    </div>
  );
}

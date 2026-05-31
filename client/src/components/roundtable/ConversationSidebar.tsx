import { useState, useEffect } from 'react';
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Message, Expert, Artifact } from "@shared/schema";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { BarChart, LineChart, Map, PieChart, Table, Code } from 'lucide-react';
import ArtifactDisplay from "../artifacts/ArtifactDisplay";

interface ConversationSidebarProps {
  messages: Message[];
  experts: Expert[];
  insights: any[];
  visualizations: any[];
  onWidthChange: (width: number) => void;
  currentWidth: number;
}

interface Visualization {
  type: 'chart' | 'map' | 'iframe' | 'table';
  title: string;
  data: any;
  url?: string;
}

export default function ConversationSidebar({
  messages,
  experts,
  insights,
  visualizations,
  onWidthChange,
  currentWidth
}: ConversationSidebarProps) {
  const [activeTab, setActiveTab] = useState('insights');
  const [activeVisualizations, setActiveVisualizations] = useState<Visualization[]>([]);
  const [allArtifacts, setAllArtifacts] = useState<Artifact[]>([]);
  const [isResizing, setIsResizing] = useState(false);
  const [startX, setStartX] = useState(0);
  const [startWidth, setStartWidth] = useState(currentWidth);

  // Extract artifacts from messages
  useEffect(() => {
    const extractedArtifacts: Artifact[] = [];
    
    messages.forEach(message => {
      if (message.artifacts && Array.isArray(message.artifacts)) {
        extractedArtifacts.push(...message.artifacts);
      }
    });

    setAllArtifacts(extractedArtifacts);
  }, [messages]);

  // Process messages to extract visualization requests and URLs
  useEffect(() => {
    const extractedVisualizations: Visualization[] = [];
    
    messages.forEach(message => {
      if (message.expertId) {
        // Look for URL patterns
        const urlMatches = message.content.match(/\bhttps?:\/\/\S+/gi);
        if (urlMatches) {
          urlMatches.forEach(url => {
            // Determine visualization type based on URL
            if (url.includes('maps.google.com') || url.includes('openstreetmap.org')) {
              extractedVisualizations.push({
                type: 'map',
                title: 'Location Map',
                data: null,
                url
              });
            } else if (url.includes('chart.googleapis.com')) {
              extractedVisualizations.push({
                type: 'chart',
                title: 'Data Visualization',
                data: null,
                url
              });
            }
          });
        }

        // Look for data visualization markers
        if (message.content.includes('```chart') || message.content.includes('```visualization')) {
          // Extract chart data between code blocks
          const chartMatch = message.content.match(/```chart\n([\s\S]*?)```/);
          if (chartMatch) {
            try {
              const chartData = JSON.parse(chartMatch[1]);
              extractedVisualizations.push({
                type: 'chart',
                title: chartData.title || 'Data Visualization',
                data: chartData
              });
            } catch (e) {
              console.error('Failed to parse chart data:', e);
            }
          }
        }
      }
    });

    setActiveVisualizations(extractedVisualizations);
  }, [messages]);

  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);
    setStartX(e.clientX);
    setStartWidth(currentWidth);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  const handleTouchStart = (e: React.TouchEvent) => {
    e.preventDefault();
    setIsResizing(true);
    setStartX(e.touches[0].clientX);
    setStartWidth(currentWidth);
  };

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizing) return;
      const diff = startX - e.clientX;
      const newWidth = Math.max(300, Math.min(800, startWidth + diff));
      onWidthChange(newWidth);
    };

    const handleMouseUp = () => {
      if (isResizing) {
        setIsResizing(false);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      }
    };

    const handleTouchMove = (e: TouchEvent) => {
      if (!isResizing) return;
      const diff = startX - e.touches[0].clientX;
      const newWidth = Math.max(300, Math.min(800, startWidth + diff));
      onWidthChange(newWidth);
    };

    const handleTouchEnd = () => {
      if (isResizing) {
        setIsResizing(false);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      }
    };

    if (isResizing) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
      document.addEventListener('touchmove', handleTouchMove, { passive: false });
      document.addEventListener('touchend', handleTouchEnd);
      return () => {
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
        document.removeEventListener('touchmove', handleTouchMove);
        document.removeEventListener('touchend', handleTouchEnd);
      };
    }
  }, [isResizing, startX, startWidth, onWidthChange]);

  const renderVisualization = (vis: Visualization) => {
    switch (vis.type) {
      case 'map':
        return (
          <div className="w-full h-[300px] rounded-lg overflow-hidden border border-neutral-200">
            <iframe
              src={vis.url}
              className="w-full h-full"
              frameBorder="0"
              allowFullScreen
              loading="lazy"
              referrerPolicy="no-referrer-when-downgrade"
            />
          </div>
        );
      case 'iframe':
        return (
          <div className="w-full h-[300px] rounded-lg overflow-hidden border border-neutral-200">
            <iframe
              src={vis.url}
              className="w-full h-full"
              frameBorder="0"
              allowFullScreen
            />
          </div>
        );
      case 'chart':
        return (
          <div className="w-full h-[300px] rounded-lg overflow-hidden border border-neutral-200 bg-white p-4">
            {/* Placeholder for chart rendering - you'll want to use a charting library like recharts or chart.js */}
            <div className="flex items-center justify-center h-full text-neutral-400">
              <BarChart className="w-6 h-6 mr-2" />
              Chart Visualization
            </div>
          </div>
        );
      default:
        return null;
    }
  };

  return (
    <div className="h-full flex flex-col relative w-full">
      <Tabs defaultValue="insights" className="w-full h-full flex flex-col">
        <div className="border-b border-neutral-200 px-4 flex-shrink-0">
          <TabsList className="mb-[-1px]">
            <TabsTrigger value="insights" onClick={() => setActiveTab('insights')}>
              Insights
            </TabsTrigger>
            <TabsTrigger value="artifacts" onClick={() => setActiveTab('artifacts')}>
              Artifacts ({allArtifacts.length})
            </TabsTrigger>
            <TabsTrigger value="visualizations" onClick={() => setActiveTab('visualizations')}>
              Visualizations
            </TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="insights" className="flex-1 mt-0 min-h-0">
          <ScrollArea className="h-full w-full px-4">
            {insights && insights.length > 0 ? (
              insights.map((insight, index) => (
                <Card key={index} className="mb-4">
                  <CardHeader>
                    <CardTitle className="text-sm font-medium">{insight.title}</CardTitle>
                    <CardDescription className="text-xs text-neutral-500">
                      Generated from conversation
                    </CardDescription>
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
              <div className="text-center text-neutral-500 mt-12 space-y-4">
                <div className="flex flex-col items-center space-y-2">
                  <div className="text-4xl">📊</div>
                  <p className="text-sm font-medium">No insights yet</p>
                  <p className="text-xs">Experts will generate key insights as your discussion progresses</p>
                </div>
              </div>
            )}
          </ScrollArea>
        </TabsContent>

        <TabsContent value="artifacts" className="flex-1 mt-0 min-h-0">
          <ScrollArea className="h-full w-full px-4">
            {allArtifacts.length > 0 ? (
              allArtifacts.map((artifact, index) => (
                <ArtifactDisplay key={index} artifact={artifact} />
              ))
            ) : (
              <div className="text-center text-neutral-500 mt-8">
                <div className="flex flex-col items-center space-y-2">
                  <Code className="w-6 h-6 text-neutral-400" />
                  <p className="text-sm">No artifacts generated yet.</p>
                  <p className="text-xs">Experts will generate code, charts, tables, and more as you discuss!</p>
                </div>
              </div>
            )}
          </ScrollArea>
        </TabsContent>

        <TabsContent value="visualizations" className="flex-1 mt-0 min-h-0">
          <ScrollArea className="h-full w-full px-4">
            {activeVisualizations.map((vis, index) => (
              <Card key={index} className="mb-4">
                <CardHeader>
                  <CardTitle className="text-sm font-medium">{vis.title}</CardTitle>
                </CardHeader>
                <CardContent>
                  {renderVisualization(vis)}
                </CardContent>
              </Card>
            ))}
            {activeVisualizations.length === 0 && (
              <div className="text-center text-neutral-500 mt-8">
                <div className="flex flex-col items-center space-y-2">
                  <div className="flex space-x-2">
                    <BarChart className="w-5 h-5" />
                    <LineChart className="w-5 h-5" />
                    <PieChart className="w-5 h-5" />
                    <Map className="w-5 h-5" />
                  </div>
                  <p className="text-sm">No visualizations available yet.</p>
                  <p className="text-xs">Ask the experts to create charts or share locations!</p>
                </div>
              </div>
            )}
          </ScrollArea>
        </TabsContent>
      </Tabs>

      {/* Resizable handle - LEFT side (drag to resize) */}
      <div
        onMouseDown={handleMouseDown}
        onTouchStart={handleTouchStart}
        className={`absolute -left-1 top-0 w-2 h-full hover:bg-farm-blue/30 cursor-col-resize transition-colors z-10 ${
          isResizing ? "bg-farm-blue/50" : "bg-transparent"
        }`}
        style={{
          borderLeft: isResizing ? '2px solid rgb(59 130 246)' : '1px solid rgb(229 231 235)'
        }}
        title="Drag to resize sidebar (300-800px)"
      />
    </div>
  );
} 
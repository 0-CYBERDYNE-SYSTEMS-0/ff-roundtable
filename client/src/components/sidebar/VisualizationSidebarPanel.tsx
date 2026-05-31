import { ScrollArea } from "@/components/ui/scroll-area";
import { BarChartIcon, TableIcon, AlertTriangleIcon, LineChartIcon, PieChartIcon, FileTextIcon } from "lucide-react";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  LineChart,
  Line,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { RefreshCwIcon } from "lucide-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useParams } from "wouter";

interface Visualization {
  id: number;
  type: 'bar' | 'line' | 'pie' | 'table' | 'text';
  title: string;
  description?: string | null;
  data: any;
}

interface VisualizationSidebarPanelProps {
  visualizations: Visualization[]; // Use the imported type
  className?: string;
}

// Basic colors for charts
const COLORS = ['#0088FE', '#00C49F', '#FFBB28', '#FF8042', '#8884d8', '#82ca9d'];

export default function VisualizationSidebarPanel({
  visualizations,
  className
}: VisualizationSidebarPanelProps) {
  const { toast } = useToast();
  const params = useParams();
  const conversationId = params.conversationId ? parseInt(params.conversationId as string, 10) : null;

  const generateVisualizationsMutation = useMutation({
    mutationFn: async () => {
      if (!conversationId) throw new Error("No active conversation ID found.");
      return apiRequest("POST", `/api/protected/conversations/${conversationId}/generate-visualizations`, {});
    },
    onSuccess: (data) => {
      toast({
        title: "Visualization Generation Triggered",
        description: "Visualizations will appear shortly.",
      });
      console.log("Visualization generation successful (API response):", data);
    },
    onError: (error: Error) => {
      toast({
        title: "Failed to Generate Visualizations",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const getVisualizationIcon = (type: Visualization['type']) => {
    switch (type) {
      case 'bar': return <BarChartIcon className="h-5 w-5 mr-2 text-blue-600" />;
      case 'line': return <LineChartIcon className="h-5 w-5 mr-2 text-purple-600" />;
      case 'pie': return <PieChartIcon className="h-5 w-5 mr-2 text-orange-600" />;
      case 'table': return <TableIcon className="h-5 w-5 mr-2 text-green-600" />;
      case 'text': return <FileTextIcon className="h-5 w-5 mr-2 text-gray-600" />;
      default: return <AlertTriangleIcon className="h-5 w-5 mr-2 text-gray-500" />;
    }
  };

  const renderVisualizationContent = (viz: Visualization) => {
    // Ensure data is an array for chart types
    const chartData = Array.isArray(viz.data) ? viz.data : [];
    const dataKeys = chartData.length > 0 ? Object.keys(chartData[0]) : [];
    const nameKey = dataKeys.find(key => typeof chartData[0][key] === 'string') || dataKeys[0]; // Guess the category key
    const valueKey = dataKeys.find(key => typeof chartData[0][key] === 'number') || dataKeys[1]; // Guess the value key

    switch (viz.type) {
      case 'bar':
        return (
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={chartData} margin={{ top: 5, right: 5, left: -20, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey={nameKey} fontSize={12} tickLine={false} axisLine={false} />
              <YAxis fontSize={12} tickLine={false} axisLine={false} />
              <Tooltip wrapperClassName="text-xs" />
              {/* <Legend wrapperStyle={{ fontSize: '12px' }} /> */}
              <Bar dataKey={valueKey} fill="#8884d8" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        );
      case 'line':
        return (
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={chartData} margin={{ top: 5, right: 5, left: -20, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey={nameKey} fontSize={12} tickLine={false} axisLine={false} />
              <YAxis fontSize={12} tickLine={false} axisLine={false} />
              <Tooltip wrapperClassName="text-xs"/>
              {/* <Legend wrapperStyle={{ fontSize: '12px' }} /> */}
              <Line type="monotone" dataKey={valueKey} stroke="#8884d8" strokeWidth={2} dot={{ r: 4 }} />
            </LineChart>
          </ResponsiveContainer>
        );
      case 'pie':
        return (
          <ResponsiveContainer width="100%" height={200}>
            <PieChart>
              <Pie
                data={chartData}
                cx="50%"
                cy="50%"
                labelLine={false}
                outerRadius={80}
                fill="#8884d8"
                dataKey={valueKey}
                nameKey={nameKey}
                label={({ cx, cy, midAngle, innerRadius, outerRadius, percent, index }) => {
                   const radius = innerRadius + (outerRadius - innerRadius) * 0.5;
                   const x = cx + radius * Math.cos(-midAngle * (Math.PI / 180));
                   const y = cy + radius * Math.sin(-midAngle * (Math.PI / 180));
                   return (
                      <text x={x} y={y} fill="white" textAnchor={x > cx ? 'start' : 'end'} dominantBaseline="central" fontSize={12}>
                        {`${(percent * 100).toFixed(0)}%`}
                      </text>
                   );
                 }}
              >
                {chartData.map((entry: any, index: number) => (
                  <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                ))}
              </Pie>
              <Tooltip wrapperClassName="text-xs"/>
              {/* <Legend wrapperStyle={{ fontSize: '12px' }} /> */}
            </PieChart>
          </ResponsiveContainer>
        );
      case 'table':
        if (!Array.isArray(viz.data) || viz.data.length === 0) {
          return <p className="text-xs text-neutral-500">No data available for table.</p>;
        }
        const headers = Object.keys(viz.data[0]);
        return (
          <Table className="text-xs">
            <TableHeader>
              <TableRow>
                {headers.map(header => <TableHead key={header}>{header}</TableHead>)}
              </TableRow>
            </TableHeader>
            <TableBody>
              {viz.data.map((row: Record<string, any>, rowIndex: number) => (
                <TableRow key={rowIndex}>
                  {headers.map(header => <TableCell key={header}>{String(row[header])}</TableCell>)}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        );
       case 'text':
         return (
           <div className="text-sm whitespace-pre-wrap">
             {viz.data} {/* Assuming data is the text content */}
           </div>
         );
      default:
        return <p className="text-xs text-neutral-500">Unsupported visualization type: {viz.type}</p>;
    }
  };

  return (
    <aside className={`bg-white border-l border-neutral-300 flex flex-col z-10 shadow-md ${className || 'w-[400px]'}`}> 
      <div className="flex flex-col h-full">
        {/* Header with Refresh Button */}
        <div className="p-4 border-b border-neutral-300 flex justify-between items-center">
          <h2 className="font-serif font-bold text-lg">Visualizations & Data</h2>
          <Button 
            variant="ghost" 
            size="icon" 
            onClick={() => generateVisualizationsMutation.mutate()} 
            disabled={generateVisualizationsMutation.isPending || !conversationId}
            title="Generate/Refresh Visualizations"
            className="text-primary h-8 w-8"
          >
            <RefreshCwIcon className={`h-4 w-4 ${generateVisualizationsMutation.isPending ? 'animate-spin' : ''}`} />
          </Button>
        </div>

        {/* Content Area */}
        <ScrollArea className="flex-1">
          {visualizations.length === 0 ? (
            <div className="text-center py-8 text-neutral-500 p-4">
              <p>No visualizations available yet.</p>
              <p className="text-sm mt-2">Visualizations based on the conversation will appear here.</p>
            </div>
          ) : (
            <div className="space-y-4 p-4">
              {visualizations.map((viz) => (
                <Card key={viz.id} className="overflow-hidden"> {/* Use viz.id as key */}
                  <CardHeader className="p-3">
                    <CardTitle className="text-sm font-medium flex items-center">
                      {getVisualizationIcon(viz.type)} 
                      <span className="truncate">{viz.title}</span>
                    </CardTitle>
                    {viz.description && <p className="text-xs text-neutral-600 mt-1">{viz.description}</p>}
                  </CardHeader>
                  <CardContent className="p-3 pt-0">
                    {renderVisualizationContent(viz)}
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </ScrollArea>
      </div>
    </aside>
  );
}

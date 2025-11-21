import { useState } from "react";
import { Artifact } from "@shared/schema";
import { Copy, Download, Maximize2, Code, Database, Table, BarChart3, FileJson } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from "recharts";

interface ArtifactDisplayProps {
  artifact: Artifact;
}

export default function ArtifactDisplay({ artifact }: ArtifactDisplayProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(artifact.content);
  };

  const handleDownload = () => {
    const element = document.createElement("a");
    const file = new Blob([artifact.content], { type: "text/plain" });
    element.href = URL.createObjectURL(file);
    element.download = `artifact-${Date.now()}.${artifact.language || "txt"}`;
    document.body.appendChild(element);
    element.click();
    document.body.removeChild(element);
  };

  const getIcon = () => {
    switch (artifact.type) {
      case "code":
        return <Code className="w-4 h-4" />;
      case "json":
        return <FileJson className="w-4 h-4" />;
      case "table":
        return <Table className="w-4 h-4" />;
      case "chart":
        return <BarChart3 className="w-4 h-4" />;
      case "html":
        return <Database className="w-4 h-4" />;
      default:
        return <Database className="w-4 h-4" />;
    }
  };

  const renderContent = () => {
    switch (artifact.type) {
      case "code":
        return (
          <pre className="bg-neutral-900 text-neutral-100 p-4 rounded overflow-x-auto text-xs font-mono">
            <code>{artifact.content}</code>
          </pre>
        );

      case "json":
        return (
          <div className="bg-neutral-900 text-neutral-100 p-4 rounded overflow-x-auto">
            <pre className="text-xs font-mono">{JSON.stringify(JSON.parse(artifact.content), null, 2)}</pre>
          </div>
        );

      case "table":
        return (
          <div className="overflow-x-auto">
            <table className="w-full text-sm border-collapse border border-neutral-200">
              <tbody>
                {artifact.content
                  .split("\n")
                  .filter((line) => line.trim())
                  .map((row, i) => (
                    <tr key={i} className={i === 1 ? "border-b-2 border-neutral-300" : ""}>
                      {row
                        .split("|")
                        .filter((cell) => cell.trim())
                        .map((cell, j) => (
                          <td
                            key={j}
                            className={`p-2 border border-neutral-200 ${i === 0 ? "font-semibold bg-neutral-100" : ""}`}
                          >
                            {cell.trim()}
                          </td>
                        ))}
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        );

      case "chart":
        try {
          const chartData = JSON.parse(artifact.content);
          if (chartData.type === "line" && Array.isArray(chartData.data)) {
            return (
              <ResponsiveContainer width="100%" height={300}>
                <LineChart data={chartData.data}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="name" />
                  <YAxis />
                  <Tooltip />
                  <Legend />
                  {chartData.lines?.map((line: any, i: number) => (
                    <Line
                      key={i}
                      type="monotone"
                      dataKey={line.key}
                      stroke={line.color || "#8884d8"}
                      dot={false}
                    />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            );
          } else if (chartData.type === "bar" && Array.isArray(chartData.data)) {
            return (
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={chartData.data}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="name" />
                  <YAxis />
                  <Tooltip />
                  <Legend />
                  {chartData.bars?.map((bar: any, i: number) => (
                    <Bar
                      key={i}
                      dataKey={bar.key}
                      fill={bar.color || "#8884d8"}
                    />
                  ))}
                </BarChart>
              </ResponsiveContainer>
            );
          }
        } catch (e) {
          return <div className="text-sm text-neutral-600">Invalid chart data</div>;
        }
        return <div className="text-sm text-neutral-600">Unsupported chart type</div>;

      case "html":
        return (
          <iframe
            srcDoc={artifact.content}
            className="w-full h-96 border border-neutral-200 rounded"
            sandbox={{ allow: ["scripts"] }}
          />
        );

      default:
        return (
          <div className="bg-neutral-50 p-4 rounded text-sm text-neutral-700 font-mono overflow-x-auto">
            {artifact.content}
          </div>
        );
    }
  };

  return (
    <Card className="mb-4 overflow-hidden">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            {getIcon()}
            <CardTitle className="text-sm">{artifact.title}</CardTitle>
            <span className="text-xs text-neutral-500 bg-neutral-100 px-2 py-1 rounded">
              {artifact.type}
            </span>
          </div>
          <div className="flex gap-1">
            <Button
              size="sm"
              variant="ghost"
              onClick={handleCopy}
              title="Copy content"
              className="h-8 w-8 p-0"
            >
              <Copy className="w-4 h-4" />
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={handleDownload}
              title="Download"
              className="h-8 w-8 p-0"
            >
              <Download className="w-4 h-4" />
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setIsExpanded(!isExpanded)}
              title="Expand"
              className="h-8 w-8 p-0"
            >
              <Maximize2 className="w-4 h-4" />
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className={isExpanded ? "max-h-[600px] overflow-y-auto" : "max-h-[300px] overflow-y-auto"}>
        {renderContent()}
      </CardContent>
    </Card>
  );
}

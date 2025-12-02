import { useState, useMemo } from "react";
import { Artifact } from "@shared/schema";
import { Copy, Download, Maximize2, Code, Table, BarChart3, FileJson, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { LineChart, Line, BarChart, Bar, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from "recharts";
import DOMPurify from "isomorphic-dompurify";

interface ArtifactDisplayProps {
  artifact: Artifact;
}

export default function ArtifactDisplay({ artifact }: ArtifactDisplayProps) {
  const [showFullscreen, setShowFullscreen] = useState(false);

  // Sanitize HTML content to prevent XSS attacks
  const sanitizedHTML = useMemo(() => {
    if (artifact.type === "html") {
      return DOMPurify.sanitize(artifact.content, {
        ADD_TAGS: ["iframe"],
        ADD_ATTR: ["allow", "allowfullscreen", "frameborder", "scrolling"]
      });
    }
    return artifact.content;
  }, [artifact.content, artifact.type]);

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
      default:
        return <FileJson className="w-4 h-4" />;
    }
  };

  const tryParseAndRenderTable = (content: string) => {
    try {
      const data = JSON.parse(content);
      if (Array.isArray(data) && data.length > 0) {
        const keys = Object.keys(data[0]);
        return (
          <div className="overflow-x-auto">
            <table className="w-full text-sm border-collapse border border-neutral-200">
              <thead>
                <tr className="bg-neutral-100">
                  {keys.map((key, i) => (
                    <th key={i} className="p-2 border border-neutral-200 font-semibold text-left">
                      {String(key)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.map((row, i) => (
                  <tr key={i} className={i % 2 === 0 ? "bg-white" : "bg-neutral-50"}>
                    {keys.map((key, j) => (
                      <td key={j} className="p-2 border border-neutral-200 text-xs">
                        {String(row[key] || "")}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      }
    } catch (e) {
      // Not a table-like JSON structure
    }
    return null;
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
        const tableRender = tryParseAndRenderTable(artifact.content);
        if (tableRender) {
          return tableRender;
        }
        return (
          <div className="bg-neutral-900 text-neutral-100 p-4 rounded overflow-x-auto">
            <pre className="text-xs font-mono">{JSON.stringify(JSON.parse(artifact.content), null, 2)}</pre>
          </div>
        );

      case "table":
        const isMarkdownTable = artifact.content.includes("|");
        if (isMarkdownTable) {
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
        }
        const tableRender2 = tryParseAndRenderTable(artifact.content);
        return tableRender2 || <div className="text-sm text-neutral-600">Invalid table data</div>;

      case "chart":
        try {
          const chartData = JSON.parse(artifact.content);
          if (chartData.type === "line" && Array.isArray(chartData.data)) {
            return (
              <ResponsiveContainer width="100%" height={300}>
                <LineChart data={chartData.data}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey={Object.keys(chartData.data[0])[0]} />
                  <YAxis />
                  <Tooltip />
                  <Legend />
                  {chartData.lines?.map((line: any, i: number) => (
                    <Line
                      key={i}
                      type="monotone"
                      dataKey={line.key}
                      stroke={line.color || "#8884d8"}
                      strokeWidth={2}
                      dot={false}
                      name={line.name || line.key}
                    />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            );
          } else if (chartData.type === "area" && Array.isArray(chartData.data)) {
            return (
              <ResponsiveContainer width="100%" height={300}>
                <AreaChart data={chartData.data}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey={Object.keys(chartData.data[0])[0]} />
                  <YAxis />
                  <Tooltip />
                  <Legend />
                  {chartData.lines?.map((line: any, i: number) => (
                    <Area
                      key={i}
                      type="monotone"
                      dataKey={line.key}
                      stroke={line.color || "#8884d8"}
                      fill={line.fill || `${line.color}40`}
                      strokeWidth={2}
                      name={line.name || line.key}
                    />
                  ))}
                </AreaChart>
              </ResponsiveContainer>
            );
          } else if (chartData.type === "bar" && Array.isArray(chartData.data)) {
            return (
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={chartData.data}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey={Object.keys(chartData.data[0])[0]} />
                  <YAxis />
                  <Tooltip />
                  <Legend />
                  {chartData.bars?.map((bar: any, i: number) => (
                    <Bar
                      key={i}
                      dataKey={bar.key}
                      fill={bar.color || "#8884d8"}
                      name={bar.name || bar.key}
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
        // HTML content is sanitized with DOMPurify to prevent XSS attacks
        // sandbox allows both scripts and same-origin for full functionality
        return (
          <iframe
            srcDoc={sanitizedHTML}
            className="w-full h-80 border border-neutral-200 rounded"
            sandbox="allow-scripts allow-same-origin"
            title="HTML Artifact"
          />
        );

      default:
        return (
          <div className="bg-neutral-50 p-4 rounded text-sm text-neutral-700 font-mono overflow-x-auto max-h-64">
            {artifact.content}
          </div>
        );
    }
  };

  const FullscreenModal = () => (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-lg max-w-4xl w-full max-h-[90vh] overflow-y-auto flex flex-col">
        <div className="flex items-center justify-between p-6 border-b border-neutral-200 sticky top-0 bg-white">
          <div className="flex items-center gap-3">
            {getIcon()}
            <h2 className="text-lg font-semibold">{artifact.title}</h2>
            <span className="text-xs text-neutral-500 bg-neutral-100 px-2 py-1 rounded">{artifact.type}</span>
          </div>
          <div className="flex gap-2">
            <Button size="sm" variant="ghost" onClick={handleCopy} title="Copy">
              <Copy className="w-4 h-4" />
            </Button>
            <Button size="sm" variant="ghost" onClick={handleDownload} title="Download">
              <Download className="w-4 h-4" />
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setShowFullscreen(false)}>
              <X className="w-4 h-4" />
            </Button>
          </div>
        </div>
        <div className="p-6 overflow-auto flex-1">{renderContent()}</div>
      </div>
    </div>
  );

  return (
    <>
      <Card className="mb-4 overflow-hidden flex flex-col">
        <CardHeader className="pb-2 flex-shrink-0">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 min-w-0">
              {getIcon()}
              <CardTitle className="text-sm truncate">{artifact.title}</CardTitle>
              <span className="text-xs text-neutral-500 bg-neutral-100 px-2 py-1 rounded flex-shrink-0">{artifact.type}</span>
            </div>
            <div className="flex gap-1 flex-shrink-0">
              <Button size="sm" variant="ghost" onClick={handleCopy} title="Copy content" className="h-8 w-8 p-0">
                <Copy className="w-4 h-4" />
              </Button>
              <Button size="sm" variant="ghost" onClick={handleDownload} title="Download" className="h-8 w-8 p-0">
                <Download className="w-4 h-4" />
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setShowFullscreen(true)} title="Fullscreen" className="h-8 w-8 p-0">
                <Maximize2 className="w-4 h-4" />
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="overflow-auto flex-1 min-h-0 pb-4 pt-2">{renderContent()}</CardContent>
      </Card>

      {showFullscreen && <FullscreenModal />}
    </>
  );
}

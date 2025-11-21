import { Artifact } from "@shared/schema";

/**
 * Extracts artifacts from AI response text
 * Supports: code blocks, JSON, HTML, markdown tables
 */
export function extractArtifacts(content: string): { artifacts: Artifact[]; cleanContent: string } {
  const artifacts: Artifact[] = [];
  let cleanContent = content;
  
  // Pattern 1: Explicit artifact blocks (```artifact-type ... ```)
  const artifactBlockRegex = /```(html|json|chart|code|table|jsx|typescript|javascript|python)\n([\s\S]*?)```/gi;
  let match;
  
  // Run regex on cleanContent and update it progressively
  while ((match = artifactBlockRegex.exec(cleanContent)) !== null) {
    const type = match[1].toLowerCase();
    const rawContent = match[2].trim();
    
    // Map code language to artifact type
    let artifactType: "html" | "json" | "table" | "chart" | "code" = "code";
    let language = type;
    
    if (type === "html") {
      artifactType = "html";
    } else if (type === "json") {
      artifactType = "json";
    } else if (type === "chart") {
      artifactType = "chart";
      language = "json";
    } else if (type === "table") {
      artifactType = "table";
    } else {
      artifactType = "code";
    }
    
    // Extract title from first comment or use default
    let title = `${artifactType} artifact`;
    const titleMatch = rawContent.match(/\/\/\s*title:\s*(.+?)(?:\n|$)|#\s*title:\s*(.+?)(?:\n|$)/i);
    if (titleMatch) {
      title = titleMatch[1] || titleMatch[2];
    }
    
    artifacts.push({
      type: artifactType,
      title,
      content: rawContent,
      language
    });
    
    // Remove from cleanContent immediately and reset regex
    cleanContent = cleanContent.replace(match[0], "");
    artifactBlockRegex.lastIndex = 0; // Reset regex position after mutation
  }
  
  // Pattern 2: Markdown tables (detect | ... | patterns)
  const tableRegex = /\n(\|.+\n)(?:\|[-:\s|]+\n)((?:\|.+\n)*)/g;
  let tableMatch;
  let tableCount = 0;
  
  while ((tableMatch = tableRegex.exec(cleanContent)) !== null) {
    const tableContent = tableMatch[0].trim();
    
    artifacts.push({
      type: "table",
      title: `Data Table ${++tableCount}`,
      content: tableContent,
      language: "markdown"
    });
    
    cleanContent = cleanContent.replace(tableContent, "");
  }
  
  // Pattern 3 removed: Pattern 1 already handles ```json blocks
  // No need to extract JSON blocks again - this was causing duplicate artifacts
  
  // Trim excessive whitespace from clean content
  cleanContent = cleanContent.replace(/\n\n\n+/g, "\n\n").trim();
  
  return { artifacts, cleanContent };
}

/**
 * Generates chart artifact from structured data
 */
export function generateChartArtifact(data: any, title: string = "Data Chart"): Artifact {
  return {
    type: "chart",
    title,
    content: JSON.stringify(data, null, 2),
    language: "json"
  };
}

/**
 * Generates table artifact from data array
 */
export function generateTableArtifact(data: any[], title: string = "Data Table"): Artifact {
  // Convert array of objects to markdown table
  if (!data || data.length === 0) {
    return {
      type: "table",
      title,
      content: "No data available",
      language: "markdown"
    };
  }
  
  const keys = Object.keys(data[0]);
  const headers = keys.map(k => k.replace(/_/g, " ")).join(" | ");
  const separator = keys.map(() => "---").join(" | ");
  const rows = data
    .map(row => keys.map(k => String(row[k] || "")).join(" | "))
    .join("\n");
  
  const content = `| ${headers} |\n| ${separator} |\n| ${rows.replace(/\n/g, " |\n| ")} |`;
  
  return {
    type: "table",
    title,
    content,
    language: "markdown"
  };
}

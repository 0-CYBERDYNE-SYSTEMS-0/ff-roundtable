import { Artifact } from "@shared/schema";
import { truncateChars } from "@shared/ics";
import { stripMarkdownToText } from "@shared/markdown";

/** Cap for titles derived from headings / header cells (SUMMARY adds " — Week N"). */
const DERIVED_TITLE_MAX_CHARS = 60;

/** Collapse all whitespace runs (incl. newlines) to single spaces. */
function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Nearest markdown heading strictly before `position` in the expert output,
 * cleaned to plain text. Used to name table/JSON artifacts ("## Spring Nitrogen
 * Plan" above a table beats "Data Table 1"). Headings recorded in `consumed`
 * are skipped so a later artifact cannot inherit an earlier artifact's title.
 */
function nearestPrecedingHeading(
  content: string,
  position: number,
  consumed: Set<string>,
): { line: string; text: string } | undefined {
  const before = content.slice(0, position);
  const headingLine = /^[ \t]*#{1,6}[ \t]+(.+)$/gm;
  let match: RegExpExecArray | null;
  let last: { line: string; text: string } | undefined;
  while ((match = headingLine.exec(before)) !== null) {
    if (consumed.has(match[0])) continue;
    const cleaned = collapseWhitespace(stripMarkdownToText(match[1]));
    if (cleaned) last = { line: match[0], text: cleaned };
  }
  return last;
}

/** Emoji & symbol decorations the system prompt coaches ("🌱 Week", "🗓️"). */
const EMOJI_DECORATION_RE = /[\uD83C-\uD83E][\uDC00-\uDFFF]|[\u2600-\u27BF]|\uFE0F|\u200D/g;

/**
 * First non-empty header cell of a markdown pipe table, cleaned to plain text
 * (markdown markers and emoji decorations dropped). "🌱 Spring Tasks" -> "Spring Tasks".
 */
function firstHeaderCell(tableContent: string): string | undefined {
  const firstLine = tableContent.split("\n", 1)[0] ?? "";
  const rawCell = firstLine
    .split("|")
    .map((cell) => cell.trim())
    .find((cell) => cell.length > 0);
  if (!rawCell) return undefined;
  const cleaned = collapseWhitespace(stripMarkdownToText(rawCell).replace(EMOJI_DECORATION_RE, ""));
  return cleaned || undefined;
}

/** Prefer a derived human title; fall back to the generic counter-based one. */
function deriveTitle(
  derived: string | undefined,
  fallbackFactory: () => string,
): string {
  return derived ? truncateChars(derived, DERIVED_TITLE_MAX_CHARS) : fallbackFactory();
}

/**
 * Extracts artifacts from AI response text
 * Supports: code blocks, JSON, HTML, markdown tables
 */
export function extractArtifacts(content: string): { artifacts: Artifact[]; cleanContent: string } {
  const artifacts: Artifact[] = [];
  let cleanContent = content;
  // Headings already spent on an artifact — a heading names exactly one block.
  const consumedHeadings = new Set<string>();
  
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

    // Title preference: nearest preceding markdown heading, else the table's
    // first header cell, else "Data Table N".
    const heading = nearestPrecedingHeading(cleanContent, tableMatch.index, consumedHeadings);
    const headerTitle = firstHeaderCell(tableContent);
    const title = deriveTitle(heading?.text ?? headerTitle, () => `Data Table ${++tableCount}`);
    if (heading) consumedHeadings.add(heading.line);

    artifacts.push({
      type: "table",
      title,
      content: tableContent,
      language: "markdown"
    });
    
    cleanContent = cleanContent.replace(tableContent, "");
    tableRegex.lastIndex = 0; // Reset regex position after mutation
  }
  
  // Pattern 3: Detect unfenced JSON blocks (structured data without code fences)
  // Use a more sophisticated approach to find balanced JSON objects/arrays
  let jsonCount = 0;
  let searchPos = 0;
  
  while (searchPos < cleanContent.length) {
    // Look for opening braces/brackets
    const openBrace = cleanContent.indexOf('{', searchPos);
    const openBracket = cleanContent.indexOf('[', searchPos);
    
    if (openBrace === -1 && openBracket === -1) break;
    
    const startPos = (openBrace === -1) ? openBracket : 
                      (openBracket === -1) ? openBrace :
                      Math.min(openBrace, openBracket);
    
    // Try to find matching closing brace/bracket
    const openChar = cleanContent[startPos];
    const closeChar = openChar === '{' ? '}' : ']';
    let depth = 1;
    let endPos = startPos + 1;
    
    while (endPos < cleanContent.length && depth > 0) {
      if (cleanContent[endPos] === openChar) depth++;
      else if (cleanContent[endPos] === closeChar) depth--;
      endPos++;
    }
    
    if (depth === 0) {
      const potentialJson = cleanContent.substring(startPos, endPos).trim();
      
      // Only extract if it's valid JSON and reasonably sized
      if (potentialJson.length > 20) {
        try {
          JSON.parse(potentialJson);

          // Same title preference as tables: preceding heading, else generic.
          const heading = nearestPrecedingHeading(cleanContent, startPos, consumedHeadings);
          const title = deriveTitle(heading?.text, () => `JSON Data ${++jsonCount}`);
          if (heading) consumedHeadings.add(heading.line);

          artifacts.push({
            type: "json",
            title,
            content: potentialJson,
            language: "json"
          });
          
          // Remove the JSON and continue from the start of removal
          cleanContent = cleanContent.substring(0, startPos) + cleanContent.substring(endPos);
          searchPos = startPos; // Continue from where we removed
          continue;
        } catch {
          // Not valid JSON, continue searching after this position
        }
      }
    }
    
    searchPos = startPos + 1; // Move past this character
  }
  
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
 * Generates table artifact from data array.
 * Title preference: caller title, else the first header (column) name, else "Data Table".
 */
export function generateTableArtifact(data: any[], title?: string): Artifact {
  // Convert array of objects to markdown table
  if (!data || data.length === 0) {
    return {
      type: "table",
      title: title || "Data Table",
      content: "No data available",
      language: "markdown"
    };
  }

  const keys = Object.keys(data[0]);
  const resolvedTitle =
    title ||
    deriveTitle(
      collapseWhitespace(stripMarkdownToText(String(keys[0] ?? "").replace(/_/g, " "))) || undefined,
      () => "Data Table",
    );
  const headers = keys.map(k => k.replace(/_/g, " ")).join(" | ");
  const separator = keys.map(() => "---").join(" | ");
  const rows = data
    .map(row => keys.map(k => String(row[k] || "")).join(" | "))
    .join("\n");

  const content = `| ${headers} |\n| ${separator} |\n| ${rows.replace(/\n/g, " |\n| ")} |`;

  return {
    type: "table",
    title: resolvedTitle,
    content,
    language: "markdown"
  };
}

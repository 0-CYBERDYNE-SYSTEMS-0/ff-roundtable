import { format } from "date-fns";

// Format a date for display in the chat
export function formatMessageDate(timestamp: Date): string {
  const now = new Date();
  const messageDate = new Date(timestamp);
  
  // If it's today, return "Today"
  if (
    messageDate.getDate() === now.getDate() &&
    messageDate.getMonth() === now.getMonth() &&
    messageDate.getFullYear() === now.getFullYear()
  ) {
    return "Today";
  }
  
  // If it's yesterday, return "Yesterday"
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (
    messageDate.getDate() === yesterday.getDate() &&
    messageDate.getMonth() === yesterday.getMonth() &&
    messageDate.getFullYear() === yesterday.getFullYear()
  ) {
    return "Yesterday";
  }
  
  // Otherwise, return the formatted date
  return format(messageDate, "MMMM d, yyyy");
}

// Get file icon based on file type
export function getFileIcon(fileType: string): string {
  if (fileType.includes("image")) {
    return "image";
  } else if (fileType.includes("pdf")) {
    return "picture_as_pdf";
  } else if (fileType.includes("spreadsheet") || fileType.includes("excel") || fileType.includes("csv")) {
    return "table_chart";
  } else if (fileType.includes("word") || fileType.includes("document")) {
    return "description";
  } else if (fileType.includes("presentation") || fileType.includes("powerpoint")) {
    return "slideshow";
  } else if (fileType.includes("text")) {
    return "text_snippet";
  } else if (fileType.includes("zip") || fileType.includes("compressed")) {
    return "folder_zip";
  } else {
    return "insert_drive_file";
  }
}

// Convert file size to human-readable format
export function formatFileSize(bytes: number): string {
  if (bytes === 0) return "0 Bytes";
  
  const k = 1024;
  const sizes = ["Bytes", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

// Convert markdown to HTML
export function markdownToHtml(markdown: string): string {
  // This is a simplified version - in a real implementation, use a library like marked
  
  // Convert headers
  let html = markdown
    .replace(/^### (.*$)/gim, "<h3>$1</h3>")
    .replace(/^## (.*$)/gim, "<h2>$1</h2>")
    .replace(/^# (.*$)/gim, "<h1>$1</h1>");
    
  // Convert bold and italic
  html = html
    .replace(/\*\*(.*)\*\*/gim, "<strong>$1</strong>")
    .replace(/\*(.*)\*/gim, "<em>$1</em>");
    
  // Convert lists
  html = html
    .replace(/^\s*\n\*/gim, "<ul>\n*")
    .replace(/^(\*.+)\s*\n([^\*])/gim, "$1\n</ul>\n\n$2")
    .replace(/^\*(.+)/gim, "<li>$1</li>");
    
  // Convert paragraphs
  html = html
    .replace(/^\s*\n\s*$/gim, "</p><p>")
    .replace(/^(.+)\s*\n/gim, "$1<br />");
    
  // Wrap in paragraph tags
  html = "<p>" + html + "</p>";
  
  return html;
}

// Generate a markdown export of a conversation
export function generateMarkdownExport(
  title: string,
  date: Date,
  experts: any[],
  messages: any[]
): string {
  let markdown = `# Farm Friend Roundtable: ${title}\n\n`;
  markdown += `Date: ${format(date, "MMMM d, yyyy")}\n\n`;
  
  markdown += "## Experts\n\n";
  for (const expert of experts) {
    markdown += `- **${expert.name}** (${expert.role})\n`;
  }
  
  markdown += "\n## Conversation\n\n";
  
  for (const message of messages) {
    if (message.userId) {
      markdown += `### You:\n\n${message.content}\n\n`;
    } else if (message.expertId) {
      const expert = experts.find((e: any) => e.id === message.expertId);
      if (expert) {
        markdown += `### ${expert.name} (${expert.role}):\n\n${message.content}\n\n`;
      }
    }
  }
  
  return markdown;
}

// Download a string as a file
export function downloadStringAsFile(content: string, filename: string, contentType: string): void {
  const blob = new Blob([content], { type: contentType });
  const url = URL.createObjectURL(blob);
  
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  
  URL.revokeObjectURL(url);
}

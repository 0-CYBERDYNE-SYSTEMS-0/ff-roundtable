import { storage } from "./storage";
// Import shared DB types
import type { InsertMessage, Expert, InsertFile, Message, File, Artifact, FarmProfile } from "@shared/schema"; 
import { extractArtifacts } from "./artifact-extractor";
import OpenAI from "openai";
import path from "path";
import fs from "fs";
import axios from "axios";
import { randomBytes } from "crypto";
import { getProvider } from "./ai-providers";

const AI_REQUEST_TIMEOUT_MS = 120_000;
const MAX_MODEL_MESSAGE_CHARS = 12_000;
const MAX_FILE_CONTEXT_FILES = 10;

function truncateForModel(content: string, maxChars = MAX_MODEL_MESSAGE_CHARS): string {
  return content.length > maxChars
    ? `${content.slice(0, maxChars)}\n... [Content Truncated] ...`
    : content;
}

function sanitizeGeneratedFilename(filename: string): string {
  const basename = path.basename(filename);
  return basename.replace(/[^a-zA-Z0-9_.-]/g, "_") || "generated-file";
}

// Define the structure for messages sent to AI APIs
export interface AIMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface AIModelResponse {
  message: {
    role: string;
    content: string;
  };
  citations?: string[];
}

// Generate a system prompt for an expert
// Pass availableRoles separately, plus optional farm context and weather
export function generateSystemPrompt(
  expert: Expert, 
  availableRoles?: string[],
  farmContext?: string,
  weatherContext?: string
): string {
  let basePrompt = `You are an AI expert in the role of ${expert.role} participating in a roundtable discussion on agricultural topics.
As a ${expert.role}, your expertise is highly valued, and you should focus on providing insights specific to your domain.
Always be respectful, helpful, and conversational while maintaining your expert perspective.

You are part of a team of experts: [${availableRoles?.join(', ') || 'various roles'}].
`;

  // Inject farmer's custom instructions for this expert if present
  if (expert.customInstructions?.trim()) {
    basePrompt += `\n📌 CUSTOM INSTRUCTIONS FROM THE FARMER (follow these closely):\n${expert.customInstructions.trim()}\n`;
  }

  // Inject farm profile context if available
  if (farmContext) {
    basePrompt += `\n🌾 FARMER CONTEXT — You are advising a REAL farmer with this operation:\n${farmContext}\n\nCRITICAL: Tailor ALL your advice to this specific farm. Reference their crops, acreage, soil type, location, and water situation directly. Do NOT give generic advice that ignores these details.\n`;
  }

  // Inject weather context if available
  if (weatherContext) {
    basePrompt += `\n🌤️ CURRENT WEATHER AT THE FARM:\n${weatherContext}\n\nUse this weather data to inform your recommendations about irrigation, planting, pest pressure, field operations, and harvest timing.\n`;
  }

  const interactionPrompt = `During discussion, actively engage with other experts. Reference their points and ask clarifying questions.
If you want to direct a comment or question to a specific expert, use '@[Role Name]' (e.g., '@Soil Scientist').
Be concise and clear in your responses.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✨ CREATE VIBRANT, VISUALLY STUNNING INTERACTIVE DATA VISUALIZATIONS ✨
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

When presenting data, trends, or insights, ALWAYS create visually striking, colorful interactive visualizations:

📊 MULTI-LINE CHARTS (BEST for multiple metrics over time):
\`\`\`chart
{
  "type": "line",
  "data": [
    {"time": "Jan", "yield": 45, "rainfall": 52, "temp": 38, "quality": 61},
    {"time": "Feb", "yield": 52, "rainfall": 48, "temp": 55, "quality": 68},
    {"time": "Mar", "yield": 68, "rainfall": 61, "temp": 62, "quality": 75},
    {"time": "Apr", "yield": 73, "rainfall": 70, "temp": 68, "quality": 82}
  ],
  "lines": [
    {"key": "yield", "color": "#10B981", "name": "Crop Yield"},
    {"key": "rainfall", "color": "#3B82F6", "name": "Rainfall"},
    {"key": "temp", "color": "#F59E0B", "name": "Temperature"},
    {"key": "quality", "color": "#8B5CF6", "name": "Quality Index"}
  ],
  "title": "Seasonal Agricultural Trends"
}
\`\`\`

📈 MULTI-AREA CHARTS (BEST for cumulative contributions or stacked trends):
\`\`\`chart
{
  "type": "area",
  "data": [
    {"week": "W1", "organic": 120, "nitrogen": 80, "phosphorus": 60},
    {"week": "W2", "organic": 150, "nitrogen": 95, "phosphorus": 78},
    {"week": "W3", "organic": 180, "nitrogen": 110, "phosphorus": 95},
    {"week": "W4", "organic": 210, "nitrogen": 130, "phosphorus": 115}
  ],
  "lines": [
    {"key": "organic", "color": "#059669", "name": "Organic Matter"},
    {"key": "nitrogen", "color": "#0284C7", "name": "Nitrogen (N)"},
    {"key": "phosphorus", "color": "#DC2626", "name": "Phosphorus (P)"}
  ],
  "title": "Soil Nutrient Accumulation"
}
\`\`\`

📊 MULTI-BAR CHARTS (BEST for comparing multiple metrics across categories):
\`\`\`chart
{
  "type": "bar",
  "data": [
    {"region": "North", "corn": 2400, "wheat": 1800, "soy": 2200},
    {"region": "South", "corn": 2100, "wheat": 2200, "soy": 1900},
    {"region": "East", "corn": 2800, "wheat": 1600, "soy": 2600},
    {"region": "West", "corn": 2200, "wheat": 1900, "soy": 2500}
  ],
  "bars": [
    {"key": "corn", "color": "#FBBF24", "name": "Corn Yield"},
    {"key": "wheat", "color": "#F97316", "name": "Wheat Yield"},
    {"key": "soy", "color": "#84CC16", "name": "Soybean Yield"}
  ],
  "title": "Regional Yield Comparison"
}
\`\`\`

📋 DYNAMIC, COLORFUL DATA TABLES - Use visual elements throughout:

\`\`\`table
| 🌱 Metric | 📊 Current | 🎯 Target | 📈 Trend | ✅ Status |
| --------- | --------- | --------- | -------- | --------- |
| **Performance** | 85% | 90% | ↑ +5% | ✓ Optimal |
| **Efficiency** | 72 units | 80 units | → Stable | ⚠️ Monitor |
| **Growth** | 12% | 15% | ↓ -1% | ✗ Action |
| **Quality** | 94% | 95% | ↑ +3% | ✓ Optimal |
\`\`\`

🎨 VISUAL PRINCIPLES FOR MAXIMUM IMPACT:

✓ Use VIBRANT, SATURATED COLORS: Emerald (#10B981), Blue (#3B82F6), Amber (#F59E0B), Violet (#8B5CF6)
✓ Always include 3+ series when visualizing complex relationships
✓ Use EMOJI INDICATORS (🌱, 📊, 🎯, 📈, ✅, ⚠️, ↑, ↓, →) in tables for quick visual parsing
✓ Make headers BOLD and use varied row emphasis
✓ Titles should be insight-driven (e.g., "Optimal Growth Detected" vs "Yield Data")
✓ Provide legend identifying each metric or series

For HTML content:
\`\`\`html
<div style="background: linear-gradient(135deg, #10b981 0%, #3b82f6 100%); padding: 24px; border-radius: 12px; color: white; font-family: sans-serif;">
  <h2 style="margin-top: 0;">Insight Discovery</h2>
  <p>Make your content visually stimulating and contextually rich!</p>
</div>
\`\`\`

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Success = Dynamic Data + Vibrant Visuals + Clear Expert Insights
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`;

  // Add role-specific instructions
  let roleInstructions = "";
  
  switch (expert.role) {
    case "Soil Scientist":
      roleInstructions = `Focus on soil health, composition, testing methods, and fertilization recommendations.
Provide insights on soil types, pH levels, nutrient content, organic matter, and sustainable soil management practices.
When appropriate, explain how soil conditions impact crop growth and farm productivity.`;
      break;
    case "Crop Specialist":
      roleInstructions = `Focus on crop varieties, rotation strategies, planting techniques, and yield optimization.
Provide insights on seed selection, crop health, disease identification, and sustainable farming methods.
When appropriate, explain how different crop choices and techniques impact overall farm productivity.`;
      break;
    case "Irrigation Engineer":
      roleInstructions = `Focus on water management systems, irrigation scheduling, water conservation, and drainage solutions.
Provide insights on irrigation technologies, water quality, efficiency improvements, and sustainable water use.
When appropriate, explain how water management impacts crop health and farm sustainability.`;
      break;
    case "Pest Management":
      roleInstructions = `Focus on insect, disease, and weed control using integrated pest management techniques.
Provide insights on pest identification, prevention strategies, biological controls, and judicious use of pesticides.
When appropriate, explain how pest management impacts crop health, yield, and environmental sustainability.`;
      break;
    case "Meteorologist":
      roleInstructions = `Focus on weather patterns, climate impacts on agriculture, and seasonal forecasting.
Provide insights on temperature trends, precipitation patterns, extreme weather events, and climate adaptation strategies.
When appropriate, explain how weather conditions impact farming decisions and risk management.`;
      break;
    case "File Creator":
      roleInstructions = `You specialize in creating useful files based on the discussion (e.g., reports, plans, data summaries, code snippets). 
      When asked to create a file, respond ONLY with a JSON object containing the file details. 
      The JSON object MUST have the following structure:
      {
        "filename": "your_suggested_filename.ext",
        "filetype": "mime/type or descriptive type like 'text/plain', 'text/csv', 'application/json', etc.",
        "content": "The full content of the file goes here as a string. Ensure proper escaping if the content itself is JSON or contains special characters."
      }
      Do NOT include any other text, explanation, or formatting outside of this JSON object in your response.
      `;
      break;
    case "Research Analyst":
      roleInstructions = `Focus on researching topics using external tools, summarizing findings, and providing citations.`;
      break;
    case "Imagery Specialist":
      roleInstructions = `Focus on analyzing satellite, drone, or field imagery to provide visual insights and interpretations. If images are provided, describe what you see and its relevance.`;
      break;
    case "Moderator":
      roleInstructions = `Facilitate the discussion, summarize key points, ensure all experts contribute, and manage conversation flow. 
      When asked who should speak next, analyze the last few messages and the overall goal. Respond ONLY with the role name of the expert who should speak next (e.g., 'Crop Specialist'). Do not add any other text. If unsure, suggest 'RoundRobin'.`;
      break;
    default:
      roleInstructions = `Provide insights based on your general agricultural knowledge.`;
  }

  return basePrompt + interactionPrompt + roleInstructions;
}

// Function to call AI API (routes through provider abstraction)
export async function callOpenRouterAPI(messages: AIMessage[], model: string): Promise<AIModelResponse> {
  const provider = getProvider(model);
  return provider.chat(messages, model);
}

// Function to call AI API with streaming (SSE) — routes through provider abstraction
export async function callOpenRouterAPIStream(
  messages: AIMessage[], 
  model: string,
  onToken: (token: string) => void
): Promise<AIModelResponse> {
  const provider = getProvider(model);
  return provider.chatStream(messages, model, onToken);
}

// Function to call Perplexity API for web search
export async function callPerplexityAPI(query: string): Promise<AIModelResponse> {
  try {
    const perplexityKey = process.env.PERPLEXITY_API_KEY;
    if (!perplexityKey) {
      throw new Error("Perplexity API key not provided");
    }
    
    console.log("Calling Perplexity API for research query");
    
    const response = await fetch("https://api.perplexity.ai/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${perplexityKey}`
      },
      body: JSON.stringify({
        model: "sonar",
        messages: [
          {
            role: "system",
            content: "You are a Research Analyst specializing in agriculture. Provide concise, accurate information with relevant citations."
          },
          {
            role: "user",
            content: query
          }
        ],
        temperature: 0.2,
        max_tokens: 1024,
        stream: false
      }),
      signal: AbortSignal.timeout(AI_REQUEST_TIMEOUT_MS),
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Perplexity API Error (${response.status}): ${errorText}`);
    }
    
    const data = await response.json();
    
    if (!data || !data.choices || !Array.isArray(data.choices) || data.choices.length === 0) {
      console.error("Invalid response from Perplexity API:", JSON.stringify(data));
      throw new Error("Invalid response format from Perplexity API");
    }
    
    if (!data.choices[0] || !data.choices[0].message) {
      console.error("Missing message in Perplexity API response:", JSON.stringify(data.choices[0]));
      throw new Error("Missing message in Perplexity API response");
    }
    
    return {
      message: data.choices[0].message,
      citations: data.citations || []
    };
  } catch (error: unknown) {
    console.error("Error calling Perplexity API:", error);
    if (error instanceof Error) {
      throw error;
    } else {
      throw new Error(`Unknown error: ${String(error)}`);
    }
  }
}

// Helper function to safely map DB roles to AI API roles
const mapDbRoleToApiRole = (dbRole: string): AIMessage['role'] => {
  if (dbRole === 'user') return 'user';
  if (dbRole === 'assistant') return 'assistant';
  if (dbRole === 'system') return 'system';
  return 'assistant'; 
};

// Helper function to read and truncate file content
async function readFileContent(file: File, maxLength = 2000): Promise<string | null> {
    const isTextBased = file.fileType.startsWith('text/') || 
                       ['csv', 'json', 'javascript', 'typescript', 'python', 'markdown'].some(ext => file.fileType.includes(ext));

    if (!isTextBased) {
        return `[Content of non-text file (${file.fileType}) is not available in this context]`;
    }

    try {
        const relativePath = file.fileUrl.startsWith('/') ? file.fileUrl.substring(1) : file.fileUrl;
        const filePath = path.join(process.cwd(), relativePath); 

        if (!fs.existsSync(filePath)) {
             console.error(`readFileContent: File not found at path: ${filePath} (derived from ${file.fileUrl})`);
             return `[File ${file.filename} not found on server]`;
        }

        const content = await fs.promises.readFile(filePath, 'utf8');
        if (content.length > maxLength) {
            return content.substring(0, maxLength) + '\n... [Content Truncated] ...';
        }
        return content;
    } catch (error) {
        console.error(`readFileContent: Error reading file ${file.filename}:`, error);
        return `[Error reading content of file ${file.filename}]`;
    }
}

// Function to generate response for a single expert WITH STREAMING
// Calls onToken for each token chunk, returns the final InsertMessage
export async function getExpertResponseStream(
  expert: Expert, 
  history: Message[], 
  referenceMessageContent: string, 
  files: File[],
  availableRoles: string[],
  onToken: (token: string) => void
): Promise<InsertMessage> { 
  console.log(`[STREAM] Generating streaming response for expert: ${expert.name} (${expert.role})`);
  
  // Fetch farm profile and weather for context
  const conversation = await storage.getConversation(expert.conversationId);
  let farmContext = "";
  let weatherContext = "";
  if (conversation) {
    try {
      const profile = await storage.getFarmProfile(conversation.userId);
      if (profile && (profile.location || profile.crops?.length)) {
        farmContext = `Farm: ${profile.farmName}\nLocation: ${profile.location}\nAcres: ${profile.acres || 'N/A'}\nCrops: ${(profile.crops || []).join(', ') || 'N/A'}\nSoil Type: ${profile.soilType || 'N/A'}\nWater Source: ${profile.waterSource || 'N/A'}\nClimate Zone: ${profile.climateZone || 'N/A'}\nHardiness Zone: ${profile.hardinessZone || 'N/A'}`;
        
        // Fetch weather if coords available
        if (profile.lat && profile.lng) {
          const { getWeatherForFarm, formatWeatherContext } = await import('./weather');
          const weather = await getWeatherForFarm(profile.lat, profile.lng);
          if (weather) {
            weatherContext = formatWeatherContext(weather);
          }
        }
      }
    } catch (err) {
      console.warn('[STREAM] Could not fetch farm/weather context:', (err as Error).message);
    }
  }
  
  const systemPrompt = generateSystemPrompt(expert, availableRoles, farmContext, weatherContext);
  
  const messages: AIMessage[] = [
    { role: "system", content: systemPrompt }
  ];

  if (files.length > 0) {
     let fileContextString = "\n\n--- Attached Files Context ---\n";
     for (const file of files.slice(0, MAX_FILE_CONTEXT_FILES)) {
         const contentSnippet = await readFileContent(file);
         fileContextString += `\nFile Name: ${file.filename} (${file.fileType})\n`;
         if (contentSnippet) {
              fileContextString += `Content Snippet:\n\`\`\`\n${contentSnippet}\n\`\`\`\n`;
         }
     }
     fileContextString += "\n--- End Attached Files Context ---\n";
     messages.push({ role: "system", content: fileContextString });
  }

   messages.push(...history.map(msg => ({
      role: mapDbRoleToApiRole(msg.role),
      content: truncateForModel(msg.content)
   })).slice(-15));

   messages.push({ role: "user", content: truncateForModel(referenceMessageContent) });

   console.log(`[STREAM] Sending ${messages.length} messages to LLM for ${expert.role}.`);

  try {
    let response: AIModelResponse;
    
    if (expert.role === "Research Analyst") {
      // Use OpenRouter streaming for Research Analyst (Perplexity optional)
      if (process.env.PERPLEXITY_API_KEY && process.env.PERPLEXITY_API_KEY.length > 10) {
        response = await callPerplexityAPI(referenceMessageContent);
        onToken(response.message.content);
      } else {
        console.log("[STREAM] No Perplexity key — Research Analyst using OpenRouter streaming");
        response = await callOpenRouterAPIStream(messages, expert.model, onToken);
      }
    } 
    else if (expert.role === "File Creator") {
      // File Creator needs full response to parse JSON — use non-streaming
      response = await callOpenRouterAPI(messages, expert.model);
      onToken(response.message.content); // Send as single token
      
      try {
        const fileData = JSON.parse(response.message.content);
        if (!fileData.filename || !fileData.filetype || !fileData.content) {
          throw new Error("Invalid JSON structure from File Creator");
        }
        const uploadsDir = path.join(process.cwd(), "uploads");
        if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);
        const safeFilename = sanitizeGeneratedFilename(fileData.filename);
        const uniqueFilename = `${randomBytes(8).toString("hex")}-${safeFilename}`;
        const filePath = path.join(uploadsDir, uniqueFilename);
        fs.writeFileSync(filePath, fileData.content);
        const fileUrl = `/uploads/${uniqueFilename}`;

        const newFile: InsertFile = {
           conversationId: expert.conversationId,
           filename: safeFilename,
           fileUrl: fileUrl,
           fileType: fileData.filetype,
           uploadedBy: `Expert: ${expert.name}`,
        };
        await storage.createFile(newFile);
        response.message.content = `Created file: ${fileData.filename}`;
      } catch (jsonError) {
        console.error("File Creator error processing JSON:", jsonError);
        response.message.content = "(File Creator Error: Could not process request to create file.)";
      }
    }
    else {
      // MAIN PATH: Streaming via OpenRouter
      response = await callOpenRouterAPIStream(messages, expert.model, onToken);
    }
    
    const { artifacts, cleanContent } = extractArtifacts(response.message.content);
    
    return {
      conversationId: expert.conversationId,
      expertId: expert.id,
      userId: null,
      content: cleanContent,
      role: "assistant",
      expertName: expert.name,
      expertRole: expert.role,
      artifacts: artifacts
    };

  } catch (error) {
    console.error(`[STREAM] Error streaming from expert ${expert.name}:`, error);
    const errorMsg = `(Error generating response for ${expert.name}: ${error instanceof Error ? error.message : String(error)})`;
    onToken(errorMsg); // Show error inline
    return {
      conversationId: expert.conversationId,
      expertId: expert.id,
      userId: null,
      content: errorMsg,
      role: "assistant",
      expertName: expert.name,
      expertRole: expert.role,
    };
  }
}

// Function to generate response for a single expert (NON-STREAMING — kept for backward compat)
export async function getExpertResponse(
  expert: Expert, 
  history: Message[], 
  referenceMessageContent: string, 
  files: File[],
  availableRoles: string[] 
): Promise<InsertMessage> { 
  console.log(`Generating response for expert: ${expert.name} (${expert.role})`);
  const systemPrompt = generateSystemPrompt(expert, availableRoles); 
  
  const messages: AIMessage[] = [
    { role: "system", content: systemPrompt }
  ];

  if (files.length > 0) {
     let fileContextString = "\n\n--- Attached Files Context ---\n";
     for (const file of files.slice(0, MAX_FILE_CONTEXT_FILES)) {
         const contentSnippet = await readFileContent(file);
         fileContextString += `\nFile Name: ${file.filename} (${file.fileType})\n`;
         if (contentSnippet) {
              fileContextString += `Content Snippet:\n\`\`\`\n${contentSnippet}\n\`\`\`\n`;
         }
     }
     fileContextString += "\n--- End Attached Files Context ---\n";
     messages.push({ 
         role: "system", 
         content: fileContextString 
     });
  }

   messages.push(...history.map(msg => ({
      role: mapDbRoleToApiRole(msg.role),
      content: truncateForModel(msg.content)
   })).slice(-15));

   messages.push({ role: "user", content: truncateForModel(referenceMessageContent) });

   console.log(`[DEBUG] Sending ${messages.length} messages to LLM for ${expert.role}.`);

  try {
    let response: AIModelResponse;
    
    if (expert.role === "Research Analyst") {
      response = await callPerplexityAPI(referenceMessageContent);
    } 
    else if (expert.role === "File Creator") {
       response = await callOpenRouterAPI(messages, expert.model);
       
       try {
         const fileData = JSON.parse(response.message.content);
         
         if (!fileData.filename || !fileData.filetype || !fileData.content) {
           throw new Error("Invalid JSON structure from File Creator");
         }
         
         const uploadsDir = path.join(process.cwd(), "uploads");
         if (!fs.existsSync(uploadsDir)) {
           fs.mkdirSync(uploadsDir);
         }
         const safeFilename = sanitizeGeneratedFilename(fileData.filename);
        const uniqueFilename = `${randomBytes(8).toString("hex")}-${safeFilename}`;
         const filePath = path.join(uploadsDir, uniqueFilename);
         fs.writeFileSync(filePath, fileData.content);
         const fileUrl = `/uploads/${uniqueFilename}`;

         const newFile: InsertFile = {
            conversationId: expert.conversationId,
            filename: safeFilename,
            fileUrl: fileUrl,
            fileType: fileData.filetype,
            uploadedBy: `Expert: ${expert.name}`,
         };
         await storage.createFile(newFile);
         
         response.message.content = `Created file: ${fileData.filename}`;

       } catch (jsonError) {
          console.error("File Creator error processing JSON:", jsonError);
          response.message.content = "(File Creator Error: Could not process request to create file. Please ensure the request is clear and try again.)";
       }
    }
    else {
      response = await callOpenRouterAPI(messages, expert.model);
    }
    
    const { artifacts, cleanContent } = extractArtifacts(response.message.content);
    
    return {
      conversationId: expert.conversationId,
      expertId: expert.id,
      userId: null,
      content: cleanContent,
      role: "assistant",
      expertName: expert.name,
      expertRole: expert.role,
      artifacts: artifacts
    };

  } catch (error) {
    console.error(`Error getting response from expert ${expert.name}:`, error);
    return {
      conversationId: expert.conversationId,
      expertId: expert.id,
      userId: null,
      content: `(Error generating response for ${expert.name}: ${error instanceof Error ? error.message : String(error)})`,
      role: "assistant",
      expertName: expert.name,
      expertRole: expert.role,
    };
  }
}

// Function to generate insights
export async function generateInsights(conversationId: number, broadcastFn?: (convId: number, data: any) => void): Promise<void> {
  try {
    const messages = await storage.getConversationMessages(conversationId);
    if (messages.length < 3) return;
    
    const historyText = messages
      .slice(-20)
      .map(m => `${m.expertName || m.role}: ${truncateForModel(m.content)}`)
      .join("\n");
    
    const insightPrompt = `
    Based on the following agricultural conversation transcript, identify 1-3 key insights, recommendations, or unresolved questions. Be concise.
    
    Transcript:
    ${historyText}
    
    Format your response STRICTLY as a JSON object with this structure:
    {
      "title": "Brief overall topic",
      "points": ["Insight/Recommendation 1", "Insight/Recommendation 2", "Insight/Recommendation 3"]
    }
    Only output the JSON object.
    `;
    
    const response = await callOpenRouterAPI([
      { role: "system", content: "You extract key insights from agricultural conversations. Respond only with the requested JSON format." },
      { role: "user", content: insightPrompt }
    ], "mistralai/mixtral-8x7b-instruct"); 
    
    try {
      const insightData = JSON.parse(response.message.content);
      
      if (insightData.title && Array.isArray(insightData.points) && insightData.points.length > 0) {
        console.log(`Storing insights for conversation ${conversationId}:`, insightData);
        await storage.createInsight({ 
          conversationId,
          title: insightData.title,
          points: insightData.points
        });
        if (broadcastFn) {
          broadcastFn(conversationId, { type: "insights" });
        }
      } else {
         console.warn(`generateInsights: Received invalid JSON structure for ${conversationId}`, insightData);
      }
    } catch (e) {
      console.error(`generateInsights: Error parsing insights JSON for ${conversationId}:`, e, "\nRaw Response:", response.message.content);
    }
  } catch (error) {
    console.error(`generateInsights: Error generating insights for ${conversationId}:`, error);
  }
}

// New function to ask the Moderator who should speak next
export async function getModeratorNextSpeakerSuggestion(
  moderatorExpert: Expert,
  history: Message[],
  availableRoles: string[]
): Promise<string | null> {
    if (moderatorExpert.role !== 'Moderator') {
        console.warn("Attempted to get speaker suggestion from non-moderator expert.");
        return null;
    }
    console.log("Asking Moderator for next speaker suggestion...");
    const moderatorSystemPrompt = generateSystemPrompt(moderatorExpert, availableRoles);
    const queryPrompt = `Based on the recent conversation history, which expert should speak next to best advance the discussion towards resolution or new insights? The available expert roles are: [${availableRoles.join(', ')}]. Respond only with the role name or 'RoundRobin'.`;

    const messages: AIMessage[] = [
        { role: "system", content: moderatorSystemPrompt },
        ...history.slice(-6).map(msg => ({
             role: mapDbRoleToApiRole(msg.role),
             content: truncateForModel(msg.content)
        })),
        { role: "user", content: queryPrompt }
    ];

    try {
        const response = await callOpenRouterAPI(messages, moderatorExpert.model || 'mistralai/mistral-7b-instruct'); 
        const suggestedRole = response.message.content.trim().replace(/\.$/, '');
        
        if (availableRoles.includes(suggestedRole) || suggestedRole === 'RoundRobin') {
             console.log(`Moderator suggested next speaker: ${suggestedRole}`);
            return suggestedRole;
        } else {
            console.warn(`Moderator suggested an invalid role: '${suggestedRole}'. Falling back.`);
            return null;
        }
    } catch (error) {
        console.error("Error querying Moderator for next speaker:", error);
        return null;
    }
}

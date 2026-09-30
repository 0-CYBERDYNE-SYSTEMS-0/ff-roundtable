import { storage } from "./storage";
// Import shared DB types
import type { InsertMessage, Expert, InsertFile, Message, File, Artifact, FarmProfile } from "@shared/schema"; 
import { extractArtifacts } from "./artifact-extractor";
import { extractMentions } from "@shared/mentions";
import OpenAI from "openai";
import path from "path";
import fs from "fs";
import axios from "axios";
import { randomBytes } from "crypto";
import { getProvider } from "./ai-providers";
import { collectImageParts, isImageFile, MAX_IMAGE_PARTS, analyzedImageNote, makeAnalyzedBeforePredicate, type ImagePart } from "./image-context";

const AI_REQUEST_TIMEOUT_MS = 120_000;
const MAX_MODEL_MESSAGE_CHARS = 12_000;
const MAX_FILE_CONTEXT_FILES = 10;
// G9: cap on the carried-forward PRIOR DECISIONS system block.
const PRIOR_DECISIONS_MAX_CHARS = 1200;

function truncateForModel(content: string, maxChars = MAX_MODEL_MESSAGE_CHARS): string {
  return content.length > maxChars
    ? `${content.slice(0, maxChars)}\n... [Content Truncated] ...`
    : content;
}

function sanitizeGeneratedFilename(filename: string): string {
  const basename = path.basename(filename);
  return basename.replace(/[^a-zA-Z0-9_.-]/g, "_") || "generated-file";
}

// Multimodal content parts (OpenAI chat-completions format) — used to deliver
// uploaded images to vision-capable models alongside the text part.
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

// Define the structure for messages sent to AI APIs
export interface AIMessage {
  role: "system" | "user" | "assistant";
  content: string | ContentPart[];
}

export interface AIModelResponse {
  message: {
    role: string;
    content: string;
  };
  citations?: string[];
}

// AI-facing Moderator identity. A roster Moderator carries its persisted
// expert row ID; the system Moderator is synthetic and has no expert row.
export interface ModeratorContext {
  id: number | null;
  conversationId: number;
  name: string;
  role: "Moderator";
  model: string | null;
  systemPrompt: string;
}

// Generate a system prompt for an expert
// Pass availableRoles separately, plus optional farm context, weather, and the
// conversation's council charter (G6 — governs every expert when present).
export function generateSystemPrompt(
  expert:
    Pick<Expert, "role">
    & Partial<Pick<Expert, "customInstructions">>
    & Partial<Pick<ModeratorContext, "systemPrompt">>,
  availableRoles?: string[],
  farmContext?: string,
  weatherContext?: string,
  charter?: string | null
): string {
  let basePrompt = `You are an AI expert in the role of ${expert.role} participating in a roundtable discussion on agricultural topics.
As a ${expert.role}, your expertise is highly valued, and you should focus on providing insights specific to your domain.
Always be respectful, helpful, and conversational while maintaining your expert perspective.

You are part of a team of experts: [${availableRoles?.join(', ') || 'various roles'}].
`;

  // G10: the Moderator context may provide system-level instructions without
  // needing a persisted Expert row. Keep those instructions on the Moderator
  // prompt path only; ordinary experts retain their existing prompt behavior.
  if (expert.role === "Moderator" && expert.systemPrompt?.trim()) {
    basePrompt += `\nMODERATOR SYSTEM INSTRUCTIONS:\n${expert.systemPrompt.trim()}\n`;
  }

  // Inject farmer's custom instructions for this expert if present
  if (expert.customInstructions?.trim()) {
    basePrompt += `\n📌 CUSTOM INSTRUCTIONS FROM THE FARMER (follow these closely):\n${expert.customInstructions.trim()}\n`;
  }

  // G6: inject the farmer's council charter. It governs the whole roundtable
  // (goal, depth, stop criteria), so it sits above per-farm context.
  if (charter?.trim()) {
    basePrompt += `\n📜 COUNCIL CHARTER (governs this roundtable — all experts):\n${charter.trim()}\nAll experts follow this charter.\n`;
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
You can direct the discussion: if you write @[Role Name], that expert will be asked to speak next. Tag only when their expertise is genuinely needed; otherwise speak to the whole table.
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
      roleInstructions = `Focus on analyzing satellite, drone, or field imagery to provide visual insights and interpretations. If images are provided, describe what you see and its relevance.
Uploaded images are delivered to you directly as native vision input — describe and analyze what you actually see in them.`;
      break;
    case "Moderator":
      roleInstructions = `Facilitate the discussion, summarize key points, ensure all experts contribute, and manage conversation flow.
      When asked who should speak next, analyze the last few messages and the overall goal. Respond ONLY with the role name of the expert who should speak next (e.g., 'Crop Specialist'). Do not add any other text.
      G5: you may also end the roundtable — if the discussion has run its course (the farmer's question is answered, decisions are made, and further turns would only repeat the table), respond ONLY with 'Conclude' and the council will close with a final synthesis from you. If unsure, suggest 'RoundRobin'.`;
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

/**
 * Build the "Attached Files Context" system message plus native vision parts
 * for the user message. Text files are inlined as before; image/* files are
 * listed as delivered-visually and their base64 image_url parts are returned
 * for appending to the user message content (SPEC §B2-B3).
 *
 * F2 analyze-image-once: user-uploaded images that have already been analyzed
 * (an assistant message exists after the upload) are described by a one-line
 * text note instead of re-embedding their base64 payload on every turn.
 */
async function buildAttachedFilesContext(
    files: File[],
    history: Message[] = []
): Promise<{ context: string | null; imageParts: ImagePart[] }> {
    if (files.length === 0) {
        return { context: null, imageParts: [] };
    }

    const analyzedBefore = makeAnalyzedBeforePredicate(history);
    const { parts: imageParts, skipped: skippedImages, alreadyAnalyzed } =
        await collectImageParts(files, MAX_IMAGE_PARTS, analyzedBefore);

    // Which image filenames actually produced a vision part? Mirror the
    // most-recent-first selection used by collectImageParts so the text
    // listing never claims delivery for an image that was skipped,
    // already analyzed, or beyond the 2-part limit.
    const deliveredImageNames = new Set<string>();
    let deliveredCount = 0;
    for (const file of files.filter(isImageFile).sort((a, b) => {
        const ta = a.uploadedAt ? new Date(a.uploadedAt).getTime() : 0;
        const tb = b.uploadedAt ? new Date(b.uploadedAt).getTime() : 0;
        return tb - ta;
    })) {
        if (alreadyAnalyzed.includes(file.filename)) continue;
        if (deliveredCount >= imageParts.length) break;
        if (skippedImages.includes(file.filename)) continue;
        deliveredImageNames.add(file.filename);
        deliveredCount++;
    }

    let fileContextString = "\n\n--- Attached Files Context ---\n";
    for (const file of files.slice(0, MAX_FILE_CONTEXT_FILES)) {
        fileContextString += `\nFile Name: ${file.filename} (${file.fileType})\n`;
        if (isImageFile(file)) {
            if (deliveredImageNames.has(file.filename)) {
                fileContextString += `[Image attached: ${file.filename} — delivered visually]\n`;
            } else if (alreadyAnalyzed.includes(file.filename)) {
                fileContextString += `${analyzedImageNote(file.filename)}\n`;
            } else if (skippedImages.includes(file.filename)) {
                fileContextString += `[Image attached: ${file.filename} — not delivered (missing or over the 5 MB vision limit)]\n`;
            } else {
                fileContextString += `[Image attached: ${file.filename} — not delivered (vision input is limited to the 2 most recent images)]\n`;
            }
        } else {
            const contentSnippet = await readFileContent(file);
            if (contentSnippet) {
                fileContextString += `Content Snippet:\n\`\`\`\n${contentSnippet}\n\`\`\`\n`;
            }
        }
    }
    fileContextString += "\n--- End Attached Files Context ---\n";

    return { context: fileContextString, imageParts };
}

/**
 * Vision-rejecting providers phrase the failure around the modality ("Image
 * input is not supported by this model"). Requiring a rejection-shaped phrase
 * near the keyword keeps lookalikes honest — e.g. a 429 body that merely echoes
 * a model slug like "llama-3.2-11b-vision-instruct:free" is a rate limit, not a
 * rejection.
 */
const VISION_REJECTION_RE = new RegExp(
  "(?:image|vision|modalit|multimodal)[\\s\\S]{0,80}(?:not\\s+support|unsupport\\w*|reject\\w*|invalid|disabled|not\\s+allowed|can(?:not|'t)|unable)" +
  "|" +
  "(?:not\\s+support|unsupport\\w*|reject\\w*|invalid|disabled|not\\s+allowed|can(?:not|'t)|unable)[\\s\\S]{0,80}(?:image|vision|modalit|multimodal)" +
  "|" +
  // OpenRouter's real rejection shape: 404 "No endpoints found that support image input"
  "(?:support|accept|allow|handle)\\s+(?:[\\w-]+\\s+){0,2}(?:image|vision|multimodal|modalit)",
  "i",
);

/**
 * True when a provider error looks like the model rejected the vision input
 * itself AND this turn actually sent image parts.
 *
 * Status-bearing 4xx: only true modality rejections (400/404/422) qualify —
 * 429/402 bodies commonly echo vision-slug model names, so rate-limit and
 * payment failures keep the generic path. 413 counts too: with parts sent, the
 * payload overflow was caused by the images. Status-less shapes (a 200 response
 * wrapping {"error":{...}} surfaces as "OpenRouter/Local AI Provider Error: …")
 * fall back to the phrase test alone.
 */
function isVisionRejection(error: unknown, imageParts: ImagePart[]): boolean {
    if (imageParts.length === 0 || !(error instanceof Error)) return false;
    const status = error.message.match(/\((4\d{2})\)/)?.[1];
    if (status) {
      if (status === "413") return true;
      if (![400, 404, 422].includes(Number(status))) return false;
    }
    return VISION_REJECTION_RE.test(error.message);
}

/** Honest per-expert failure message for vision-rejecting models (SPEC §B4). */
function visionRejectionMessage(expertName: string): string {
    return `⚠️ ${expertName} could not analyze the image — this model doesn't accept image input. Try a vision-capable model (e.g. switch this expert to one, or use BYOK).`;
}

/**
 * G9 legibility: the structural slice of a stored Insight the carried-forward
 * block needs (a plain Insight satisfies this). id/createdAt are optional so
 * synthetic entries remain testable; the latest-insight pick falls back
 * through id → createdAt → insertion order.
 */
export interface PriorDecisionInsight {
    title: string;
    // Nullable to accept the drizzle select type of the insights.points
    // array column directly; non-array values are filtered out below.
    points: string[] | null | undefined;
    id?: number;
    createdAt?: Date | string | null;
}

/**
 * G9 legibility: build the compact "PRIOR DECISIONS" system block injected
 * into expert turns so the council builds on settled decisions from a prior
 * sequence instead of re-litigating them. Zero extra model calls — the block
 * is assembled from the insights already stored by generateInsights.
 *
 * Pure and unit-testable. Returns the block for the LATEST insight (highest
 * id, else newest createdAt, else last array entry — storage order is not
 * relied upon), or null when there is nothing usable. The whole block is
 * truncated to PRIOR_DECISIONS_MAX_CHARS via the shared truncator.
 */
export function buildPriorDecisionsBlock(insights: PriorDecisionInsight[]): string | null {
    if (!Array.isArray(insights) || insights.length === 0) return null;
    const withPoints = insights.filter(
        (i) => i && Array.isArray(i.points) && i.points.some((p) => typeof p === "string" && p.trim())
    );
    if (withPoints.length === 0) return null;
    const rank = (i: PriorDecisionInsight): number => {
        if (typeof i.id === "number") return i.id;
        const t = i.createdAt ? new Date(i.createdAt).getTime() : 0;
        return Number.isNaN(t) ? 0 : t;
    };
    const latest = withPoints.reduce((a, b) => (rank(b) >= rank(a) ? b : a));
    // The filter above guarantees an array, but narrowing doesn't survive
    // reduce — assert it locally.
    const latestPoints: string[] = Array.isArray(latest.points) ? latest.points : [];
    const bullets = latestPoints
        .filter((p) => typeof p === "string" && p.trim())
        .map((p) => `- ${p.trim()}`);
    if (bullets.length === 0) return null;
    return truncateForModel(
        `PRIOR DECISIONS (settled in an earlier round — do not re-litigate; build on these):\n${bullets.join("\n")}`,
        PRIOR_DECISIONS_MAX_CHARS
    );
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
          if (weather.ok) {
            weatherContext = formatWeatherContext(weather.data);
          }
        }
      }
    } catch (err) {
      console.warn('[STREAM] Could not fetch farm/weather context:', (err as Error).message);
    }
  }
  
  const systemPrompt = generateSystemPrompt(expert, availableRoles, farmContext, weatherContext, conversation?.charter ?? null);

  const messages: AIMessage[] = [
    { role: "system", content: systemPrompt }
  ];

  const { context: fileContext, imageParts } = await buildAttachedFilesContext(files, history);
  if (fileContext) {
     messages.push({ role: "system", content: fileContext });
  }

   messages.push(...history.map(msg => ({
      role: mapDbRoleToApiRole(msg.role),
      content: truncateForModel(msg.content)
   })).slice(-15));

   // G9 legibility: carried-forward context — the latest insight from a prior
   // sequence rides along as a compact system block (zero extra model calls).
   // Optional context: any storage hiccup is logged and skipped, never fatal.
   try {
     const priorInsights = await storage.getConversationInsights(expert.conversationId);
     const priorDecisionsBlock = buildPriorDecisionsBlock(priorInsights ?? []);
     if (priorDecisionsBlock) {
       messages.push({ role: "system", content: priorDecisionsBlock });
     }
   } catch (priorErr) {
     console.warn("[STREAM] Could not load prior decisions:", (priorErr as Error).message);
   }

   // With image parts present, the user message becomes a multimodal content
   // array. The 12k-char truncation applies to the TEXT part only — the
   // base64 image parts are appended verbatim, never truncated.
   const userText = truncateForModel(referenceMessageContent);
   messages.push(
      imageParts.length > 0
        ? { role: "user", content: [{ type: "text", text: userText }, ...imageParts] }
        : { role: "user", content: userText }
   );

   console.log(`[STREAM] Sending ${messages.length} messages to LLM for ${expert.role}${imageParts.length > 0 ? ` (with ${imageParts.length} image part${imageParts.length > 1 ? "s" : ""})` : ""}.`);

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
      artifacts: artifacts,
      // G4: parse the @-tags the model actually wrote so the orchestrator
      // can route on them (and the client can render chips) without
      // re-parsing the stored content.
      mentions: extractMentions(cleanContent, availableRoles)
    };

  } catch (error) {
    console.error(`[STREAM] Error streaming from expert ${expert.name}:`, error);
    const errorMsg = isVisionRejection(error, imageParts)
      ? visionRejectionMessage(expert.name)
      : `(Error generating response for ${expert.name}: ${error instanceof Error ? error.message : String(error)})`;
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
  // G6: fetch the conversation for its council charter (farm/weather context
  // is only wired into the streaming path).
  const conversation = await storage.getConversation(expert.conversationId);
  const systemPrompt = generateSystemPrompt(expert, availableRoles, undefined, undefined, conversation?.charter ?? null);
  
  const messages: AIMessage[] = [
    { role: "system", content: systemPrompt }
  ];

  const { context: fileContext, imageParts } = await buildAttachedFilesContext(files, history);
  if (fileContext) {
     messages.push({
         role: "system",
         content: fileContext
     });
  }

   messages.push(...history.map(msg => ({
      role: mapDbRoleToApiRole(msg.role),
      content: truncateForModel(msg.content)
   })).slice(-15));

   // G9 legibility: same carried-forward PRIOR DECISIONS block as the
   // streaming path. Optional context: storage hiccups are skipped.
   try {
     const priorInsights = await storage.getConversationInsights(expert.conversationId);
     const priorDecisionsBlock = buildPriorDecisionsBlock(priorInsights ?? []);
     if (priorDecisionsBlock) {
       messages.push({ role: "system", content: priorDecisionsBlock });
     }
   } catch (priorErr) {
     console.warn("Could not load prior decisions:", (priorErr as Error).message);
   }

   // With image parts present, the user message becomes a multimodal content
   // array. The 12k-char truncation applies to the TEXT part only — the
   // base64 image parts are appended verbatim, never truncated.
   const userText = truncateForModel(referenceMessageContent);
   messages.push(
      imageParts.length > 0
        ? { role: "user", content: [{ type: "text", text: userText }, ...imageParts] }
        : { role: "user", content: userText }
   );

   console.log(`[DEBUG] Sending ${messages.length} messages to LLM for ${expert.role}${imageParts.length > 0 ? ` (with ${imageParts.length} image part${imageParts.length > 1 ? "s" : ""})` : ""}.`);

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
      artifacts: artifacts,
      // G4: parse the @-tags the model actually wrote so the orchestrator
      // can route on them (and the client can render chips) without
      // re-parsing the stored content.
      mentions: extractMentions(cleanContent, availableRoles)
    };

  } catch (error) {
    console.error(`Error getting response from expert ${expert.name}:`, error);
    const errorMsg = isVisionRejection(error, imageParts)
      ? visionRejectionMessage(expert.name)
      : `(Error generating response for ${expert.name}: ${error instanceof Error ? error.message : String(error)})`;
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

/**
 * G8 aux-call hygiene: resolve the model for auxiliary (non-expert-turn) LLM
 * calls — insight extraction and the Moderator's next-speaker suggestion.
 * Precedence: the Moderator expert's own model → DEFAULT_AUX_MODEL → the first
 * expert's model. Null means nothing resolvable: callers must skip the aux
 * call (or treat it as failed) instead of dialing a hardcoded legacy slug
 * that is likely dead on fresh installs. Whitespace-only values count as
 * empty; the returned slug is trimmed.
 */
export function resolveAuxModel(
  moderatorModel: string | null | undefined,
  firstExpertModel: string | null | undefined
): string | null {
  if (moderatorModel?.trim()) return moderatorModel.trim();
  const envModel = process.env.DEFAULT_AUX_MODEL;
  if (envModel && envModel.trim()) return envModel.trim();
  if (firstExpertModel?.trim()) return firstExpertModel.trim();
  return null;
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
    
    // G8: resolve the insights model dynamically (Moderator's model →
    // DEFAULT_AUX_MODEL → first expert's model). Nothing resolvable means no
    // insights: log and return instead of calling a dead legacy slug.
    const experts = await storage.getConversationExperts(conversationId);
    const moderatorExpert = experts.find(e => e.role === 'Moderator') ?? null;
    const firstExpertModel = experts.find(e => e.role !== 'Moderator')?.model ?? null;
    const auxModel = resolveAuxModel(moderatorExpert?.model ?? null, firstExpertModel);
    if (!auxModel) {
      console.error(`generateInsights: no aux model could be resolved for conversation ${conversationId} (no Moderator model, DEFAULT_AUX_MODEL unset, roster empty) — skipping insights.`);
      return;
    }

    const response = await callOpenRouterAPI([
      { role: "system", content: "You extract key insights from agricultural conversations. Respond only with the requested JSON format." },
      { role: "user", content: insightPrompt }
    ], auxModel);
    
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
  moderatorExpert: ModeratorContext,
  history: Message[],
  availableRoles: string[]
): Promise<string | null> {
    console.log("Asking Moderator for next speaker suggestion...");
    // G6: the speak-next / conclude judgment is charter-aware — the Moderator
    // weighs the charter's goal and stop criteria.
    const conversation = await storage.getConversation(moderatorExpert.conversationId);
    const charter = conversation?.charter ?? null;
    const expertRoles = availableRoles.filter(role => role !== "Moderator");
    const moderatorSystemPrompt = generateSystemPrompt(moderatorExpert, expertRoles, undefined, undefined, charter);
    let queryPrompt = `Based on the recent conversation history, which expert should speak next to best advance the discussion towards resolution or new insights? The available expert roles are: [${expertRoles.join(', ')}]. If the discussion has already run its course — the question is resolved and another turn would only repeat the table — answer 'Conclude' instead. Respond only with the role name, 'Conclude', or 'RoundRobin'.`;
    if (charter?.trim()) {
      queryPrompt += ` The council charter in your instructions states this roundtable's goal and stop criteria — factor them into the decision.`;
    }

    const messages: AIMessage[] = [
        { role: "system", content: moderatorSystemPrompt },
        ...history.slice(-6).map(msg => ({
             role: mapDbRoleToApiRole(msg.role),
             content: truncateForModel(msg.content)
        })),
        { role: "user", content: queryPrompt }
    ];

    // G8: resolve this aux call's model dynamically (Moderator's model →
    // DEFAULT_AUX_MODEL → first expert's model, via the conversation's
    // expert roster in order — experts[0] is the first active expert).
    // Nothing resolvable behaves exactly like a failed call: return null so
    // the orchestrator falls back to round-robin.
    const experts = await storage.getConversationExperts(moderatorExpert.conversationId);
    const firstExpertModel = experts.find(expert => expert.role !== "Moderator")?.model ?? null;
    const auxModel = resolveAuxModel(moderatorExpert.model, firstExpertModel);
    if (!auxModel) {
        console.error("getModeratorNextSpeakerSuggestion: no aux model could be resolved (Moderator has no model, DEFAULT_AUX_MODEL unset, roster empty) — falling back to round-robin.");
        return null;
    }

    try {
        const response = await callOpenRouterAPI(messages, auxModel);
        const suggestedRole = response.message.content.trim().replace(/\.$/, '');
        
        if (expertRoles.includes(suggestedRole) || suggestedRole === 'RoundRobin' || suggestedRole === 'Conclude') {
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

/**
 * G5 semantic conclusion: after the Moderator answers 'Conclude', stream the
 * council's closing synthesis as one full Moderator turn. Broadcasts the same
 * lifecycle as a normal expert turn (expert_stream_start → tokens →
 * expert_stream_done with the stored message) and persists the message with
 * isSynthesis: true so the client (and history) can tell it apart. Never
 * throws — provider failures store an honest "(Error generating response …)"
 * assistant message (still flagged isSynthesis) and broadcast done.
 *
 * G6: charter-aware — the conversation's council charter is injected into the
 * Moderator's system prompt and the closing prompt, so the summary honors the
 * charter's goal and stop criteria.
 */
export async function generateClosingSynthesis(
  conversationId: number,
  moderatorExpert: ModeratorContext,
  broadcastFn: (convId: number, data: any) => void
): Promise<void> {
  console.log(`[SYNTHESIS] Generating closing synthesis for conversation ${conversationId}`);
  try {
    const history = await storage.getConversationMessages(conversationId);
    const experts = await storage.getConversationExperts(conversationId);
    const availableRoles = experts.map(e => e.role).filter(role => role !== "Moderator");
    const conversation = await storage.getConversation(conversationId);
    const charter = conversation?.charter ?? null;
    const systemPrompt = generateSystemPrompt(moderatorExpert, availableRoles, undefined, undefined, charter);
    const firstExpertModel = experts.find(expert => expert.role !== "Moderator")?.model ?? null;
    const closingModel = resolveAuxModel(moderatorExpert.model, firstExpertModel);

    const closingPrompt = `The discussion has run its course and the council is closing. Write the council's closing synthesis for the farmer:
- Summarize the consensus the council reached and the concrete decisions made.
- Name the open disagreements or unanswered questions, if any remain.
- List the concrete next actions for the farmer, in order.
- Name the experts who contributed key points.
Be brief — a farmer should be able to act on this in one read.` + (charter?.trim() ? `\nMeasure the summary against the council charter: state how the outcome fulfills its goal and stop criteria.` : ``);

    const messages: AIMessage[] = [
      { role: "system", content: systemPrompt },
      ...history.map(msg => ({
        role: mapDbRoleToApiRole(msg.role),
        content: truncateForModel(msg.content)
      })).slice(-15),
      { role: "user", content: closingPrompt }
    ];

    broadcastFn(conversationId, {
      type: "expert_stream_start",
      expertId: moderatorExpert.id,
      expertName: moderatorExpert.name,
      expertRole: "Moderator",
    });

    // G8/G10: resolve the Moderator's model, configured aux fallback, then
    // first council expert. If none is available, the honest-error path below
    // persists and broadcasts a closing failure instead of using a dead slug.
    if (!closingModel) {
      throw new Error("No auxiliary model could be resolved for the Moderator closing synthesis.");
    }
    const response = await callOpenRouterAPIStream(messages, closingModel, (token) => {
      broadcastFn(conversationId, {
        type: "expert_stream_token",
        expertId: moderatorExpert.id,
        token,
      });
    });
    const content = response.message.content;

    const storedMessage = await storage.createMessage({
      conversationId,
      expertId: moderatorExpert.id,
      userId: null,
      content,
      role: "assistant",
      expertName: moderatorExpert.name,
      expertRole: moderatorExpert.role,
      isSynthesis: true,
      mentions: extractMentions(content, availableRoles),
    });
    broadcastFn(conversationId, {
      type: "expert_stream_done",
      expertId: moderatorExpert.id,
      message: storedMessage,
    });
    console.log(`[SYNTHESIS] Closing synthesis stored and broadcast for conversation ${conversationId}`);
  } catch (error) {
    console.error(`[SYNTHESIS] Error generating closing synthesis for conversation ${conversationId}:`, error);
    // Honest-error convention: persist the failure (survives refetches), keep
    // the synthesis flag, and still close the stream so the client is never
    // left with a spinner. Re-throw nothing — the orchestrator chain continues
    // into the natural-end cleanup.
    const errorMsg = `(Error generating response from ${moderatorExpert.name}: ${error instanceof Error ? error.message : String(error)})`;
    broadcastFn(conversationId, {
      type: "expert_stream_token",
      expertId: moderatorExpert.id,
      token: errorMsg,
    });
    let storedMessage: Message | undefined;
    try {
      storedMessage = await storage.createMessage({
        conversationId,
        expertId: moderatorExpert.id,
        userId: null,
        content: errorMsg,
        role: "assistant",
        expertName: moderatorExpert.name,
        expertRole: moderatorExpert.role,
        isSynthesis: true,
      });
    } catch (storeError) {
      console.error("[SYNTHESIS] Failed to store synthesis error message:", storeError);
    }
    if (storedMessage) {
      broadcastFn(conversationId, {
        type: "expert_stream_done",
        expertId: moderatorExpert.id,
        message: storedMessage,
      });
    }
  }
}

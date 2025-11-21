import { storage } from "./storage";
// Import shared DB types
import type { InsertMessage, Expert, InsertFile, Message, File, Artifact } from "@shared/schema"; 
import { extractArtifacts } from "./artifact-extractor";
import OpenAI from "openai";
import path from "path";
import fs from "fs";
import axios from "axios";
import { randomBytes } from "crypto";

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
// Pass availableRoles separately
export function generateSystemPrompt(expert: Expert, availableRoles?: string[]): string {
  const basePrompt = `You are an AI expert in the role of ${expert.role} participating in a roundtable discussion on agricultural topics.
As a ${expert.role}, your expertise is highly valued, and you should focus on providing insights specific to your domain.
Always be respectful, helpful, and conversational while maintaining your expert perspective.

You are part of a team of experts: [${availableRoles?.join(', ') || 'various roles'}].
`;

  const interactionPrompt = `During discussion, actively engage with other experts. Reference their points and ask clarifying questions.
If you want to direct a comment or question to a specific expert, use '@[Role Name]' (e.g., '@Soil Scientist').
Be concise and clear in your responses.
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

// Function to call OpenRouter API
export async function callOpenRouterAPI(messages: AIMessage[], model: string): Promise<AIModelResponse> {
  console.log(`[DEBUG] Entering callOpenRouterAPI for model: ${model}`);
  try {
    const openRouterKey = process.env.OPENROUTER_API_KEY;
    if (!openRouterKey) {
      console.error("[DEBUG] OpenRouter API key not provided");
      throw new Error("OpenRouter API key not provided");
    }
    
    console.log(`[DEBUG] Calling OpenRouter fetch: https://openrouter.ai/api/v1/chat/completions, Model: ${model}`);
    
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${openRouterKey}`,
        "HTTP-Referer": "https://farm-friend-roundtable.replit.app", // Replace with your actual referer if different
        "X-Title": "Farm Friend Roundtable" // Replace with your actual title if different
      },
      body: JSON.stringify({
        model: model,
        messages: messages,
        temperature: 0.7,
        max_tokens: 8192,
      }),
    });
    
    console.log(`[DEBUG] OpenRouter fetch completed. Status: ${response.status}`);
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[DEBUG] OpenRouter API Error Response Text: ${errorText}`);
      throw new Error(`OpenRouter API Error (${response.status}): ${errorText}`);
    }
    
    console.log("[DEBUG] OpenRouter response OK. Parsing JSON...");
    const data = await response.json();
    console.log("[DEBUG] OpenRouter JSON parsed successfully.");
    
    // === Add check for top-level error object even if status was 200 ===
    if (data && data.error) {
        console.error(`[DEBUG] OpenRouter returned error object despite 200 OK:`, JSON.stringify(data.error));
        // Construct a user-friendly error message if possible
        const errorMsg = data.error.message || JSON.stringify(data.error);
        throw new Error(`OpenRouter Provider Error: ${errorMsg}`);
    }
    // ==================================================================

    // Add proper error handling for missing data
    if (!data || !data.choices || !Array.isArray(data.choices) || data.choices.length === 0 || !data.choices[0] || !data.choices[0].message) {
      console.error("[DEBUG] Invalid/Incomplete response structure from OpenRouter API:", JSON.stringify(data));
      throw new Error("Invalid response format from OpenRouter API");
    }
    
    console.log("[DEBUG] OpenRouter response structure validated. Returning message.");
    return {
      message: data.choices[0].message
    };
  } catch (error: unknown) {
    console.error("[DEBUG] Error caught within callOpenRouterAPI:", error);
    // Properly handle the unknown error type
    if (error instanceof Error) {
      throw error; // Re-throw the original error
    } else {
      throw new Error(`Unknown error in callOpenRouterAPI: ${String(error)}`);
    }
  }
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
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Perplexity API Error (${response.status}): ${errorText}`);
    }
    
    const data = await response.json();
    
    // Add proper error handling for missing data
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
    // Properly handle the unknown error type
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
  if (dbRole === 'system') return 'system'; // Explicitly handle system role
  // Fallback for unexpected roles, maybe log a warning
  console.warn(`Mapping unknown DB role "${dbRole}" to "assistant" for AI API.`);
  return 'assistant'; 
};

// Helper function to read and truncate file content
async function readFileContent(file: File, maxLength = 2000): Promise<string | null> {
    // Basic check for potentially text-based types
    const isTextBased = file.fileType.startsWith('text/') || 
                       ['csv', 'json', 'javascript', 'typescript', 'python', 'markdown'].some(ext => file.fileType.includes(ext));

    if (!isTextBased) {
        return `[Content of non-text file (${file.fileType}) is not available in this context]`;
    }

    try {
        // Construct absolute path from the relative URL stored
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

// Function to generate response for a single expert
// Export this function so the orchestrator can use it
export async function getExpertResponse(
  expert: Expert, 
  history: Message[], 
  referenceMessageContent: string, 
  files: File[],
  availableRoles: string[] 
): Promise<InsertMessage> { 
  console.log(`Generating response for expert: ${expert.name} (${expert.role})`);
  const systemPrompt = generateSystemPrompt(expert, availableRoles); 
  
  // 1. Initialize messages array with system prompt
  const messages: AIMessage[] = [
    { role: "system", content: systemPrompt }
  ];

  // 2. Add File Context (if any) as a system message
  if (files.length > 0) {
     let fileContextString = "\n\n--- Attached Files Context ---\n";
     for (const file of files) {
         const contentSnippet = await readFileContent(file); // Read content
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

  // 3. Add relevant history messages
   messages.push(...history.map(msg => ({
      role: mapDbRoleToApiRole(msg.role),
      content: msg.content
   })).slice(-15)); // Limit history length to avoid excessive context

   // 4. Add the latest reference message last
   messages.push({ role: "user", content: referenceMessageContent });

   console.log(`[DEBUG] Sending ${messages.length} messages to LLM for ${expert.role}.`);
   // Optional: Log the full message structure for detailed debugging
   // console.log("[DEBUG] Messages:", JSON.stringify(messages, null, 2)); 

  try {
    let response: AIModelResponse;
    
    // Special handling for Research Analyst (Perplexity)
    if (expert.role === "Research Analyst") {
      // Perplexity might work better with just the query + file context?
      // Let's try sending only system, file context, and reference message
      const perplexityMessages = messages.filter(m => m.role === 'system' || m.role === 'user');
      // Ensure the last message is the user query
      if (perplexityMessages[perplexityMessages.length - 1]?.role !== 'user') {
           perplexityMessages.push({ role: "user", content: referenceMessageContent });
      }
      console.log(`[DEBUG] Sending ${perplexityMessages.length} messages specifically to Perplexity.`);
      response = await callPerplexityAPI(referenceMessageContent); // Perplexity API call structure might need only the query
      // TODO: Re-evaluate if perplexity call should use messages array instead
    } 
    // Special handling for File Creator (JSON response expected)
    else if (expert.role === "File Creator") {
       response = await callOpenRouterAPI(messages, expert.model);
       
       try {
         const fileData = JSON.parse(response.message.content);
         
         // Validate structure
         if (!fileData.filename || !fileData.filetype || !fileData.content) {
           throw new Error("Invalid JSON structure from File Creator");
         }
         
         // Create file (similar logic to original processUserMessage)
         const uploadsDir = path.join(process.cwd(), "uploads");
         if (!fs.existsSync(uploadsDir)) {
           fs.mkdirSync(uploadsDir);
         }
         const uniqueFilename = `${randomBytes(8).toString("hex")}-${fileData.filename}`;
         const filePath = path.join(uploadsDir, uniqueFilename);
         fs.writeFileSync(filePath, fileData.content);
         const fileUrl = `/uploads/${uniqueFilename}`;

         const newFile: InsertFile = {
            conversationId: expert.conversationId,
            filename: fileData.filename,
            fileUrl: fileUrl,
            fileType: fileData.filetype,
            uploadedBy: `Expert: ${expert.name}`, // Mark as uploaded by expert
         };
         await storage.createFile(newFile);
         
         // Adjust response message to confirm file creation
         response.message.content = `Created file: ${fileData.filename}`;

       } catch (jsonError) {
          console.error("File Creator error processing JSON:", jsonError);
          // Fallback to a normal text response if JSON is invalid or file saving fails
          response.message.content = "(File Creator Error: Could not process request to create file. Please ensure the request is clear and try again.)";
       }
    }
    // Default handling for other experts (OpenRouter)
    else {
      response = await callOpenRouterAPI(messages, expert.model);
    }
    
    // Extract artifacts from response
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
    // Return an error message formatted for storage
    return {
      conversationId: expert.conversationId,
      expertId: expert.id,
      userId: null,
      content: `(Error generating response for ${expert.name}: ${error instanceof Error ? error.message : String(error)})`,
      role: "assistant",
      expertName: expert.name,
      expertRole: expert.role,
      // Consider adding an 'isError' flag if needed for UI
    };
  }
}

// OLD function - keep for reference or until fully deprecated
// Function to process user message and get expert responses (PARALLEL)
/*
export async function processUserMessage(
  userId: number,
  conversationId: number, 
  userMessage: string
): Promise<InsertMessage[]> {
// ... existing parallel processing logic ...
}
*/

// Function to generate insights (Re-enabled)
export async function generateInsights(conversationId: number, broadcastFn?: (convId: number, data: any) => void): Promise<void> {
  try {
    const messages = await storage.getConversationMessages(conversationId);
    if (messages.length < 3) return; // Not enough messages for insights
    
    // Base insights on a larger portion of the conversation
    const historyText = messages
      .slice(-20) // Use last 20 messages
      .map(m => `${m.expertName || m.role}: ${m.content}`) // Add role/name
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
      // Use a capable model for summarization/extraction
      // Using Mixtral Instruct as a generally available good option
    ], "mistralai/mixtral-8x7b-instruct"); 
    
    try {
      const insightData = JSON.parse(response.message.content);
      
      if (insightData.title && Array.isArray(insightData.points) && insightData.points.length > 0) {
        // Store insight using the existing create function
        console.log(`Storing insights for conversation ${conversationId}:`, insightData);
        await storage.createInsight({ 
          conversationId,
          title: insightData.title,
          points: insightData.points
        });
        // Broadcast the new insights via WebSocket
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
        ...history.slice(-6).map(msg => ({ // Limit history for this specific query
             role: mapDbRoleToApiRole(msg.role),
             content: msg.content
        })),
        { role: "user", content: queryPrompt }
    ];

    try {
        // Use a cheaper/faster model for this focused task if desired
        const response = await callOpenRouterAPI(messages, moderatorExpert.model || 'mistralai/mistral-7b-instruct'); 
        const suggestedRole = response.message.content.trim().replace(/\.$/, ''); // Clean up response
        
        // Validate if the suggestion is one of the available roles or RoundRobin
        if (availableRoles.includes(suggestedRole) || suggestedRole === 'RoundRobin') {
             console.log(`Moderator suggested next speaker: ${suggestedRole}`);
            return suggestedRole;
        } else {
            console.warn(`Moderator suggested an invalid role: '${suggestedRole}'. Falling back.`);
            return null; // Fallback if suggestion is invalid
        }
    } catch (error) {
        console.error("Error querying Moderator for next speaker:", error);
        return null; // Fallback on error
    }
}

import { storage } from "./storage";
import type { InsertMessage, Expert, InsertFile } from "@shared/schema";
import OpenAI from "openai";
import path from "path";
import fs from "fs";
import axios from "axios";
import { randomBytes } from "crypto";

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
export function generateSystemPrompt(expert: Expert): string {
  const basePrompt = `You are an AI expert in the role of ${expert.role} participating in a roundtable discussion on agricultural topics.
As a ${expert.role}, your expertise is highly valued, and you should focus on providing insights specific to your domain.
Always be respectful, helpful, and conversational while maintaining your expert perspective.

You are part of a team of experts, each with their own specialty. If a question would be better answered by another expert, you can acknowledge this, but still provide your perspective from your area of expertise.

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
      roleInstructions = `Facilitate the discussion, summarize key points, ensure all experts contribute, and manage conversation flow. You may also be asked to synthesize information from other experts.`;
      break;
    default:
      roleInstructions = `Provide insights based on your general agricultural knowledge.`;
  }

  return basePrompt + roleInstructions;
}

// Function to call OpenRouter API
export async function callOpenRouterAPI(messages: AIMessage[], model: string): Promise<AIModelResponse> {
  try {
    const openRouterKey = process.env.OPENROUTER_API_KEY;
    if (!openRouterKey) {
      throw new Error("OpenRouter API key not provided");
    }
    
    console.log(`Calling OpenRouter API with model: ${model}`);
    
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${openRouterKey}`,
        "HTTP-Referer": "https://farm-friend-roundtable.replit.app",
        "X-Title": "Farm Friend Roundtable"
      },
      body: JSON.stringify({
        model: model,
        messages: messages,
        temperature: 0.7,
        max_tokens: 1024,
      }),
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenRouter API Error (${response.status}): ${errorText}`);
    }
    
    const data = await response.json();
    
    // Add proper error handling for missing data
    if (!data || !data.choices || !Array.isArray(data.choices) || data.choices.length === 0) {
      console.error("Invalid response from OpenRouter API:", JSON.stringify(data));
      throw new Error("Invalid response format from OpenRouter API");
    }
    
    if (!data.choices[0] || !data.choices[0].message) {
      console.error("Missing message in API response:", JSON.stringify(data.choices[0]));
      throw new Error("Missing message in API response");
    }
    
    return {
      message: data.choices[0].message
    };
  } catch (error: unknown) {
    console.error("Error calling OpenRouter API:", error);
    // Properly handle the unknown error type
    if (error instanceof Error) {
      throw error;
    } else {
      throw new Error(`Unknown error: ${String(error)}`);
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
        model: "llama-3.1-sonar-small-128k-online",
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

// Function to process user message and get expert responses
export async function processUserMessage(
  userId: number,
  conversationId: number, 
  userMessage: string
): Promise<InsertMessage[]> {
  try {
    // Create user message
    const userMessageData: InsertMessage = {
      conversationId,
      userId,
      expertId: null,
      content: userMessage,
      role: "user"
    };
    
    // Store user message
    await storage.createMessage(userMessageData);
    
    // Get conversation experts
    const experts = await storage.getConversationExperts(conversationId);
    if (experts.length === 0) {
      throw new Error("No experts found for this conversation");
    }
    
    // Get conversation history
    const history = await storage.getConversationMessages(conversationId);
    
    // Get conversation files
    const files = await storage.getConversationFiles(conversationId);
    
    // Process responses from each expert
    const expertResponses: InsertMessage[] = [];
    
    for (const expert of experts) {
      const expertResponse = await getExpertResponse(expert, history, userMessage, files);
      expertResponses.push(expertResponse);
    }
    
    return expertResponses;
  } catch (error) {
    console.error("Error processing user message:", error);
    throw error;
  }
}

// Helper to extract file content for context
async function getFileContent(fileUrl: string, fileType: string): Promise<string | null> {
  try {
    // Get the absolute path from the relative URL
    const filePath = path.join(process.cwd(), fileUrl.replace(/^\//, ''));
    
    // Check if file exists
    if (!fs.existsSync(filePath)) {
      console.error(`File not found: ${filePath}`);
      return null;
    }
    
    // Handle different file types
    if (fileType.startsWith('text/') || 
        fileType.includes('json') || 
        fileType.includes('javascript') || 
        fileType.includes('csv') ||
        fileType.includes('xml')) {
      // Read text files directly
      return fs.readFileSync(filePath, 'utf8');
    } else if (fileType.startsWith('image/')) {
      // For images, just return a placeholder
      return `[This is an image file that the experts can reference but cannot be directly included in the text. The image is available at ${fileUrl}]`;
    } else {
      // For other binary files, just indicate their presence
      return `[This is a binary file (${fileType}) that can be referenced but not directly included in the text. The file is available at ${fileUrl}]`;
    }
  } catch (error) {
    console.error(`Error retrieving file content: ${error}`);
    return null;
  }
}

// Helper function to create and save a file generated by AI
async function createAndSaveFile(
  conversationId: number,
  fileName: string,
  fileType: string,
  content: string
): Promise<InsertFile> {
  try {
    // Generate unique file name
    const uniqueId = randomBytes(8).toString("hex");
    const sanitizedFileName = fileName.replace(/[^a-zA-Z0-9_.-]/g, "_").replace(/^\.+$/, '_');
    const uniqueFileName = `${uniqueId}-${sanitizedFileName}`;
    
    // Ensure uploads directory exists
    const uploadsDir = path.join(process.cwd(), "uploads");
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true });
    }
    
    // Write file
    const filePath = path.join(uploadsDir, uniqueFileName);
    fs.writeFileSync(filePath, content, "utf8");
    
    // Create file record in storage
    const fileRecord: InsertFile = {
      conversationId,
      filename: sanitizedFileName,
      fileUrl: `/uploads/${uniqueFileName}`,
      fileType: fileType || "application/octet-stream",
      uploadedBy: "ai"
    };
    
    return await storage.createFile(fileRecord);
    
  } catch (error) {
    console.error("Error saving generated file:", error);
    if (error instanceof Error) {
      throw new Error(`Failed to save generated file: ${error.message}`);
    }
    throw new Error("An unknown error occurred while saving the generated file.");
  }
}

// Function to get a response from a specific expert
async function getExpertResponse(
  expert: Expert, 
  conversationHistory: any[], 
  userMessage: string,
  files: any[] = []
): Promise<InsertMessage> {
  let expertMessage: InsertMessage; // Define message object outside try/catch

  try {
    // Prepare system prompt for the expert
    const systemPrompt = expert.systemPrompt || generateSystemPrompt(expert);
    
    // Prepare messages for AI model
    const messages: AIMessage[] = [
      { role: "system", content: systemPrompt }
    ];
    
    // Process files and add their context to the expert
    if (files.length > 0) {
      let fileContext = "The following files have been uploaded to the conversation and might be relevant:\n\n";
      
      for (const file of files) {
        // Provide a link/reference and type for all files
        fileContext += `- File: ${file.filename} (${file.fileType}) - available at ${file.fileUrl}\n`;
        
        // Include content snippets for specific roles or text-based files if needed for context
        const shouldIncludeContent = (expert.role === "Moderator" || expert.role === "File Creator") ||
                                     (expert.role === "Imagery Specialist" && file.fileType.startsWith("image/")) ||
                                     (file.fileType?.startsWith("text/") || file.fileType?.includes("json") || file.fileType?.includes("csv")); 
                                     
        if (shouldIncludeContent && !file.fileType?.startsWith("image/")) {
          const content = await getFileContent(file.fileUrl, file.fileType);
          if (content) {
            // Add a limited snippet to avoid excessive context length
            const snippet = content.substring(0, 500); 
            fileContext += `  Content Snippet: ${snippet}${content.length > 500 ? '...' : ''}\n\n`;
          }
        } else if (file.fileType?.startsWith("image/")) {
          fileContext += "  (Image content available for analysis)\n\n";
        } else {
          fileContext += "  (File content not displayed in context)\n\n";
        }
      }
      
      // Add file context as a system message
      messages.push({ 
        role: "system", 
        content: fileContext + "Reference these files in your responses when relevant."
      });
    }
    
    // Add relevant conversation history (ensure proper roles and filtering)
    const historyToAdd = conversationHistory
      .slice(-15) // Limit history length
      .map(msg => {
          // Map user messages
          if (msg.role === 'user') return { role: 'user', content: msg.content };
          // Map this expert's previous messages
          if (msg.role === 'assistant' && msg.expertId === expert.id) return { role: 'assistant', content: msg.content };
          // Map system messages about file uploads (if needed, simplified here)
          if (msg.role === 'system' && msg.content.includes('Uploaded file:')) {
            // Maybe simplify this representation for the AI
            return { role: 'system', content: `System note: ${msg.content}` }; 
          }
          return null; // Ignore other messages (e.g., other experts' responses)
      })
      .filter(Boolean) as AIMessage[]; // Filter out nulls and assert type

    messages.push(...historyToAdd);
    
    // Ensure the user's current message is the last one
    if (messages[messages.length - 1]?.role !== "user" || messages[messages.length - 1]?.content !== userMessage) {
         // Check if the user message is already in the filtered history to avoid duplicates
         if (!historyToAdd.some(m => m.role === 'user' && m.content === userMessage)) {
            messages.push({ role: "user", content: userMessage });
         }
    }
   
    let response: AIModelResponse;
    
    // Special handling for research analyst (Perplexity)
    if (expert.role === "Research Analyst") {
      // Perplexity often works best with just the direct query
      response = await callPerplexityAPI(userMessage); 
    } 
    // Special handling for imagery specialist with image files
    else if (expert.role === "Imagery Specialist" && files.some(f => f.fileType.startsWith("image/"))) {
      // Prepare messages potentially including image URLs for vision model
      // This might require specific formatting for the vision model API
      // Assuming callOpenRouterAPI handles multimodal input appropriately if model supports it
      const visionModelId = expert.model || "openai/gpt-4o"; // Use expert's model or default vision
      try {
          // Add image URLs to the last user message content if necessary for the model
          const userMessageWithImages = { ...messages.pop() } as AIMessage; // Get last user message
          const imageFiles = files.filter(f => f.fileType.startsWith("image/"));
          
          // Example: Construct content part for vision model (adapt based on API requirements)
          const imageContentParts: any[] = imageFiles.map(f => ({
              type: "image_url",
              image_url: {
                // Assuming fileUrl is accessible or needs modification for the API
                url: `data:${f.fileType};base64,...` // Or direct URL if supported
                // Note: Actual image data loading (e.g., to base64) might be needed here
              }
          }));

          // Reconstruct messages for vision model (API dependent)
          // This is a placeholder structure - specific API docs needed
          const visionMessages = [
              ...messages, 
              { 
                role: "user", 
                content: [
                    { type: "text", text: userMessageWithImages.content },
                    ...imageContentParts // Add image parts here
                ]
              }
          ];

          // response = await callOpenRouterAPI(visionMessages, visionModelId); // Pass modified messages
          // TEMPORARY: Fallback to text-only until vision handling is fully implemented
          console.warn("Vision model integration placeholder used. Sending text-only to:", visionModelId);
          response = await callOpenRouterAPI(messages, visionModelId);

      } catch (err) {
        console.error(`Error with vision model, falling back to standard model: ${err}`);
        // Fallback to standard text-based call
        messages.push({ role: "user", content: userMessage }); // Re-add user message if popped
        response = await callOpenRouterAPI(messages, expert.model || "gpt-3.5-turbo"); // Use original model or default
      }
    }
    else {
      // Regular OpenRouter call for other experts
      try {
        response = await callOpenRouterAPI(messages, expert.model);
      } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        console.error(`Error with OpenRouter for model ${expert.model}:`, errorMessage);
        throw new Error(`Failed to get response from AI model (${expert.model}): ${errorMessage}`);
      }
    }
    
    // --- File Creator Logic ---
    if (expert.role === "File Creator") {
      try {
        // Attempt to parse the response as JSON
        const fileData = JSON.parse(response.message.content);
        
        // Validate the expected structure
        if (fileData && typeof fileData.filename === 'string' && typeof fileData.content === 'string') {
          // File type is optional but useful
          const fileType = typeof fileData.filetype === 'string' ? fileData.filetype : 'text/plain'; 
          
          // Save the file using the helper function
          const savedFile = await createAndSaveFile(
            expert.conversationId,
            fileData.filename,
            fileType,
            fileData.content
          );
          
          // Create a confirmation message linking to the file
          expertMessage = {
            conversationId: expert.conversationId,
            expertId: expert.id,
            userId: null,
            // Use markdown link format: [link text](url)
            content: `I have created the file: [${savedFile.filename}](${savedFile.fileUrl})`, 
            role: "assistant"
          };
          
        } else {
          // Malformed JSON or missing fields, fallback to text response
          console.warn("File Creator response was not valid JSON or missed required fields. Treating as text.");
          expertMessage = {
            conversationId: expert.conversationId,
            expertId: expert.id,
            userId: null,
            content: "I tried to create the file, but there was an issue with the format. Here is the content I generated:\n\n" + response.message.content,
            role: "assistant"
          };
        }
      } catch (parseError) {
        // JSON parsing failed, treat the response as regular text
        console.warn("File Creator response was not valid JSON. Treating as text:", parseError);
        expertMessage = {
          conversationId: expert.conversationId,
          expertId: expert.id,
          userId: null,
          content: "I generated the following content, but couldn't format it as a downloadable file:\n\n" + response.message.content,
          role: "assistant"
        };
      }
    } else {
      // --- Default Logic for other experts ---
      expertMessage = {
        conversationId: expert.conversationId,
        expertId: expert.id,
        userId: null,
        content: response.message.content,
        role: "assistant"
      };
    }
    
    // Store the final message (either confirmation or regular response)
    return await storage.createMessage(expertMessage);

  } catch (error) {
    console.error(`Error getting response from ${expert.role}:`, error);
    
    // Ensure expertMessage is defined even in case of error before storage call
    expertMessage = {
      conversationId: expert.conversationId,
      expertId: expert.id,
      userId: null,
      content: `I apologize, but I encountered an error while processing your request${error instanceof Error ? ': ' + error.message : ''}. Please try again later.`,
      role: "assistant"
    };
    
    // Attempt to store the error message, but don't crash if this fails too
    try {
      return await storage.createMessage(expertMessage);
    } catch (storageError) {
       console.error(`Failed to store error message for ${expert.role}:`, storageError);
       // Return the error message object directly, it won't be stored but might be usable upstream
       return expertMessage; 
    }
  }
}

// Generate insights from conversation
export async function generateInsights(conversationId: number): Promise<void> {
  try {
    const messages = await storage.getConversationMessages(conversationId);
    if (messages.length < 3) return; // Not enough messages for insights
    
    const lastMessages = messages.slice(-10).map(m => m.content).join("\n");
    
    const insightPrompt = `
    Based on the following agricultural conversation, identify 1-3 key insights or recommendations:
    
    ${lastMessages}
    
    Format your response as a JSON object with this structure:
    {
      "title": "Brief topic title",
      "points": ["Point 1", "Point 2", "Point 3"]
    }
    `;
    
    const response = await callOpenRouterAPI([
      { role: "system", content: "You extract key insights from agricultural conversations. Respond only with the requested JSON format." },
      { role: "user", content: insightPrompt }
    ], "claude-3-sonnet-20240229");
    
    try {
      const insightData = JSON.parse(response.message.content);
      
      if (insightData.title && Array.isArray(insightData.points) && insightData.points.length > 0) {
        await storage.createInsight({
          conversationId,
          title: insightData.title,
          points: insightData.points
        });
      }
    } catch (e) {
      console.error("Error parsing insights JSON:", e);
    }
  } catch (error) {
    console.error("Error generating insights:", error);
  }
}

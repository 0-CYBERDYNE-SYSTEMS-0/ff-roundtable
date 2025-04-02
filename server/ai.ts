import { storage } from "./storage";
import type { InsertMessage, Expert } from "@shared/schema";

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

// Mock function to generate system prompts based on expert roles
export function generateSystemPrompt(role: string): string {
  const basePrompt = "You are an AI agricultural expert participating in a roundtable discussion with other AI experts. ";
  
  const rolePrompts: Record<string, string> = {
    "Soil Scientist": basePrompt + "You specialize in soil health, composition analysis, and fertilization recommendations. Provide detailed insights on soil-related issues, testing methods, and how to improve soil quality for better crop yields.",
    
    "Crop Specialist": basePrompt + "You are an expert in crop varieties, rotation strategies, and yield optimization techniques. Provide specific advice on crop selection, planting schedules, and management practices appropriate for different regions and soil conditions.",
    
    "Irrigation Engineer": basePrompt + "You specialize in water management systems, irrigation scheduling, and water conservation. Provide practical guidance on irrigation systems, water usage efficiency, and drainage solutions for various agricultural settings.",
    
    "Pest Management": basePrompt + "You are an expert in identifying and managing pests, diseases, and implementing IPM strategies. Provide advice on pest identification, prevention methods, and both organic and conventional treatment options.",
    
    "Meteorologist": basePrompt + "You specialize in weather patterns, climate impacts on agriculture, and seasonal forecasting. Provide insights on how weather conditions affect farming decisions and how to adapt to changing climate conditions.",
    
    "File Creator": basePrompt + "You specialize in creating useful files like reports, plans, and scripts based on the discussion. When asked to create a file, provide the complete content that should be included in the file. Format it appropriately for the file type requested.",
    
    "Research Analyst": basePrompt + "You have the ability to search the internet for current information. When providing information, include relevant sources and citations. Focus on finding the most up-to-date research and market trends in agriculture.",
    
    "Imagery Specialist": basePrompt + "You can generate agricultural visualizations based on descriptions. When asked to create an image, provide a detailed description of what the image should contain for optimal generation.",
    
    "Moderator": basePrompt + "You are the discussion moderator. Summarize key points, manage the conversation flow, and highlight important insights. Help organize the information shared by other experts and the user."
  };
  
  return rolePrompts[role] || basePrompt + "Provide expert agricultural advice based on your knowledge and experience.";
}

// Function to call OpenRouter API
export async function callOpenRouterAPI(messages: AIMessage[], model: string): Promise<AIModelResponse> {
  try {
    const openRouterKey = process.env.OPENROUTER_API_KEY;
    if (!openRouterKey) {
      throw new Error("OpenRouter API key not provided");
    }
    
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
    return {
      message: data.choices[0].message
    };
  } catch (error) {
    console.error("Error calling OpenRouter API:", error);
    throw error;
  }
}

// Function to call Perplexity API for web search
export async function callPerplexityAPI(query: string): Promise<AIModelResponse> {
  try {
    const perplexityKey = process.env.PERPLEXITY_API_KEY;
    if (!perplexityKey) {
      throw new Error("Perplexity API key not provided");
    }
    
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
    return {
      message: data.choices[0].message,
      citations: data.citations || []
    };
  } catch (error) {
    console.error("Error calling Perplexity API:", error);
    throw error;
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
    
    // Process responses from each expert
    const expertResponses: InsertMessage[] = [];
    
    for (const expert of experts) {
      const expertResponse = await getExpertResponse(expert, history, userMessage);
      expertResponses.push(expertResponse);
    }
    
    return expertResponses;
  } catch (error) {
    console.error("Error processing user message:", error);
    throw error;
  }
}

// Function to get a response from a specific expert
async function getExpertResponse(
  expert: Expert, 
  conversationHistory: any[], 
  userMessage: string
): Promise<InsertMessage> {
  try {
    // Prepare messages for AI model
    const messages: AIMessage[] = [
      { role: "system", content: expert.systemPrompt }
    ];
    
    // Add relevant conversation history (simplified for now)
    for (const msg of conversationHistory.slice(-10)) {
      if (msg.role === "user") {
        messages.push({ role: "user", content: msg.content });
      } else if (msg.expertId === expert.id) {
        messages.push({ role: "assistant", content: msg.content });
      }
    }
    
    // Ensure the last message is the user's message
    if (messages[messages.length - 1].role !== "user") {
      messages.push({ role: "user", content: userMessage });
    }
    
    let response: AIModelResponse;
    
    // Special handling for research analyst (Perplexity)
    if (expert.role === "Research Analyst") {
      response = await callPerplexityAPI(userMessage);
    } else {
      // Regular OpenRouter call for other experts
      response = await callOpenRouterAPI(messages, expert.model);
    }
    
    // Create expert message
    const expertMessage: InsertMessage = {
      conversationId: expert.conversationId,
      expertId: expert.id,
      userId: null,
      content: response.message.content,
      role: "assistant"
    };
    
    // Store expert message
    return await storage.createMessage(expertMessage);
  } catch (error) {
    console.error(`Error getting response from ${expert.role}:`, error);
    
    // Return error message
    return {
      conversationId: expert.conversationId,
      expertId: expert.id,
      userId: null,
      content: `I apologize, but I encountered an error while processing your request. ${error.message}`,
      role: "assistant"
    };
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

import { AIMessage, AIModelResponse } from "../types";

// Function to call OpenRouter API
export async function callOpenRouterAPI(
  messages: AIMessage[],
  model: string
): Promise<AIModelResponse> {
  try {
    const openRouterKey = process.env.OPENROUTER_API_KEY || import.meta.env.VITE_OPENROUTER_API_KEY;
    if (!openRouterKey) {
      throw new Error("OpenRouter API key not provided");
    }

    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${openRouterKey}`,
        "HTTP-Referer": window.location.origin,
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
      message: data.choices[0].message,
    };
  } catch (error) {
    console.error("Error calling OpenRouter API:", error);
    throw error;
  }
}

// Function to call Perplexity API for web search
export async function callPerplexityAPI(query: string): Promise<AIModelResponse> {
  try {
    const perplexityKey = process.env.PERPLEXITY_API_KEY || import.meta.env.VITE_PERPLEXITY_API_KEY;
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

// Function to generate system prompts based on expert roles
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

// Function to get expert avatar based on role
export function getExpertAvatarUrl(role: string): string {
  const avatars: Record<string, string> = {
    "Soil Scientist": "https://images.unsplash.com/photo-1560365163-3e8d64e762ef?ixlib=rb-1.2.1&auto=format&fit=crop&w=48&h=48&q=80",
    "Crop Specialist": "https://images.unsplash.com/photo-1530836369250-ef72a3f5cda8?ixlib=rb-1.2.1&auto=format&fit=crop&w=48&h=48&q=80",
    "Irrigation Engineer": "https://images.unsplash.com/photo-1584824188625-0d6dd2183f9e?ixlib=rb-1.2.1&auto=format&fit=crop&w=48&h=48&q=80",
    "Pest Management": "https://images.unsplash.com/photo-1570913149827-d2ac84ab3f9a?ixlib=rb-1.2.1&auto=format&fit=crop&w=48&h=48&q=80",
    "Meteorologist": "https://images.unsplash.com/photo-1564939558297-fc396f18e5c7?ixlib=rb-1.2.1&auto=format&fit=crop&w=48&h=48&q=80",
    "File Creator": "https://images.unsplash.com/photo-1598300042247-d088f8ab3a91?ixlib=rb-1.2.1&auto=format&fit=crop&w=48&h=48&q=80",
    "Research Analyst": "https://images.unsplash.com/photo-1501504905252-473c47e087f8?ixlib=rb-1.2.1&auto=format&fit=crop&w=48&h=48&q=80",
    "Imagery Specialist": "https://images.unsplash.com/photo-1607000975631-8094b497b327?ixlib=rb-1.2.1&auto=format&fit=crop&w=48&h=48&q=80",
    "Moderator": "https://images.unsplash.com/photo-1506794778202-cad84cf45f1d?ixlib=rb-1.2.1&auto=format&fit=crop&w=48&h=48&q=80"
  };

  return avatars[role] || "https://images.unsplash.com/photo-1506794778202-cad84cf45f1d?ixlib=rb-1.2.1&auto=format&fit=crop&w=48&h=48&q=80";
}

// Get expert name based on role
export function getExpertName(role: string): string {
  const names: Record<string, string> = {
    "Soil Scientist": "Dr. Soil",
    "Crop Specialist": "Crop Master",
    "Irrigation Engineer": "Hydro Engineer",
    "Pest Management": "Pest Pro",
    "Meteorologist": "Weather Wiz",
    "File Creator": "Document Builder",
    "Research Analyst": "Research Scout",
    "Imagery Specialist": "Vision Artist",
    "Moderator": "Moderator"
  };

  return names[role] || `${role.split(' ')[0]} Expert`;
}

// Get model based on expert role
export function getExpertModel(role: string): string {
  const models: Record<string, string> = {
    "Soil Scientist": "claude-3-sonnet-20240229",
    "Crop Specialist": "gpt-4-0613",
    "Irrigation Engineer": "meta-llama/llama-2-70b-chat",
    "Pest Management": "claude-3-haiku-20240307",
    "Meteorologist": "gpt-3.5-turbo",
    "File Creator": "gpt-4-0613",
    "Research Analyst": "perplexity/llama-3.1-sonar-small-128k-online",
    "Imagery Specialist": "gemini/flash-2-0",
    "Moderator": "claude-3-opus-20240229"
  };

  return models[role] || "gpt-3.5-turbo";
}

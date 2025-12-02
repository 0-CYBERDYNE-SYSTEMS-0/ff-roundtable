import { useState, useEffect, useCallback } from "react";

// Create a WebSocket connection
export function useWebSocket() {
  const [socket, setSocket] = useState<WebSocket | null>(null);
  const [reconnectAttempts, setReconnectAttempts] = useState(0);
  const MAX_RECONNECT_ATTEMPTS = 5;
  
  // Create a function to establish WebSocket connection
  const connectWebSocket = useCallback(() => {
    // Determine if we're using secure connection
    const isSecure = window.location.protocol === "https:";
    const wsProtocol = isSecure ? "wss:" : "ws:";
    const host = window.location.host || window.location.hostname;
    const wsUrl = `${wsProtocol}//${host}/ws`;
    
    console.log("Attempting to connect to WebSocket at:", wsUrl);
    
    // Create WebSocket connection
    const ws = new WebSocket(wsUrl);
    
    // Connection opened
    ws.addEventListener("open", (event) => {
      console.log("WebSocket connection established");
      // Reset reconnect attempts on successful connection
      setReconnectAttempts(0);
    });
    
    // Listen for errors
    ws.addEventListener("error", (event) => {
      console.error("WebSocket error:", event);
    });
    
    // Connection closed
    ws.addEventListener("close", (event) => {
      console.log("WebSocket connection closed", event.code, event.reason);
      
      // Attempt to reconnect if the connection was closed abnormally
      // and we haven't exceeded maximum reconnect attempts
      if (event.code !== 1000 && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        const timeout = Math.min(1000 * (2 ** reconnectAttempts), 30000); // Exponential backoff with 30s max
        console.log(`Attempting to reconnect WebSocket in ${timeout/1000}s (attempt ${reconnectAttempts + 1}/${MAX_RECONNECT_ATTEMPTS})...`);
        
        setTimeout(() => {
          setReconnectAttempts(prev => prev + 1);
          setSocket(null); // This will trigger a reconnection due to the dependency in useEffect
        }, timeout);
      }
    });
    
    setSocket(ws);
    
    return ws;
  }, [reconnectAttempts]);
  
  useEffect(() => {
    const ws = connectWebSocket();
    
    // Clean up function
    return () => {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close(1000, "Component unmounted");
      }
    };
  }, [connectWebSocket]);
  
  return socket;
}

// Send a message through the WebSocket
export function sendWebSocketMessage(socket: WebSocket | null, message: any): boolean {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    console.error("WebSocket is not connected");
    return false;
  }
  
  socket.send(JSON.stringify(message));
  return true;
}

// Create a function to add event listeners to a WebSocket
export function addWebSocketListener(
  socket: WebSocket | null,
  type: string,
  callback: (data: any) => void
): () => void {
  if (!socket) return () => {};
  
  const handler = (event: MessageEvent) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type === type) {
        callback(data);
      }
    } catch (error) {
      console.error("Error parsing WebSocket message:", error);
    }
  };
  
  socket.addEventListener("message", handler);
  
  // Return a cleanup function
  return () => {
    socket.removeEventListener("message", handler);
  };
}

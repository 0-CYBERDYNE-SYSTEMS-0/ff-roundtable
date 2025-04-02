import { useState, useEffect } from "react";

// Create a WebSocket connection
export function useWebSocket() {
  const [socket, setSocket] = useState<WebSocket | null>(null);
  
  useEffect(() => {
    // Determine if we're using secure connection
    const isSecure = window.location.protocol === "https:";
    const wsProtocol = isSecure ? "wss:" : "ws:";
    const wsUrl = `${wsProtocol}//${window.location.host}`;
    
    // Create WebSocket connection
    const ws = new WebSocket(wsUrl);
    
    // Connection opened
    ws.addEventListener("open", (event) => {
      console.log("WebSocket connection established");
    });
    
    // Listen for errors
    ws.addEventListener("error", (event) => {
      console.error("WebSocket error:", event);
    });
    
    // Connection closed
    ws.addEventListener("close", (event) => {
      console.log("WebSocket connection closed", event.code, event.reason);
      
      // Attempt to reconnect after 5 seconds if the connection was closed abnormally
      if (event.code !== 1000) {
        setTimeout(() => {
          console.log("Attempting to reconnect WebSocket...");
          setSocket(null);
        }, 5000);
      }
    });
    
    setSocket(ws);
    
    // Clean up function
    return () => {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close(1000, "Component unmounted");
      }
    };
  }, []);
  
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

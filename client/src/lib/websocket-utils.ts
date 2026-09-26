import { useEffect, useRef, useState } from "react";

export type WebSocketStatus = "connecting" | "connected" | "reconnecting" | "disconnected";

export interface WebSocketState {
  socket: WebSocket | null;
  status: WebSocketStatus;
  reconnectAttempts: number;
}

// Create a WebSocket connection and keep retrying while the app is mounted.
export function useWebSocket(): WebSocketState {
  const [socket, setSocket] = useState<WebSocket | null>(null);
  const [status, setStatus] = useState<WebSocketStatus>("connecting");
  const [reconnectAttempts, setReconnectAttempts] = useState(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attemptsRef = useRef(0);
  const mountedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    let currentSocket: WebSocket | null = null;

    const connect = () => {
      if (!mountedRef.current) return;

      const isSecure = window.location.protocol === "https:";
      const wsProtocol = isSecure ? "wss:" : "ws:";
      const host = window.location.host || window.location.hostname;
      const wsUrl = `${wsProtocol}//${host}/ws`;
      const isRetry = attemptsRef.current > 0;

      setStatus(isRetry ? "reconnecting" : "connecting");
      console.log("Attempting to connect to WebSocket at:", wsUrl);
      currentSocket = new WebSocket(wsUrl);
      setSocket(currentSocket);

      currentSocket.addEventListener("open", () => {
        if (!mountedRef.current) return;
        attemptsRef.current = 0;
        setReconnectAttempts(0);
        setStatus("connected");
        console.log("WebSocket connection established");
      });

      currentSocket.addEventListener("error", (event) => {
        console.error("WebSocket error:", event);
      });

      currentSocket.addEventListener("close", (event) => {
        if (!mountedRef.current) return;
        setSocket((activeSocket) => activeSocket === currentSocket ? null : activeSocket);
        setStatus("reconnecting");

        const timeout = Math.min(1000 * (2 ** attemptsRef.current), 30000);
        attemptsRef.current += 1;
        setReconnectAttempts(attemptsRef.current);
        console.log(`WebSocket closed (${event.code}); retrying in ${timeout / 1000}s...`);
        reconnectTimerRef.current = setTimeout(connect, timeout);
      });
    };

    connect();

    return () => {
      mountedRef.current = false;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      if (currentSocket?.readyState === WebSocket.OPEN || currentSocket?.readyState === WebSocket.CONNECTING) {
        currentSocket.close(1000, "Component unmounted");
      }
      setSocket(null);
      setStatus("disconnected");
    };
  }, []);

  return { socket, status, reconnectAttempts };
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

// Subscribe the socket to a conversation's broadcasts (G3 scoping): the
// server only sends events for conversations explicitly subscribed to.
export function sendWebSocketSubscription(socket: WebSocket | null, conversationId: number): boolean {
  return sendWebSocketMessage(socket, { type: "subscribe", conversationId });
}

// Drop a conversation subscription (e.g. after switching conversations).
export function sendWebSocketUnsubscription(socket: WebSocket | null, conversationId: number): boolean {
  return sendWebSocketMessage(socket, { type: "unsubscribe", conversationId });
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

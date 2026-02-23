import { WebSocket } from 'ws';

export interface ClientConnection {
  ws: WebSocket;
  userId?: string;
  challenge?: string;
  pendingPublicKey?: string;
}

class ConnectionManager {
  private clients: Set<ClientConnection> = new Set();

  addClient(ws: WebSocket): ClientConnection {
    const client: ClientConnection = { ws };
    this.clients.add(client);
    console.log(`[WS DEBUG] Client added. Total clients: ${this.clients.size}`);
    return client;
  }

  removeClient(client: ClientConnection) {
    this.clients.delete(client);
    console.log(`[WS DEBUG] Client removed. Total clients: ${this.clients.size}`);
  }

  setUserId(client: ClientConnection, userId: string) {
    client.userId = userId;
    console.log(`[WS DEBUG] Client authenticated as user: ${userId}`);
  }

  broadcast(message: any) {
    const data = JSON.stringify(message);
    for (const client of this.clients) {
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(data);
      }
    }
  }

  broadcastToAuthenticated(message: any) {
    const data = JSON.stringify(message);
    for (const client of this.clients) {
      if (client.userId && client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(data);
      }
    }
  }

  sendToUser(userId: string, message: any) {
    const data = JSON.stringify(message);
    for (const client of this.clients) {
      if (client.userId === userId && client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(data);
      }
    }
  }
}

export const connectionManager = new ConnectionManager();

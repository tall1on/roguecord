import { WebSocket } from 'ws';

export interface ClientConnection {
  ws: WebSocket;
  userId?: string;
  ipAddress?: string;
  challenge?: string;
  pendingPublicKey?: string;
  isNewUser?: boolean;
  isAlive: boolean;
}

class ConnectionManager {
  private clients: Set<ClientConnection> = new Set();

  addClient(ws: WebSocket, ipAddress?: string): ClientConnection {
    const client: ClientConnection = { ws, isAlive: true, ipAddress };
    this.clients.add(client);
    console.log(`[WS DEBUG] Client added. Total clients: ${this.clients.size}`);
    return client;
  }

  removeClient(client: ClientConnection) {
    this.clients.delete(client);
    console.log(`[WS DEBUG] Client removed. Total clients: ${this.clients.size}`);
  }

  getClients(): Set<ClientConnection> {
    return this.clients;
  }

  setUserId(client: ClientConnection, userId: string) {
    client.userId = userId;
    console.log(`[WS DEBUG] Client authenticated as user: ${userId}`);
  }

  getOnlineUserIds(): string[] {
    const ids = new Set<string>();
    for (const client of this.clients) {
      if (client.userId) {
        ids.add(client.userId);
      }
    }
    return Array.from(ids);
  }

  isUserOnline(userId: string, excludeClient?: ClientConnection): boolean {
    for (const client of this.clients) {
      if (client !== excludeClient && client.userId === userId) {
        return true;
      }
    }
    return false;
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

  getUserIp(userId: string): string | undefined {
    for (const client of this.clients) {
      if (client.userId === userId && client.ipAddress) {
        return client.ipAddress;
      }
    }
    return undefined;
  }

  closeUserConnections(userId: string): void {
    for (const client of this.clients) {
      if (client.userId === userId && client.ws.readyState === WebSocket.OPEN) {
        client.ws.close(4003, 'Moderation action enforced');
      }
    }
  }
}

export const connectionManager = new ConnectionManager();

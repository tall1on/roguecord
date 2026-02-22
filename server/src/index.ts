import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import selfsigned from 'selfsigned';
import dotenv from 'dotenv';
import { db } from './db';
import { createWorker } from './mediasoup';
import { connectionManager } from './ws/connectionManager';
import { handleMessage, handleClientDisconnect } from './ws/handlers';
import { adminKey } from './admin';

dotenv.config();

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 1337;
const HOST = '0.0.0.0';

// Generate temporary self-signed certificate for HTTPS and WebRTC
const attrs = [{ name: 'commonName', value: 'localhost' }];

async function startServer() {
  const pems = selfsigned.generate(attrs, { days: 365 } as any);
  const resolvedPems = await Promise.resolve(pems);

  const serverOptions = {
    key: resolvedPems.private,
    cert: resolvedPems.cert,
  };

  const server = https.createServer(serverOptions, (req, res) => {
    // Basic HTTP handler
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('RogueCord Server Running\n');
  });

  // Set up WebSocket server attached to the HTTPS server
  const wss = new WebSocketServer({ server });

  wss.on('connection', (ws, req) => {
    console.log(`New WebSocket connection from ${req.socket.remoteAddress}`);
    
    const client = connectionManager.addClient(ws);

    ws.on('message', async (message) => {
      console.log(`Received message: ${message}`);
      await handleMessage(client, message.toString());
    });

    ws.on('close', () => {
      console.log('WebSocket connection closed');
      handleClientDisconnect(client);
      connectionManager.removeClient(client);
    });
  });

  server.listen(PORT, HOST, async () => {
    try {
      await createWorker();
      console.log('Mediasoup worker created successfully');
    } catch (error) {
      console.error('Failed to create Mediasoup worker:', error);
    }
    console.log(`HTTPS Server listening on https://${HOST}:${PORT}`);
    console.log(`WebSocket Server listening on wss://${HOST}:${PORT}`);
    console.log(`Admin Key: ${adminKey}`);
  });
}

startServer().catch(console.error);

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {WebSocketServer} from 'ws';
import dotenv from 'dotenv';
import {db} from './db';
import {createWorker} from './mediasoup';
import {connectionManager} from './ws/connectionManager';
import {handleMessage, handleClientDisconnect} from './ws/handlers';
import {adminKey} from './admin';

dotenv.config();

const PORT = process.env.PORT ? ~~process.env.PORT : 1337;
const HOST = process.env.LISTEN_IP || '0.0.0.0';

async function startServer() {
    const server = http.createServer((req, res) => {
        // Basic HTTP handler
        res.writeHead(200, {'Content-Type': 'text/plain'});
        res.end('RogueCord Server Running\n');
    });

    // Set up WebSocket server attached to the HTTP server
    const wss = new WebSocketServer({server});

    wss.on('connection', (ws, req) => {
        console.log(`[WS DEBUG] New WebSocket connection from ${req.socket.remoteAddress}`);

        const client = connectionManager.addClient(ws);

        ws.on('message', async (message) => {
            console.log(`[WS DEBUG] Received message from ${client.userId || 'unauthenticated'}: ${message}`);
            await handleMessage(client, message.toString());
        });

        ws.on('close', () => {
            console.log(`[WS DEBUG] WebSocket connection closed for ${client.userId || 'unauthenticated'}`);
            handleClientDisconnect(client);
            connectionManager.removeClient(client);
        });

        ws.on('error', (error) => {
            console.error(`[WS DEBUG] WebSocket error for ${client.userId || 'unauthenticated'}:`, error);
        });
    });

    server.listen(PORT, HOST, async () => {
        console.log(`HTTP Server listening on http://${HOST}:${PORT}`);
        console.log(`WebSocket Server listening on ws://${HOST}:${PORT}`);
        try {
            await createWorker();
            console.log('Mediasoup worker created successfully');
        } catch (error) {
            console.error('Failed to create Mediasoup worker:', error);
        }
        console.log(`Admin Key: ${adminKey}`);
    });
}

startServer().catch(console.error);

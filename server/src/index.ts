import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {WebSocketServer} from 'ws';
import dotenv from 'dotenv';
import {db, channelsSchemaReady, dataDir} from './db';
import {createWorker} from './mediasoup';
import {connectionManager} from './ws/connectionManager';
import {handleMessage, handleClientDisconnect} from './ws/handlers';
import {adminKey} from './admin';
import { startRssPolling } from './rssPolling';
import { getServer, getServerStorageSettings } from './models';
import { downloadFileFromS3 } from './storage/s3Storage';

dotenv.config();

const PORT = process.env.PORT ? ~~process.env.PORT : 1337;
const HOST = process.env.LISTEN_IP || '0.0.0.0';
const serverIconsRootDir = path.resolve(dataDir, 'server-icons');
const filesRootDir = path.resolve(dataDir, 'files');

const getIconContentType = (filePath: string) => {
    const ext = path.extname(filePath).toLowerCase();
    switch (ext) {
        case '.png':
            return 'image/png';
        case '.jpg':
        case '.jpeg':
            return 'image/jpeg';
        case '.webp':
            return 'image/webp';
        case '.gif':
            return 'image/gif';
        default:
            return 'application/octet-stream';
    }
};

const getFileContentType = (filePath: string, fallback: string | null = null) => {
    if (fallback && fallback.trim()) {
        return fallback;
    }

    const ext = path.extname(filePath).toLowerCase();
    switch (ext) {
        case '.png':
            return 'image/png';
        case '.jpg':
        case '.jpeg':
            return 'image/jpeg';
        case '.webp':
            return 'image/webp';
        case '.gif':
            return 'image/gif';
        case '.svg':
            return 'image/svg+xml';
        case '.txt':
            return 'text/plain; charset=utf-8';
        case '.pdf':
            return 'application/pdf';
        case '.json':
            return 'application/json; charset=utf-8';
        default:
            return 'application/octet-stream';
    }
};

const sendNotFound = (res: http.ServerResponse) => {
    res.writeHead(404, {'Content-Type': 'text/plain'});
    res.end('Not found\n');
};

const sendServerError = (res: http.ServerResponse) => {
    res.writeHead(500, {'Content-Type': 'text/plain'});
    res.end('Failed to load server icon\n');
};

const isSafeServerId = (value: string) => /^[a-zA-Z0-9-]+$/.test(value);

const isSafeStorageName = (value: string) => {
    if (!value) return false;
    if (value !== path.basename(value)) return false;
    if (value.includes('..')) return false;
    return true;
};

const isSafeChannelId = (value: string) => /^[a-zA-Z0-9-]+$/.test(value);

const isSafeS3Key = (value: string) => {
    const trimmed = (value || '').trim();
    if (!trimmed) return false;
    if (trimmed.includes('\\') || /[\u0000-\u001F]/.test(trimmed)) return false;
    const segments = trimmed.split('/').filter(Boolean);
    if (!segments.length) return false;
    return segments.every((segment) => segment !== '.' && segment !== '..');
};

const getSafeChannelFilesDir = (channelId: string) => {
    const safeChannelId = (channelId || '').replace(/[^a-zA-Z0-9-]/g, '');
    const dir = path.resolve(filesRootDir, safeChannelId);
    const root = path.resolve(filesRootDir);
    if (!dir.startsWith(root)) {
        throw new Error('Unsafe channel path');
    }
    return dir;
};

const resolveSafeStoredFilePath = (channelId: string, storageName: string) => {
    const channelDir = getSafeChannelFilesDir(channelId);
    const safeStorageName = path.basename(storageName || '').replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_').trim();
    if (!safeStorageName) {
        throw new Error('Invalid storage name');
    }
    const fullPath = path.resolve(channelDir, safeStorageName);
    if (!fullPath.startsWith(channelDir)) {
        throw new Error('Unsafe file path');
    }
    return fullPath;
};

async function startServer() {
    const server = http.createServer(async (req, res) => {
        const requestUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

        if (req.method === 'GET' && requestUrl.pathname.startsWith('/server-icons/')) {
            try {
                const serverInfo = await getServer();
                if (!serverInfo?.iconPath) {
                    sendNotFound(res);
                    return;
                }

                if (requestUrl.pathname.startsWith('/server-icons/s3/')) {
                    const encodedKey = requestUrl.pathname.slice('/server-icons/s3/'.length);
                    const key = decodeURIComponent(encodedKey || '');
                    if (!key || serverInfo.iconPath !== `s3:${key}`) {
                        sendNotFound(res);
                        return;
                    }

                    const storageSettings = await getServerStorageSettings();
                    if (!storageSettings?.s3) {
                        sendServerError(res);
                        return;
                    }

                    const fileBuffer = await downloadFileFromS3({
                        config: storageSettings.s3,
                        key
                    });

                    res.writeHead(200, {
                        'Content-Type': getIconContentType(key),
                        'Cache-Control': 'public, max-age=300'
                    });
                    res.end(fileBuffer);
                    return;
                }

                const segments = requestUrl.pathname.split('/').filter(Boolean);
                if (segments.length !== 3) {
                    sendNotFound(res);
                    return;
                }

                const serverId = segments[1] || '';
                const storageName = segments[2] || '';

                if (!isSafeServerId(serverId) || !isSafeStorageName(storageName)) {
                    sendNotFound(res);
                    return;
                }

                const expectedPath = `/server-icons/${serverId}/${storageName}`;
                if (serverInfo.iconPath !== expectedPath) {
                    sendNotFound(res);
                    return;
                }

                const iconFilePath = path.resolve(serverIconsRootDir, serverId, storageName);
                if (!iconFilePath.startsWith(serverIconsRootDir) || !fs.existsSync(iconFilePath)) {
                    sendNotFound(res);
                    return;
                }

                const fileBuffer = fs.readFileSync(iconFilePath);
                res.writeHead(200, {
                    'Content-Type': getIconContentType(iconFilePath),
                    'Cache-Control': 'public, max-age=300'
                });
                res.end(fileBuffer);
                return;
            } catch (error) {
                console.error('Failed to serve server icon:', error);
                sendServerError(res);
                return;
            }
        }

        if (req.method === 'GET' && requestUrl.pathname.startsWith('/files/')) {
            try {
                if (requestUrl.pathname.startsWith('/files/s3/')) {
                    const encodedKey = requestUrl.pathname.slice('/files/s3/'.length);
                    const key = decodeURIComponent(encodedKey || '');
                    if (!isSafeS3Key(key)) {
                        sendNotFound(res);
                        return;
                    }

                    const storageSettings = await getServerStorageSettings();
                    if (!storageSettings?.s3) {
                        sendServerError(res);
                        return;
                    }

                    const fileBuffer = await downloadFileFromS3({
                        config: storageSettings.s3,
                        key
                    });

                    res.writeHead(200, {
                        'Content-Type': getFileContentType(key),
                        'Cache-Control': 'public, max-age=300'
                    });
                    res.end(fileBuffer);
                    return;
                }

                const segments = requestUrl.pathname.split('/').filter(Boolean);
                if (segments.length !== 3) {
                    sendNotFound(res);
                    return;
                }

                const channelId = segments[1] || '';
                const storageName = segments[2] || '';

                if (!isSafeChannelId(channelId) || !isSafeStorageName(storageName)) {
                    sendNotFound(res);
                    return;
                }

                const filePath = resolveSafeStoredFilePath(channelId, storageName);
                if (!filePath.startsWith(filesRootDir) || !fs.existsSync(filePath)) {
                    sendNotFound(res);
                    return;
                }

                const fileBuffer = fs.readFileSync(filePath);
                res.writeHead(200, {
                    'Content-Type': getFileContentType(filePath),
                    'Cache-Control': 'public, max-age=300'
                });
                res.end(fileBuffer);
                return;
            } catch (error) {
                console.error('Failed to serve stored file:', error);
                sendServerError(res);
                return;
            }
        }

        // Basic HTTP handler
        res.writeHead(200, {'Content-Type': 'text/plain'});
        res.end('RogueCord Server Running\n');
    });

    // Set up WebSocket server attached to the HTTP server
    const wss = new WebSocketServer({server});

    const interval = setInterval(() => {
        for (const client of connectionManager.getClients()) {
            if (client.isAlive === false) {
                console.log(`[WS DEBUG] Terminating inactive connection for ${client.userId || 'unauthenticated'}`);
                client.ws.terminate();
                continue;
            }

            client.isAlive = false;
            client.ws.ping();
        }
    }, 30000);

    wss.on('close', () => {
        clearInterval(interval);
    });

    wss.on('connection', (ws, req) => {
        console.log(`[WS DEBUG] New WebSocket connection from ${req.socket.remoteAddress}`);

        const client = connectionManager.addClient(ws, req.socket.remoteAddress || undefined);

        ws.on('pong', () => {
            client.isAlive = true;
        });

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
            await channelsSchemaReady;
        } catch (error) {
            console.error('Database schema initialization failed:', error);
            process.exit(1);
        }
        try {
            await createWorker();
            console.log('Mediasoup worker created successfully');
        } catch (error) {
            console.error('Failed to create Mediasoup worker:', error);
        }
        startRssPolling();
        console.log(`Admin Key: ${adminKey}`);
    });
}

startServer().catch(console.error);

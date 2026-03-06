import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import {WebSocketServer} from 'ws';
import dotenv from 'dotenv';
import {db, channelsSchemaReady, dataDir} from './db';
import {createWorker} from './mediasoup';
import {connectionManager} from './ws/connectionManager';
import {handleMessage, handleClientDisconnect} from './ws/handlers';
import {adminKey} from './admin';
import { startRssPolling } from './rssPolling';
import { getServer, getServerStorageSettings } from './models';
import type { S3StorageConfig } from './storage/s3Storage';
import { getFileStreamFromS3 } from './storage/s3Storage';

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
    res.end('Failed to serve file\n');
};

const isAbortedStreamError = (error: unknown) => {
    return error instanceof Error && (
        error.name === 'AbortError'
        || error.message === 'aborted'
        || error.message === 'The operation was aborted'
    );
};

const handleStreamingResponseError = (res: http.ServerResponse, error: unknown, contextMessage: string) => {
    if (isAbortedStreamError(error) || res.destroyed || res.writableEnded) {
        return;
    }

    console.error(contextMessage, error);

    if (res.headersSent) {
        res.destroy();
        return;
    }

    sendServerError(res);
};

const MEDIA_RANGE_HEADER = 'bytes';

const buildBaseFileHeaders = (contentType: string, contentLength: number) => ({
    'Content-Type': contentType,
    'Content-Length': contentLength,
    'Accept-Ranges': MEDIA_RANGE_HEADER,
    'Cache-Control': 'public, max-age=300'
});

const parseSingleRangeHeader = (rangeHeader: string | undefined, size: number) => {
    if (!rangeHeader) {
        return null;
    }

    const trimmed = rangeHeader.trim();
    const match = /^bytes=(\d*)-(\d*)$/i.exec(trimmed);
    if (!match) {
        return { malformed: true as const };
    }

    const startRaw = match[1] || '';
    const endRaw = match[2] || '';
    if (!startRaw && !endRaw) {
        return { malformed: true as const };
    }

    let start: number;
    let end: number;

    if (!startRaw) {
        const suffixLength = Number.parseInt(endRaw, 10);
        if (!Number.isFinite(suffixLength) || suffixLength <= 0) {
            return { malformed: true as const };
        }
        if (suffixLength >= size) {
            start = 0;
        } else {
            start = size - suffixLength;
        }
        end = size - 1;
    } else {
        start = Number.parseInt(startRaw, 10);
        if (!Number.isFinite(start) || start < 0 || start >= size) {
            return { unsatisfiable: true as const };
        }

        if (!endRaw) {
            end = size - 1;
        } else {
            end = Number.parseInt(endRaw, 10);
            if (!Number.isFinite(end) || end < start) {
                return { malformed: true as const };
            }
            if (end >= size) {
                end = size - 1;
            }
        }
    }

    return {
        start,
        end,
        length: end - start + 1
    };
};

const sendRangeNotSatisfiable = (res: http.ServerResponse, size: number) => {
    res.writeHead(416, {
        'Content-Range': `bytes */${size}`,
        'Accept-Ranges': MEDIA_RANGE_HEADER
    });
    res.end();
};

const streamLocalFile = async (req: http.IncomingMessage, res: http.ServerResponse, filePath: string, fallbackContentType: string | null = null) => {
    const stats = await fs.promises.stat(filePath);
    const parsedRange = parseSingleRangeHeader(req.headers.range, stats.size);
    const contentType = getFileContentType(filePath, fallbackContentType);

    if (parsedRange && 'malformed' in parsedRange) {
        res.writeHead(200, buildBaseFileHeaders(contentType, stats.size));
        await pipeline(fs.createReadStream(filePath), res);
        return;
    }

    if (parsedRange && 'unsatisfiable' in parsedRange) {
        sendRangeNotSatisfiable(res, stats.size);
        return;
    }

    if (!parsedRange) {
        res.writeHead(200, buildBaseFileHeaders(contentType, stats.size));
        await pipeline(fs.createReadStream(filePath), res);
        return;
    }

    res.writeHead(206, {
        ...buildBaseFileHeaders(contentType, parsedRange.length),
        'Content-Range': `bytes ${parsedRange.start}-${parsedRange.end}/${stats.size}`
    });
    await pipeline(fs.createReadStream(filePath, { start: parsedRange.start, end: parsedRange.end }), res);
};

const streamS3File = async (req: http.IncomingMessage, res: http.ServerResponse, key: string, config: S3StorageConfig, fallbackContentType: string | null = null) => {
    const rangeHeader = req.headers.range?.trim() || null;
    const normalizedRange = rangeHeader && /^bytes=(\d*)-(\d*)$/i.test(rangeHeader) ? rangeHeader : null;
    const response = await getFileStreamFromS3({
        config,
        key,
        range: normalizedRange
    });

    const contentType = getFileContentType(key, response.contentType || fallbackContentType);
    const isPartial = Boolean(normalizedRange && response.contentRange);
    const headers: Record<string, string | number> = {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=300',
        'Accept-Ranges': response.acceptRanges || MEDIA_RANGE_HEADER
    };

    if (response.contentLength !== null) {
        headers['Content-Length'] = response.contentLength;
    }
    if (response.contentRange) {
        headers['Content-Range'] = response.contentRange;
    }

    res.writeHead(isPartial ? 206 : 200, headers);
    await pipeline(response.body, res);
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

                    await streamS3File(req, res, key, storageSettings.s3, getIconContentType(key));
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

                await streamLocalFile(req, res, iconFilePath, getIconContentType(iconFilePath));
                return;
            } catch (error) {
                handleStreamingResponseError(res, error, 'Failed to serve server icon:');
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

                    await streamS3File(req, res, key, storageSettings.s3);
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

                await streamLocalFile(req, res, filePath);
                return;
            } catch (error) {
                handleStreamingResponseError(res, error, 'Failed to serve stored file:');
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

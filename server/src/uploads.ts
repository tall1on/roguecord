import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { dataDir } from './db';
import type { S3StorageConfig } from './storage/s3Storage';
import { buildS3StorageKey, uploadFilePathToS3Multipart } from './storage/s3Storage';

export const MAX_UPLOAD_FILE_SIZE_BYTES = 2 * 1024 * 1024 * 1024;
export const MAX_UPLOAD_CHUNK_SIZE_BYTES = 8 * 1024 * 1024;
export const MAX_UPLOAD_PATH_TTL_MS = 15 * 60 * 1000;

const uploadsRootDir = path.resolve(dataDir, 'uploads');

export type PendingUploadKind = 'message_attachment' | 'folder_file';

export interface PendingUploadRecord {
  uploadId: string;
  kind: PendingUploadKind;
  channelId: string;
  userId: string;
  originalName: string;
  mimeType: string | null;
  storageName: string;
  expectedSize: number;
  receivedBytes: number;
  tempFilePath: string;
  createdAt: number;
  updatedAt: number;
}

const pendingUploads = new Map<string, PendingUploadRecord>();

const sanitizeSegment = (value: string) => value.replace(/[^a-zA-Z0-9-]/g, '');

export const sanitizeUploadFileName = (value: string, fallback = 'attachment') => {
  const normalized = path.basename((value || '').trim()).replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_').trim();
  return normalized || fallback;
};

const ensureUploadsRootDir = () => {
  if (!fs.existsSync(uploadsRootDir)) {
    fs.mkdirSync(uploadsRootDir, { recursive: true });
  }
};

const getUploadDirectory = (uploadId: string) => {
  ensureUploadsRootDir();
  const safeUploadId = sanitizeSegment(uploadId);
  const dir = path.resolve(uploadsRootDir, safeUploadId);
  if (!dir.startsWith(uploadsRootDir)) {
    throw new Error('Unsafe upload directory');
  }
  return dir;
};

const cleanupUploadFile = (record: PendingUploadRecord) => {
  try {
    if (fs.existsSync(record.tempFilePath)) {
      fs.unlinkSync(record.tempFilePath);
    }
  } catch {
    // ignore cleanup errors
  }

  try {
    const dir = path.dirname(record.tempFilePath);
    if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) {
      fs.rmdirSync(dir);
    }
  } catch {
    // ignore cleanup errors
  }
};

export const purgeExpiredPendingUploads = () => {
  const now = Date.now();
  for (const [uploadId, record] of pendingUploads.entries()) {
    if (now - record.updatedAt <= MAX_UPLOAD_PATH_TTL_MS) {
      continue;
    }
    cleanupUploadFile(record);
    pendingUploads.delete(uploadId);
  }
};

export const createPendingUpload = (input: {
  kind: PendingUploadKind;
  channelId: string;
  userId: string;
  originalName: string;
  mimeType?: string | null;
  expectedSize: number;
}) => {
  purgeExpiredPendingUploads();

  const uploadId = crypto.randomUUID();
  const originalName = sanitizeUploadFileName(input.originalName);
  const ext = path.extname(originalName).slice(0, 20);
  const storageName = `${crypto.randomUUID()}${ext}`;
  const dir = getUploadDirectory(uploadId);
  fs.mkdirSync(dir, { recursive: true });
  const tempFilePath = path.resolve(dir, 'upload.bin');
  fs.closeSync(fs.openSync(tempFilePath, 'w'));

  const now = Date.now();
  const record: PendingUploadRecord = {
    uploadId,
    kind: input.kind,
    channelId: input.channelId,
    userId: input.userId,
    originalName,
    mimeType: input.mimeType?.trim() || null,
    storageName,
    expectedSize: input.expectedSize,
    receivedBytes: 0,
    tempFilePath,
    createdAt: now,
    updatedAt: now
  };

  pendingUploads.set(uploadId, record);
  return record;
};

export const getPendingUpload = (uploadId: string) => {
  purgeExpiredPendingUploads();
  return pendingUploads.get(uploadId) || null;
};

export const appendPendingUploadChunk = (uploadId: string, chunk: Buffer, offset: number) => {
  const record = getPendingUpload(uploadId);
  if (!record) {
    throw new Error('Upload session not found or expired');
  }

  if (offset !== record.receivedBytes) {
    throw new Error('Upload chunk offset mismatch');
  }

  if (chunk.length > MAX_UPLOAD_CHUNK_SIZE_BYTES) {
    throw new Error('Upload chunk exceeds maximum chunk size');
  }

  const nextSize = record.receivedBytes + chunk.length;
  if (nextSize > record.expectedSize) {
    throw new Error('Upload exceeds declared file size');
  }

  const handle = fs.openSync(record.tempFilePath, 'r+');
  try {
    fs.writeSync(handle, chunk, 0, chunk.length, offset);
  } finally {
    fs.closeSync(handle);
  }

  record.receivedBytes = nextSize;
  record.updatedAt = Date.now();
  pendingUploads.set(uploadId, record);
  return record;
};

export const finalizePendingUpload = async (uploadId: string, input: {
  storageType: 'data_dir' | 's3';
  s3Config?: S3StorageConfig | null;
  s3Prefix?: string | null;
  localTargetPath?: string | null;
}) => {
  const record = getPendingUpload(uploadId);
  if (!record) {
    throw new Error('Upload session not found or expired');
  }

  if (record.receivedBytes !== record.expectedSize) {
    throw new Error('Upload is incomplete');
  }

  let storageProvider: 'data_dir' | 's3' = 'data_dir';
  let storageKey: string | null = null;

  if (input.storageType === 's3') {
    if (!input.s3Config) {
      throw new Error('S3 configuration is missing');
    }
    storageProvider = 's3';
    storageKey = buildS3StorageKey(input.s3Prefix || '', record.channelId, record.storageName);
    await uploadFilePathToS3Multipart({
      config: input.s3Config,
      key: storageKey,
      filePath: record.tempFilePath,
      mimeType: record.mimeType
    });
    cleanupUploadFile(record);
  } else {
    const localTargetPath = input.localTargetPath?.trim();
    if (!localTargetPath) {
      throw new Error('Local target path is missing');
    }
    fs.renameSync(record.tempFilePath, localTargetPath);
    try {
      const dir = path.dirname(record.tempFilePath);
      if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) {
        fs.rmdirSync(dir);
      }
    } catch {
      // ignore cleanup errors
    }
  }

  pendingUploads.delete(uploadId);

  return {
    ...record,
    storageProvider,
    storageKey
  };
};

export const abortPendingUpload = (uploadId: string) => {
  const record = getPendingUpload(uploadId);
  if (!record) {
    return false;
  }
  cleanupUploadFile(record);
  pendingUploads.delete(uploadId);
  return true;
};

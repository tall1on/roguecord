import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from '../db';
import type { S3StorageConfig } from './s3Storage';
import { buildS3StorageKey, createPresignedReadUrlForS3, deleteFileFromS3, uploadFilePathToS3Multipart } from './s3Storage';

// Camera recordings produced while a timed track run is active. Kept small and self-contained
// so the drive track code does not depend on the channel/file upload storage layout.
export type TrackRecordingStorageProvider = 'data_dir' | 's3';

export type TrackRecordingStorageMetadata = {
  storageProvider: TrackRecordingStorageProvider;
  storageKey: string | null;
  storageName: string;
  mimeType: string;
};

export const MAX_TRACK_RECORDING_SIZE_BYTES = 128 * 1024 * 1024;
export const TRACK_RECORDING_MAX_DURATION_MS = 3 * 60 * 1000;
// Extra slack on top of the hard cap so a slightly late stop message still validates.
export const TRACK_RECORDING_DURATION_SLACK_MS = 15 * 1000;

const recordingsRootDir = path.resolve(dataDir, 'track-recordings');

const MIME_EXTENSIONS: Record<string, string> = {
  'video/webm': 'webm',
  'video/mp4': 'mp4',
  'video/x-matroska': 'mkv',
  'video/ogg': 'ogv',
  'video/quicktime': 'mov'
};

export const normalizeTrackRecordingMimeType = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const base = value.trim().toLowerCase().split(';')[0]?.trim() || '';
  return MIME_EXTENSIONS[base] ? base : null;
};

export const getTrackRecordingFileExtension = (mimeType: string): string | null => MIME_EXTENSIONS[mimeType] ?? null;

export const buildTrackRecordingStorageName = (mimeType: string, storageName: string): string => {
  const extension = MIME_EXTENSIONS[mimeType];
  if (!extension) throw new Error('Unsupported track recording format');
  const safe = path.basename((storageName || '').trim()).replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_').trim();
  if (!safe) throw new Error('Invalid track recording name');
  return safe.toLowerCase().endsWith(`.${extension}`) ? safe : `${safe}.${extension}`;
};

const sanitizeRunId = (runId: string) => (runId || '').replace(/[^a-zA-Z0-9-]/g, '');

const ensureRecordingsRootDir = () => {
  if (!fs.existsSync(recordingsRootDir)) {
    fs.mkdirSync(recordingsRootDir, { recursive: true });
  }
};

export const getSafeLocalTrackRecordingPath = (runId: string, storageName: string): string => {
  ensureRecordingsRootDir();
  const safeRunId = sanitizeRunId(runId);
  const safeStorageName = path.basename(storageName || '').replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_').trim();
  if (!safeRunId || !safeStorageName) throw new Error('Invalid track recording path');

  const dir = path.resolve(recordingsRootDir, safeRunId);
  if (!dir.startsWith(recordingsRootDir)) throw new Error('Unsafe track recording directory');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const fullPath = path.resolve(dir, safeStorageName);
  if (!fullPath.startsWith(dir)) throw new Error('Unsafe track recording file path');
  return fullPath;
};

export const buildLocalTrackRecordingUrl = (runId: string, storageName: string): string => {
  const safeRunId = sanitizeRunId(runId);
  const safeStorageName = path.basename(storageName || '').replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_').trim();
  if (!safeRunId || !safeStorageName) throw new Error('Invalid track recording URL');
  return `/track-recordings/${safeRunId}/${safeStorageName}`;
};

export const buildTrackRecordingS3Key = (prefix: string | null | undefined, runId: string, storageName: string): string => {
  const safeRunId = sanitizeRunId(runId);
  if (!safeRunId) throw new Error('Invalid track recording run id');
  return buildS3StorageKey(prefix, `track-recordings/${safeRunId}`, storageName);
};

export const storeTrackRecordingFromFile = async (input: {
  runId: string;
  sourceFilePath: string;
  storageName: string;
  mimeType: string;
  storageType: TrackRecordingStorageProvider;
  s3Config: S3StorageConfig | null;
}): Promise<TrackRecordingStorageMetadata> => {
  const storageName = buildTrackRecordingStorageName(input.mimeType, input.storageName);

  if (input.storageType === 's3') {
    if (!input.s3Config) throw new Error('S3 storage is enabled but configuration is missing');
    const key = buildTrackRecordingS3Key(input.s3Config.prefix, input.runId, storageName);
    await uploadFilePathToS3Multipart({
      config: input.s3Config,
      key,
      filePath: input.sourceFilePath,
      mimeType: input.mimeType
    });
    try { if (fs.existsSync(input.sourceFilePath)) fs.unlinkSync(input.sourceFilePath); } catch { /* ignore */ }
    return { storageProvider: 's3', storageKey: key, storageName, mimeType: input.mimeType };
  }

  const targetPath = getSafeLocalTrackRecordingPath(input.runId, storageName);
  fs.renameSync(input.sourceFilePath, targetPath);
  return { storageProvider: 'data_dir', storageKey: null, storageName, mimeType: input.mimeType };
};

export const buildTrackRecordingClientUrl = async (input: {
  runId: string;
  storageProvider: TrackRecordingStorageProvider;
  storageKey: string | null;
  storageName: string;
  mimeType: string;
  persistedS3Config: S3StorageConfig | null;
  download?: boolean;
}): Promise<string | null> => {
  if (input.storageProvider === 's3' && input.storageKey && input.persistedS3Config) {
    return createPresignedReadUrlForS3({
      config: input.persistedS3Config,
      key: input.storageKey,
      fileName: input.storageName,
      mimeType: input.mimeType,
      download: input.download === true
    });
  }
  if (input.storageProvider === 'data_dir' && input.storageName) {
    const url = buildLocalTrackRecordingUrl(input.runId, input.storageName);
    return input.download ? `${url}?download=1` : url;
  }
  return null;
};

export const deleteTrackRecording = async (input: {
  runId: string;
  storageProvider: TrackRecordingStorageProvider;
  storageKey: string | null;
  storageName: string | null;
  persistedS3Config: S3StorageConfig | null;
}): Promise<void> => {
  if (input.storageProvider === 's3' && input.storageKey && input.persistedS3Config) {
    try {
      await deleteFileFromS3({ config: input.persistedS3Config, key: input.storageKey });
    } catch { /* keep stale recording when cleanup fails */ }
    return;
  }
  if (!input.storageName) return;
  try {
    const localPath = getSafeLocalTrackRecordingPath(input.runId, input.storageName);
    if (fs.existsSync(localPath)) fs.unlinkSync(localPath);
  } catch { /* keep stale recording when cleanup fails */ }
};

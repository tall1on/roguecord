import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from '../db';
import type { S3StorageConfig } from './s3Storage';
import { buildS3StorageKey, createPresignedReadUrlForS3, deleteFileFromS3, listS3KeysByPrefix, uploadFileToS3 } from './s3Storage';

export type ProfileImageStorageProvider = 'data_dir' | 's3';

export type ProfileImageMimeType = 'image/png' | 'image/jpeg' | 'image/gif';

export type ProfileImageExtension = 'png' | 'jpg' | 'gif';

export type ProfileImageStorageMetadata = {
  storageProvider: ProfileImageStorageProvider;
  storageKey: string | null;
  storageName: string;
  mimeType: ProfileImageMimeType;
};

export type ParsedProfileImageDataUrl = {
  buffer: Buffer;
  mimeType: ProfileImageMimeType;
  extension: ProfileImageExtension;
  normalizedDataUrl: string;
};

export type ProfileImageStorageKind = {
  folderName: string;
  storageNamePrefix: string;
  allowedMimeTypes: ReadonlyArray<ProfileImageMimeType>;
  maxSizeErrorLabel: string;
};

export type BuildProfileImageClientUrlInput = {
  userId: string;
  url: string | null;
  storageProvider: ProfileImageStorageProvider | null;
  storageKey: string | null;
  storageName: string | null;
  mimeType: string | null;
  persistedS3Config: S3StorageConfig | null;
};

export type StoreProfileImageInput = {
  userId: string;
  parsedImage: ParsedProfileImageDataUrl;
  storageType: ProfileImageStorageProvider;
  s3Config: S3StorageConfig | null;
};

export type CleanupProfileImageReferenceInput = {
  userId: string;
  url: string | null | undefined;
  storageProvider: ProfileImageStorageProvider | null | undefined;
  storageKey: string | null | undefined;
  storageName: string | null | undefined;
  persistedS3Config: S3StorageConfig | null;
};

export type CleanupStaleProfileImagesInput = {
  userId: string;
  s3Config: S3StorageConfig;
  activeKey: string | null;
};

const sanitizeUserIdForPath = (userId: string) => (userId || '').replace(/[^a-zA-Z0-9-]/g, '');

const sanitizeStorageName = (storageName: string) => path.basename(storageName || '').replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_').trim();

const buildMimeAlternatives = (allowed: ReadonlyArray<ProfileImageMimeType>) => {
  const alternatives: string[] = [];
  for (const mimeType of allowed) {
    alternatives.push(mimeType.replace('/', '\\/'));
    if (mimeType === 'image/jpeg') {
      alternatives.push('image\\/jpg');
    }
  }
  return alternatives;
};

export const createProfileImageStorage = (kind: ProfileImageStorageKind) => {
  const rootDir = path.resolve(dataDir, kind.folderName);
  const allowedMimeTypes = new Set<ProfileImageMimeType>(kind.allowedMimeTypes);
  const dataUrlRegex = new RegExp(`^data:(${buildMimeAlternatives(kind.allowedMimeTypes).join('|')});base64,([a-z0-9+/=\\r\\n]+)$`, 'i');

  const ensureRootDir = () => {
    if (!fs.existsSync(rootDir)) {
      fs.mkdirSync(rootDir, { recursive: true });
    }
  };

  const parseDataUrl = (value: unknown, maxSizeBytes: number): ParsedProfileImageDataUrl | null => {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    const match = trimmed.match(dataUrlRegex);
    if (!match) return null;

    const rawMimeType = match[1]!.toLowerCase();
    const mimeType = (rawMimeType === 'image/jpg' ? 'image/jpeg' : rawMimeType) as ProfileImageMimeType;
    if (!allowedMimeTypes.has(mimeType)) return null;

    const extension: ProfileImageExtension = mimeType === 'image/jpeg' ? 'jpg' : (mimeType.split('/')[1] as ProfileImageExtension);
    const buffer = Buffer.from(match[2] || '', 'base64');
    if (!buffer.length) return null;
    if (buffer.length > maxSizeBytes) {
      throw new Error(`${kind.maxSizeErrorLabel} exceeds 10MB size limit.`);
    }

    return {
      buffer,
      mimeType,
      extension,
      normalizedDataUrl: `data:${mimeType};base64,${buffer.toString('base64')}`
    };
  };

  const buildStorageName = (extension: string) => {
    const safeExtension = (extension || '').trim().replace(/[^a-z0-9]/gi, '').toLowerCase();
    if (!safeExtension) {
      throw new Error('Invalid image extension');
    }
    return `${kind.storageNamePrefix}-${crypto.randomUUID()}.${safeExtension}`;
  };

  const getSafeLocalPath = (userId: string, storageName: string) => {
    ensureRootDir();
    const safeUserId = sanitizeUserIdForPath(userId);
    const safeStorageName = sanitizeStorageName(storageName);
    if (!safeUserId || !safeStorageName) {
      throw new Error('Invalid image path');
    }

    const dir = path.resolve(rootDir, safeUserId);
    const root = path.resolve(rootDir);
    if (!dir.startsWith(root)) {
      throw new Error('Unsafe image directory');
    }

    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const fullPath = path.resolve(dir, safeStorageName);
    if (!fullPath.startsWith(dir)) {
      throw new Error('Unsafe image file path');
    }

    return fullPath;
  };

  const buildLocalUrl = (userId: string, storageName: string) => {
    const safeUserId = sanitizeUserIdForPath(userId);
    const safeStorageName = sanitizeStorageName(storageName);
    if (!safeUserId || !safeStorageName) {
      throw new Error('Invalid image URL');
    }
    return `/${kind.folderName}/${safeUserId}/${safeStorageName}`;
  };

  const parseSafeLocalStorageName = (userId: string, url: string): string | null => {
    const safeUserId = sanitizeUserIdForPath(userId);
    if (!safeUserId) {
      return null;
    }

    const normalizedPath = (url || '').trim();
    const supportedPrefixes = [
      `/${kind.folderName}/${safeUserId}/`,
      `/files/${kind.folderName}/${safeUserId}/`
    ];
    const matchingPrefix = supportedPrefixes.find((prefix) => normalizedPath.startsWith(prefix));
    if (!matchingPrefix) {
      return null;
    }

    const storageName = normalizedPath.slice(matchingPrefix.length).trim();
    if (!storageName || storageName.includes('/') || storageName.includes('\\')) {
      return null;
    }

    const safeStorageName = sanitizeStorageName(storageName);
    return safeStorageName && safeStorageName === storageName ? safeStorageName : null;
  };

  const buildS3Prefix = (prefix: string | null | undefined, userId: string) => {
    const marker = `__${kind.storageNamePrefix}_marker__`;
    const keyWithMarker = buildS3StorageKey(prefix, `${kind.folderName}/${sanitizeUserIdForPath(userId)}`, marker);
    return keyWithMarker.slice(0, -marker.length);
  };

  const isSafeS3KeyForUser = (userId: string, key: string) => {
    const trimmed = (key || '').trim();
    const safeUserId = sanitizeUserIdForPath(userId);
    if (!trimmed || !safeUserId) {
      return false;
    }
    if (trimmed.includes('\\') || /[\u0000-\u001F]/.test(trimmed)) {
      return false;
    }
    const segments = trimmed.split('/').filter(Boolean);
    if (!segments.length || segments.some((segment) => segment === '.' || segment === '..')) {
      return false;
    }

    const marker = `${kind.folderName}/${safeUserId}/`;
    return trimmed === `${kind.folderName}/${safeUserId}` || trimmed.includes(marker);
  };

  const buildClientUrl = async (input: BuildProfileImageClientUrlInput) => {
    if (input.storageProvider === 's3' && input.storageKey && input.persistedS3Config) {
      return createPresignedReadUrlForS3({
        config: input.persistedS3Config,
        key: input.storageKey,
        fileName: input.storageName || `${kind.storageNamePrefix}-${input.userId}`,
        mimeType: input.mimeType
      });
    }

    if (input.storageProvider === 'data_dir' && input.storageName) {
      return buildLocalUrl(input.userId, input.storageName);
    }

    return input.url;
  };

  const storeImage = async (input: StoreProfileImageInput): Promise<ProfileImageStorageMetadata> => {
    const storageName = buildStorageName(input.parsedImage.extension);

    if (input.storageType === 's3') {
      if (!input.s3Config) {
        throw new Error('S3 storage is enabled but configuration is missing');
      }

      const key = buildS3StorageKey(input.s3Config.prefix, `${kind.folderName}/${sanitizeUserIdForPath(input.userId)}`, storageName);
      await uploadFileToS3({
        config: input.s3Config,
        key,
        buffer: input.parsedImage.buffer,
        mimeType: input.parsedImage.mimeType
      });

      return {
        storageProvider: 's3',
        storageKey: key,
        storageName,
        mimeType: input.parsedImage.mimeType
      };
    }

    const targetPath = getSafeLocalPath(input.userId, storageName);
    fs.writeFileSync(targetPath, input.parsedImage.buffer);
    return {
      storageProvider: 'data_dir',
      storageKey: null,
      storageName,
      mimeType: input.parsedImage.mimeType
    };
  };

  const cleanupReference = async (input: CleanupProfileImageReferenceInput) => {
    if (input.storageProvider === 's3' && input.storageKey && input.persistedS3Config) {
      if (!isSafeS3KeyForUser(input.userId, input.storageKey)) {
        return;
      }
      try {
        await deleteFileFromS3({ config: input.persistedS3Config, key: input.storageKey });
      } catch {
        // keep stale S3 image when cleanup fails
      }
      return;
    }

    const localStorageName = input.storageName || (input.url ? parseSafeLocalStorageName(input.userId, input.url) : null);
    if (!localStorageName) {
      return;
    }

    try {
      const localPath = getSafeLocalPath(input.userId, localStorageName);
      if (fs.existsSync(localPath)) {
        fs.unlinkSync(localPath);
      }
    } catch {
      // keep stale local image when cleanup fails
    }
  };

  const cleanupStaleS3 = async (input: CleanupStaleProfileImagesInput) => {
    const imagePrefix = buildS3Prefix(input.s3Config.prefix, input.userId);
    const existingKeys = await listS3KeysByPrefix({ config: input.s3Config, prefix: imagePrefix });
    for (const existingKey of existingKeys) {
      if (input.activeKey && existingKey === input.activeKey) {
        continue;
      }
      if (!isSafeS3KeyForUser(input.userId, existingKey)) {
        continue;
      }
      try {
        await deleteFileFromS3({ config: input.s3Config, key: existingKey });
      } catch {
        // ignore cleanup failures
      }
    }
  };

  return {
    ensureRootDir,
    parseDataUrl,
    buildStorageName,
    getSafeLocalPath,
    buildLocalUrl,
    parseSafeLocalStorageName,
    buildS3Prefix,
    isSafeS3KeyForUser,
    buildClientUrl,
    storeImage,
    cleanupReference,
    cleanupStaleS3
  };
};

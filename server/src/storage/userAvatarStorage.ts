import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from '../db';
import type { S3StorageConfig } from './s3Storage';
import { buildS3StorageKey, createPresignedReadUrlForS3, deleteFileFromS3, listS3KeysByPrefix, uploadFileToS3 } from './s3Storage';

export type UserAvatarStorageProvider = 'data_dir' | 's3';

export type UserAvatarStorageMetadata = {
  storageProvider: UserAvatarStorageProvider;
  storageKey: string | null;
  storageName: string;
  mimeType: string;
};

export type ParsedUserAvatarDataUrl = {
  buffer: Buffer;
  mimeType: 'image/png' | 'image/jpeg' | 'image/gif';
  extension: 'png' | 'jpg' | 'gif';
  normalizedDataUrl: string;
};

const userAvatarsRootDir = path.resolve(dataDir, 'user-avatars');

const sanitizeUserIdForPath = (userId: string) => (userId || '').replace(/[^a-zA-Z0-9-]/g, '');

const sanitizeStorageName = (storageName: string) => path.basename(storageName || '').replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_').trim();

export const ensureUserAvatarsRootDir = () => {
  if (!fs.existsSync(userAvatarsRootDir)) {
    fs.mkdirSync(userAvatarsRootDir, { recursive: true });
  }
};

export const parseUserAvatarDataUrl = (value: unknown, maxSizeBytes: number): ParsedUserAvatarDataUrl | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  const match = trimmed.match(/^data:(image\/(png|jpeg|jpg|gif));base64,([a-z0-9+/=\r\n]+)$/i);
  if (!match) return null;

  const mimeType = match[1].toLowerCase() === 'image/jpg' ? 'image/jpeg' : (match[1].toLowerCase() as 'image/png' | 'image/jpeg' | 'image/gif');
  const extension = mimeType === 'image/jpeg' ? 'jpg' : (mimeType.split('/')[1] as 'png' | 'gif');
  const buffer = Buffer.from(match[3] || '', 'base64');
  if (!buffer.length) return null;
  if (buffer.length > maxSizeBytes) {
    throw new Error('Profile picture exceeds 10MB size limit.');
  }

  return {
    buffer,
    mimeType,
    extension,
    normalizedDataUrl: `data:${mimeType};base64,${buffer.toString('base64')}`
  };
};

export const buildUserAvatarStorageName = (extension: string) => {
  const safeExtension = (extension || '').trim().replace(/[^a-z0-9]/gi, '').toLowerCase();
  if (!safeExtension) {
    throw new Error('Invalid avatar extension');
  }
  return `avatar-${crypto.randomUUID()}.${safeExtension}`;
};

export const getSafeLocalUserAvatarPath = (userId: string, storageName: string) => {
  ensureUserAvatarsRootDir();
  const safeUserId = sanitizeUserIdForPath(userId);
  const safeStorageName = sanitizeStorageName(storageName);
  if (!safeUserId || !safeStorageName) {
    throw new Error('Invalid user avatar path');
  }

  const dir = path.resolve(userAvatarsRootDir, safeUserId);
  const root = path.resolve(userAvatarsRootDir);
  if (!dir.startsWith(root)) {
    throw new Error('Unsafe user avatar directory');
  }

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const fullPath = path.resolve(dir, safeStorageName);
  if (!fullPath.startsWith(dir)) {
    throw new Error('Unsafe user avatar file path');
  }

  return fullPath;
};

export const buildLocalUserAvatarUrl = (userId: string, storageName: string) => {
  const safeUserId = sanitizeUserIdForPath(userId);
  const safeStorageName = sanitizeStorageName(storageName);
  if (!safeUserId || !safeStorageName) {
    throw new Error('Invalid user avatar URL');
  }
  return `/user-avatars/${safeUserId}/${safeStorageName}`;
};

export const parseSafeLocalUserAvatarStorageName = (userId: string, avatarUrl: string): string | null => {
  const safeUserId = sanitizeUserIdForPath(userId);
  if (!safeUserId) {
    return null;
  }

  const normalizedPath = (avatarUrl || '').trim();
  const supportedPrefixes = [
    `/user-avatars/${safeUserId}/`,
    `/files/user-avatars/${safeUserId}/`
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

export const buildS3UserAvatarPrefix = (prefix: string | null | undefined, userId: string) => {
  const marker = '__user_avatar_marker__';
  const keyWithMarker = buildS3StorageKey(prefix, `user-avatars/${sanitizeUserIdForPath(userId)}`, marker);
  return keyWithMarker.slice(0, -marker.length);
};

export const isSafeS3AvatarKeyForUser = (userId: string, key: string) => {
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

  const marker = `user-avatars/${safeUserId}/`;
  return trimmed === `user-avatars/${safeUserId}` || trimmed.includes(marker);
};

export const buildUserAvatarClientUrl = async (input: {
  userId: string;
  avatarUrl: string | null;
  avatarStorageProvider: UserAvatarStorageProvider | null;
  avatarStorageKey: string | null;
  avatarStorageName: string | null;
  avatarMimeType: string | null;
  persistedS3Config: S3StorageConfig | null;
}) => {
  if (input.avatarStorageProvider === 's3' && input.avatarStorageKey && input.persistedS3Config) {
    const presignedUrl = createPresignedReadUrlForS3({
      config: input.persistedS3Config,
      key: input.avatarStorageKey,
      fileName: input.avatarStorageName || `avatar-${input.userId}`,
      mimeType: input.avatarMimeType
    });

    console.info('[AVATAR DEBUG] Resolved S3 user avatar URL', {
      userId: input.userId,
      provider: input.avatarStorageProvider,
      storageKeyPresent: Boolean(input.avatarStorageKey),
      storageName: input.avatarStorageName || null,
      resolvedUrlPresent: Boolean(presignedUrl)
    });

    return presignedUrl;
  }

  if (input.avatarStorageProvider === 'data_dir' && input.avatarStorageName) {
    const localUrl = buildLocalUserAvatarUrl(input.userId, input.avatarStorageName);

    console.info('[AVATAR DEBUG] Resolved local data-dir user avatar URL', {
      userId: input.userId,
      provider: input.avatarStorageProvider,
      storageName: input.avatarStorageName,
      resolvedUrl: localUrl
    });

    return localUrl;
  }

  console.info('[AVATAR DEBUG] Falling back to persisted avatar_url value', {
    userId: input.userId,
    provider: input.avatarStorageProvider,
    storageName: input.avatarStorageName,
    rawAvatarUrlPresent: Boolean(input.avatarUrl),
    rawAvatarUrl: input.avatarUrl
  });

  return input.avatarUrl;
};

export const storeUserAvatar = async (input: {
  userId: string;
  parsedAvatar: ParsedUserAvatarDataUrl;
  storageType: UserAvatarStorageProvider;
  s3Config: S3StorageConfig | null;
}) : Promise<UserAvatarStorageMetadata> => {
  const storageName = buildUserAvatarStorageName(input.parsedAvatar.extension);

  if (input.storageType === 's3') {
    if (!input.s3Config) {
      throw new Error('S3 storage is enabled but configuration is missing');
    }

    const key = buildS3StorageKey(input.s3Config.prefix, `user-avatars/${sanitizeUserIdForPath(input.userId)}`, storageName);
    await uploadFileToS3({
      config: input.s3Config,
      key,
      buffer: input.parsedAvatar.buffer,
      mimeType: input.parsedAvatar.mimeType
    });

    return {
      storageProvider: 's3',
      storageKey: key,
      storageName,
      mimeType: input.parsedAvatar.mimeType
    };
  }

  const targetPath = getSafeLocalUserAvatarPath(input.userId, storageName);
  fs.writeFileSync(targetPath, input.parsedAvatar.buffer);
  return {
    storageProvider: 'data_dir',
    storageKey: null,
    storageName,
    mimeType: input.parsedAvatar.mimeType
  };
};

export const cleanupUserAvatarReference = async (input: {
  userId: string;
  avatarUrl: string | null | undefined;
  avatarStorageProvider: UserAvatarStorageProvider | null | undefined;
  avatarStorageKey: string | null | undefined;
  avatarStorageName: string | null | undefined;
  persistedS3Config: S3StorageConfig | null;
}) => {
  if (input.avatarStorageProvider === 's3' && input.avatarStorageKey && input.persistedS3Config) {
    if (!isSafeS3AvatarKeyForUser(input.userId, input.avatarStorageKey)) {
      return;
    }
    try {
      await deleteFileFromS3({ config: input.persistedS3Config, key: input.avatarStorageKey });
    } catch {
      // keep stale S3 avatar when cleanup fails
    }
    return;
  }

  const localStorageName = input.avatarStorageName || (input.avatarUrl ? parseSafeLocalUserAvatarStorageName(input.userId, input.avatarUrl) : null);
  if (!localStorageName) {
    return;
  }

  try {
    const localPath = getSafeLocalUserAvatarPath(input.userId, localStorageName);
    if (fs.existsSync(localPath)) {
      fs.unlinkSync(localPath);
    }
  } catch {
    // keep stale local avatar when cleanup fails
  }
};

export const cleanupStaleS3UserAvatars = async (input: {
  userId: string;
  s3Config: S3StorageConfig;
  activeKey: string | null;
}) => {
  const avatarPrefix = buildS3UserAvatarPrefix(input.s3Config.prefix, input.userId);
  const existingKeys = await listS3KeysByPrefix({ config: input.s3Config, prefix: avatarPrefix });
  for (const existingKey of existingKeys) {
    if (input.activeKey && existingKey === input.activeKey) {
      continue;
    }
    if (!isSafeS3AvatarKeyForUser(input.userId, existingKey)) {
      continue;
    }
    try {
      await deleteFileFromS3({ config: input.s3Config, key: existingKey });
    } catch {
      // ignore cleanup failures
    }
  }
};

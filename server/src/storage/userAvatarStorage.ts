import type { S3StorageConfig } from './s3Storage';
import {
  createProfileImageStorage,
  type ParsedProfileImageDataUrl,
  type ProfileImageStorageMetadata,
  type ProfileImageStorageProvider
} from './profileImageStorage';

export type UserAvatarStorageProvider = ProfileImageStorageProvider;
export type UserAvatarStorageMetadata = ProfileImageStorageMetadata;
export type ParsedUserAvatarDataUrl = ParsedProfileImageDataUrl;

const storage = createProfileImageStorage({
  folderName: 'user-avatars',
  storageNamePrefix: 'avatar',
  allowedMimeTypes: ['image/png', 'image/jpeg', 'image/gif'],
  maxSizeErrorLabel: 'Profile picture'
});

export const ensureUserAvatarsRootDir = storage.ensureRootDir;

export const parseUserAvatarDataUrl = storage.parseDataUrl;

export const buildUserAvatarStorageName = storage.buildStorageName;

export const getSafeLocalUserAvatarPath = storage.getSafeLocalPath;

export const buildLocalUserAvatarUrl = storage.buildLocalUrl;

export const parseSafeLocalUserAvatarStorageName = storage.parseSafeLocalStorageName;

export const buildS3UserAvatarPrefix = storage.buildS3Prefix;

export const isSafeS3AvatarKeyForUser = storage.isSafeS3KeyForUser;

export const buildUserAvatarClientUrl = (input: {
  userId: string;
  avatarUrl: string | null;
  avatarStorageProvider: UserAvatarStorageProvider | null;
  avatarStorageKey: string | null;
  avatarStorageName: string | null;
  avatarMimeType: string | null;
  persistedS3Config: S3StorageConfig | null;
}) => storage.buildClientUrl({
  userId: input.userId,
  url: input.avatarUrl,
  storageProvider: input.avatarStorageProvider,
  storageKey: input.avatarStorageKey,
  storageName: input.avatarStorageName,
  mimeType: input.avatarMimeType,
  persistedS3Config: input.persistedS3Config
});

export const storeUserAvatar = (input: {
  userId: string;
  parsedAvatar: ParsedUserAvatarDataUrl;
  storageType: UserAvatarStorageProvider;
  s3Config: S3StorageConfig | null;
}) => storage.storeImage({
  userId: input.userId,
  parsedImage: input.parsedAvatar,
  storageType: input.storageType,
  s3Config: input.s3Config
});

export const cleanupUserAvatarReference = (input: {
  userId: string;
  avatarUrl: string | null | undefined;
  avatarStorageProvider: UserAvatarStorageProvider | null | undefined;
  avatarStorageKey: string | null | undefined;
  avatarStorageName: string | null | undefined;
  persistedS3Config: S3StorageConfig | null;
}) => storage.cleanupReference({
  userId: input.userId,
  url: input.avatarUrl,
  storageProvider: input.avatarStorageProvider,
  storageKey: input.avatarStorageKey,
  storageName: input.avatarStorageName,
  persistedS3Config: input.persistedS3Config
});

export const cleanupStaleS3UserAvatars = (input: {
  userId: string;
  s3Config: S3StorageConfig;
  activeKey: string | null;
}) => storage.cleanupStaleS3(input);

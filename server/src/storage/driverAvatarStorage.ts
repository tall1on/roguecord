import type { S3StorageConfig } from './s3Storage';
import {
  createProfileImageStorage,
  type ParsedProfileImageDataUrl,
  type ProfileImageStorageMetadata,
  type ProfileImageStorageProvider
} from './profileImageStorage';

export type DriverAvatarStorageProvider = ProfileImageStorageProvider;
export type DriverAvatarStorageMetadata = ProfileImageStorageMetadata;
export type ParsedDriverAvatarDataUrl = ParsedProfileImageDataUrl;

const storage = createProfileImageStorage({
  folderName: 'driver-avatars',
  storageNamePrefix: 'driver',
  allowedMimeTypes: ['image/png', 'image/jpeg'],
  maxSizeErrorLabel: 'Driver avatar'
});

export const ensureDriverAvatarsRootDir = storage.ensureRootDir;

export const parseDriverAvatarDataUrl = storage.parseDataUrl;

export const buildDriverAvatarStorageName = storage.buildStorageName;

export const getSafeLocalDriverAvatarPath = storage.getSafeLocalPath;

export const buildLocalDriverAvatarUrl = storage.buildLocalUrl;

export const parseSafeLocalDriverAvatarStorageName = storage.parseSafeLocalStorageName;

export const buildS3DriverAvatarPrefix = storage.buildS3Prefix;

export const isSafeS3DriverAvatarKeyForUser = storage.isSafeS3KeyForUser;

export const buildDriverAvatarClientUrl = (input: {
  userId: string;
  driverAvatarUrl: string | null;
  driverAvatarStorageProvider: DriverAvatarStorageProvider | null;
  driverAvatarStorageKey: string | null;
  driverAvatarStorageName: string | null;
  driverAvatarMimeType: string | null;
  persistedS3Config: S3StorageConfig | null;
}) => storage.buildClientUrl({
  userId: input.userId,
  url: input.driverAvatarUrl,
  storageProvider: input.driverAvatarStorageProvider,
  storageKey: input.driverAvatarStorageKey,
  storageName: input.driverAvatarStorageName,
  mimeType: input.driverAvatarMimeType,
  persistedS3Config: input.persistedS3Config
});

export const storeDriverAvatar = (input: {
  userId: string;
  parsedAvatar: ParsedDriverAvatarDataUrl;
  storageType: DriverAvatarStorageProvider;
  s3Config: S3StorageConfig | null;
}) => storage.storeImage({
  userId: input.userId,
  parsedImage: input.parsedAvatar,
  storageType: input.storageType,
  s3Config: input.s3Config
});

export const cleanupDriverAvatarReference = (input: {
  userId: string;
  driverAvatarUrl: string | null | undefined;
  driverAvatarStorageProvider: DriverAvatarStorageProvider | null | undefined;
  driverAvatarStorageKey: string | null | undefined;
  driverAvatarStorageName: string | null | undefined;
  persistedS3Config: S3StorageConfig | null;
}) => storage.cleanupReference({
  userId: input.userId,
  url: input.driverAvatarUrl,
  storageProvider: input.driverAvatarStorageProvider,
  storageKey: input.driverAvatarStorageKey,
  storageName: input.driverAvatarStorageName,
  persistedS3Config: input.persistedS3Config
});

export const cleanupStaleS3DriverAvatars = (input: {
  userId: string;
  s3Config: S3StorageConfig;
  activeKey: string | null;
}) => storage.cleanupStaleS3(input);

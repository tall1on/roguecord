import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client
} from '@aws-sdk/client-s3';

export type S3StorageConfig = {
  endpoint: string;
  region: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
  prefix?: string | null;
};

const normalizePrefix = (prefix: string | null | undefined) => {
  const trimmed = (prefix || '').trim().replace(/^\/+/, '').replace(/\/+$/, '');
  return trimmed.length > 0 ? trimmed : null;
};

const sanitizeEndpoint = (endpoint: string) => {
  const trimmed = (endpoint || '').trim();
  if (!trimmed) {
    throw new Error('S3 endpoint is required');
  }
  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const parsed = new URL(withProtocol);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('S3 endpoint must use http or https');
  }
  return parsed.toString().replace(/\/$/, '');
};

const sanitizeConfig = (config: S3StorageConfig): S3StorageConfig => {
  const endpoint = sanitizeEndpoint(config.endpoint);
  const region = (config.region || '').trim();
  const bucket = (config.bucket || '').trim();
  const accessKey = (config.accessKey || '').trim();
  const secretKey = (config.secretKey || '').trim();
  const prefix = normalizePrefix(config.prefix);

  if (!region) {
    throw new Error('S3 region is required');
  }
  if (!bucket) {
    throw new Error('S3 bucket is required');
  }
  if (!accessKey) {
    throw new Error('S3 access key is required');
  }
  if (!secretKey) {
    throw new Error('S3 secret key is required');
  }

  return {
    endpoint,
    region,
    bucket,
    accessKey,
    secretKey,
    prefix
  };
};

const extractS3ValidationErrorMessage = (error: unknown) => {
  if (!error || typeof error !== 'object') {
    return 'Unknown S3 error';
  }

  const awsError = error as {
    name?: unknown;
    code?: unknown;
    message?: unknown;
    $metadata?: { httpStatusCode?: unknown; requestId?: unknown; extendedRequestId?: unknown };
    Code?: unknown;
    Message?: unknown;
  };

  const name = typeof awsError.name === 'string' && awsError.name.trim() ? awsError.name.trim() : null;
  const code = typeof awsError.code === 'string' && awsError.code.trim()
    ? awsError.code.trim()
    : (typeof awsError.Code === 'string' && awsError.Code.trim() ? awsError.Code.trim() : null);
  const message = typeof awsError.message === 'string' && awsError.message.trim()
    ? awsError.message.trim()
    : (typeof awsError.Message === 'string' && awsError.Message.trim() ? awsError.Message.trim() : null);
  const statusCode = typeof awsError.$metadata?.httpStatusCode === 'number' ? awsError.$metadata.httpStatusCode : null;

  const parts: string[] = [];
  if (statusCode) parts.push(`HTTP ${statusCode}`);
  if (code) parts.push(code);
  else if (name) parts.push(name);
  if (message) parts.push(message);

  if (parts.length === 0) {
    return 'Unknown S3 error';
  }

  return parts.join(': ');
};

const createS3Client = (config: S3StorageConfig) => {
  const normalized = sanitizeConfig(config);
  return new S3Client({
    region: normalized.region,
    endpoint: normalized.endpoint,
    forcePathStyle: true,
    credentials: {
      accessKeyId: normalized.accessKey,
      secretAccessKey: normalized.secretKey
    }
  });
};

export const buildS3StorageKey = (prefix: string | null | undefined, channelId: string, storageName: string) => {
  const normalizedPrefix = normalizePrefix(prefix);
  const keyWithoutPrefix = `channels/${channelId}/${storageName}`;
  return normalizedPrefix ? `${normalizedPrefix}/${keyWithoutPrefix}` : keyWithoutPrefix;
};

export const validateS3Configuration = async (config: S3StorageConfig): Promise<{ ok: true } | { ok: false; message: string }> => {
  let normalized: S3StorageConfig;
  try {
    normalized = sanitizeConfig(config);
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : 'Invalid S3 configuration'
    };
  }

  const client = createS3Client(normalized);
  const testKey = buildS3StorageKey(normalized.prefix, '__healthcheck__', `${Date.now()}-roguecord.txt`);

  try {
    await client.send(new PutObjectCommand({
      Bucket: normalized.bucket,
      Key: testKey,
      Body: Buffer.from('roguecord-s3-healthcheck', 'utf8'),
      ContentType: 'text/plain'
    }));

    await client.send(new DeleteObjectCommand({
      Bucket: normalized.bucket,
      Key: testKey
    }));

    return { ok: true };
  } catch (error) {
    const message = extractS3ValidationErrorMessage(error);
    return {
      ok: false,
      message: `S3 validation failed: ${message}`
    };
  }
};

export const uploadFileToS3 = async (input: {
  config: S3StorageConfig;
  key: string;
  buffer: Buffer;
  mimeType?: string | null;
}) => {
  const normalized = sanitizeConfig(input.config);
  const client = createS3Client(normalized);
  await client.send(new PutObjectCommand({
    Bucket: normalized.bucket,
    Key: input.key,
    Body: input.buffer,
    ContentType: input.mimeType || 'application/octet-stream'
  }));
};

export const downloadFileFromS3 = async (input: {
  config: S3StorageConfig;
  key: string;
}): Promise<Buffer> => {
  const normalized = sanitizeConfig(input.config);
  const client = createS3Client(normalized);
  const response = await client.send(new GetObjectCommand({
    Bucket: normalized.bucket,
    Key: input.key
  }));

  const chunks: Buffer[] = [];
  if (!response.Body) {
    throw new Error('S3 object is empty');
  }

  for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
};

export const deleteFileFromS3 = async (input: {
  config: S3StorageConfig;
  key: string;
}) => {
  const normalized = sanitizeConfig(input.config);
  const client = createS3Client(normalized);
  await client.send(new DeleteObjectCommand({
    Bucket: normalized.bucket,
    Key: input.key
  }));
};


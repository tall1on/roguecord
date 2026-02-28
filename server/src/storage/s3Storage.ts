import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
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

type ResolvedS3Config = S3StorageConfig & {
  forcePathStyle: boolean;
  provider: 'generic' | 'hetzner';
};

type S3ClientMode = {
  endpoint: string;
  forcePathStyle: boolean;
  label: string;
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

const parseHetznerEndpointHost = (endpoint: string): { location: string; bucketFromHost: string | null } | null => {
  try {
    const host = new URL(endpoint).hostname.toLowerCase();
    const labels = host.split('.').filter(Boolean);
    if (labels.length < 3) {
      return null;
    }

    const suffix = labels.slice(-2).join('.');
    if (suffix !== 'your-objectstorage.com') {
      return null;
    }

    const location = labels[labels.length - 3] || '';
    const bucketFromHost = labels.length > 3 ? labels.slice(0, labels.length - 3).join('.') : null;
    if (!location) {
      return null;
    }

    return {
      location,
      bucketFromHost: bucketFromHost || null
    };
  } catch {
    return null;
  }
};

const resolveS3ClientConfig = (config: S3StorageConfig): ResolvedS3Config => {
  const parsedEndpoint = new URL(config.endpoint);
  const parsedHetzner = parseHetznerEndpointHost(config.endpoint);

  if (parsedHetzner) {
    const normalizedBucket = config.bucket.trim();
    const normalizedRegion = config.region.trim();
    const hostBucket = parsedHetzner.bucketFromHost;

    if (hostBucket && hostBucket !== normalizedBucket.toLowerCase()) {
      throw new Error('S3 bucket does not match Hetzner endpoint bucket segment');
    }
    if (normalizedRegion.toLowerCase() !== parsedHetzner.location) {
      throw new Error('S3 region does not match Hetzner endpoint location segment');
    }

    const normalizedBase = new URL(parsedEndpoint.toString());
    normalizedBase.hostname = `${parsedHetzner.location}.your-objectstorage.com`;

    return {
      ...config,
      endpoint: normalizedBase.toString().replace(/\/$/, ''),
      region: parsedHetzner.location,
      bucket: hostBucket || normalizedBucket,
      forcePathStyle: true,
      provider: 'hetzner'
    };
  }

  return {
    ...config,
    forcePathStyle: true,
    provider: 'generic'
  };
};

const getBaseEndpointWithoutBucketSubdomain = (endpoint: string, bucket: string) => {
  const parsedEndpoint = new URL(endpoint);
  const endpointHost = parsedEndpoint.hostname.toLowerCase();
  const normalizedBucket = bucket.toLowerCase();

  if (endpointHost.startsWith(`${normalizedBucket}.`)) {
    const baseHost = endpointHost.slice(normalizedBucket.length + 1);
    const normalizedBase = new URL(parsedEndpoint.toString());
    normalizedBase.hostname = baseHost;
    return normalizedBase.toString().replace(/\/$/, '');
  }

  return parsedEndpoint.toString().replace(/\/$/, '');
};

const buildS3ValidationModes = (config: S3StorageConfig): S3ClientMode[] => {
  const sanitized = sanitizeConfig(config);
  const resolved = resolveS3ClientConfig(sanitized);

  if (resolved.provider === 'hetzner') {
    return [{
      endpoint: resolved.endpoint,
      forcePathStyle: true,
      label: 'path-style/hetzner-normalized'
    }];
  }

  const baseEndpoint = getBaseEndpointWithoutBucketSubdomain(sanitized.endpoint, sanitized.bucket);
  const directEndpoint = sanitized.endpoint;

  const candidates: S3ClientMode[] = [
    {
      // Primary mode (existing behavior): base endpoint + path-style
      endpoint: resolved.endpoint,
      forcePathStyle: true,
      label: 'path-style/base-endpoint'
    },
    {
      // Fallback mode for providers that validate signatures only in virtual-host mode.
      endpoint: baseEndpoint,
      forcePathStyle: false,
      label: 'virtual-host/base-endpoint'
    },
    {
      // Final fallback for endpoint formats that already include a bucket hostname.
      // In virtual-host mode this avoids adding bucket into the URL path.
      endpoint: directEndpoint,
      forcePathStyle: false,
      label: 'virtual-host/direct-endpoint'
    }
  ];

  const unique = new Map<string, S3ClientMode>();
  for (const candidate of candidates) {
    unique.set(`${candidate.endpoint}|${candidate.forcePathStyle}`, candidate);
  }

  return Array.from(unique.values());
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

  const isMeaningful = (value: string | null) => Boolean(value && value.toLowerCase() !== 'unknownerror');
  const normalizedCode = isMeaningful(code) ? code : null;
  const normalizedName = isMeaningful(name) ? name : null;
  const normalizedMessage = isMeaningful(message) ? message : null;

  const parts: string[] = [];
  if (statusCode) parts.push(`HTTP ${statusCode}`);
  if (normalizedCode) {
    parts.push(normalizedCode);
  } else if (normalizedName) {
    parts.push(normalizedName);
  }

  if (
    normalizedMessage
    && normalizedMessage !== normalizedCode
    && normalizedMessage !== normalizedName
  ) {
    parts.push(normalizedMessage);
  }

  if (parts.length === 0) {
    return 'Unknown S3 error';
  }

  return parts.join(': ');
};

const extractS3ErrorCode = (error: unknown): string | null => {
  if (!error || typeof error !== 'object') {
    return null;
  }

  const awsError = error as {
    code?: unknown;
    Code?: unknown;
    name?: unknown;
  };

  const values = [awsError.code, awsError.Code, awsError.name];
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      const normalized = value.trim();
      if (normalized.toLowerCase() !== 'unknownerror') {
        return normalized;
      }
    }
  }

  return null;
};

const shouldTrySignatureFallback = (error: unknown) => {
  const code = extractS3ErrorCode(error)?.toLowerCase() || '';
  const message = extractS3ValidationErrorMessage(error).toLowerCase();

  if (!code && !message) {
    return false;
  }

  return (
    code.includes('signature')
    || code.includes('authorization')
    || code === 'accessdenied'
    || message.includes('signature')
    || message.includes('authorization')
    || message.includes('credential')
  );
};

const createS3Client = (config: S3StorageConfig, mode?: Pick<S3ClientMode, 'endpoint' | 'forcePathStyle'>) => {
  const normalized = sanitizeConfig(config);
  const resolved = resolveS3ClientConfig(normalized);
  const endpoint = mode?.endpoint || resolved.endpoint;
  const forcePathStyle = typeof mode?.forcePathStyle === 'boolean' ? mode.forcePathStyle : resolved.forcePathStyle;

  return new S3Client({
    region: resolved.region,
    endpoint,
    forcePathStyle,
    credentials: {
      accessKeyId: resolved.accessKey,
      secretAccessKey: resolved.secretKey
    }
  });
};

const buildValidationDebugDetails = (attempt: S3ClientMode, resolved: ResolvedS3Config) => {
  const endpointHost = new URL(attempt.endpoint).host;
  const addressingStyle = attempt.forcePathStyle ? 'path' : 'virtual-host';
  return `host=${endpointHost}, bucket=${resolved.bucket}, region=${resolved.region}, addressing=${addressingStyle}`;
};

export const buildS3StorageKey = (prefix: string | null | undefined, channelId: string, storageName: string) => {
  const normalizedPrefix = normalizePrefix(prefix);
  const keyWithoutPrefix = `channels/${channelId}/${storageName}`;
  return normalizedPrefix ? `${normalizedPrefix}/${keyWithoutPrefix}` : keyWithoutPrefix;
};

export const validateS3Configuration = async (config: S3StorageConfig): Promise<{ ok: true } | { ok: false; message: string }> => {
  let normalized: S3StorageConfig;
  let resolved: ResolvedS3Config;
  try {
    normalized = sanitizeConfig(config);
    resolved = resolveS3ClientConfig(normalized);
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : 'Invalid S3 configuration'
    };
  }

  const testKey = buildS3StorageKey(normalized.prefix, '__healthcheck__', `${Date.now()}-roguecord.txt`);
  const attempts = buildS3ValidationModes(resolved);
  const failedReasons: string[] = [];

  for (let i = 0; i < attempts.length; i += 1) {
    const attempt = attempts[i];
    const client = createS3Client(normalized, {
      endpoint: attempt.endpoint,
      forcePathStyle: attempt.forcePathStyle
    });

    try {
      await client.send(new HeadBucketCommand({
        Bucket: resolved.bucket
      }));

      return { ok: true };
    } catch (error) {
      const reason = extractS3ValidationErrorMessage(error);
      const details = buildValidationDebugDetails(attempt, resolved);
      failedReasons.push(`${attempt.label} [${details}] => ${reason}`);

      const hasRemainingAttempt = i < attempts.length - 1;
      if (!hasRemainingAttempt || !shouldTrySignatureFallback(error)) {
        break;
      }
    }
  }

  const summary = failedReasons.join(' | ');
  return {
    ok: false,
    message: `S3 validation failed: ${summary || 'Unknown S3 error'}`
  };
};

export const uploadFileToS3 = async (input: {
  config: S3StorageConfig;
  key: string;
  buffer: Buffer;
  mimeType?: string | null;
}) => {
  const normalized = sanitizeConfig(input.config);
  const resolved = resolveS3ClientConfig(normalized);
  const client = createS3Client(resolved);
  await client.send(new PutObjectCommand({
    Bucket: resolved.bucket,
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
  const resolved = resolveS3ClientConfig(normalized);
  const client = createS3Client(resolved);
  const response = await client.send(new GetObjectCommand({
    Bucket: resolved.bucket,
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
  const resolved = resolveS3ClientConfig(normalized);
  const client = createS3Client(resolved);
  await client.send(new DeleteObjectCommand({
    Bucket: resolved.bucket,
    Key: input.key
  }));
};


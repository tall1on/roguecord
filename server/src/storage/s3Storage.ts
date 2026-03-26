import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  UploadPartCommand
} from '@aws-sdk/client-s3';
import fs from 'node:fs';

export type S3StorageProvider = 'generic_s3' | 'cloudflare_r2';

export type S3StorageConfig = {
  provider?: S3StorageProvider;
  providerUrl?: string | null;
  endpoint: string;
  region: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
  prefix?: string | null;
};

type ResolvedS3Config = Omit<S3StorageConfig, 'provider'> & {
  providerKey: S3StorageProvider;
  forcePathStyle: boolean;
  provider: 'generic' | 'hetzner' | 'cloudflare_r2';
};

type S3ClientMode = {
  endpoint: string;
  region: string;
  forcePathStyle: boolean;
  label: string;
};

type ResolvedS3Runtime = {
  normalized: S3StorageConfig;
  resolved: ResolvedS3Config;
  client: S3Client;
};

const normalizePrefix = (prefix: string | null | undefined) => {
  const trimmed = (prefix || '').trim().replace(/^\/+/, '').replace(/\/+$/, '');
  return trimmed.length > 0 ? trimmed : null;
};

const stripPrefixFromKey = (key: string, prefix: string | null) => {
  const trimmedKey = (key || '').trim().replace(/^\/+/, '');
  if (!trimmedKey) {
    return null;
  }

  if (!prefix) {
    return trimmedKey;
  }

  if (trimmedKey === prefix) {
    return '';
  }

  const prefixedKey = `${prefix}/`;
  if (trimmedKey.startsWith(prefixedKey)) {
    return trimmedKey.slice(prefixedKey.length);
  }

  return null;
};

const joinPrefixAndRelativeKey = (prefix: string | null, relativeKey: string) => {
  const trimmedRelativeKey = (relativeKey || '').trim().replace(/^\/+/, '');
  if (!trimmedRelativeKey) {
    return prefix || null;
  }
  return prefix ? `${prefix}/${trimmedRelativeKey}` : trimmedRelativeKey;
};

const dedupeKeys = (keys: Array<string | null | undefined>) => {
  const unique = new Set<string>();
  for (const key of keys) {
    const trimmed = (key || '').trim().replace(/^\/+/, '');
    if (trimmed) {
      unique.add(trimmed);
    }
  }
  return Array.from(unique);
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

const sanitizeR2ProviderUrl = (providerUrl: string) => {
  const trimmed = (providerUrl || '').trim();
  if (!trimmed) {
    throw new Error('Cloudflare R2 URL is required');
  }

  const parsed = new URL(trimmed);
  if (parsed.protocol !== 'https:') {
    throw new Error('Cloudflare R2 URL must use https');
  }

  return parsed.toString().replace(/\/$/, '');
};

const parseCloudflareR2Url = (providerUrl: string) => {
  const sanitizedUrl = sanitizeR2ProviderUrl(providerUrl);
  const parsed = new URL(sanitizedUrl);
  const hostLabels = parsed.hostname.split('.').filter(Boolean);
  if (hostLabels.length < 5) {
    throw new Error('Cloudflare R2 URL must match https://[ACCOUNT_ID].[REGION].r2.cloudflarestorage.com/[BUCKET]');
  }

  const suffix = hostLabels.slice(-3).join('.');
  if (suffix !== 'r2.cloudflarestorage.com') {
    throw new Error('Cloudflare R2 URL host must end with r2.cloudflarestorage.com');
  }

  const accountId = hostLabels[0] || '';
  const region = hostLabels.slice(1, -3).join('.');
  const bucket = parsed.pathname.split('/').filter(Boolean)[0] || '';
  if (!accountId) {
    throw new Error('Cloudflare R2 URL is missing account identifier');
  }
  if (!region) {
    throw new Error('Cloudflare R2 URL is missing region segment');
  }
  if (!bucket) {
    throw new Error('Cloudflare R2 URL is missing bucket path segment');
  }

  return {
    providerUrl: sanitizedUrl,
    endpoint: `https://${accountId}.${region}.r2.cloudflarestorage.com`,
    region: 'auto',
    bucket
  };
};

const sanitizeConfig = (config: S3StorageConfig): S3StorageConfig => {
  const requestedProvider = config.provider === 'cloudflare_r2' ? 'cloudflare_r2' : 'generic_s3';
  const prefix = normalizePrefix(config.prefix);
  const accessKey = (config.accessKey || '').trim();
  const secretKey = (config.secretKey || '').trim();

  if (!accessKey) {
    throw new Error('S3 access key is required');
  }
  if (!secretKey) {
    throw new Error('S3 secret key is required');
  }

  if (requestedProvider === 'cloudflare_r2') {
    const parsedR2 = parseCloudflareR2Url(config.providerUrl || config.endpoint || '');
    return {
      provider: 'cloudflare_r2',
      providerUrl: parsedR2.providerUrl,
      endpoint: parsedR2.endpoint,
      region: parsedR2.region,
      bucket: parsedR2.bucket,
      accessKey,
      secretKey,
      prefix
    };
  }

  const endpoint = sanitizeEndpoint(config.endpoint);
  const region = (config.region || '').trim();
  const bucket = (config.bucket || '').trim();

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
    provider: 'generic_s3',
    providerUrl: null,
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
      providerKey: 'generic_s3',
      ...config,
      endpoint: normalizedBase.toString().replace(/\/$/, ''),
      region: parsedHetzner.location,
      bucket: hostBucket || normalizedBucket,
      forcePathStyle: true,
      provider: 'hetzner'
    };
  }

  if (config.provider === 'cloudflare_r2') {
    return {
      providerKey: 'cloudflare_r2',
      ...config,
      region: 'auto',
      forcePathStyle: true,
      provider: 'cloudflare_r2'
    };
  }

  return {
    providerKey: 'generic_s3',
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

const buildSignerRegionFallbacks = (primaryRegion: string) => {
  const candidates = [primaryRegion.trim(), 'us-east-1'];
  const unique = new Set<string>();
  for (const candidate of candidates) {
    const normalized = candidate.trim();
    if (normalized) {
      unique.add(normalized);
    }
  }
  return Array.from(unique.values());
};

const buildS3ValidationModes = (config: S3StorageConfig): S3ClientMode[] => {
  const sanitized = sanitizeConfig(config);
  const resolved = resolveS3ClientConfig(sanitized);

   if (resolved.provider === 'cloudflare_r2') {
    return [
      {
        endpoint: resolved.endpoint,
        region: 'auto',
        forcePathStyle: true,
        label: 'path-style/cloudflare-r2'
      }
    ];
  }

  const signerRegions = buildSignerRegionFallbacks(resolved.region);

  if (resolved.provider === 'hetzner') {
    const baseEndpoint = getBaseEndpointWithoutBucketSubdomain(resolved.endpoint, resolved.bucket);

    const candidates: S3ClientMode[] = [];
    for (const signerRegion of signerRegions) {
      candidates.push(
        {
          endpoint: baseEndpoint,
          region: signerRegion,
          forcePathStyle: false,
          label: 'virtual-host/hetzner-base-endpoint'
        },
        {
          endpoint: baseEndpoint,
          region: signerRegion,
          forcePathStyle: true,
          label: 'path-style/hetzner-base-endpoint'
        }
      );
    }

    const unique = new Map<string, S3ClientMode>();
    for (const candidate of candidates) {
      unique.set(`${candidate.endpoint}|${candidate.forcePathStyle}|${candidate.region}`, candidate);
    }

    return Array.from(unique.values());
  }

  const baseEndpoint = getBaseEndpointWithoutBucketSubdomain(sanitized.endpoint, sanitized.bucket);
  const directEndpoint = sanitized.endpoint;

  const candidates: S3ClientMode[] = [
    {
      // Primary mode (existing behavior): base endpoint + path-style
      endpoint: resolved.endpoint,
      region: resolved.region,
      forcePathStyle: true,
      label: 'path-style/base-endpoint'
    },
    {
      // Fallback mode for providers that validate signatures only in virtual-host mode.
      endpoint: baseEndpoint,
      region: resolved.region,
      forcePathStyle: false,
      label: 'virtual-host/base-endpoint'
    },
    {
      // Final fallback for endpoint formats that already include a bucket hostname.
      // In virtual-host mode this avoids adding bucket into the URL path.
      endpoint: directEndpoint,
      region: resolved.region,
      forcePathStyle: false,
      label: 'virtual-host/direct-endpoint'
    }
  ];

  const unique = new Map<string, S3ClientMode>();
  for (const candidate of candidates) {
    unique.set(`${candidate.endpoint}|${candidate.forcePathStyle}|${candidate.region}`, candidate);
  }

  return Array.from(unique.values());
};

const sanitizeS3DiagnosticText = (value: string) => {
  return value.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
};

const extractXmlField = (xml: string, tagName: 'Code' | 'Message') => {
  const match = xml.match(new RegExp(`<${tagName}>([\\s\\S]*?)</${tagName}>`, 'i'));
  if (!match || typeof match[1] !== 'string') {
    return null;
  }

  const value = sanitizeS3DiagnosticText(match[1]);
  return value || null;
};

const tryExtractXmlS3Error = (value: unknown): { code: string | null; message: string | null } | null => {
  let raw: string | null = null;
  if (typeof value === 'string') {
    raw = value;
  } else if (Buffer.isBuffer(value)) {
    raw = value.toString('utf8');
  }

  if (!raw || !raw.trim()) {
    return null;
  }

  const normalized = raw.trim();
  if (!normalized.startsWith('<') || normalized.indexOf('<Error') === -1) {
    return null;
  }

  return {
    code: extractXmlField(normalized, 'Code'),
    message: extractXmlField(normalized, 'Message')
  };
};

const tryBuildBodySnippet = (value: unknown): string | null => {
  if (typeof value === 'string') {
    const normalized = sanitizeS3DiagnosticText(value);
    return normalized ? normalized.slice(0, 240) : null;
  }
  if (Buffer.isBuffer(value)) {
    const normalized = sanitizeS3DiagnosticText(value.toString('utf8'));
    return normalized ? normalized.slice(0, 240) : null;
  }
  if (value && typeof value === 'object') {
    const withMessage = value as { message?: unknown };
    if (typeof withMessage.message === 'string' && withMessage.message.trim()) {
      return sanitizeS3DiagnosticText(withMessage.message).slice(0, 240);
    }
  }
  return null;
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
    requestId?: unknown;
    RequestId?: unknown;
    hostId?: unknown;
    HostId?: unknown;
    body?: unknown;
    Body?: unknown;
    $response?: { body?: unknown };
  };

  const name = typeof awsError.name === 'string' && awsError.name.trim() ? awsError.name.trim() : null;
  const code = typeof awsError.code === 'string' && awsError.code.trim()
    ? awsError.code.trim()
    : (typeof awsError.Code === 'string' && awsError.Code.trim() ? awsError.Code.trim() : null);
  const message = typeof awsError.message === 'string' && awsError.message.trim()
    ? awsError.message.trim()
    : (typeof awsError.Message === 'string' && awsError.Message.trim() ? awsError.Message.trim() : null);
  const statusCode = typeof awsError.$metadata?.httpStatusCode === 'number' ? awsError.$metadata.httpStatusCode : null;
  const requestId = typeof awsError.$metadata?.requestId === 'string' && awsError.$metadata.requestId.trim()
    ? awsError.$metadata.requestId.trim()
    : (typeof awsError.requestId === 'string' && awsError.requestId.trim()
      ? awsError.requestId.trim()
      : (typeof awsError.RequestId === 'string' && awsError.RequestId.trim() ? awsError.RequestId.trim() : null));
  const hostId = typeof awsError.$metadata?.extendedRequestId === 'string' && awsError.$metadata.extendedRequestId.trim()
    ? awsError.$metadata.extendedRequestId.trim()
    : (typeof awsError.hostId === 'string' && awsError.hostId.trim()
      ? awsError.hostId.trim()
      : (typeof awsError.HostId === 'string' && awsError.HostId.trim() ? awsError.HostId.trim() : null));
  const bodySnippet = tryBuildBodySnippet(awsError.body)
    || tryBuildBodySnippet(awsError.Body)
    || tryBuildBodySnippet(awsError.$response?.body);
  const xmlFromBody = tryExtractXmlS3Error(awsError.body)
    || tryExtractXmlS3Error(awsError.Body)
    || tryExtractXmlS3Error(awsError.$response?.body);

  const isMeaningful = (value: string | null) => Boolean(value && value.toLowerCase() !== 'unknownerror');
  const normalizedCode = isMeaningful(code)
    ? code
    : (isMeaningful(xmlFromBody?.code || null) ? xmlFromBody?.code || null : null);
  const normalizedName = isMeaningful(name) ? name : null;
  const normalizedMessage = isMeaningful(message)
    ? message
    : (isMeaningful(xmlFromBody?.message || null) ? xmlFromBody?.message || null : null);

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

  if (requestId) {
    parts.push(`requestId=${requestId}`);
  }
  if (hostId) {
    parts.push(`hostId=${hostId}`);
  }
  if (bodySnippet && (!normalizedMessage || !bodySnippet.includes(normalizedMessage))) {
    parts.push(`body=${bodySnippet}`);
  }

  if (parts.length === 0) {
    return 'Unknown S3 error';
  }

  return parts.join(': ');
};

const createS3Client = (config: S3StorageConfig, mode?: Pick<S3ClientMode, 'endpoint' | 'forcePathStyle' | 'region'>) => {
  const normalized = sanitizeConfig(config);
  const resolved = resolveS3ClientConfig(normalized);
  const endpoint = mode?.endpoint || resolved.endpoint;
  const region = mode?.region || resolved.region;
  const forcePathStyle = typeof mode?.forcePathStyle === 'boolean' ? mode.forcePathStyle : resolved.forcePathStyle;

  return new S3Client({
    region,
    endpoint,
    forcePathStyle,
    credentials: {
      accessKeyId: resolved.accessKey,
      secretAccessKey: resolved.secretKey
    }
  });
};

const createResolvedS3Runtime = (config: S3StorageConfig): ResolvedS3Runtime => {
  const normalized = sanitizeConfig(config);
  const resolved = resolveS3ClientConfig(normalized);
  const client = createS3Client(toS3StorageConfig(resolved));
  return {
    normalized,
    resolved,
    client
  };
};

const toS3StorageConfig = (resolved: ResolvedS3Config): S3StorageConfig => ({
  provider: resolved.providerKey,
  providerUrl: resolved.providerUrl || null,
  endpoint: resolved.endpoint,
  region: resolved.region,
  bucket: resolved.bucket,
  accessKey: resolved.accessKey,
  secretKey: resolved.secretKey,
  prefix: resolved.prefix || null
});

const buildValidationDebugDetails = (attempt: S3ClientMode, resolved: ResolvedS3Config) => {
  const endpointHost = new URL(attempt.endpoint).host;
  const addressingStyle = attempt.forcePathStyle ? 'path' : 'virtual-host';
  return `host=${endpointHost}, bucket=${resolved.bucket}, signerRegion=${attempt.region}, configuredRegion=${resolved.region}, addressing=${addressingStyle}`;
};

export const buildS3StorageKey = (prefix: string | null | undefined, channelId: string, storageName: string) => {
  const normalizedPrefix = normalizePrefix(prefix);
  const keyWithoutPrefix = `channels/${channelId}/${storageName}`;
  return normalizedPrefix ? `${normalizedPrefix}/${keyWithoutPrefix}` : keyWithoutPrefix;
};

export const buildS3ManagedFilesPrefix = (prefix: string | null | undefined) => {
  const normalizedPrefix = normalizePrefix(prefix);
  return normalizedPrefix ? `${normalizedPrefix}/channels/` : 'channels/';
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
  const attempts = buildS3ValidationModes(normalized);
  const failedReasons: string[] = [];

  for (let i = 0; i < attempts.length; i += 1) {
    const attempt = attempts[i];
    const client = createS3Client(normalized, {
      endpoint: attempt.endpoint,
      region: attempt.region,
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
      if (!hasRemainingAttempt) {
        break;
      }
    }
  }

  const summary = failedReasons.join(' | ');
  const shouldAddHetzner403Hint = resolved.provider === 'hetzner'
    && failedReasons.some((reason) => /\bHTTP\s*403\b/i.test(reason))
    && failedReasons.some((reason) => /\b(unknown|unknownerror)\b/i.test(reason));
  const hetznerHint = shouldAddHetzner403Hint
    ? ' Hint: Hetzner HTTP 403/Unknown usually means invalid access key/secret or region/signing mismatch.'
    : '';
  return {
    ok: false,
    message: `S3 validation failed: ${summary || 'Unknown S3 error'}${hetznerHint}`
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
  const client = createS3Client(toS3StorageConfig(resolved));
  await client.send(new PutObjectCommand({
    Bucket: resolved.bucket,
    Key: input.key,
    Body: input.buffer,
    ContentType: input.mimeType || 'application/octet-stream'
  }));
};

export const deleteS3Keys = async (input: {
  config: S3StorageConfig;
  keys: string[];
}) => {
  const uniqueKeys = Array.from(new Set((input.keys || []).map((key) => (key || '').trim()).filter(Boolean)));
  for (const key of uniqueKeys) {
    await deleteFileFromS3({
      config: input.config,
      key
    });
  }
};

export const clearS3KeysByPrefix = async (input: {
  config: S3StorageConfig;
  prefix: string;
}) => {
  const keys = await listS3KeysByPrefix({
    config: input.config,
    prefix: input.prefix
  });
  if (!keys.length) {
    return [];
  }

  await deleteS3Keys({
    config: input.config,
    keys
  });

  return keys;
};

export const uploadFilePathToS3Multipart = async (input: {
  config: S3StorageConfig;
  key: string;
  filePath: string;
  mimeType?: string | null;
}) => {
  const normalized = sanitizeConfig(input.config);
  const resolved = resolveS3ClientConfig(normalized);
  const client = createS3Client(toS3StorageConfig(resolved));
  const stat = await fs.promises.stat(input.filePath);
  const partSize = 8 * 1024 * 1024;

  if (stat.size <= partSize) {
    const buffer = await fs.promises.readFile(input.filePath);
    await client.send(new PutObjectCommand({
      Bucket: resolved.bucket,
      Key: input.key,
      Body: buffer,
      ContentType: input.mimeType || 'application/octet-stream'
    }));
    return;
  }

  const createResponse = await client.send(new CreateMultipartUploadCommand({
    Bucket: resolved.bucket,
    Key: input.key,
    ContentType: input.mimeType || 'application/octet-stream'
  }));

  const uploadId = createResponse.UploadId;
  if (!uploadId) {
    throw new Error('S3 multipart upload did not return an upload id');
  }

  const completedParts: Array<{ ETag?: string; PartNumber: number }> = [];

  try {
    let partNumber = 1;
    let offset = 0;
    while (offset < stat.size) {
      const end = Math.min(offset + partSize, stat.size);
      const chunkLength = end - offset;
      const stream = fs.createReadStream(input.filePath, { start: offset, end: end - 1 });
      const uploadPartResponse = await client.send(new UploadPartCommand({
        Bucket: resolved.bucket,
        Key: input.key,
        UploadId: uploadId,
        PartNumber: partNumber,
        Body: stream,
        ContentLength: chunkLength
      }));
      completedParts.push({ ETag: uploadPartResponse.ETag, PartNumber: partNumber });
      offset = end;
      partNumber += 1;
    }

    await client.send(new CompleteMultipartUploadCommand({
      Bucket: resolved.bucket,
      Key: input.key,
      UploadId: uploadId,
      MultipartUpload: {
        Parts: completedParts
      }
    }));
  } catch (error) {
    await client.send(new AbortMultipartUploadCommand({
      Bucket: resolved.bucket,
      Key: input.key,
      UploadId: uploadId
    })).catch(() => undefined);
    throw error;
  }
};

export const downloadFileFromS3 = async (input: {
  config: S3StorageConfig;
  key: string;
}): Promise<Buffer> => {
  const runtime = createResolvedS3Runtime(input.config);
  const response = await runtime.client.send(new GetObjectCommand({
    Bucket: runtime.resolved.bucket,
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

const buildObjectReadDebugDetails = (resolved: ResolvedS3Config, key: string, attemptedKeys?: string[]) => {
  const details = [
    `provider=${resolved.providerKey}`,
    `bucket=${resolved.bucket}`,
    `endpoint=${resolved.endpoint}`,
    `region=${resolved.region}`,
    `prefix=${resolved.prefix || '(none)'}`,
    `key=${key}`
  ];
  if (attemptedKeys && attemptedKeys.length > 0) {
    details.push(`attemptedKeys=${attemptedKeys.join(',')}`);
  }
  return details.join(', ');
};

const enrichMissingObjectReadError = (error: unknown, resolved: ResolvedS3Config, key: string, attemptedKeys?: string[]) => {
  const code = typeof error === 'object' && error && '$metadata' in error
    ? String((error as any).name || (error as any).Code || (error as any).code || '')
    : String((error as any)?.name || (error as any)?.Code || (error as any)?.code || '');
  const message = String((error as any)?.message || 'Unknown S3 error');
  const isMissingKey = /NoSuchKey/i.test(code) || /The specified key does not exist/i.test(message);
  if (!isMissingKey) {
    return error;
  }

  const details = buildObjectReadDebugDetails(resolved, key, attemptedKeys);
  return new Error(`S3 source read failed with NoSuchKey (${details}): ${message}`);
};

export const downloadFileFromS3ForMigration = async (input: {
  config: S3StorageConfig;
  key: string;
}): Promise<{ buffer: Buffer; resolvedKey: string }> => {
  const runtime = createResolvedS3Runtime(input.config);
  const normalizedStoredKey = (input.key || '').trim().replace(/^\/+/, '');
  const normalizedPrefix = runtime.normalized.prefix ?? null;
  const relativeToCurrentPrefix = stripPrefixFromKey(normalizedStoredKey, normalizedPrefix);
  const fallbackKeys = runtime.resolved.providerKey === 'cloudflare_r2' && relativeToCurrentPrefix !== null
    ? [joinPrefixAndRelativeKey(null, relativeToCurrentPrefix), joinPrefixAndRelativeKey(normalizedPrefix, relativeToCurrentPrefix)]
    : [];
  const candidateKeys = dedupeKeys([normalizedStoredKey, ...fallbackKeys]);

  let lastError: unknown = null;
  for (let index = 0; index < candidateKeys.length; index += 1) {
    const candidateKey = candidateKeys[index];
    try {
      const buffer = await downloadFileFromS3({
        config: input.config,
        key: candidateKey
      });
      return {
        buffer,
        resolvedKey: candidateKey
      };
    } catch (error) {
      lastError = error;
      const message = String((error as any)?.message || '');
      const name = String((error as any)?.name || (error as any)?.Code || (error as any)?.code || '');
      const isMissingKey = /NoSuchKey/i.test(name) || /The specified key does not exist/i.test(message);
      const hasMoreCandidates = index < candidateKeys.length - 1;
      if (!isMissingKey || !hasMoreCandidates) {
        throw enrichMissingObjectReadError(error, runtime.resolved, normalizedStoredKey, candidateKeys);
      }
    }
  }

  throw enrichMissingObjectReadError(lastError, runtime.resolved, normalizedStoredKey, candidateKeys);
};

export const getFileStreamFromS3 = async (input: {
  config: S3StorageConfig;
  key: string;
  range?: string | null;
}): Promise<{
  body: AsyncIterable<Uint8Array>;
  contentLength: number | null;
  contentRange: string | null;
  acceptRanges: string | null;
  contentType: string | null;
}> => {
  const normalized = sanitizeConfig(input.config);
  const resolved = resolveS3ClientConfig(normalized);
  const client = createS3Client(toS3StorageConfig(resolved));
  const response = await client.send(new GetObjectCommand({
    Bucket: resolved.bucket,
    Key: input.key,
    Range: input.range?.trim() || undefined
  }));

  if (!response.Body) {
    throw new Error('S3 object is empty');
  }

  return {
    body: response.Body as AsyncIterable<Uint8Array>,
    contentLength: typeof response.ContentLength === 'number' ? response.ContentLength : null,
    contentRange: typeof response.ContentRange === 'string' ? response.ContentRange : null,
    acceptRanges: typeof response.AcceptRanges === 'string' ? response.AcceptRanges : null,
    contentType: typeof response.ContentType === 'string' ? response.ContentType : null
  };
};

export const deleteFileFromS3 = async (input: {
  config: S3StorageConfig;
  key: string;
}) => {
  const normalized = sanitizeConfig(input.config);
  const resolved = resolveS3ClientConfig(normalized);
  const client = createS3Client(toS3StorageConfig(resolved));
  await client.send(new DeleteObjectCommand({
    Bucket: resolved.bucket,
    Key: input.key
  }));
};

export const listS3KeysByPrefix = async (input: {
  config: S3StorageConfig;
  prefix: string;
}): Promise<string[]> => {
  const normalized = sanitizeConfig(input.config);
  const resolved = resolveS3ClientConfig(normalized);
  const client = createS3Client(toS3StorageConfig(resolved));

  const keys: string[] = [];
  let continuationToken: string | undefined;

  do {
    const response = await client.send(new ListObjectsV2Command({
      Bucket: resolved.bucket,
      Prefix: input.prefix,
      ContinuationToken: continuationToken
    }));

    for (const item of response.Contents || []) {
      const key = (item.Key || '').trim();
      if (key) {
        keys.push(key);
      }
    }

    continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
  } while (continuationToken);

  return keys;
};


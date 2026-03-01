import crypto from 'node:crypto';

const TRACKING_QUERY_PARAMS = new Set([
  'fbclid',
  'gclid',
  'dclid',
  'mc_cid',
  'mc_eid',
  '_hsenc',
  '_hsmi',
  'mkt_tok',
  'igshid'
]);

const trimTrailingSlashes = (pathname: string): string => {
  if (pathname.length <= 1) return pathname;
  return pathname.replace(/\/+$/g, '') || '/';
};

export const normalizeRssItemUrl = (rawUrl: string | null | undefined): string | null => {
  const value = (rawUrl || '').trim();
  if (!value) return null;

  try {
    const url = new URL(value);

    url.hash = '';
    url.hostname = url.hostname.toLowerCase();

    const protocol = url.protocol.toLowerCase();
    if ((protocol === 'https:' && url.port === '443') || (protocol === 'http:' && url.port === '80')) {
      url.port = '';
    }

    const keptParams = [...url.searchParams.entries()]
      .filter(([key]) => {
        const lowered = key.toLowerCase();
        if (lowered.startsWith('utm_')) return false;
        return !TRACKING_QUERY_PARAMS.has(lowered);
      })
      .sort((a, b) => {
        if (a[0] === b[0]) return a[1].localeCompare(b[1]);
        return a[0].localeCompare(b[0]);
      });

    url.search = '';
    for (const [key, valueParam] of keptParams) {
      url.searchParams.append(key, valueParam);
    }

    url.pathname = trimTrailingSlashes(url.pathname);
    return url.toString();
  } catch {
    return value;
  }
};

export const buildRssContentFingerprint = (input: {
  normalizedUrl: string | null;
  title: string;
  publishedAt: number;
}): string => {
  if (input.normalizedUrl) {
    return `url:${input.normalizedUrl}`;
  }

  const fallback = `${input.title.trim()}|${input.publishedAt || 0}`;
  return `fallback:${crypto.createHash('sha256').update(fallback).digest('hex')}`;
};

export const extractNormalizedUrlFromMessageContent = (content: string | null | undefined): string | null => {
  const value = (content || '').trim();
  if (!value) return null;

  const lines = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const maybeUrl = lines[i];
    if (!/^https?:\/\//i.test(maybeUrl)) continue;
    return normalizeRssItemUrl(maybeUrl);
  }

  return null;
};


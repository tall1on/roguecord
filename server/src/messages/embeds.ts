import type { Message, User } from '../models';

export type MessageEmbedType = 'youtube' | 'twitch' | 'spotify' | 'x' | 'link';

export interface MessageEmbed {
  type: MessageEmbedType;
  provider: string;
  url: string;
  displayUrl: string;
  title: string;
  description: string | null;
  thumbnailUrl: string | null;
  embedUrl: string | null;
  authorName?: string | null;
  authorUsername?: string | null;
  publishedAt?: string | null;
  mediaType?: 'image' | 'video' | null;
  mediaUrl?: string | null;
  mediaThumbnailUrl?: string | null;
}

export interface MessageWithUserAndEmbeds extends Message {
  user: User;
  embeds: MessageEmbed[];
}

const URL_REGEX = /(https?:\/\/[^\s<]+)/gi;
const TRAILING_PUNCTUATION_REGEX = /[),.;:!?\]]+$/;
const MAX_EMBEDS_PER_MESSAGE = 4;

const sanitizeRawUrl = (rawUrl: string) => {
  const trailing = rawUrl.match(TRAILING_PUNCTUATION_REGEX)?.[0] || '';
  const normalized = trailing ? rawUrl.slice(0, -trailing.length) : rawUrl;
  return normalized.trim();
};

const isSafeHttpUrl = (value: string) => {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
};

const normalizeHost = (host: string) => host.toLowerCase().replace(/^www\./, '').replace(/^m\./, '');

const getYouTubeVideoId = (url: URL): string | null => {
  const host = normalizeHost(url.hostname);
  const pathParts = url.pathname.split('/').filter(Boolean);

  let candidate: string | null = null;
  if (host === 'youtu.be') {
    candidate = pathParts[0] || null;
  } else if (host === 'youtube.com') {
    if (url.pathname === '/watch') {
      candidate = url.searchParams.get('v');
    } else if (pathParts[0] === 'shorts' || pathParts[0] === 'embed' || pathParts[0] === 'live') {
      candidate = pathParts[1] || null;
    }
  }

  if (!candidate) {
    return null;
  }

  return /^[A-Za-z0-9_-]{11}$/.test(candidate) ? candidate : null;
};

const buildYouTubeEmbed = (url: URL): MessageEmbed | null => {
  const videoId = getYouTubeVideoId(url);
  if (!videoId) {
    return null;
  }

  const canonicalUrl = `https://www.youtube.com/watch?v=${videoId}`;
  return {
    type: 'youtube',
    provider: 'YouTube',
    url: canonicalUrl,
    displayUrl: canonicalUrl,
    title: 'YouTube Video',
    description: null,
    thumbnailUrl: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    embedUrl: `https://www.youtube.com/embed/${videoId}`
  };
};

const isValidTwitchChannel = (value: string) => /^[A-Za-z0-9_]{3,25}$/.test(value);
const isValidTwitchVideoId = (value: string) => /^\d+$/.test(value);
const isValidTwitchClip = (value: string) => /^[A-Za-z0-9_-]{3,}$/.test(value);
const SPOTIFY_SUPPORTED_KINDS = new Set(['track', 'album', 'playlist', 'artist', 'episode', 'show']);
const X_POST_HOSTS = new Set(['x.com', 'twitter.com']);
const X_OEMBED_ENDPOINT = 'https://publish.x.com/oembed';

const decodeHtmlEntities = (value: string) => {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x2F;/gi, '/');
};

const stripHtmlTags = (value: string) => decodeHtmlEntities(value.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

const parseXHtml = (html: string) => {
  const textSource = html.match(/<p[^>]*lang="[^"]+"[^>]*dir="[^"]+"[^>]*>([\s\S]*?)<\/p>/i)?.[1] || '';
  const description = stripHtmlTags(textSource) || null;
  const imageUrl = html.match(/<a[^>]+href="([^"]+\/photo\/\d+)"[^>]*>\s*<img[^>]+src="([^"]+)"/i)?.[2] || null;
  const videoThumb = html.match(/<a[^>]+href="([^"]+\/video\/\d+)"[^>]*>\s*<img[^>]+src="([^"]+)"/i)?.[2] || null;
  const authorName = stripHtmlTags(html.match(/&mdash;\s*([^<(]+?)(?:\s*\(@|<\/a>)/i)?.[1] || '') || null;
  const authorUsername = html.match(/\(@([A-Za-z0-9_]{1,15})\)/)?.[1] || null;

  return {
    description,
    authorName,
    authorUsername,
    mediaType: imageUrl ? 'image' as const : videoThumb ? 'video' as const : null,
    mediaUrl: imageUrl,
    mediaThumbnailUrl: imageUrl || videoThumb
  };
};

const fetchXEmbedMetadata = async (canonicalUrl: string) => {
  const requestUrl = `${X_OEMBED_ENDPOINT}?omit_script=true&dnt=true&url=${encodeURIComponent(canonicalUrl)}`;

  try {
    const response = await fetch(requestUrl, {
      headers: {
        'User-Agent': 'RogueCord/1.0 (+https://publish.x.com/oembed)'
      }
    });

    if (!response.ok) {
      return null;
    }

    const payload = await response.json() as {
      author_name?: string;
      author_url?: string;
      html?: string;
      thumbnail_url?: string;
    };

    const parsedHtml = payload.html ? parseXHtml(payload.html) : null;
    const authorUsername = payload.author_url
      ? payload.author_url.match(/(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})/i)?.[1] || null
      : parsedHtml?.authorUsername || null;

    return {
      authorName: payload.author_name || parsedHtml?.authorName || null,
      authorUsername,
      description: parsedHtml?.description || null,
      mediaType: parsedHtml?.mediaType || null,
      mediaUrl: parsedHtml?.mediaUrl || null,
      mediaThumbnailUrl: parsedHtml?.mediaThumbnailUrl || payload.thumbnail_url || null,
      thumbnailUrl: payload.thumbnail_url || parsedHtml?.mediaThumbnailUrl || null
    };
  } catch {
    return null;
  }
};

const buildTwitchEmbed = (url: URL): MessageEmbed | null => {
  const host = normalizeHost(url.hostname);
  const pathParts = url.pathname.split('/').filter(Boolean);

  if (host === 'clips.twitch.tv') {
    const clip = pathParts[0] || '';
    if (!isValidTwitchClip(clip)) return null;
    return {
      type: 'twitch',
      provider: 'Twitch',
      url: `https://clips.twitch.tv/${clip}`,
      displayUrl: `https://clips.twitch.tv/${clip}`,
      title: 'Twitch Clip',
      description: null,
      thumbnailUrl: null,
      embedUrl: `https://clips.twitch.tv/embed?clip=${encodeURIComponent(clip)}&parent={parent}`
    };
  }

  if (host !== 'twitch.tv') {
    return null;
  }

  if (pathParts[0] === 'videos' && pathParts[1] && isValidTwitchVideoId(pathParts[1])) {
    const videoId = pathParts[1];
    return {
      type: 'twitch',
      provider: 'Twitch',
      url: `https://www.twitch.tv/videos/${videoId}`,
      displayUrl: `https://www.twitch.tv/videos/${videoId}`,
      title: `Twitch Video ${videoId}`,
      description: null,
      thumbnailUrl: null,
      embedUrl: `https://player.twitch.tv/?video=v${encodeURIComponent(videoId)}&parent={parent}`
    };
  }

  if (pathParts.length >= 3 && pathParts[1] === 'clip' && isValidTwitchChannel(pathParts[0] || '') && isValidTwitchClip(pathParts[2] || '')) {
    const channel = pathParts[0];
    const clip = pathParts[2];
    return {
      type: 'twitch',
      provider: 'Twitch',
      url: `https://www.twitch.tv/${channel}/clip/${clip}`,
      displayUrl: `https://www.twitch.tv/${channel}/clip/${clip}`,
      title: `Twitch Clip by ${channel}`,
      description: null,
      thumbnailUrl: null,
      embedUrl: `https://clips.twitch.tv/embed?clip=${encodeURIComponent(clip)}&parent={parent}`
    };
  }

  if (pathParts[0] && isValidTwitchChannel(pathParts[0])) {
    const channel = pathParts[0];
    return {
      type: 'twitch',
      provider: 'Twitch',
      url: `https://www.twitch.tv/${channel}`,
      displayUrl: `https://www.twitch.tv/${channel}`,
      title: `Twitch Channel ${channel}`,
      description: null,
      thumbnailUrl: null,
      embedUrl: `https://player.twitch.tv/?channel=${encodeURIComponent(channel)}&parent={parent}`
    };
  }

  return null;
};

const buildSpotifyEmbed = (url: URL): MessageEmbed | null => {
  const host = normalizeHost(url.hostname);
  if (host !== 'spotify.com' && host !== 'open.spotify.com') {
    return null;
  }

  const pathParts = url.pathname.split('/').filter(Boolean);
  if (pathParts.length < 2) {
    return null;
  }

  let kindIndex = 0;
  if (
    pathParts.length >= 3
    && /^(?:[A-Za-z]{2}(?:-[A-Za-z]{2})?|intl-[A-Za-z]{2})$/.test(pathParts[0] || '')
  ) {
    kindIndex = 1;
  }

  const kind = pathParts[kindIndex] || '';
  const id = pathParts[kindIndex + 1] || '';

  if (!SPOTIFY_SUPPORTED_KINDS.has(kind) || !/^[A-Za-z0-9]+$/.test(id)) {
    return null;
  }

  const canonicalUrl = `https://open.spotify.com/${kind}/${id}`;
  const providerLabel = kind.charAt(0).toUpperCase() + kind.slice(1);

  return {
    type: 'spotify',
    provider: 'Spotify',
    url: canonicalUrl,
    displayUrl: canonicalUrl,
    title: `Spotify ${providerLabel}`,
    description: null,
    thumbnailUrl: null,
    embedUrl: `https://open.spotify.com/embed/${kind}/${id}`
  };
};

const buildXEmbed = async (url: URL): Promise<MessageEmbed | null> => {
  const host = normalizeHost(url.hostname);
  if (!X_POST_HOSTS.has(host)) {
    return null;
  }

  const pathParts = url.pathname.split('/').filter(Boolean);
  if (pathParts.length < 3) {
    return null;
  }

  const username = pathParts[0] || '';
  const statusSegment = pathParts[1]?.toLowerCase() || '';
  const postId = pathParts[2] || '';

  if (!/^[A-Za-z0-9_]{1,15}$/.test(username) || statusSegment !== 'status' || !/^\d+$/.test(postId)) {
    return null;
  }

  const canonicalUrl = `https://x.com/${username}/status/${postId}`;

  const metadata = await fetchXEmbedMetadata(canonicalUrl);

  return {
    type: 'x',
    provider: 'X',
    url: canonicalUrl,
    displayUrl: canonicalUrl,
    title: `Post by @${metadata?.authorUsername || username}`,
    description: metadata?.description || null,
    thumbnailUrl: metadata?.thumbnailUrl || null,
    embedUrl: null,
    authorName: metadata?.authorName || null,
    authorUsername: metadata?.authorUsername || username,
    mediaType: metadata?.mediaType || null,
    mediaUrl: metadata?.mediaUrl || null,
    mediaThumbnailUrl: metadata?.mediaThumbnailUrl || null
  };
};

const buildGenericEmbed = (url: URL): MessageEmbed => {
  const providerHost = normalizeHost(url.hostname);
  const trimmedPath = `${url.pathname}${url.search}`;
  const shortPath = trimmedPath.length > 96 ? `${trimmedPath.slice(0, 93)}...` : trimmedPath;

  return {
    type: 'link',
    provider: providerHost,
    url: url.toString(),
    displayUrl: `${url.origin}${shortPath || '/'}`,
    title: providerHost,
    description: shortPath || null,
    thumbnailUrl: null,
    embedUrl: null
  };
};

const buildEmbedFromUrl = async (urlString: string): Promise<MessageEmbed | null> => {
  try {
    const url = new URL(urlString);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return null;
    }

    const youtube = buildYouTubeEmbed(url);
    if (youtube) {
      return youtube;
    }

    const twitch = buildTwitchEmbed(url);
    if (twitch) {
      return twitch;
    }

    const spotify = buildSpotifyEmbed(url);
    if (spotify) {
      return spotify;
    }

    const x = await buildXEmbed(url);
    if (x) {
      return x;
    }

    return buildGenericEmbed(url);
  } catch {
    return null;
  }
};

export const extractEmbedsFromContent = async (content: string): Promise<MessageEmbed[]> => {
  if (!content || typeof content !== 'string') {
    return [];
  }

  const urls = (content.match(URL_REGEX) || [])
    .map(sanitizeRawUrl)
    .filter((url) => url.length > 0)
    .filter(isSafeHttpUrl);

  const uniqueUrls: string[] = [];
  const seen = new Set<string>();
  for (const url of urls) {
    if (seen.has(url)) continue;
    seen.add(url);
    uniqueUrls.push(url);
    if (uniqueUrls.length >= MAX_EMBEDS_PER_MESSAGE) break;
  }

  const embeds: MessageEmbed[] = [];
  for (const url of uniqueUrls) {
    const embed = await buildEmbedFromUrl(url);
    if (embed) {
      embeds.push(embed);
    }
  }

  return embeds;
};

export const withMessageEmbeds = async <T extends Pick<Message, 'content'>>(message: T) => {
  return {
    ...message,
    embeds: await extractEmbedsFromContent(message.content)
  };
};


import type { Message, User } from '../models';

export type MessageEmbedType = 'youtube' | 'twitch' | 'link';

export interface MessageEmbed {
  type: MessageEmbedType;
  provider: string;
  url: string;
  displayUrl: string;
  title: string;
  description: string | null;
  thumbnailUrl: string | null;
  embedUrl: string | null;
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

const buildEmbedFromUrl = (urlString: string): MessageEmbed | null => {
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

    return buildGenericEmbed(url);
  } catch {
    return null;
  }
};

export const extractEmbedsFromContent = (content: string): MessageEmbed[] => {
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
    const embed = buildEmbedFromUrl(url);
    if (embed) {
      embeds.push(embed);
    }
  }

  return embeds;
};

export const withMessageEmbeds = <T extends Pick<Message, 'content'>>(message: T) => {
  return {
    ...message,
    embeds: extractEmbedsFromContent(message.content)
  };
};


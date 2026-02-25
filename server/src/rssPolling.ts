import crypto from 'node:crypto';
import {
  completeRssItem,
  createMessage,
  getOrCreateRssBotUser,
  getRssChannels,
  releaseRssItemReservation,
  reserveRssItem,
  type Channel
} from './models';
import { connectionManager } from './ws/connectionManager';

type ParsedFeedItem = {
  key: string;
  title: string;
  link: string | null;
  publishedAt: number;
};

const DEFAULT_POLL_INTERVAL_MS = 120000;
const MAX_ITEMS_PER_CHANNEL_PER_POLL = 5;

const decodeXml = (value: string) => {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
};

const extractTagValue = (source: string, tagName: string): string | null => {
  const match = source.match(new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'i'));
  if (!match || !match[1]) return null;
  return decodeXml(match[1]);
};

const extractAtomLink = (entry: string): string | null => {
  const linkMatch = entry.match(/<link[^>]*href=["']([^"']+)["'][^>]*>/i);
  return linkMatch?.[1] || null;
};

const toTimestamp = (value: string | null): number => {
  if (!value) return 0;
  const ts = Date.parse(value);
  return Number.isFinite(ts) ? ts : 0;
};

const buildItemKey = (parts: Array<string | null | undefined>): string => {
  const normalized = parts.map((part) => (part || '').trim()).join('|');
  return crypto.createHash('sha256').update(normalized).digest('hex');
};

const parseRssItems = (xml: string): ParsedFeedItem[] => {
  const items = xml.match(/<item\b[\s\S]*?<\/item>/gi) || [];
  return items
    .map((item) => {
      const title = extractTagValue(item, 'title') || 'Untitled RSS Item';
      const link = extractTagValue(item, 'link');
      const guid = extractTagValue(item, 'guid');
      const pubDate = extractTagValue(item, 'pubDate');

      const key = buildItemKey([guid, link, title, pubDate]);
      return {
        key,
        title,
        link,
        publishedAt: toTimestamp(pubDate)
      };
    })
    .filter((item) => item.title || item.link);
};

const parseAtomItems = (xml: string): ParsedFeedItem[] => {
  const entries = xml.match(/<entry\b[\s\S]*?<\/entry>/gi) || [];
  return entries
    .map((entry) => {
      const title = extractTagValue(entry, 'title') || 'Untitled RSS Item';
      const link = extractAtomLink(entry) || extractTagValue(entry, 'id');
      const id = extractTagValue(entry, 'id');
      const updated = extractTagValue(entry, 'updated') || extractTagValue(entry, 'published');

      const key = buildItemKey([id, link, title, updated]);
      return {
        key,
        title,
        link,
        publishedAt: toTimestamp(updated)
      };
    })
    .filter((item) => item.title || item.link);
};

const parseFeedItems = (xml: string): ParsedFeedItem[] => {
  const normalizedXml = xml.trim();
  if (/<rss\b/i.test(normalizedXml) || /<rdf:RDF\b/i.test(normalizedXml)) {
    return parseRssItems(normalizedXml);
  }
  if (/<feed\b/i.test(normalizedXml)) {
    return parseAtomItems(normalizedXml);
  }
  return [];
};

const formatMessageContent = (item: ParsedFeedItem): string => {
  if (item.link) {
    return `${item.title}\n${item.link}`;
  }
  return item.title;
};

const pollChannelFeed = async (channel: Channel) => {
  if (!channel.feed_url) return;

  const response = await fetch(channel.feed_url, {
    method: 'GET',
    headers: {
      'User-Agent': 'RogueCord RSS Bot/1.0',
      'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.1'
    }
  });

  if (!response.ok) {
    throw new Error(`Feed request failed (${response.status}) for ${channel.feed_url}`);
  }

  const xml = await response.text();
  const parsedItems = parseFeedItems(xml)
    .sort((a, b) => a.publishedAt - b.publishedAt)
    .slice(-MAX_ITEMS_PER_CHANNEL_PER_POLL);

  if (parsedItems.length === 0) {
    return;
  }

  const rssBotUser = await getOrCreateRssBotUser();

  for (const item of parsedItems) {
    const reserved = await reserveRssItem(channel.id, item.key);
    if (!reserved) {
      continue;
    }

    try {
      const message = await createMessage(channel.id, rssBotUser.id, formatMessageContent(item));
      await completeRssItem(channel.id, item.key, message.id);

      connectionManager.broadcastToAuthenticated({
        type: 'new_message',
        payload: {
          message: {
            ...message,
            user: rssBotUser
          }
        }
      });
    } catch (error) {
      await releaseRssItemReservation(channel.id, item.key);
      throw error;
    }
  }
};

const pollAllRssChannels = async () => {
  const rssChannels = await getRssChannels();
  for (const channel of rssChannels) {
    try {
      await pollChannelFeed(channel);
    } catch (error) {
      console.error(`[RSS] Poll failed for channel ${channel.id}:`, error);
    }
  }
};

export const startRssPolling = () => {
  const intervalFromEnv = Number(process.env.RSS_POLL_INTERVAL_MS || DEFAULT_POLL_INTERVAL_MS);
  const intervalMs = Number.isFinite(intervalFromEnv) && intervalFromEnv >= 15000
    ? Math.floor(intervalFromEnv)
    : DEFAULT_POLL_INTERVAL_MS;

  void pollAllRssChannels();
  setInterval(() => {
    void pollAllRssChannels();
  }, intervalMs);

  console.log(`[RSS] Polling service started (interval: ${intervalMs}ms)`);
};

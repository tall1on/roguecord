import { db } from '../db';
import crypto from 'node:crypto';

// Helper functions to wrap sqlite3 in Promises
export const dbRun = (sql: string, params: any[] = []): Promise<void> => {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve();
    });
  });
};

export const dbGet = <T>(sql: string, params: any[] = []): Promise<T | undefined> => {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row as T);
    });
  });
};

export const dbAll = <T>(sql: string, params: any[] = []): Promise<T[]> => {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows as T[]);
    });
  });
};

// --- Servers ---
export interface Server {
  id: string;
  name: string;
  title: string;
  rulesChannelId?: string;
  welcomeChannelId?: string;
}

export const getServer = async (): Promise<Server | undefined> => {
  const row = await dbGet<any>('SELECT * FROM servers LIMIT 1');
  if (!row) return undefined;
  return {
    id: row.id,
    name: row.name,
    title: row.title || row.name,
    rulesChannelId: row.rules_channel_id,
    welcomeChannelId: row.welcome_channel_id
  };
};

export const createServer = async (name: string, welcomeChannelId?: string): Promise<Server> => {
  const id = crypto.randomUUID();
  await dbRun('INSERT INTO servers (id, name, title, welcome_channel_id) VALUES (?, ?, ?, ?)', [id, name, name, welcomeChannelId]);
  const row = await dbGet<any>('SELECT * FROM servers WHERE id = ?', [id]);
  return {
    id: row.id,
    name: row.name,
    title: row.title || row.name,
    rulesChannelId: row.rules_channel_id,
    welcomeChannelId: row.welcome_channel_id
  };
};

export const updateServerSettings = async (id: string, title: string, rulesChannelId: string | null, welcomeChannelId: string | null): Promise<void> => {
  await dbRun('UPDATE servers SET title = ?, rules_channel_id = ?, welcome_channel_id = ? WHERE id = ?', [title, rulesChannelId, welcomeChannelId, id]);
};

// --- Users ---
export interface User {
  id: string;
  username: string;
  public_key: string;
  avatar_url: string | null;
  last_ip: string | null;
  role: string;
  created_at: string;
}

export const createUser = async (username: string, public_key: string, avatar_url: string | null = null): Promise<User> => {
  const id = crypto.randomUUID();
  await dbRun('INSERT INTO users (id, username, public_key, avatar_url) VALUES (?, ?, ?, ?)', [id, username, public_key, avatar_url]);
  return (await dbGet<User>('SELECT * FROM users WHERE id = ?', [id]))!;
};

export const getUserById = async (id: string): Promise<User | undefined> => {
  return dbGet<User>('SELECT * FROM users WHERE id = ?', [id]);
};

export const getUserByUsername = async (username: string): Promise<User | undefined> => {
  return dbGet<User>('SELECT * FROM users WHERE username = ?', [username]);
};

export const getUserByPublicKey = async (publicKey: string): Promise<User | undefined> => {
  return dbGet<User>('SELECT * FROM users WHERE public_key = ?', [publicKey]);
};

export const getUsers = async (): Promise<User[]> => {
  return dbAll<User>('SELECT * FROM users');
};

export const getOrCreateSystemUser = async (): Promise<User> => {
  const systemPublicKey = '__system__';
  const existing = await getUserByPublicKey(systemPublicKey);
  if (existing) {
    if (existing.role !== 'system') {
      await updateUserRole(existing.id, 'system');
      return (await getUserById(existing.id))!;
    }
    return existing;
  }

  const systemUser = await createUser('System', systemPublicKey, null);
  await updateUserRole(systemUser.id, 'system');
  return (await getUserById(systemUser.id))!;
};

export const getOrCreateRssBotUser = async (): Promise<User> => {
  const rssBotPublicKey = '__rss_bot__';
  const existing = await getUserByPublicKey(rssBotPublicKey);
  if (existing) {
    if (existing.role !== 'bot') {
      await updateUserRole(existing.id, 'bot');
      return (await getUserById(existing.id))!;
    }
    return existing;
  }

  const rssBotUser = await createUser('RSS Bot', rssBotPublicKey, null);
  await updateUserRole(rssBotUser.id, 'bot');
  return (await getUserById(rssBotUser.id))!;
};

export const updateUserRole = async (id: string, role: string): Promise<void> => {
  await dbRun('UPDATE users SET role = ? WHERE id = ?', [role, id]);
};

export const updateUserLastIp = async (id: string, ipAddress: string | null): Promise<void> => {
  await dbRun('UPDATE users SET last_ip = ? WHERE id = ?', [ipAddress, id]);
};

// --- Categories ---
export interface Category {
  id: string;
  name: string;
  position: number;
}

export const createCategory = async (name: string, position: number = 0): Promise<Category> => {
  const id = crypto.randomUUID();
  await dbRun('INSERT INTO categories (id, name, position) VALUES (?, ?, ?)', [id, name, position]);
  return (await dbGet<Category>('SELECT * FROM categories WHERE id = ?', [id]))!;
};

export const getCategories = async (): Promise<Category[]> => {
  return dbAll<Category>('SELECT * FROM categories ORDER BY position ASC');
};

// --- Channels ---
export interface Channel {
  id: string;
  category_id: string | null;
  name: string;
  type: 'text' | 'voice' | 'rss';
  position: number;
  feed_url: string | null;
}

export const createChannel = async (
  category_id: string | null,
  name: string,
  type: 'text' | 'voice' | 'rss',
  position: number = 0,
  feedUrl: string | null = null
): Promise<Channel> => {
  const id = crypto.randomUUID();
  await dbRun(
    'INSERT INTO channels (id, category_id, name, type, position, feed_url) VALUES (?, ?, ?, ?, ?, ?)',
    [id, category_id, name, type, position, feedUrl]
  );
  return (await dbGet<Channel>('SELECT * FROM channels WHERE id = ?', [id]))!;
};

export const getChannels = async (): Promise<Channel[]> => {
  return dbAll<Channel>('SELECT * FROM channels ORDER BY position ASC');
};

export const getChannelById = async (id: string): Promise<Channel | undefined> => {
  return dbGet<Channel>('SELECT * FROM channels WHERE id = ?', [id]);
};

export const getRssChannels = async (): Promise<Channel[]> => {
  return dbAll<Channel>(
    "SELECT * FROM channels WHERE type = 'rss' AND feed_url IS NOT NULL AND TRIM(feed_url) != '' ORDER BY position ASC"
  );
};

export const deleteChannel = async (id: string): Promise<void> => {
  await dbRun('DELETE FROM messages WHERE channel_id = ?', [id]);
  await dbRun('DELETE FROM rss_channel_items WHERE channel_id = ?', [id]);
  await dbRun('DELETE FROM channels WHERE id = ?', [id]);
};

// --- Messages ---
export interface Message {
  id: string;
  channel_id: string;
  user_id: string;
  content: string;
  created_at: string;
}

export interface MessageWithUser extends Message {
  user: User;
}

export interface MessagePageCursor {
  createdAt: string;
  id: string;
}

export interface MessagePage {
  messages: MessageWithUser[];
  hasMore: boolean;
}

export type ModerationActionType = 'kick' | 'ban';
export type MessageDeleteMode = 'none' | 'hours' | 'all';

export interface ModerationAction {
  id: string;
  target_user_id: string;
  moderator_user_id: string;
  action_type: ModerationActionType;
  reason: string | null;
  delete_mode: MessageDeleteMode;
  delete_hours: number | null;
  blacklist_identity: number;
  blacklist_ip: number;
  target_ip: string | null;
  enforced: number;
  created_at: string;
  enforced_at: string | null;
}

export interface BanRule {
  id: string;
  target_user_id: string | null;
  target_public_key: string | null;
  target_ip: string | null;
  blacklist_identity: number;
  blacklist_ip: number;
  reason: string | null;
  moderator_user_id: string;
  active: number;
  created_at: string;
  revoked_at: string | null;
}

export const createMessage = async (channel_id: string, user_id: string, content: string): Promise<Message> => {
  const id = crypto.randomUUID();
  await dbRun('INSERT INTO messages (id, channel_id, user_id, content) VALUES (?, ?, ?, ?)', [id, channel_id, user_id, content]);
  return (await dbGet<Message>('SELECT * FROM messages WHERE id = ?', [id]))!;
};

export const deleteMessagesByUser = async (userId: string, mode: MessageDeleteMode, hours?: number): Promise<void> => {
  if (mode === 'all') {
    await dbRun('DELETE FROM messages WHERE user_id = ?', [userId]);
    return;
  }

  if (mode === 'hours') {
    const normalizedHours = Math.max(1, Math.floor(hours || 0));
    await dbRun(
      "DELETE FROM messages WHERE user_id = ? AND created_at >= datetime('now', ?)",
      [userId, `-${normalizedHours} hours`]
    );
  }
};

export const createModerationAction = async (input: {
  targetUserId: string;
  moderatorUserId: string;
  actionType: ModerationActionType;
  reason?: string | null;
  deleteMode: MessageDeleteMode;
  deleteHours?: number | null;
  blacklistIdentity?: boolean;
  blacklistIp?: boolean;
  targetIp?: string | null;
  enforced?: boolean;
}): Promise<ModerationAction> => {
  const id = crypto.randomUUID();
  const enforcedValue = input.enforced ? 1 : 0;
  await dbRun(
    `
      INSERT INTO moderation_actions (
        id,
        target_user_id,
        moderator_user_id,
        action_type,
        reason,
        delete_mode,
        delete_hours,
        blacklist_identity,
        blacklist_ip,
        target_ip,
        enforced,
        enforced_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN ? = 1 THEN CURRENT_TIMESTAMP ELSE NULL END)
    `,
    [
      id,
      input.targetUserId,
      input.moderatorUserId,
      input.actionType,
      input.reason || null,
      input.deleteMode,
      input.deleteMode === 'hours' ? Math.max(1, Math.floor(input.deleteHours || 1)) : null,
      input.blacklistIdentity ? 1 : 0,
      input.blacklistIp ? 1 : 0,
      input.targetIp || null,
      enforcedValue,
      enforcedValue
    ]
  );

  return (await dbGet<ModerationAction>('SELECT * FROM moderation_actions WHERE id = ?', [id]))!;
};

export const markModerationActionEnforced = async (actionId: string): Promise<void> => {
  await dbRun('UPDATE moderation_actions SET enforced = 1, enforced_at = CURRENT_TIMESTAMP WHERE id = ?', [actionId]);
};

export const getPendingModerationActions = async (userId: string): Promise<ModerationAction[]> => {
  return dbAll<ModerationAction>(
    'SELECT * FROM moderation_actions WHERE target_user_id = ? AND enforced = 0 ORDER BY created_at ASC',
    [userId]
  );
};

export const createBanRule = async (input: {
  targetUserId?: string | null;
  targetPublicKey?: string | null;
  targetIp?: string | null;
  blacklistIdentity: boolean;
  blacklistIp: boolean;
  reason?: string | null;
  moderatorUserId: string;
}): Promise<BanRule> => {
  const id = crypto.randomUUID();
  await dbRun(
    `
      INSERT INTO ban_rules (
        id,
        target_user_id,
        target_public_key,
        target_ip,
        blacklist_identity,
        blacklist_ip,
        reason,
        moderator_user_id,
        active
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
    `,
    [
      id,
      input.targetUserId || null,
      input.targetPublicKey || null,
      input.targetIp || null,
      input.blacklistIdentity ? 1 : 0,
      input.blacklistIp ? 1 : 0,
      input.reason || null,
      input.moderatorUserId
    ]
  );

  return (await dbGet<BanRule>('SELECT * FROM ban_rules WHERE id = ?', [id]))!;
};

export const getMatchingActiveBan = async (input: {
  targetUserId?: string | null;
  targetPublicKey?: string | null;
  targetIp?: string | null;
}): Promise<BanRule | undefined> => {
  const effectiveUserId = input.targetUserId || null;
  const effectivePublicKey = input.targetPublicKey || null;
  const effectiveIp = input.targetIp || null;

  return dbGet<BanRule>(
    `
      SELECT *
      FROM ban_rules
      WHERE active = 1
        AND (
          (
            blacklist_identity = 1
            AND (
              (? IS NOT NULL AND target_user_id = ?)
              OR (? IS NOT NULL AND target_public_key = ?)
            )
          )
          OR (
            blacklist_ip = 1
            AND (? IS NOT NULL AND target_ip = ?)
          )
        )
      ORDER BY created_at DESC
      LIMIT 1
    `,
    [
      effectiveUserId,
      effectiveUserId,
      effectivePublicKey,
      effectivePublicKey,
      effectiveIp,
      effectiveIp
    ]
  );
};

export const getChannelMessages = async (
  channel_id: string,
  limit: number = 25,
  before?: MessagePageCursor
): Promise<MessagePage> => {
  const normalizedLimit = Math.max(1, Math.min(25, Math.floor(limit)));

  const queryParams: Array<string | number> = [channel_id];
  let whereCursorClause = '';
  if (before) {
    whereCursorClause = 'AND (created_at < ? OR (created_at = ? AND id < ?))';
    queryParams.push(before.createdAt, before.createdAt, before.id);
  }

  queryParams.push(normalizedLimit + 1);

  const messages = await dbAll<Message>(
    `
      SELECT *
      FROM messages
      WHERE channel_id = ?
      ${whereCursorClause}
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `,
    queryParams
  );

  const hasMore = messages.length > normalizedLimit;
  const pageMessages = hasMore ? messages.slice(0, normalizedLimit) : messages;
  
  // Fetch users for messages (could be done with a JOIN, but this is fine for now)
  const messagesWithUsers: MessageWithUser[] = [];
  for (const msg of pageMessages) {
    const user = await getUserById(msg.user_id);
    if (user) {
      messagesWithUsers.push({ ...msg, user });
    }
  }

  return {
    messages: messagesWithUsers.reverse(), // Return in chronological order
    hasMore
  };
};

export const reserveRssItem = async (
  channelId: string,
  itemKey: string,
  contentFingerprint: string | null = null
): Promise<boolean> => {
  return new Promise((resolve, reject) => {
    db.run(
      'INSERT OR IGNORE INTO rss_channel_items (channel_id, item_key, content_fingerprint, message_id) VALUES (?, ?, ?, NULL)',
      [channelId, itemKey, contentFingerprint],
      function (err) {
        if (err) {
          reject(err);
          return;
        }
        resolve((this.changes || 0) > 0);
      }
    );
  });
};

export const completeRssItem = async (channelId: string, itemKey: string, messageId: string): Promise<void> => {
  await dbRun(
    'UPDATE rss_channel_items SET message_id = ? WHERE channel_id = ? AND item_key = ?',
    [messageId, channelId, itemKey]
  );
};

export const releaseRssItemReservation = async (channelId: string, itemKey: string): Promise<void> => {
  await dbRun('DELETE FROM rss_channel_items WHERE channel_id = ? AND item_key = ?', [channelId, itemKey]);
};

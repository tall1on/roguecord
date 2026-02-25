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

export const createMessage = async (channel_id: string, user_id: string, content: string): Promise<Message> => {
  const id = crypto.randomUUID();
  await dbRun('INSERT INTO messages (id, channel_id, user_id, content) VALUES (?, ?, ?, ?)', [id, channel_id, user_id, content]);
  return (await dbGet<Message>('SELECT * FROM messages WHERE id = ?', [id]))!;
};

export const getChannelMessages = async (channel_id: string, limit: number = 50): Promise<MessageWithUser[]> => {
  const messages = await dbAll<Message>(
    'SELECT * FROM messages WHERE channel_id = ? ORDER BY created_at DESC LIMIT ?',
    [channel_id, limit]
  );
  
  // Fetch users for messages (could be done with a JOIN, but this is fine for now)
  const messagesWithUsers: MessageWithUser[] = [];
  for (const msg of messages) {
    const user = await getUserById(msg.user_id);
    if (user) {
      messagesWithUsers.push({ ...msg, user });
    }
  }
  
  return messagesWithUsers.reverse(); // Return in chronological order
};

export const reserveRssItem = async (channelId: string, itemKey: string): Promise<boolean> => {
  return new Promise((resolve, reject) => {
    db.run(
      'INSERT OR IGNORE INTO rss_channel_items (channel_id, item_key, message_id) VALUES (?, ?, NULL)',
      [channelId, itemKey],
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

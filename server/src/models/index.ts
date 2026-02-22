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

export const updateUserRole = async (id: string, role: string): Promise<void> => {
  await dbRun('UPDATE users SET role = ? WHERE id = ?', [role, id]);
};

// --- Servers ---
export interface Server {
  id: string;
  name: string;
  icon_url: string | null;
  owner_id: string;
  created_at: string;
}

export const createServer = async (name: string, owner_id: string, icon_url: string | null = null): Promise<Server> => {
  const id = crypto.randomUUID();
  await dbRun('INSERT INTO servers (id, name, icon_url, owner_id) VALUES (?, ?, ?, ?)', [id, name, icon_url, owner_id]);
  return (await dbGet<Server>('SELECT * FROM servers WHERE id = ?', [id]))!;
};

export const getServerById = async (id: string): Promise<Server | undefined> => {
  return dbGet<Server>('SELECT * FROM servers WHERE id = ?', [id]);
};

// --- Server Members ---
export interface ServerMember {
  server_id: string;
  user_id: string;
  joined_at: string;
}

export const addServerMember = async (server_id: string, user_id: string): Promise<void> => {
  await dbRun('INSERT OR IGNORE INTO server_members (server_id, user_id) VALUES (?, ?)', [server_id, user_id]);
};

export const getServerMembers = async (server_id: string): Promise<User[]> => {
  return dbAll<User>(
    'SELECT u.* FROM users u JOIN server_members sm ON u.id = sm.user_id WHERE sm.server_id = ?',
    [server_id]
  );
};

export const getUserServers = async (user_id: string): Promise<Server[]> => {
  return dbAll<Server>(
    'SELECT s.* FROM servers s JOIN server_members sm ON s.id = sm.server_id WHERE sm.user_id = ?',
    [user_id]
  );
};

// --- Categories ---
export interface Category {
  id: string;
  server_id: string;
  name: string;
  position: number;
}

export const createCategory = async (server_id: string, name: string, position: number = 0): Promise<Category> => {
  const id = crypto.randomUUID();
  await dbRun('INSERT INTO categories (id, server_id, name, position) VALUES (?, ?, ?, ?)', [id, server_id, name, position]);
  return (await dbGet<Category>('SELECT * FROM categories WHERE id = ?', [id]))!;
};

export const getServerCategories = async (server_id: string): Promise<Category[]> => {
  return dbAll<Category>('SELECT * FROM categories WHERE server_id = ? ORDER BY position ASC', [server_id]);
};

// --- Channels ---
export interface Channel {
  id: string;
  server_id: string;
  category_id: string | null;
  name: string;
  type: 'text' | 'voice';
  position: number;
}

export const createChannel = async (server_id: string, category_id: string | null, name: string, type: 'text' | 'voice', position: number = 0): Promise<Channel> => {
  const id = crypto.randomUUID();
  await dbRun('INSERT INTO channels (id, server_id, category_id, name, type, position) VALUES (?, ?, ?, ?, ?, ?)', [id, server_id, category_id, name, type, position]);
  return (await dbGet<Channel>('SELECT * FROM channels WHERE id = ?', [id]))!;
};

export const getServerChannels = async (server_id: string): Promise<Channel[]> => {
  return dbAll<Channel>('SELECT * FROM channels WHERE server_id = ? ORDER BY position ASC', [server_id]);
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

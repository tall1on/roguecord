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

const isMissingColumnError = (error: unknown, columnName: string): boolean => {
  if (!error || typeof error !== 'object' || !('message' in error)) return false;
  const message = String((error as any).message || '').toLowerCase();
  return message.includes('no such column') && message.includes(columnName.toLowerCase());
};

const folderFilesLegacySelect = `
  SELECT
    id,
    channel_id,
    original_name,
    storage_name,
    'data_dir' AS storage_provider,
    NULL AS storage_key,
    mime_type,
    size_bytes,
    uploader_user_id,
    NULL AS migrated_to_s3_at,
    created_at,
    updated_at
  FROM folder_channel_files
`;

// --- Servers ---
export interface Server {
  id: string;
  name: string;
  title: string;
  rulesChannelId?: string;
  welcomeChannelId?: string;
  storageType: 'data_dir' | 's3';
  storageLastError?: string | null;
  storageUpdatedAt?: string | null;
}

export interface ServerS3Config {
  endpoint: string;
  region: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
  prefix: string | null;
}

export interface ServerStorageSettings {
  serverId: string;
  storageType: 'data_dir' | 's3';
  s3: ServerS3Config | null;
  storageLastError: string | null;
  storageUpdatedAt: string | null;
}

const mapServerRow = (row: any): Server => ({
  id: row.id,
  name: row.name,
  title: row.title || row.name,
  rulesChannelId: row.rules_channel_id,
  welcomeChannelId: row.welcome_channel_id,
  storageType: row.storage_type === 's3' ? 's3' : 'data_dir',
  storageLastError: row.storage_last_error || null,
  storageUpdatedAt: row.storage_updated_at || null
});

const mapServerStorageSettings = (row: any): ServerStorageSettings => ({
  serverId: row.id,
  storageType: row.storage_type === 's3' ? 's3' : 'data_dir',
  s3: row.s3_endpoint && row.s3_region && row.s3_bucket && row.s3_access_key && row.s3_secret_key
    ? {
      endpoint: row.s3_endpoint,
      region: row.s3_region,
      bucket: row.s3_bucket,
      accessKey: row.s3_access_key,
      secretKey: row.s3_secret_key,
      prefix: row.s3_prefix || null
    }
    : null,
  storageLastError: row.storage_last_error || null,
  storageUpdatedAt: row.storage_updated_at || null
});

export const getServer = async (): Promise<Server | undefined> => {
  const row = await dbGet<any>('SELECT * FROM servers LIMIT 1');
  if (!row) return undefined;
  return mapServerRow(row);
};

export const createServer = async (name: string, welcomeChannelId?: string): Promise<Server> => {
  const id = crypto.randomUUID();
  await dbRun('INSERT INTO servers (id, name, title, welcome_channel_id) VALUES (?, ?, ?, ?)', [id, name, name, welcomeChannelId]);
  const row = await dbGet<any>('SELECT * FROM servers WHERE id = ?', [id]);
  return mapServerRow(row);
};

export const updateServerSettings = async (id: string, title: string, rulesChannelId: string | null, welcomeChannelId: string | null): Promise<void> => {
  await dbRun('UPDATE servers SET title = ?, rules_channel_id = ?, welcome_channel_id = ? WHERE id = ?', [title, rulesChannelId, welcomeChannelId, id]);
};

export const getServerStorageSettings = async (): Promise<ServerStorageSettings | undefined> => {
  const row = await dbGet<any>('SELECT * FROM servers LIMIT 1');
  if (!row) return undefined;
  return mapServerStorageSettings(row);
};

export const updateServerStorageSettings = async (input: {
  serverId: string;
  storageType: 'data_dir' | 's3';
  s3Endpoint: string | null;
  s3Region: string | null;
  s3Bucket: string | null;
  s3AccessKey: string | null;
  s3SecretKey: string | null;
  s3Prefix: string | null;
  storageLastError: string | null;
}): Promise<void> => {
  await dbRun(
    `
      UPDATE servers
      SET
        storage_type = ?,
        s3_endpoint = ?,
        s3_region = ?,
        s3_bucket = ?,
        s3_access_key = ?,
        s3_secret_key = ?,
        s3_prefix = ?,
        storage_last_error = ?,
        storage_updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `,
    [
      input.storageType,
      input.s3Endpoint,
      input.s3Region,
      input.s3Bucket,
      input.s3AccessKey,
      input.s3SecretKey,
      input.s3Prefix,
      input.storageLastError,
      input.serverId
    ]
  );
};

export const updateServerStorageLastError = async (input: {
  serverId: string;
  storageLastError: string | null;
}): Promise<void> => {
  await dbRun(
    'UPDATE servers SET storage_last_error = ?, storage_updated_at = CURRENT_TIMESTAMP WHERE id = ?',
    [input.storageLastError, input.serverId]
  );
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
  type: 'text' | 'voice' | 'rss' | 'folder';
  position: number;
  feed_url: string | null;
}

export const createChannel = async (
  category_id: string | null,
  name: string,
  type: 'text' | 'voice' | 'rss' | 'folder',
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
  await dbRun('DELETE FROM folder_channel_files WHERE channel_id = ?', [id]);
  await dbRun('DELETE FROM channels WHERE id = ?', [id]);
};

export interface FolderChannelFile {
  id: string;
  channel_id: string;
  original_name: string;
  storage_name: string;
  storage_provider: 'data_dir' | 's3';
  storage_key: string | null;
  mime_type: string | null;
  size_bytes: number;
  uploader_user_id: string;
  migrated_to_s3_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface FolderChannelFileWithUploader extends FolderChannelFile {
  uploader_username: string;
}

export const createFolderChannelFile = async (input: {
  channelId: string;
  originalName: string;
  storageName: string;
  storageProvider?: 'data_dir' | 's3';
  storageKey?: string | null;
  mimeType?: string | null;
  sizeBytes: number;
  uploaderUserId: string;
}): Promise<FolderChannelFile> => {
  const id = crypto.randomUUID();
  try {
    await dbRun(
      `
        INSERT INTO folder_channel_files (
          id,
          channel_id,
          original_name,
          storage_name,
          storage_provider,
          storage_key,
          mime_type,
          size_bytes,
          uploader_user_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        id,
        input.channelId,
        input.originalName,
        input.storageName,
        input.storageProvider || 'data_dir',
        input.storageKey || null,
        input.mimeType || null,
        input.sizeBytes,
        input.uploaderUserId
      ]
    );
  } catch (error) {
    if (!isMissingColumnError(error, 'storage_provider') && !isMissingColumnError(error, 'storage_key')) {
      throw error;
    }

    await dbRun(
      `
        INSERT INTO folder_channel_files (
          id,
          channel_id,
          original_name,
          storage_name,
          mime_type,
          size_bytes,
          uploader_user_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
      [
        id,
        input.channelId,
        input.originalName,
        input.storageName,
        input.mimeType || null,
        input.sizeBytes,
        input.uploaderUserId
      ]
    );
  }

  return (await getFolderChannelFileById(id))!;
};

export const getFolderChannelFiles = async (channelId: string): Promise<FolderChannelFileWithUploader[]> => {
  try {
    return await dbAll<FolderChannelFileWithUploader>(
      `
        SELECT
          f.*,
          u.username AS uploader_username
        FROM folder_channel_files f
        INNER JOIN users u ON u.id = f.uploader_user_id
        WHERE f.channel_id = ?
        ORDER BY f.created_at DESC, f.id DESC
      `,
      [channelId]
    );
  } catch (error) {
    if (!isMissingColumnError(error, 'storage_provider') && !isMissingColumnError(error, 'storage_key') && !isMissingColumnError(error, 'migrated_to_s3_at')) {
      throw error;
    }

    return dbAll<FolderChannelFileWithUploader>(
      `
        SELECT
          f.id,
          f.channel_id,
          f.original_name,
          f.storage_name,
          'data_dir' AS storage_provider,
          NULL AS storage_key,
          f.mime_type,
          f.size_bytes,
          f.uploader_user_id,
          NULL AS migrated_to_s3_at,
          f.created_at,
          f.updated_at,
          u.username AS uploader_username
        FROM folder_channel_files f
        INNER JOIN users u ON u.id = f.uploader_user_id
        WHERE f.channel_id = ?
        ORDER BY f.created_at DESC, f.id DESC
      `,
      [channelId]
    );
  }
};

export const getFolderChannelFileById = async (fileId: string): Promise<FolderChannelFile | undefined> => {
  try {
    return await dbGet<FolderChannelFile>('SELECT * FROM folder_channel_files WHERE id = ?', [fileId]);
  } catch (error) {
    if (!isMissingColumnError(error, 'storage_provider') && !isMissingColumnError(error, 'storage_key') && !isMissingColumnError(error, 'migrated_to_s3_at')) {
      throw error;
    }

    return dbGet<FolderChannelFile>(`${folderFilesLegacySelect} WHERE id = ?`, [fileId]);
  }
};

export const getAllFolderChannelFiles = async (): Promise<FolderChannelFile[]> => {
  try {
    return await dbAll<FolderChannelFile>('SELECT * FROM folder_channel_files ORDER BY created_at ASC, id ASC');
  } catch (error) {
    if (!isMissingColumnError(error, 'storage_provider') && !isMissingColumnError(error, 'storage_key') && !isMissingColumnError(error, 'migrated_to_s3_at')) {
      throw error;
    }

    return dbAll<FolderChannelFile>(`${folderFilesLegacySelect} ORDER BY created_at ASC, id ASC`);
  }
};

export const deleteFolderChannelFileById = async (fileId: string): Promise<void> => {
  await dbRun('DELETE FROM folder_channel_files WHERE id = ?', [fileId]);
};

export const updateFolderChannelFileStorage = async (input: {
  fileId: string;
  storageProvider: 'data_dir' | 's3';
  storageKey: string | null;
  migratedToS3At: string | null;
}): Promise<void> => {
  try {
    await dbRun(
      `
        UPDATE folder_channel_files
        SET storage_provider = ?,
            storage_key = ?,
            migrated_to_s3_at = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `,
      [input.storageProvider, input.storageKey, input.migratedToS3At, input.fileId]
    );
  } catch (error) {
    if (!isMissingColumnError(error, 'storage_provider') && !isMissingColumnError(error, 'storage_key') && !isMissingColumnError(error, 'migrated_to_s3_at')) {
      throw error;
    }

    await dbRun(
      `
        UPDATE folder_channel_files
        SET updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `,
      [input.fileId]
    );
  }
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

export interface ChannelReadState {
  user_id: string;
  channel_id: string;
  last_read_message_id: string | null;
  last_read_message_created_at: string | null;
  updated_at: string;
}

export interface ChannelUnreadState {
  channel_id: string;
  unread: boolean;
  last_read_message_id: string | null;
  last_read_message_created_at: string | null;
  latest_message_id: string | null;
  latest_message_created_at: string | null;
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

export const ensureChannelReadState = async (userId: string, channelId: string): Promise<void> => {
  await dbRun(
    `
      INSERT OR IGNORE INTO channel_read_states (
        user_id,
        channel_id,
        last_read_message_id,
        last_read_message_created_at,
        updated_at
      ) VALUES (
        ?,
        ?,
        (
          SELECT id
          FROM messages
          WHERE channel_id = ?
          ORDER BY created_at DESC, id DESC
          LIMIT 1
        ),
        (
          SELECT created_at
          FROM messages
          WHERE channel_id = ?
          ORDER BY created_at DESC, id DESC
          LIMIT 1
        ),
        CURRENT_TIMESTAMP
      )
    `,
    [userId, channelId, channelId, channelId]
  );
};

export const ensureChannelReadStatesForUser = async (userId: string): Promise<void> => {
  await dbRun(
    `
      INSERT OR IGNORE INTO channel_read_states (
        user_id,
        channel_id,
        last_read_message_id,
        last_read_message_created_at,
        updated_at
      )
      SELECT
        ?,
        c.id,
        (
          SELECT m.id
          FROM messages m
          WHERE m.channel_id = c.id
          ORDER BY m.created_at DESC, m.id DESC
          LIMIT 1
        ),
        (
          SELECT m.created_at
          FROM messages m
          WHERE m.channel_id = c.id
          ORDER BY m.created_at DESC, m.id DESC
          LIMIT 1
        ),
        CURRENT_TIMESTAMP
      FROM channels c
    `,
    [userId]
  );
};

export const markChannelReadUpToMessage = async (input: {
  userId: string;
  channelId: string;
  messageId: string;
  messageCreatedAt: string;
}): Promise<void> => {
  await ensureChannelReadState(input.userId, input.channelId);
  await dbRun(
    `
      UPDATE channel_read_states
      SET
        last_read_message_id = ?,
        last_read_message_created_at = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE user_id = ?
        AND channel_id = ?
        AND (
          last_read_message_created_at IS NULL
          OR last_read_message_created_at < ?
          OR (last_read_message_created_at = ? AND (last_read_message_id IS NULL OR last_read_message_id < ?))
        )
    `,
    [
      input.messageId,
      input.messageCreatedAt,
      input.userId,
      input.channelId,
      input.messageCreatedAt,
      input.messageCreatedAt,
      input.messageId
    ]
  );
};

export const getChannelUnreadStatesForUser = async (userId: string): Promise<ChannelUnreadState[]> => {
  await ensureChannelReadStatesForUser(userId);

  return dbAll<ChannelUnreadState>(
    `
      SELECT
        c.id AS channel_id,
        CASE
          WHEN latest_message.id IS NULL THEN 0
          WHEN crs.last_read_message_created_at IS NULL THEN 1
          WHEN latest_message.created_at > crs.last_read_message_created_at THEN 1
          WHEN latest_message.created_at = crs.last_read_message_created_at
            AND latest_message.id > COALESCE(crs.last_read_message_id, '') THEN 1
          ELSE 0
        END AS unread,
        crs.last_read_message_id,
        crs.last_read_message_created_at,
        latest_message.id AS latest_message_id,
        latest_message.created_at AS latest_message_created_at
      FROM channels c
      LEFT JOIN channel_read_states crs
        ON crs.user_id = ?
        AND crs.channel_id = c.id
      LEFT JOIN messages latest_message
        ON latest_message.id = (
          SELECT m.id
          FROM messages m
          WHERE m.channel_id = c.id
          ORDER BY m.created_at DESC, m.id DESC
          LIMIT 1
        )
      WHERE c.type IN ('text', 'rss')
      ORDER BY c.position ASC
    `,
    [userId]
  );
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

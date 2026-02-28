import sqlite3 from 'sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';

export const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, 'roguecord.db');

let resolveChannelsSchemaReady: (() => void) | null = null;
let rejectChannelsSchemaReady: ((error: Error) => void) | null = null;

export const channelsSchemaReady = new Promise<void>((resolve, reject) => {
  resolveChannelsSchemaReady = resolve;
  rejectChannelsSchemaReady = reject;
});

let serversSchemaMigrated = false;
let channelsSchemaMigrated = false;
let folderFilesSchemaMigrated = false;

function failSchemaInitialization(error: Error) {
  rejectChannelsSchemaReady?.(error);
}

function markSchemaStepDone(step: 'servers' | 'channels' | 'folder_files') {
  if (step === 'servers') serversSchemaMigrated = true;
  if (step === 'channels') channelsSchemaMigrated = true;
  if (step === 'folder_files') folderFilesSchemaMigrated = true;

  if (serversSchemaMigrated && channelsSchemaMigrated && folderFilesSchemaMigrated) {
    resolveChannelsSchemaReady?.();
  }
}

export const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Error opening database:', err.message);
  } else {
    console.log('Connected to the SQLite database.');
    initializeDatabase();
  }
});

function initializeDatabase() {
  db.serialize(() => {
    // Servers Table
    db.run(`
      CREATE TABLE IF NOT EXISTS servers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT 'My Server',
        rules_channel_id TEXT,
        welcome_channel_id TEXT,
        storage_type TEXT NOT NULL DEFAULT 'data_dir',
        s3_endpoint TEXT,
        s3_region TEXT,
        s3_bucket TEXT,
        s3_access_key TEXT,
        s3_secret_key TEXT,
        s3_api_key TEXT,
        s3_prefix TEXT,
        storage_last_error TEXT,
        storage_updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `, (err) => {
      if (err) {
        console.error('Error creating servers table:', err.message);
        failSchemaInitialization(err);
        return;
      }

      migrateServersTableSchema((migrationErr) => {
        if (migrationErr) {
          console.error('Error migrating servers table:', migrationErr.message);
          failSchemaInitialization(migrationErr);
          return;
        }

        markSchemaStepDone('servers');
      });
    });

    // Users Table
    db.run(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        public_key TEXT UNIQUE NOT NULL,
        avatar_url TEXT,
        last_ip TEXT,
        role TEXT DEFAULT 'user',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `, (err) => {
      if (err) {
        console.error('Error creating users table:', err.message);
        return;
      }

      db.run('ALTER TABLE users ADD COLUMN last_ip TEXT', () => {});
    });

    // Categories Table
    db.run(`
      CREATE TABLE IF NOT EXISTS categories (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        position INTEGER NOT NULL DEFAULT 0
      )
    `);

    // Channels Table
    db.run(`
      CREATE TABLE IF NOT EXISTS channels (
        id TEXT PRIMARY KEY,
        category_id TEXT,
        name TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('text', 'voice', 'rss', 'folder')),
        position INTEGER NOT NULL DEFAULT 0,
        feed_url TEXT,
        FOREIGN KEY (category_id) REFERENCES categories(id)
      )
    `, (err) => {
      if (err) {
        console.error('Error creating channels table:', err.message);
        failSchemaInitialization(err);
        return;
      }

      migrateChannelsTableSchema((migrationErr) => {
        if (migrationErr) {
          failSchemaInitialization(migrationErr);
          return;
        }

        markSchemaStepDone('channels');
      });
    });

    // File metadata for folder channels
    db.run(`
      CREATE TABLE IF NOT EXISTS folder_channel_files (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        original_name TEXT NOT NULL,
        storage_name TEXT NOT NULL,
        storage_provider TEXT NOT NULL DEFAULT 'data_dir',
        storage_key TEXT,
        mime_type TEXT,
        size_bytes INTEGER NOT NULL,
        uploader_user_id TEXT NOT NULL,
        migrated_to_s3_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (channel_id) REFERENCES channels(id),
        FOREIGN KEY (uploader_user_id) REFERENCES users(id)
      )
    `, (err) => {
      if (err) {
        console.error('Error creating folder_channel_files table:', err.message);
        failSchemaInitialization(err);
        return;
      }

      migrateFolderChannelFilesStorageSchema((migrationErr) => {
        if (migrationErr) {
          console.error('Error migrating folder_channel_files table for storage schema:', migrationErr.message);
          failSchemaInitialization(migrationErr);
          return;
        }

        db.serialize(() => {
          db.run('CREATE INDEX IF NOT EXISTS idx_folder_channel_files_channel_id ON folder_channel_files(channel_id)');
          db.run('CREATE INDEX IF NOT EXISTS idx_folder_channel_files_uploader_id ON folder_channel_files(uploader_user_id)');
          db.run('CREATE INDEX IF NOT EXISTS idx_folder_channel_files_storage_provider ON folder_channel_files(storage_provider)');
        });

        markSchemaStepDone('folder_files');
      });
    });

    // RSS dedupe tracking table
    db.run(`
      CREATE TABLE IF NOT EXISTS rss_channel_items (
        channel_id TEXT NOT NULL,
        item_key TEXT NOT NULL,
        content_fingerprint TEXT,
        message_id TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (channel_id, item_key),
        FOREIGN KEY (channel_id) REFERENCES channels(id),
        FOREIGN KEY (message_id) REFERENCES messages(id)
      )
    `, (err) => {
      if (err) {
        console.error('Error creating rss_channel_items table:', err.message);
        return;
      }

      migrateRssChannelItemsForContentDedupe((migrationErr) => {
        if (migrationErr) {
          console.error('Error migrating rss_channel_items table for content dedupe:', migrationErr.message);
        }
      });
    });

    // Messages Table
    db.run(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (channel_id) REFERENCES channels(id),
        FOREIGN KEY (user_id) REFERENCES users(id)
      )
    `);

    // Per-user channel read state (used for persistent unread indicators)
    db.run(`
      CREATE TABLE IF NOT EXISTS channel_read_states (
        user_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        last_read_message_id TEXT,
        last_read_message_created_at DATETIME,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (user_id, channel_id),
        FOREIGN KEY (user_id) REFERENCES users(id),
        FOREIGN KEY (channel_id) REFERENCES channels(id),
        FOREIGN KEY (last_read_message_id) REFERENCES messages(id)
      )
    `, (err) => {
      if (err) {
        console.error('Error creating channel_read_states table:', err.message);
        return;
      }

      migrateChannelReadStatesTable((migrationErr) => {
        if (migrationErr) {
          console.error('Error migrating channel_read_states table:', migrationErr.message);
          return;
        }

        // Backfill existing user/channel pairs so legacy installs do not mark all history as unread.
        db.run(
          `
            INSERT OR IGNORE INTO channel_read_states (
              user_id,
              channel_id,
              last_read_message_id,
              last_read_message_created_at,
              updated_at
            )
            SELECT
              u.id,
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
            FROM users u
            CROSS JOIN channels c
          `,
          (seedErr) => {
            if (seedErr) {
              console.error('Error seeding channel_read_states baseline:', seedErr.message);
            }
          }
        );
      });
    });

    // Moderation actions table (supports offline enforcement + audit trail)
    db.run(`
      CREATE TABLE IF NOT EXISTS moderation_actions (
        id TEXT PRIMARY KEY,
        target_user_id TEXT NOT NULL,
        moderator_user_id TEXT NOT NULL,
        action_type TEXT NOT NULL CHECK(action_type IN ('kick', 'ban')),
        reason TEXT,
        delete_mode TEXT NOT NULL DEFAULT 'none' CHECK(delete_mode IN ('none', 'hours', 'all')),
        delete_hours INTEGER,
        blacklist_identity INTEGER NOT NULL DEFAULT 0,
        blacklist_ip INTEGER NOT NULL DEFAULT 0,
        target_ip TEXT,
        enforced INTEGER NOT NULL DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        enforced_at DATETIME,
        FOREIGN KEY (target_user_id) REFERENCES users(id),
        FOREIGN KEY (moderator_user_id) REFERENCES users(id)
      )
    `, (err) => {
      if (err) {
        console.error('Error creating moderation_actions table:', err.message);
        return;
      }

      migrateModerationActionsTable((migrationErr) => {
        if (migrationErr) {
          console.error('Error migrating moderation_actions table:', migrationErr.message);
        }
      });
    });

    // Ban rules table (persistent enforcement by identity and/or IP)
    db.run(`
      CREATE TABLE IF NOT EXISTS ban_rules (
        id TEXT PRIMARY KEY,
        target_user_id TEXT,
        target_public_key TEXT,
        target_ip TEXT,
        blacklist_identity INTEGER NOT NULL DEFAULT 1,
        blacklist_ip INTEGER NOT NULL DEFAULT 0,
        reason TEXT,
        moderator_user_id TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        revoked_at DATETIME,
        FOREIGN KEY (target_user_id) REFERENCES users(id),
        FOREIGN KEY (moderator_user_id) REFERENCES users(id)
      )
    `, (err) => {
      if (err) {
        console.error('Error creating ban_rules table:', err.message);
        return;
      }

      migrateBanRulesTable((migrationErr) => {
        if (migrationErr) {
          console.error('Error migrating ban_rules table:', migrationErr.message);
        }
      });
    });

    // Ensure default server exists
    db.get('SELECT count(*) as count FROM servers', (err, row: any) => {
      if (err) {
        console.error('Error checking servers:', err);
        return;
      }
      if (row.count === 0) {
        const serverId = crypto.randomUUID();
        db.run('INSERT INTO servers (id, name, title) VALUES (?, ?, ?)', [serverId, 'My Server', 'My Server'], (err) => {
          if (err) {
            console.error('Error creating default server:', err);
          } else {
            console.log('Created default server.');
          }
        });
      }
    });

    // Ensure default channels exist
    db.get('SELECT count(*) as count FROM channels', (err, row: any) => {
      if (err) {
        console.error('Error checking channels:', err);
        return;
      }
      if (row.count === 0) {
        const textId = crypto.randomUUID();
        db.run('INSERT INTO channels (id, category_id, name, type, position) VALUES (?, NULL, ?, ?, ?)', [textId, 'general', 'text', 0], (err) => {
          if (err) {
            console.error('Error creating default text channel:', err);
          } else {
            console.log('Created default "general" text channel.');
            // Ensure default server exists and set welcome channel
            db.get('SELECT count(*) as count FROM servers', (err, row: any) => {
              if (row && row.count === 0) {
                const serverId = crypto.randomUUID();
                db.run('INSERT INTO servers (id, name, title, welcome_channel_id) VALUES (?, ?, ?, ?)', [serverId, 'My Server', 'My Server', textId]);
              } else {
                db.run('UPDATE servers SET welcome_channel_id = ? WHERE welcome_channel_id IS NULL', [textId]);
              }
            });
          }
        });

        const voiceId = crypto.randomUUID();
        db.run('INSERT INTO channels (id, category_id, name, type, position) VALUES (?, NULL, ?, ?, ?)', [voiceId, 'General Voice', 'voice', 1], (err) => {
          if (err) {
            console.error('Error creating default voice channel:', err);
          } else {
            console.log('Created default "General Voice" voice channel.');
          }
        });
      }
    });

    console.log('Database tables initialized.');
  });
}

function migrateChannelsTableSchema(done: (error?: Error) => void) {
  db.all('PRAGMA table_info(channels)', (pragmaErr, columns: any[]) => {
    if (pragmaErr) {
      console.error('Failed to inspect channels table for migration:', pragmaErr.message);
      done(pragmaErr);
      return;
    }

    const hasFeedUrl = columns.some((column) => column.name === 'feed_url');
    db.get("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'channels'", (schemaErr, schemaRow: any) => {
      if (schemaErr) {
        done(schemaErr);
        return;
      }

      const tableSql = typeof schemaRow?.sql === 'string' ? schemaRow.sql.toLowerCase() : '';
      const supportsFolderType = tableSql.includes("'folder'");

      if (hasFeedUrl && supportsFolderType) {
        done();
        return;
      }

      db.run(
        `
        CREATE TABLE IF NOT EXISTS channels_new (
          id TEXT PRIMARY KEY,
          category_id TEXT,
          name TEXT NOT NULL,
          type TEXT NOT NULL CHECK(type IN ('text', 'voice', 'rss', 'folder')),
          position INTEGER NOT NULL DEFAULT 0,
          feed_url TEXT,
          FOREIGN KEY (category_id) REFERENCES categories(id)
        )
        `,
        (createErr) => {
          if (createErr) {
            console.error('Failed to create channels_new migration table:', createErr.message);
            done(createErr);
            return;
          }

          const feedUrlSelect = hasFeedUrl ? 'feed_url' : 'NULL';
          db.run(
            `
            INSERT INTO channels_new (id, category_id, name, type, position, feed_url)
            SELECT id, category_id, name, type, position, ${feedUrlSelect} FROM channels
            `,
            (copyErr) => {
              if (copyErr) {
                console.error('Failed to copy channels into migration table:', copyErr.message);
                db.run('DROP TABLE IF EXISTS channels_new', () => {});
                done(copyErr);
                return;
              }

              db.run('DROP TABLE channels', (dropErr) => {
                if (dropErr) {
                  console.error('Failed to drop old channels table during migration:', dropErr.message);
                  db.run('DROP TABLE IF EXISTS channels_new', () => {});
                  done(dropErr);
                  return;
                }

                db.run('ALTER TABLE channels_new RENAME TO channels', (renameErr) => {
                  if (renameErr) {
                    console.error('Failed to rename channels_new table during migration:', renameErr.message);
                    done(renameErr);
                    return;
                  }
                  console.log('Migrated channels table schema to support rss feed_url and folder channels.');
                  done();
                });
              });
            }
          );
        }
      );
    });
  });
}

function migrateServersTableSchema(done: (error?: Error) => void) {
  db.all('PRAGMA table_info(servers)', (pragmaErr, columns: any[]) => {
    if (pragmaErr) {
      done(pragmaErr);
      return;
    }

    const hasTitle = columns.some((column) => column.name === 'title');
    const hasRulesChannelId = columns.some((column) => column.name === 'rules_channel_id');
    const hasWelcomeChannelId = columns.some((column) => column.name === 'welcome_channel_id');
    const hasStorageType = columns.some((column) => column.name === 'storage_type');
    const hasS3Endpoint = columns.some((column) => column.name === 's3_endpoint');
    const hasS3Region = columns.some((column) => column.name === 's3_region');
    const hasS3Bucket = columns.some((column) => column.name === 's3_bucket');
    const hasS3AccessKey = columns.some((column) => column.name === 's3_access_key');
    const hasS3SecretKey = columns.some((column) => column.name === 's3_secret_key');
    const hasS3ApiKey = columns.some((column) => column.name === 's3_api_key');
    const hasS3Prefix = columns.some((column) => column.name === 's3_prefix');
    const hasStorageLastError = columns.some((column) => column.name === 'storage_last_error');
    const hasStorageUpdatedAt = columns.some((column) => column.name === 'storage_updated_at');

    const pendingAlterStatements: string[] = [];
    if (!hasTitle) pendingAlterStatements.push("ALTER TABLE servers ADD COLUMN title TEXT NOT NULL DEFAULT 'My Server'");
    if (!hasRulesChannelId) pendingAlterStatements.push('ALTER TABLE servers ADD COLUMN rules_channel_id TEXT');
    if (!hasWelcomeChannelId) pendingAlterStatements.push('ALTER TABLE servers ADD COLUMN welcome_channel_id TEXT');
    if (!hasStorageType) pendingAlterStatements.push("ALTER TABLE servers ADD COLUMN storage_type TEXT NOT NULL DEFAULT 'data_dir'");
    if (!hasS3Endpoint) pendingAlterStatements.push('ALTER TABLE servers ADD COLUMN s3_endpoint TEXT');
    if (!hasS3Region) pendingAlterStatements.push('ALTER TABLE servers ADD COLUMN s3_region TEXT');
    if (!hasS3Bucket) pendingAlterStatements.push('ALTER TABLE servers ADD COLUMN s3_bucket TEXT');
    if (!hasS3AccessKey) pendingAlterStatements.push('ALTER TABLE servers ADD COLUMN s3_access_key TEXT');
    if (!hasS3SecretKey) pendingAlterStatements.push('ALTER TABLE servers ADD COLUMN s3_secret_key TEXT');
    if (!hasS3ApiKey) pendingAlterStatements.push('ALTER TABLE servers ADD COLUMN s3_api_key TEXT');
    if (!hasS3Prefix) pendingAlterStatements.push('ALTER TABLE servers ADD COLUMN s3_prefix TEXT');
    if (!hasStorageLastError) pendingAlterStatements.push('ALTER TABLE servers ADD COLUMN storage_last_error TEXT');
    if (!hasStorageUpdatedAt) pendingAlterStatements.push('ALTER TABLE servers ADD COLUMN storage_updated_at DATETIME');

    const runNextAlter = (index: number) => {
      if (index >= pendingAlterStatements.length) {
        db.run(
          `
            UPDATE servers
            SET
              title = COALESCE(NULLIF(title, ''), name, 'My Server'),
              storage_updated_at = COALESCE(storage_updated_at, CURRENT_TIMESTAMP)
          `,
          (updateErr) => {
            done(updateErr || undefined);
          }
        );
        return;
      }

      db.run(pendingAlterStatements[index], (alterErr) => {
        if (alterErr) {
          done(alterErr);
          return;
        }
        runNextAlter(index + 1);
      });
    };

    runNextAlter(0);
  });
}

function migrateRssChannelItemsForContentDedupe(done: (error?: Error) => void) {
  db.all('PRAGMA table_info(rss_channel_items)', (pragmaErr, columns: any[]) => {
    if (pragmaErr) {
      done(pragmaErr);
      return;
    }

    const hasContentFingerprint = columns.some((column) => column.name === 'content_fingerprint');

    const ensureUniqueIndex = () => {
      db.run(
        `
        CREATE UNIQUE INDEX IF NOT EXISTS idx_rss_channel_items_channel_content_fingerprint
        ON rss_channel_items(channel_id, content_fingerprint)
        WHERE content_fingerprint IS NOT NULL
        `,
        (indexErr) => {
          if (indexErr) {
            done(indexErr);
            return;
          }

          done();
        }
      );
    };

    if (hasContentFingerprint) {
      ensureUniqueIndex();
      return;
    }

    db.run('ALTER TABLE rss_channel_items ADD COLUMN content_fingerprint TEXT', (alterErr) => {
      if (alterErr) {
        done(alterErr);
        return;
      }

      ensureUniqueIndex();
    });
  });
}

function migrateModerationActionsTable(done: (error?: Error) => void) {
  db.all('PRAGMA table_info(moderation_actions)', (pragmaErr, columns: any[]) => {
    if (pragmaErr) {
      done(pragmaErr);
      return;
    }

    const hasDeleteMode = columns.some((column) => column.name === 'delete_mode');
    const hasDeleteHours = columns.some((column) => column.name === 'delete_hours');
    const hasBlacklistIdentity = columns.some((column) => column.name === 'blacklist_identity');
    const hasBlacklistIp = columns.some((column) => column.name === 'blacklist_ip');
    const hasTargetIp = columns.some((column) => column.name === 'target_ip');
    const hasEnforced = columns.some((column) => column.name === 'enforced');
    const hasEnforcedAt = columns.some((column) => column.name === 'enforced_at');

    const pendingAlterStatements: string[] = [];
    if (!hasDeleteMode) pendingAlterStatements.push("ALTER TABLE moderation_actions ADD COLUMN delete_mode TEXT NOT NULL DEFAULT 'none'");
    if (!hasDeleteHours) pendingAlterStatements.push('ALTER TABLE moderation_actions ADD COLUMN delete_hours INTEGER');
    if (!hasBlacklistIdentity) pendingAlterStatements.push('ALTER TABLE moderation_actions ADD COLUMN blacklist_identity INTEGER NOT NULL DEFAULT 0');
    if (!hasBlacklistIp) pendingAlterStatements.push('ALTER TABLE moderation_actions ADD COLUMN blacklist_ip INTEGER NOT NULL DEFAULT 0');
    if (!hasTargetIp) pendingAlterStatements.push('ALTER TABLE moderation_actions ADD COLUMN target_ip TEXT');
    if (!hasEnforced) pendingAlterStatements.push('ALTER TABLE moderation_actions ADD COLUMN enforced INTEGER NOT NULL DEFAULT 0');
    if (!hasEnforcedAt) pendingAlterStatements.push('ALTER TABLE moderation_actions ADD COLUMN enforced_at DATETIME');

    const runNextAlter = (index: number) => {
      if (index >= pendingAlterStatements.length) {
        db.run('CREATE INDEX IF NOT EXISTS idx_moderation_actions_target_enforced ON moderation_actions(target_user_id, enforced)', (indexErr) => {
          if (indexErr) {
            done(indexErr);
            return;
          }
          done();
        });
        return;
      }

      db.run(pendingAlterStatements[index], (alterErr) => {
        if (alterErr) {
          done(alterErr);
          return;
        }
        runNextAlter(index + 1);
      });
    };

    runNextAlter(0);
  });
}

function migrateBanRulesTable(done: (error?: Error) => void) {
  db.all('PRAGMA table_info(ban_rules)', (pragmaErr, columns: any[]) => {
    if (pragmaErr) {
      done(pragmaErr);
      return;
    }

    const hasTargetUserId = columns.some((column) => column.name === 'target_user_id');
    const hasTargetPublicKey = columns.some((column) => column.name === 'target_public_key');
    const hasTargetIp = columns.some((column) => column.name === 'target_ip');
    const hasBlacklistIdentity = columns.some((column) => column.name === 'blacklist_identity');
    const hasBlacklistIp = columns.some((column) => column.name === 'blacklist_ip');
    const hasActive = columns.some((column) => column.name === 'active');
    const hasRevokedAt = columns.some((column) => column.name === 'revoked_at');

    const pendingAlterStatements: string[] = [];
    if (!hasTargetUserId) pendingAlterStatements.push('ALTER TABLE ban_rules ADD COLUMN target_user_id TEXT');
    if (!hasTargetPublicKey) pendingAlterStatements.push('ALTER TABLE ban_rules ADD COLUMN target_public_key TEXT');
    if (!hasTargetIp) pendingAlterStatements.push('ALTER TABLE ban_rules ADD COLUMN target_ip TEXT');
    if (!hasBlacklistIdentity) pendingAlterStatements.push('ALTER TABLE ban_rules ADD COLUMN blacklist_identity INTEGER NOT NULL DEFAULT 1');
    if (!hasBlacklistIp) pendingAlterStatements.push('ALTER TABLE ban_rules ADD COLUMN blacklist_ip INTEGER NOT NULL DEFAULT 0');
    if (!hasActive) pendingAlterStatements.push('ALTER TABLE ban_rules ADD COLUMN active INTEGER NOT NULL DEFAULT 1');
    if (!hasRevokedAt) pendingAlterStatements.push('ALTER TABLE ban_rules ADD COLUMN revoked_at DATETIME');

    const runNextAlter = (index: number) => {
      if (index >= pendingAlterStatements.length) {
        db.serialize(() => {
          db.run('CREATE INDEX IF NOT EXISTS idx_ban_rules_identity ON ban_rules(target_user_id, target_public_key, active)');
          db.run('CREATE INDEX IF NOT EXISTS idx_ban_rules_ip ON ban_rules(target_ip, active)');
        });
        done();
        return;
      }

      db.run(pendingAlterStatements[index], (alterErr) => {
        if (alterErr) {
          done(alterErr);
          return;
        }
        runNextAlter(index + 1);
      });
    };

    runNextAlter(0);
  });
}

function migrateChannelReadStatesTable(done: (error?: Error) => void) {
  db.all('PRAGMA table_info(channel_read_states)', (pragmaErr, columns: any[]) => {
    if (pragmaErr) {
      done(pragmaErr);
      return;
    }

    const hasLastReadMessageId = columns.some((column) => column.name === 'last_read_message_id');
    const hasLastReadMessageCreatedAt = columns.some((column) => column.name === 'last_read_message_created_at');
    const hasUpdatedAt = columns.some((column) => column.name === 'updated_at');

    const pendingAlterStatements: string[] = [];
    if (!hasLastReadMessageId) pendingAlterStatements.push('ALTER TABLE channel_read_states ADD COLUMN last_read_message_id TEXT');
    if (!hasLastReadMessageCreatedAt) pendingAlterStatements.push('ALTER TABLE channel_read_states ADD COLUMN last_read_message_created_at DATETIME');
    if (!hasUpdatedAt) pendingAlterStatements.push('ALTER TABLE channel_read_states ADD COLUMN updated_at DATETIME DEFAULT CURRENT_TIMESTAMP');

    const runNextAlter = (index: number) => {
      if (index >= pendingAlterStatements.length) {
        db.serialize(() => {
          db.run('CREATE INDEX IF NOT EXISTS idx_channel_read_states_user ON channel_read_states(user_id)');
          db.run('CREATE INDEX IF NOT EXISTS idx_channel_read_states_channel ON channel_read_states(channel_id)');
        });
        done();
        return;
      }

      db.run(pendingAlterStatements[index], (alterErr) => {
        if (alterErr) {
          done(alterErr);
          return;
        }
        runNextAlter(index + 1);
      });
    };

    runNextAlter(0);
  });
}

function migrateFolderChannelFilesStorageSchema(done: (error?: Error) => void) {
  db.all('PRAGMA table_info(folder_channel_files)', (pragmaErr, columns: any[]) => {
    if (pragmaErr) {
      done(pragmaErr);
      return;
    }

    const hasStorageProvider = columns.some((column) => column.name === 'storage_provider');
    const hasStorageKey = columns.some((column) => column.name === 'storage_key');
    const hasMigratedToS3At = columns.some((column) => column.name === 'migrated_to_s3_at');

    const pendingAlterStatements: string[] = [];
    if (!hasStorageProvider) pendingAlterStatements.push("ALTER TABLE folder_channel_files ADD COLUMN storage_provider TEXT NOT NULL DEFAULT 'data_dir'");
    if (!hasStorageKey) pendingAlterStatements.push('ALTER TABLE folder_channel_files ADD COLUMN storage_key TEXT');
    if (!hasMigratedToS3At) pendingAlterStatements.push('ALTER TABLE folder_channel_files ADD COLUMN migrated_to_s3_at DATETIME');

    const runNextAlter = (index: number) => {
      if (index >= pendingAlterStatements.length) {
        done();
        return;
      }

      db.run(pendingAlterStatements[index], (alterErr) => {
        if (alterErr) {
          done(alterErr);
          return;
        }
        runNextAlter(index + 1);
      });
    };

    runNextAlter(0);
  });
}

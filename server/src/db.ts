import sqlite3 from 'sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';

const dbDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const dbPath = path.join(dbDir, 'roguecord.db');

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
        welcome_channel_id TEXT
      )
    `, (err) => {
      if (!err) {
        // Try to add columns in case the table already existed without them
        try {
          db.run("ALTER TABLE servers ADD COLUMN title TEXT NOT NULL DEFAULT 'My Server'", () => {});
          db.run('ALTER TABLE servers ADD COLUMN rules_channel_id TEXT', () => {});
          db.run('ALTER TABLE servers ADD COLUMN welcome_channel_id TEXT', () => {});
          db.run("UPDATE servers SET title = COALESCE(NULLIF(title, ''), name, 'My Server')", () => {});
        } catch (e) {
          console.error('Migration error:', e);
        }
      }
    });

    // Users Table
    db.run(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        public_key TEXT UNIQUE NOT NULL,
        avatar_url TEXT,
        role TEXT DEFAULT 'user',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

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
        type TEXT NOT NULL CHECK(type IN ('text', 'voice', 'rss')),
        position INTEGER NOT NULL DEFAULT 0,
        feed_url TEXT,
        FOREIGN KEY (category_id) REFERENCES categories(id)
      )
    `, (err) => {
      if (err) {
        console.error('Error creating channels table:', err.message);
        return;
      }

      migrateChannelsTableForRss();
    });

    // RSS dedupe tracking table
    db.run(`
      CREATE TABLE IF NOT EXISTS rss_channel_items (
        channel_id TEXT NOT NULL,
        item_key TEXT NOT NULL,
        message_id TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (channel_id, item_key),
        FOREIGN KEY (channel_id) REFERENCES channels(id),
        FOREIGN KEY (message_id) REFERENCES messages(id)
      )
    `, (err) => {
      if (err) {
        console.error('Error creating rss_channel_items table:', err.message);
      }
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

function migrateChannelsTableForRss() {
  db.all('PRAGMA table_info(channels)', (pragmaErr, columns: any[]) => {
    if (pragmaErr) {
      console.error('Failed to inspect channels table for migration:', pragmaErr.message);
      return;
    }

    const hasFeedUrl = columns.some((column) => column.name === 'feed_url');
    if (hasFeedUrl) {
      return;
    }

    db.run(
      `
      CREATE TABLE IF NOT EXISTS channels_new (
        id TEXT PRIMARY KEY,
        category_id TEXT,
        name TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('text', 'voice', 'rss')),
        position INTEGER NOT NULL DEFAULT 0,
        feed_url TEXT,
        FOREIGN KEY (category_id) REFERENCES categories(id)
      )
      `,
      (createErr) => {
        if (createErr) {
          console.error('Failed to create channels_new migration table:', createErr.message);
          return;
        }

        db.run(
          `
          INSERT INTO channels_new (id, category_id, name, type, position, feed_url)
          SELECT id, category_id, name, type, position, NULL FROM channels
          `,
          (copyErr) => {
            if (copyErr) {
              console.error('Failed to copy channels into migration table:', copyErr.message);
              db.run('DROP TABLE IF EXISTS channels_new', () => {});
              return;
            }

            db.run('DROP TABLE channels', (dropErr) => {
              if (dropErr) {
                console.error('Failed to drop old channels table during migration:', dropErr.message);
                db.run('DROP TABLE IF EXISTS channels_new', () => {});
                return;
              }

              db.run('ALTER TABLE channels_new RENAME TO channels', (renameErr) => {
                if (renameErr) {
                  console.error('Failed to rename channels_new table during migration:', renameErr.message);
                  return;
                }
                console.log('Migrated channels table to support rss channels and feed_url.');
              });
            });
          }
        );
      }
    );
  });
}

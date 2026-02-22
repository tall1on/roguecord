import sqlite3 from 'sqlite3';
import path from 'node:path';
import fs from 'node:fs';

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

    // Servers Table
    db.run(`
      CREATE TABLE IF NOT EXISTS servers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        icon_url TEXT,
        owner_id TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (owner_id) REFERENCES users(id)
      )
    `);

    // Server Members Table
    db.run(`
      CREATE TABLE IF NOT EXISTS server_members (
        server_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (server_id, user_id),
        FOREIGN KEY (server_id) REFERENCES servers(id),
        FOREIGN KEY (user_id) REFERENCES users(id)
      )
    `);

    // Categories Table
    db.run(`
      CREATE TABLE IF NOT EXISTS categories (
        id TEXT PRIMARY KEY,
        server_id TEXT NOT NULL,
        name TEXT NOT NULL,
        position INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY (server_id) REFERENCES servers(id)
      )
    `);

    // Channels Table
    db.run(`
      CREATE TABLE IF NOT EXISTS channels (
        id TEXT PRIMARY KEY,
        server_id TEXT NOT NULL,
        category_id TEXT,
        name TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('text', 'voice')),
        position INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY (server_id) REFERENCES servers(id),
        FOREIGN KEY (category_id) REFERENCES categories(id)
      )
    `);

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

    console.log('Database tables initialized.');
  });
}

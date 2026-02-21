const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, 'media.db');
const db = new Database(dbPath);

// Включаем WAL для лучшей производительности
db.pragma('journal_mode = WAL');

// Создаём таблицу видео
db.exec(`
  CREATE TABLE IF NOT EXISTS videos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    filename TEXT NOT NULL,
    stored_name TEXT NOT NULL UNIQUE,
    size INTEGER NOT NULL,
    mime_type TEXT NOT NULL DEFAULT 'video/mp4',
    share_id TEXT UNIQUE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

module.exports = db;

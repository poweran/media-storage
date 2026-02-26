const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, 'media.db');
const db = new Database(dbPath);

// Включаем WAL и внешние ключи для лучшей производительности и консистентности
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Создаём таблицу пользователей
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// Создаём таблицу видео
db.exec(`
  CREATE TABLE IF NOT EXISTS videos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    filename TEXT NOT NULL,
    stored_name TEXT NOT NULL UNIQUE,
    size INTEGER NOT NULL,
    mime_type TEXT NOT NULL DEFAULT 'video/mp4',
    share_id TEXT UNIQUE,
    uploader_username TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// Создаём таблицу папок
db.exec(`
  CREATE TABLE IF NOT EXISTS folders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    parent_id INTEGER DEFAULT NULL,
    uploader_username TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(parent_id) REFERENCES folders(id) ON DELETE CASCADE
  )
`);

// Миграция: добавляем колонку uploader_username, если её нет
try {
  const tableInfo = db.pragma('table_info(videos)');
  const hasUploader = tableInfo.some(column => column.name === 'uploader_username');
  if (!hasUploader) {
    db.exec('ALTER TABLE videos ADD COLUMN uploader_username TEXT');
    console.log('Выполнена миграция БД: добавлена колонка uploader_username в videos');
  }
} catch (err) {
  console.error('Ошибка при миграции БД (uploader_username):', err);
}

// Миграция: добавляем колонку folder_id, если её нет
try {
  const tableInfo = db.pragma('table_info(videos)');
  const hasFolder = tableInfo.some(column => column.name === 'folder_id');
  if (!hasFolder) {
    db.exec('ALTER TABLE videos ADD COLUMN folder_id INTEGER DEFAULT NULL REFERENCES folders(id) ON DELETE CASCADE');
    console.log('Выполнена миграция БД: добавлена колонка folder_id в videos');
  }
} catch (err) {
  console.error('Ошибка при миграции БД (folder_id):', err);
}

module.exports = db;

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const storagePath = process.env.STORAGE_PATH ? path.resolve(process.env.STORAGE_PATH) : __dirname;
if (process.env.STORAGE_PATH && !fs.existsSync(storagePath)) {
  fs.mkdirSync(storagePath, { recursive: true });
}

const dbPath = path.join(storagePath, 'media.db');
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
    share_expires_at DATETIME,
    is_shared INTEGER DEFAULT 0,
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
    share_id TEXT UNIQUE,
    share_expires_at DATETIME,
    is_shared INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(parent_id) REFERENCES folders(id) ON DELETE CASCADE
  )
`);

// Создаём таблицу настроек
db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT NOT NULL UNIQUE,
    value TEXT NOT NULL
  )
`);

// Настройки по умолчанию
try {
  const titleSetting = db.prepare("SELECT value FROM settings WHERE key = 'site_title'").get();
  if (!titleSetting) {
    db.prepare("INSERT INTO settings (key, value) VALUES ('site_title', 'Provideo Media Holding')").run();
  }
} catch (err) {
  console.error('Ошибка инициализации настроек:', err);
}

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

// Миграция: добавляем колонку share_expires_at, если её нет
try {
  const tableInfo = db.pragma('table_info(videos)');
  const hasExpires = tableInfo.some(column => column.name === 'share_expires_at');
  if (!hasExpires) {
    db.exec('ALTER TABLE videos ADD COLUMN share_expires_at DATETIME');
    console.log('Выполнена миграция БД: добавлена колонка share_expires_at в videos');
  }
} catch (err) {
  console.error('Ошибка при миграции БД (share_expires_at):', err);
}

// Миграция: добавляем колонку share_id в folders
try {
  const tableInfo = db.pragma('table_info(folders)');
  const hasShareId = tableInfo.some(column => column.name === 'share_id');
  if (!hasShareId) {
    db.exec('ALTER TABLE folders ADD COLUMN share_id TEXT');
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_folders_share_id ON folders(share_id)');
    console.log('Выполнена миграция БД: добавлена колонка share_id в folders');
  }
} catch (err) {
  console.error('Ошибка при миграции БД (share_id в folders):', err);
}

// Миграция: добавляем колонку share_expires_at в folders
try {
  const tableInfo = db.pragma('table_info(folders)');
  const hasShareExpiresAt = tableInfo.some(column => column.name === 'share_expires_at');
  if (!hasShareExpiresAt) {
    db.exec('ALTER TABLE folders ADD COLUMN share_expires_at DATETIME');
    console.log('Выполнена миграция БД: добавлена колонка share_expires_at в folders');
  }
} catch (err) {
  console.error('Ошибка при миграции БД (share_expires_at в folders):', err);
}

// Миграция: добавляем колонку is_shared в videos
try {
  const tableInfo = db.pragma('table_info(videos)');
  const hasIsShared = tableInfo.some(column => column.name === 'is_shared');
  if (!hasIsShared) {
    db.exec('ALTER TABLE videos ADD COLUMN is_shared INTEGER DEFAULT 0');
    // Если уже есть share_id, помечаем как расшаренное
    db.exec('UPDATE videos SET is_shared = 1 WHERE share_id IS NOT NULL');
    console.log('Выполнена миграция БД: добавлена колонка is_shared в videos');
  }
} catch (err) {
  console.error('Ошибка при миграции БД (is_shared в videos):', err);
}

// Миграция: добавляем колонку is_shared в folders
try {
  const tableInfo = db.pragma('table_info(folders)');
  const hasIsShared = tableInfo.some(column => column.name === 'is_shared');
  if (!hasIsShared) {
    db.exec('ALTER TABLE folders ADD COLUMN is_shared INTEGER DEFAULT 0');
    // Если уже есть share_id, помечаем как расшаренное
    db.exec('UPDATE folders SET is_shared = 1 WHERE share_id IS NOT NULL');
    console.log('Выполнена миграция БД: добавлена колонка is_shared в folders');
  }
} catch (err) {
  console.error('Ошибка при миграции БД (is_shared в folders):', err);
}

module.exports = db;

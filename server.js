const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { spawn, exec } = require('child_process');
const crypto = require('crypto');
const cookieParser = require('cookie-parser');
const { nanoid } = require('nanoid');
const bcrypt = require('bcrypt');
const archiver = require('archiver');
const db = require('./db');

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;

// ==================== Авторизация ====================
let AUTH_SECRET = process.env.AUTH_SECRET ? process.env.AUTH_SECRET.trim() : null;
if (!AUTH_SECRET) {
    const secretFile = path.join(__dirname, '.auth_secret');
    if (fs.existsSync(secretFile)) {
        AUTH_SECRET = fs.readFileSync(secretFile, 'utf8').trim();
    } else {
        AUTH_SECRET = crypto.randomBytes(32).toString('hex');
        try { fs.writeFileSync(secretFile, AUTH_SECRET); } catch (e) {}
    }
}
const TOKEN_MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 7 дней
const inFlightThumbnails = new Map();

function generateToken(username) {
    const expires = Date.now() + TOKEN_MAX_AGE;
    const data = `auth:${username}:${expires}`;
    const hmac = crypto.createHmac('sha256', AUTH_SECRET).update(data).digest('hex');
    return `${username}.${expires}.${hmac}`;
}

function verifyToken(token) {
    if (!token || typeof token !== 'string') return false;
    const parts = token.split('.');
    if (parts.length !== 3) return false;
    const [username, expires, hmac] = parts;
    const expNum = parseInt(expires, 10);
    if (isNaN(expNum) || Date.now() > expNum) return false;
    try {
        const expected = crypto.createHmac('sha256', AUTH_SECRET).update(`auth:${username}:${expires}`).digest('hex');
        const bufHmac = Buffer.from(hmac, 'utf8');
        const bufExpected = Buffer.from(expected, 'utf8');
        if (bufHmac.length !== bufExpected.length) return false;
        return crypto.timingSafeEqual(bufHmac, bufExpected) ? username : false;
    } catch (err) {
        return false;
    }
}

function clearAuthCookie(req, res) {
    const isHttps = Boolean(
        (req && (req.secure || req.protocol === 'https' || req.headers['x-forwarded-proto'] === 'https')) ||
        (req && req.headers && req.headers.host && !req.headers.host.includes('localhost') && !req.headers.host.includes('127.0.0.1'))
    );
    
    // Clear standard cookie
    res.clearCookie('auth_token', { path: '/', httpOnly: true, sameSite: 'lax', secure: isHttps });
    res.cookie('auth_token', '', { path: '/', httpOnly: true, sameSite: 'lax', secure: isHttps, expires: new Date(0), maxAge: 0 });

    if (isHttps) {
        res.clearCookie('auth_token', { path: '/', httpOnly: true, sameSite: 'none', secure: true });
        res.cookie('auth_token', '', { path: '/', httpOnly: true, sameSite: 'none', secure: true, expires: new Date(0), maxAge: 0 });
    }
}

// Создаём пользователя по умолчанию или обновляем пароль
try {
    const rawPassword = process.env.AUTH_PASSWORD;
    const defaultPassword = rawPassword ? rawPassword.trim() : 'admin';
    const hash = bcrypt.hashSync(defaultPassword, 10);

    // Пытаемся вставить пользователя. Если он уже есть, игнорируем ошибку.
    const info = db.prepare('INSERT OR IGNORE INTO users (username, password_hash) VALUES (?, ?)').run('admin', hash);

    // Если пользователь уже существовал, и переменная AUTH_PASSWORD передана, обновляем пароль
    if (info.changes === 0 && rawPassword) {
        db.prepare('UPDATE users SET password_hash = ? WHERE username = ?').run(hash, 'admin');
        console.log('Пароль администратора успешно обновлён из переменной AUTH_PASSWORD');
    } else if (info.changes > 0) {
        console.log(`Создан пользователь по умолчанию: admin / ${rawPassword ? 'пароль из AUTH_PASSWORD' : 'admin'}`);
    }
} catch (err) {
    console.error('Ошибка инициализации пользователей:', err);
}

// Публичные пути (не требуют авторизации)
function isPublicPath(pathname) {
    return (
        pathname === '/secure-admin' ||
        pathname === '/secure-admin.html' ||
        pathname === '/api/login' ||
        pathname === '/api/logout' ||
        pathname === '/logout' ||
        pathname === '/api/me' ||
        pathname === '/api/settings' ||
        pathname.startsWith('/s/') ||
        pathname.startsWith('/api/share/') ||
        pathname.startsWith('/fonts/') ||
        pathname === '/style.css' ||
        pathname === '/favicon.ico' ||
        pathname === '/app.js'
    );
}

// Создание папок uploads и temp_uploads
const rawStoragePath = process.env.STORAGE_PATH || process.env.MEDIA_STORAGE_PATH || __dirname;
const resolvedStoragePath = path.resolve(rawStoragePath);
let storagePath = resolvedStoragePath;
let uploadsDir = path.join(resolvedStoragePath, 'uploads');
if (path.basename(resolvedStoragePath) === 'uploads') {
    uploadsDir = resolvedStoragePath;
    storagePath = fs.existsSync(path.join(resolvedStoragePath, 'media.db'))
        ? resolvedStoragePath
        : path.dirname(resolvedStoragePath);
}
const tempDir = path.join(storagePath, 'temp_uploads');
const thumbsDir = path.join(uploadsDir, '.thumbs');

if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}
if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
}
if (!fs.existsSync(thumbsDir)) {
    fs.mkdirSync(thumbsDir, { recursive: true });
}

// Настройка multer (загрузка во временную директорию)
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, tempDir),
    filename: (req, file, cb) => {
        file.originalname = Buffer.from(file.originalname, 'latin1').toString('utf8');
        const ext = path.extname(file.originalname);
        cb(null, nanoid(16) + ext);
    }
});

function getMimeType(filename) {
    if (!filename) return 'application/octet-stream';
    const ext = path.extname(filename).toLowerCase();
    const mimeMap = {
        '.mp4': 'video/mp4', '.mkv': 'video/x-matroska', '.webm': 'video/webm',
        '.avi': 'video/x-msvideo', '.mov': 'video/quicktime', '.m4v': 'video/mp4',
        '.wmv': 'video/x-ms-wmv', '.flv': 'video/x-flv', '.3gp': 'video/3gpp', '.3g2': 'video/3gpp2',
        '.ts': 'video/mp2t', '.m2ts': 'video/mp2t', '.mts': 'video/mp2t', '.m2t': 'video/mp2t',
        '.vob': 'video/dvd', '.ogv': 'video/ogg', '.ogg': 'video/ogg', '.mpg': 'video/mpeg',
        '.mpeg': 'video/mpeg', '.m2v': 'video/mpeg', '.asf': 'video/x-ms-asf',
        '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
        '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
        '.bmp': 'image/bmp', '.ico': 'image/x-icon', '.tiff': 'image/tiff',
        '.tif': 'image/tiff', '.heic': 'image/heic', '.heif': 'image/heif',
        '.avif': 'image/avif', '.raw': 'image/x-raw', '.cr2': 'image/x-canon-cr2',
        '.cr3': 'image/x-canon-cr3', '.nef': 'image/x-nikon-nef', '.arw': 'image/x-sony-arw',
        '.dng': 'image/x-adobe-dng'
    };
    return mimeMap[ext] || 'application/octet-stream';
}

function naturalCompare(a, b) {
    if (a === b) return 0;
    const strA = String(a || '');
    const strB = String(b || '');
    const res = strA.localeCompare(strB, undefined, { numeric: true, sensitivity: 'base' });
    if (res !== 0) return res;
    return strA.localeCompare(strB, undefined, { numeric: true });
}

const folderPathCache = new Map();

function getFolderPathFromDb(folderId) {
    if (!folderId) return '';
    if (folderPathCache.has(folderId)) return folderPathCache.get(folderId);
    let currentId = folderId;
    const parts = [];
    while (currentId) {
        const folder = db.prepare('SELECT id, name, parent_id FROM folders WHERE id = ?').get(currentId);
        if (!folder) break;
        parts.unshift(folder.name);
        currentId = folder.parent_id;
    }
    const res = parts.join('/');
    folderPathCache.set(folderId, res);
    return res;
}

const fileFilter = (req, file, cb) => {
    const isChunk = file.fieldname === 'chunk';
    const extMime = getMimeType(file.originalname);
    const isAllowedType = (file.mimetype && (file.mimetype.startsWith('video/') || file.mimetype.startsWith('image/'))) ||
                          extMime.startsWith('video/') || extMime.startsWith('image/') ||
                          isChunk;
    
    if (isAllowedType) {
        cb(null, true);
    } else {
        cb(new Error('Only video and photo files are allowed'), false);
    }
};

const MAX_FILE_SIZE_GB = parseInt(process.env.MAX_FILE_SIZE_GB) || 2;
const MAX_FILE_COUNT = parseInt(process.env.MAX_FILE_COUNT) || 50;
const upload = multer({
    storage,
    fileFilter,
    limits: { fileSize: MAX_FILE_SIZE_GB * 1024 * 1024 * 1024 }
});

function createZipArchive(options = { zlib: { level: 0 } }) {
    if (typeof archiver === 'function') {
        return archiver('zip', options);
    }
    if (archiver && archiver.ZipArchive) {
        return new archiver.ZipArchive(options);
    }
    if (archiver && typeof archiver.create === 'function') {
        return archiver.create('zip', options);
    }
    throw new Error('Unsupported archiver interface');
}

// ==================== Очередь перекодирования ====================
const transcodeQueue = [];
let isTranscoding = false;

function getOriginalResolution(filePath) {
    return new Promise((resolve) => {
        exec(`ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=s=x:p=0 "${filePath}"`, { timeout: 15000 }, (err, stdout) => {
            if (err) return resolve(null);
            const [w, h] = (stdout || '').trim().split('x').map(Number);
            resolve(h); // Возвращаем высоту
        });
    });
}

function processQueue() {
    if (isTranscoding || transcodeQueue.length === 0) return;
    isTranscoding = true;
    const task = transcodeQueue.shift();

    const qualities = [1080, 720, 480, 360];

    getOriginalResolution(task.input).then(origHeight => {
        if (!origHeight) {
            isTranscoding = false;
            processQueue();
            return;
        }

        const targets = qualities.filter(q => q < origHeight);

        const processNextQuality = (index) => {
            if (index >= targets.length) {
                isTranscoding = false;
                processQueue();
                return;
            }

            const q = targets[index];
            const ext = path.extname(task.input);
            const outputName = task.input.replace(ext, `_${q}p.mp4`); // всегда mp4 для простоты

            const args = [
                '-i', task.input,
                '-vf', `scale=-2:${q}`,
                '-c:v', 'libx264',
                '-preset', 'veryfast',
                '-crf', '28',
                '-c:a', 'aac',
                '-b:a', '128k',
                '-threads', '2',
                '-y', outputName
            ];

            const ffmpeg = spawn('nice', ['-n', '15', 'ffmpeg', ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
            let stderrTail = '';
            ffmpeg.stderr.on('data', (chunk) => {
                stderrTail = (stderrTail + chunk.toString()).slice(-2000);
            });

            let finished = false;
            const finishQuality = (success) => {
                if (finished) return;
                finished = true;
                if (success) {
                    console.log(`[FFmpeg] Успешно создано качество ${q}p для ${task.filename}`);
                } else {
                    console.error(`[FFmpeg] Ошибка создания ${q}p для ${task.filename}: ${stderrTail.slice(-500)}`);
                }
                processNextQuality(index + 1);
            };

            ffmpeg.on('close', (code) => {
                finishQuality(code === 0);
            });

            ffmpeg.on('error', (err) => {
                console.error(`[FFmpeg Spawn Error] ${task.filename}:`, err);
                finishQuality(false);
            });
        };

        processNextQuality(0);
    });
}

function cleanUpCorruptedThumbs() {
    try {
        if (!fs.existsSync(thumbsDir)) return;
        const files = fs.readdirSync(thumbsDir);
        for (const file of files) {
            const filePath = path.join(thumbsDir, file);
            if (file.includes('.tmp_')) {
                try { fs.unlinkSync(filePath); } catch (e) {}
            } else {
                try {
                    const stat = fs.statSync(filePath);
                    if (stat.size === 0) {
                        fs.unlinkSync(filePath);
                    }
                } catch (e) {}
            }
        }
    } catch (e) {
        console.error('[CleanUpThumbs Error]', e);
    }
}
cleanUpCorruptedThumbs();

function ensureFolderPath(username, relativeFolderPath, rootParentId = null) {
    if (!relativeFolderPath) return rootParentId;
    const cacheKey = `fpath_${username}_${relativeFolderPath}_${rootParentId || 'root'}`;
    if (folderPathCache.has(cacheKey)) return folderPathCache.get(cacheKey);

    const parts = relativeFolderPath.split(/[/\\]/).filter(Boolean);
    let currentParentId = rootParentId;
    let currentRelPath = username;

    if (rootParentId) {
        const parentPath = getFolderPathFromDb(rootParentId);
        if (parentPath) {
            currentRelPath = path.join(username, parentPath);
        }
    }

    for (const part of parts) {
        currentRelPath = path.join(currentRelPath, part);
        const diskPath = path.join(uploadsDir, currentRelPath);
        if (!fs.existsSync(diskPath)) {
            fs.mkdirSync(diskPath, { recursive: true });
        }

        let folder;
        if (currentParentId) {
            folder = db.prepare('SELECT id FROM folders WHERE LOWER(TRIM(name)) = LOWER(TRIM(?)) AND parent_id = ?')
                .get(part, currentParentId);
        } else {
            folder = db.prepare('SELECT id FROM folders WHERE LOWER(TRIM(name)) = LOWER(TRIM(?)) AND parent_id IS NULL AND (uploader_username = ? OR uploader_username IS NULL)')
                .get(part, username);
        }

        if (!folder) {
            const info = db.prepare('INSERT INTO folders (name, parent_id, uploader_username) VALUES (?, ?, ?)')
                .run(part, currentParentId, username);
            currentParentId = info.lastInsertRowid;
        } else {
            currentParentId = folder.id;
        }
    }
    folderPathCache.set(cacheKey, currentParentId);
    return currentParentId;
}

function mergeDuplicateFolders(dbInstance) {
    let changed = true;
    let totalMerged = 0;
    while (changed) {
        changed = false;
        const folders = dbInstance.prepare("SELECT * FROM folders").all();
        const groups = new Map();

        for (const f of folders) {
            const parentKey = f.parent_id === null ? "root" : String(f.parent_id);
            const nameKey = (f.name || "").trim().toLowerCase();
            const key = `${parentKey}:::${nameKey}`;
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(f);
        }

        for (const [key, list] of groups.entries()) {
            if (list.length > 1) {
                list.sort((a, b) => {
                    if (a.share_id && !b.share_id) return -1;
                    if (!a.share_id && b.share_id) return 1;
                    return a.id - b.id;
                });

                const canonical = list[0];
                for (let i = 1; i < list.length; i++) {
                    const dup = list[i];
                    if (!canonical.share_id && dup.share_id) {
                        dbInstance.prepare("UPDATE folders SET share_id = ?, share_expires_at = ?, is_shared = ? WHERE id = ?")
                            .run(dup.share_id, dup.share_expires_at, dup.is_shared, canonical.id);
                        canonical.share_id = dup.share_id;
                    }

                    dbInstance.prepare("UPDATE videos SET folder_id = ? WHERE folder_id = ?").run(canonical.id, dup.id);
                    dbInstance.prepare("UPDATE folders SET parent_id = ? WHERE parent_id = ?").run(canonical.id, dup.id);
                    dbInstance.prepare("DELETE FROM folders WHERE id = ?").run(dup.id);
                    totalMerged++;
                    changed = true;
                }
            }
        }
    }
    return totalMerged;
}

const lastUserSyncMap = new Map();

function reconcileStorageAndDb() {
    try {
        if (!fs.existsSync(uploadsDir)) {
            fs.mkdirSync(uploadsDir, { recursive: true });
        }

        // 1. Собираем список всех пользователей из БД и папок uploadsDir
        const userSet = new Set(['admin']);
        try {
            const dbUsers = db.prepare('SELECT username FROM users').all();
            dbUsers.forEach(u => { if (u.username) userSet.add(u.username); });
        } catch (e) {}

        try {
            const diskDirs = fs.readdirSync(uploadsDir, { withFileTypes: true })
                .filter(d => d.isDirectory() && !d.name.startsWith('.'))
                .map(d => d.name);
            diskDirs.forEach(d => userSet.add(d));
        } catch (e) {}

        // 2. Создаем структуры папок пользователей на диске для всех папок из БД
        try {
            const allDbFolders = db.prepare('SELECT * FROM folders').all();
            for (const f of allDbFolders) {
                const uploader = f.uploader_username || 'admin';
                const folderRelPath = getFolderPathFromDb(f.id);
                if (folderRelPath) {
                    const folderDiskPath = path.join(uploadsDir, uploader, folderRelPath);
                    if (!fs.existsSync(folderDiskPath)) {
                        fs.mkdirSync(folderDiskPath, { recursive: true });
                    }
                }
            }
        } catch (e) {}

        // 3. Синхронизируем файлы и папки для каждого пользователя отдельно
        for (const user of userSet) {
            const userDir = path.join(uploadsDir, user);
            if (!fs.existsSync(userDir)) {
                fs.mkdirSync(userDir, { recursive: true });
                continue;
            }

            const diskFolders = new Set();
            const diskVideos = new Map();

            function getOrCreateFolderForUser(folderName, parentFolderId, uploader) {
                let folder;
                if (parentFolderId) {
                    folder = db.prepare('SELECT id FROM folders WHERE LOWER(TRIM(name)) = LOWER(TRIM(?)) AND parent_id = ?')
                        .get(folderName, parentFolderId);
                } else {
                    folder = db.prepare('SELECT id FROM folders WHERE LOWER(TRIM(name)) = LOWER(TRIM(?)) AND parent_id IS NULL')
                        .get(folderName);
                }

                if (!folder) {
                    const info = db.prepare('INSERT INTO folders (name, parent_id, uploader_username) VALUES (?, ?, ?)')
                        .run(folderName, parentFolderId || null, uploader);
                    folder = { id: info.lastInsertRowid };
                }
                return folder.id;
            }

            function scanUserDir(dirPath, parentFolderId, relFolderPath) {
                let entries = [];
                try {
                    entries = fs.readdirSync(dirPath, { withFileTypes: true });
                    entries.sort((a, b) => naturalCompare(a.name, b.name));
                } catch (e) {
                    return;
                }

                for (const entry of entries) {
                    const fullPath = path.join(dirPath, entry.name);
                    const relPath = relFolderPath ? `${relFolderPath}/${entry.name}` : entry.name;

                    if (entry.isDirectory()) {
                        const folderId = getOrCreateFolderForUser(entry.name, parentFolderId, user);
                        diskFolders.add(folderId);
                        scanUserDir(fullPath, folderId, relPath);
                    } else if (entry.isFile()) {
                        if (/_(1080p|720p|480p|360p)\.mp4$/i.test(entry.name)) {
                            continue;
                        }
                        const mimeType = getMimeType(entry.name);
                        if (mimeType.startsWith('video/') || mimeType.startsWith('image/')) {
                            const storedName = `${user}/${relPath}`;
                            const stats = fs.statSync(fullPath);
                            diskVideos.set(storedName, {
                                filename: entry.name,
                                stored_name: storedName,
                                size: stats.size,
                                mime_type: mimeType,
                                folder_id: parentFolderId
                            });
                        }
                    }
                }
            }

            scanUserDir(userDir, null, '');

            // Сверяем найденные на диске видео с записями в БД
            const dbVideos = db.prepare('SELECT id, filename, stored_name, folder_id, uploader_username, size FROM videos WHERE uploader_username = ? OR stored_name LIKE ?').all(user, `${user}/%`);
            const dbVideoMap = new Map(dbVideos.map(v => [v.stored_name, v]));

            for (const [storedName, info] of diskVideos.entries()) {
                const existing = dbVideoMap.get(storedName) || db.prepare('SELECT id, filename, stored_name, folder_id, uploader_username, size FROM videos WHERE stored_name = ?').get(storedName);
                if (!existing) {
                    const infoResult = db.prepare(`
                        INSERT INTO videos (filename, stored_name, size, mime_type, uploader_username, folder_id)
                        VALUES (?, ?, ?, ?, ?, ?)
                    `).run(info.filename, info.stored_name, info.size, info.mime_type, user, info.folder_id);

                    generateThumbnailForMedia({ id: infoResult.lastInsertRowid, stored_name: info.stored_name, mime_type: info.mime_type });
                } else {
                    // Обновляем folder_id, uploader_username и размер, если они не совпадают
                    if (existing.folder_id !== info.folder_id || existing.uploader_username !== user || existing.size !== info.size) {
                        db.prepare('UPDATE videos SET folder_id = ?, uploader_username = ?, size = ? WHERE id = ?')
                            .run(info.folder_id, user, info.size, existing.id);
                    }
                }
            }

            // Удаляем записи из БД, если файлов больше нет на диске
            for (const v of dbVideos) {
                if (v.stored_name && v.stored_name.startsWith(`${user}/`) && !diskVideos.has(v.stored_name)) {
                    if (fs.existsSync(path.join(uploadsDir, v.stored_name))) {
                        continue;
                    }
                    db.prepare('DELETE FROM videos WHERE id = ?').run(v.id);
                }
            }
        }

        // 4. Проверяем старые файлы без префикса пользователя в stored_name и перемещаем в uploads/admin/
        const unassignedVideos = db.prepare("SELECT id, stored_name, filename, folder_id, uploader_username FROM videos WHERE stored_name NOT LIKE '%/%'").all();
        for (const uv of unassignedVideos) {
            const user = uv.uploader_username || 'admin';
            const userDiskPath = path.join(uploadsDir, user, uv.stored_name);
            const rootDiskPath = path.join(uploadsDir, uv.stored_name);
            if (fs.existsSync(rootDiskPath) && !fs.existsSync(userDiskPath)) {
                fs.mkdirSync(path.dirname(userDiskPath), { recursive: true });
                fs.renameSync(rootDiskPath, userDiskPath);
            }
            if (fs.existsSync(userDiskPath)) {
                db.prepare('UPDATE videos SET stored_name = ?, uploader_username = ? WHERE id = ?')
                    .run(`${user}/${uv.stored_name}`, user, uv.id);
            }
        }

        // 5. Выполняем авто-объединение дубликатов папок при необходимости
        mergeDuplicateFolders(db);
    } catch (err) {
        console.error('[Reconcile Error]', err);
    }
}

function syncUserStorage(username) {
    if (!username) return;
    const now = Date.now();
    const lastSync = lastUserSyncMap.get(username) || 0;
    if (now - lastSync < 15000) return; // Синхронизируем не чаще чем раз в 15 секунд
    lastUserSyncMap.set(username, now);

    setImmediate(() => {
        reconcileStorageAndDb();
    });
}

reconcileStorageAndDb();
ensureAllThumbnails();

// Middleware
app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
        const duration = Date.now() - start;
        console.log(`[REQ] ${req.method} ${req.url} - ${res.statusCode} (${duration}ms) [${req.headers['x-forwarded-for'] || req.ip}]`);
    });
    next();
});
app.use(cookieParser());
app.use(express.json());

// Запрещаем кэширование ответов API (чтобы статус авторизации не кэшировался браузером)
app.use('/api', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Surrogate-Control', 'no-store');
    next();
});

// Middleware авторизации
app.use((req, res, next) => {
    let token = req.cookies ? req.cookies.auth_token : null;
    let tokenSource = token ? 'cookie' : null;
    if (!token && req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
        token = req.headers.authorization.slice(7).trim();
        tokenSource = 'bearer';
    }
    if (!token && req.query && req.query.token) {
        token = req.query.token;
        tokenSource = 'query';
    }

    const username = verifyToken(token);
    if (username) {
        req.user = { username };
        if (req.path === '/api/me' || req.path === '/api/logout') {
            console.log(`[AUTH-DEBUG] Path: ${req.path} | User: ${username} | Source: ${tokenSource} | Cookie: ${req.headers.cookie ? 'present' : 'none'} | AuthHeader: ${req.headers.authorization ? 'present' : 'none'}`);
        }
    } else {
        if (req.path === '/api/me' || req.path === '/api/logout') {
            console.log(`[AUTH-DEBUG] Path: ${req.path} | Unauthenticated | Cookie: ${req.headers.cookie ? 'present' : 'none'} | AuthHeader: ${req.headers.authorization ? 'present' : 'none'}`);
        }
        if (token && req.path !== '/api/login') {
            clearAuthCookie(req, res);
        }
    }

    if (isPublicPath(req.path)) return next();

    if (req.user) return next();

    // Для API — 401, для страниц — редиректим на логин /secure-admin
    if (req.path.startsWith('/api/')) {
        return res.status(401).json({ error: 'Authorization required' });
    }
    return res.redirect('/secure-admin');
});

// Статические файлы (после middleware авторизации)
app.use(express.static(path.join(__dirname, 'public'), {
    maxAge: 0,
    etag: false,
    lastModified: false,
    setHeaders: (res, filePath) => {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        res.setHeader('Surrogate-Control', 'no-store');
    }
}));

// Роут для страницы входа
app.get('/secure-admin', (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.sendFile(path.join(__dirname, 'public', 'secure-admin.html'));
});

// ==================== Аутентификация ====================

app.get('/api/me', (req, res) => {
    if (req.user) {
        res.json({
            username: req.user.username,
            authenticated: true,
            is_admin: req.user.username === 'admin'
        });
    } else {
        res.json({ username: null, authenticated: false, is_admin: false });
    }
});

// Логин
app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ error: 'Username and password are required' });
    }

    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (!user) {
        return res.status(401).json({ error: 'Invalid username or password' });
    }

    const match = await bcrypt.compare(password, user.password_hash);
    if (match) {
        const token = generateToken(user.username);
        const isHttps = Boolean(
            req.secure || req.protocol === 'https' || req.headers['x-forwarded-proto'] === 'https' ||
            (req.headers.host && !req.headers.host.includes('localhost') && !req.headers.host.includes('127.0.0.1'))
        );
        res.cookie('auth_token', token, {
            httpOnly: true,
            maxAge: TOKEN_MAX_AGE,
            sameSite: 'lax',
            secure: isHttps,
            path: '/'
        });
        res.json({ success: true, token, username: user.username });
    } else {
        res.status(401).json({ error: 'Invalid username or password' });
    }
});

// Регистрация (только для admin)
app.post('/api/register', async (req, res) => {
    if (!req.user || req.user.username !== 'admin') {
        return res.status(403).json({ error: 'Access denied: only admin can register new users' });
    }

    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ error: 'Username and password are required' });
    }

    const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
    if (existing) {
        return res.status(400).json({ error: 'User with this username already exists' });
    }

    try {
        const hash = await bcrypt.hash(password, 10);
        db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(username, hash);

        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Registration error' });
    }
});

// Список пользователей (только для admin)
app.get('/api/users', (req, res) => {
    if (!req.user || req.user.username !== 'admin') {
        return res.status(403).json({ error: 'Access denied' });
    }
    const users = db.prepare('SELECT id, username, created_at FROM users ORDER BY username ASC').all();
    res.json(users);
});

// Удалить пользователя (только для admin)
app.delete('/api/users/:id', (req, res) => {
    if (!req.user || req.user.username !== 'admin') {
        return res.status(403).json({ error: 'Access denied' });
    }

    const user = db.prepare('SELECT username FROM users WHERE id = ?').get(req.params.id);
    if (!user) {
        return res.status(404).json({ error: 'User not found' });
    }

    if (user.username === 'admin') {
        return res.status(400).json({ error: 'Cannot delete admin user' });
    }

    db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
    res.json({ success: true });
});

// Выход
app.post('/api/logout', (req, res) => {
    clearAuthCookie(req, res);
    res.json({ success: true });
});

app.get('/api/logout', (req, res) => {
    clearAuthCookie(req, res);
    res.redirect('/secure-admin');
});

app.get('/logout', (req, res) => {
    clearAuthCookie(req, res);
    res.redirect('/secure-admin');
});

// ==================== Настройки ====================

app.get('/api/settings', (req, res) => {
    const settings = {
        max_file_size_gb: MAX_FILE_SIZE_GB,
        max_file_count: MAX_FILE_COUNT
    };
    const rows = db.prepare('SELECT key, value FROM settings').all();
    rows.forEach(r => settings[r.key] = r.value);
    res.json(settings);
});

app.post('/api/settings', (req, res) => {
    if (!req.user || req.user.username !== 'admin') {
        return res.status(403).json({ error: 'Access denied: only admin can modify settings' });
    }
    const { site_title } = req.body;
    if (site_title) {
        db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(site_title, 'site_title');
    }
    res.json({ success: true });
});

// ==================== API ====================

// Список всех папок (доступен для всех авторизованных пользователей)
app.get('/api/folders', (req, res) => {
    if (req.user) syncUserStorage(req.user.username);
    const parentId = req.query.parent_id ? parseInt(req.query.parent_id, 10) : null;
    const sortBy = req.query.sort_by || 'name';
    const order = (req.query.order || 'asc').toUpperCase() === 'DESC' ? 'DESC' : 'ASC';
    const search = req.query.search ? req.query.search.trim() : (req.query.q ? req.query.q.trim() : '');
    const isRecursive = req.query.recursive === '1' || req.query.recursive === 'true' || search.length > 0;
    const searchLimit = search ? (parseInt(req.query.limit, 10) || 100) : (req.query.limit ? parseInt(req.query.limit, 10) : null);
    const limitClause = searchLimit ? `LIMIT ${searchLimit}` : '';

    let sortCol = 'name';
    if (sortBy === 'date') sortCol = 'created_at';
    else if (sortBy === 'uploader') sortCol = 'uploader_username';
    else if (sortBy === 'name') sortCol = 'name';

    let folders;
    if (search) {
        if (parentId) {
            folders = db.prepare(`
                WITH RECURSIVE subfolders(id) AS (
                    SELECT id FROM folders WHERE parent_id = ?
                    UNION ALL
                    SELECT child.id FROM folders child JOIN subfolders s ON child.parent_id = s.id
                )
                SELECT * FROM folders 
                WHERE id IN (SELECT id FROM subfolders)
                  AND contains_utf8(name, ?)
                ORDER BY ${sortCol} ${order}
                ${limitClause}
            `).all(parentId, search);
        } else {
            folders = db.prepare(`
                SELECT * FROM folders 
                WHERE contains_utf8(name, ?)
                ORDER BY ${sortCol} ${order}
                ${limitClause}
            `).all(search);
        }
    } else if (isRecursive) {
        if (parentId) {
            folders = db.prepare(`
                WITH RECURSIVE subfolders(id) AS (
                    SELECT id FROM folders WHERE parent_id = ?
                    UNION ALL
                    SELECT child.id FROM folders child JOIN subfolders s ON child.parent_id = s.id
                )
                SELECT * FROM folders 
                WHERE id IN (SELECT id FROM subfolders)
                ORDER BY ${sortCol} ${order}
            `).all(parentId);
        } else {
            folders = db.prepare(`
                SELECT * FROM folders 
                ORDER BY ${sortCol} ${order}
            `).all();
        }
    } else {
        if (parentId) {
            folders = db.prepare(`SELECT * FROM folders WHERE parent_id = ? ORDER BY ${sortCol} ${order}`).all(parentId);
        } else {
            folders = db.prepare(`SELECT * FROM folders WHERE parent_id IS NULL ORDER BY ${sortCol} ${order}`).all();
        }
    }

    const mult = order === 'ASC' ? 1 : -1;
    folders.sort((a, b) => {
        let diff = 0;
        if (sortBy === 'name') {
            diff = naturalCompare(a.name, b.name);
        } else if (sortBy === 'date') {
            diff = new Date(a.created_at || 0).getTime() - new Date(b.created_at || 0).getTime();
        } else if (sortBy === 'uploader') {
            diff = naturalCompare(a.uploader_username, b.uploader_username);
        }
        if (diff !== 0) return diff * mult;
        return naturalCompare(a.name, b.name) * mult;
    });

    const foldersWithStats = folders.map(f => {
        const stats = db.prepare(`
            WITH RECURSIVE subfolders(id) AS (
                SELECT id FROM folders WHERE id = ?
                UNION ALL
                SELECT child.id FROM folders child JOIN subfolders s ON child.parent_id = s.id
            )
            SELECT COUNT(*) as file_count, COALESCE(SUM(size), 0) as total_size 
            FROM videos 
            WHERE folder_id IN (SELECT id FROM subfolders)
        `).get(f.id);

        return {
            ...f,
            folder_path: getFolderPathFromDb(f.id),
            file_count: stats ? stats.file_count : 0,
            total_size: stats ? stats.total_size : 0
        };
    });

    res.json(foldersWithStats);
});

// Получить информацию о конкретной папке (включая цепочку breadcrumbs)
app.get('/api/folders/:id', (req, res) => {
    const folder = db.prepare('SELECT * FROM folders WHERE id = ?').get(req.params.id);
    if (!folder) {
        return res.status(404).json({ error: 'Folder not found' });
    }

    const breadcrumbs = [];
    let curId = folder.id;
    while (curId) {
        const cur = db.prepare('SELECT id, name, parent_id FROM folders WHERE id = ?').get(curId);
        if (!cur) break;
        breadcrumbs.unshift({ id: cur.id, name: cur.name });
        curId = cur.parent_id;
    }

    res.json({ ...folder, breadcrumbs });
});

// Получить полное дерево файлов в папке (рекурсивно) для прямого скачивания
app.get('/api/folders/:id/tree', (req, res) => {
    const folder = db.prepare('SELECT * FROM folders WHERE id = ?').get(req.params.id);
    if (!folder) {
        return res.status(404).json({ error: 'Folder not found' });
    }

    const files = [];
    function traverseUser(currentFolderId, currentRelDir) {
        const videos = db.prepare('SELECT id, filename, size, mime_type FROM videos WHERE folder_id = ?').all(currentFolderId);
        videos.sort((a, b) => naturalCompare(a.filename, b.filename));
        for (const v of videos) {
            const relPath = currentRelDir ? path.posix.join(currentRelDir, v.filename) : v.filename;
            files.push({
                id: v.id,
                filename: v.filename,
                relativePath: relPath,
                size: v.size,
                mime_type: v.mime_type,
                streamUrl: `/api/stream/${v.id}`
            });
        }

        const subfolders = db.prepare('SELECT id, name FROM folders WHERE parent_id = ?').all(currentFolderId);
        subfolders.sort((a, b) => naturalCompare(a.name, b.name));
        for (const sub of subfolders) {
            const subRelDir = currentRelDir ? path.posix.join(currentRelDir, sub.name) : sub.name;
            traverseUser(sub.id, subRelDir);
        }
    }

    traverseUser(folder.id, '');
    res.json({ folder, files });
});

// Скачать папку в виде ZIP-архива (для авторизованных пользователей)
app.get('/api/folders/:id/zip', (req, res) => {
    const folder = db.prepare('SELECT * FROM folders WHERE id = ?').get(req.params.id);
    if (!folder) {
        return res.status(404).json({ error: 'Folder not found' });
    }

    const files = [];
    function traverseUser(currentFolderId, currentRelDir) {
        const videos = db.prepare('SELECT id, filename, stored_name, size, mime_type FROM videos WHERE folder_id = ?').all(currentFolderId);
        videos.sort((a, b) => naturalCompare(a.filename, b.filename));
        for (const v of videos) {
            const relPath = currentRelDir ? path.posix.join(currentRelDir, v.filename) : v.filename;
            files.push({
                id: v.id,
                filename: v.filename,
                stored_name: v.stored_name,
                relativePath: relPath
            });
        }

        const subfolders = db.prepare('SELECT id, name FROM folders WHERE parent_id = ?').all(currentFolderId);
        subfolders.sort((a, b) => naturalCompare(a.name, b.name));
        for (const sub of subfolders) {
            const subRelDir = currentRelDir ? path.posix.join(currentRelDir, sub.name) : sub.name;
            traverseUser(sub.id, subRelDir);
        }
    }

    traverseUser(folder.id, '');

    const rawFolderName = folder.name || 'folder';
    const asciiName = rawFolderName.replace(/[^\w\s.-]/gi, '_').trim() || 'folder';
    const utf8Encoded = encodeURIComponent(rawFolderName);

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${asciiName}.zip"; filename*=UTF-8''${utf8Encoded}.zip`);

    const archive = createZipArchive({
        zlib: { level: 0 }
    });

    archive.on('error', (err) => {
        console.error('[Archive Error]', err);
        if (!res.headersSent) {
            res.status(500).json({ error: 'Failed to create archive' });
        } else {
            res.end();
        }
    });

    res.on('close', () => {
        archive.abort();
    });

    archive.pipe(res);

    for (const f of files) {
        const fullDiskPath = path.join(uploadsDir, f.stored_name);
        if (fs.existsSync(fullDiskPath)) {
            archive.file(fullDiskPath, { name: f.relativePath });
        }
    }

    archive.finalize();
});

// Создать папку
app.post('/api/folders', (req, res) => {
    const { name, parent_id } = req.body;
    if (!name) return res.status(400).json({ error: 'Folder name is required' });

    try {
        const parentId = parent_id ? parseInt(parent_id) : null;
        if (parentId) {
            const parent = db.prepare('SELECT id, uploader_username FROM folders WHERE id = ?').get(parentId);
            if (!parent) return res.status(404).json({ error: 'Parent folder not found' });
        }

        const info = db.prepare('INSERT INTO folders (name, parent_id, uploader_username) VALUES (?, ?, ?)')
            .run(name, parentId, req.user.username);
        const folderId = info.lastInsertRowid;

        // Создаем физическую папку на диске под пользователем
        const folderRelPath = getFolderPathFromDb(folderId);
        if (folderRelPath) {
            const diskPath = path.join(uploadsDir, req.user.username, folderRelPath);
            if (!fs.existsSync(diskPath)) {
                fs.mkdirSync(diskPath, { recursive: true });
            }
        }

        folderPathCache.clear();
        res.json({ id: folderId, name, parent_id: parentId, uploader_username: req.user.username });
    } catch (err) {
        res.status(500).json({ error: 'Failed to create folder' });
    }
});

// Переименовать папку
app.patch('/api/folders/:id', (req, res) => {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'Folder name is required' });

    const folder = db.prepare('SELECT * FROM folders WHERE id = ?').get(req.params.id);
    if (!folder) return res.status(404).json({ error: 'Folder not found' });

    if (req.user.username !== 'admin' && folder.uploader_username !== req.user.username) {
        return res.status(403).json({ error: 'Access denied' });
    }

    const uploader = folder.uploader_username || req.user.username;
    const oldRelPath = getFolderPathFromDb(folder.id);

    const result = db.prepare('UPDATE folders SET name = ? WHERE id = ?').run(name, req.params.id);
    if (result.changes === 0) return res.status(404).json({ error: 'Folder not found' });

    folderPathCache.clear();
    const newRelPath = getFolderPathFromDb(folder.id);

    // Переименовываем физическую папку на диске
    if (oldRelPath && newRelPath && oldRelPath !== newRelPath) {
        const oldDiskPath = path.join(uploadsDir, uploader, oldRelPath);
        const newDiskPath = path.join(uploadsDir, uploader, newRelPath);
        if (fs.existsSync(oldDiskPath)) {
            try {
                fs.mkdirSync(path.dirname(newDiskPath), { recursive: true });
                fs.renameSync(oldDiskPath, newDiskPath);
            } catch (err) {
                console.error('[Rename Folder Disk Error]', err);
            }
        }

        // Обновляем stored_name для всех видео внутри этой папки и её подпапок
        try {
            const affectedVideos = db.prepare(`
                WITH RECURSIVE subfolders(id) AS (
                    SELECT id FROM folders WHERE id = ?
                    UNION ALL
                    SELECT child.id FROM folders child JOIN subfolders s ON child.parent_id = s.id
                )
                SELECT id, stored_name, filename, folder_id, uploader_username FROM videos WHERE folder_id IN (SELECT id FROM subfolders)
            `).all(folder.id);

            for (const v of affectedVideos) {
                const vUploader = v.uploader_username || uploader;
                const vFolderRelPath = getFolderPathFromDb(v.folder_id);
                const newStoredName = vFolderRelPath
                    ? path.posix.join(vUploader, vFolderRelPath, v.filename)
                    : path.posix.join(vUploader, v.filename);
                db.prepare('UPDATE videos SET stored_name = ? WHERE id = ?').run(newStoredName, v.id);
            }
        } catch (err) {
            console.error('[Rename Folder Update Videos Error]', err);
        }
    }

    folderPathCache.clear();
    res.json({ success: true });
});

// Удалить папку (и всё её содержимое)
app.delete('/api/folders/:id', (req, res) => {
    const folderId = req.params.id;
    const folder = db.prepare('SELECT * FROM folders WHERE id = ?').get(folderId);
    if (!folder) {
        return res.status(404).json({ error: 'Folder not found' });
    }

    if (req.user.username !== 'admin' && folder.uploader_username !== req.user.username) {
        return res.status(403).json({ error: 'Access denied' });
    }

    const folderRelPath = getFolderPathFromDb(folderId);
    const uploader = folder.uploader_username || req.user.username;

    // Рекурсивный сбор и удаление всех видео в этой папке и подпапках
    function deleteFolderContent(fId) {
        const videos = db.prepare('SELECT * FROM videos WHERE folder_id = ?').all(fId);
        videos.forEach(video => {
            try {
                const ext = path.extname(video.stored_name);
                const baseName = video.stored_name.replace(ext, '');
                const filesToRemove = [
                    video.stored_name,
                    `${baseName}_1080p.mp4`,
                    `${baseName}_720p.mp4`,
                    `${baseName}_480p.mp4`,
                    `${baseName}_360p.mp4`,
                ];
                filesToRemove.forEach(f => {
                    const fp = path.join(uploadsDir, f);
                    if (fs.existsSync(fp)) fs.unlinkSync(fp);
                });

                const thumbFp = path.join(thumbsDir, `thumb_${video.id}.jpg`);
                if (fs.existsSync(thumbFp)) fs.unlinkSync(thumbFp);
            } catch (err) { }
        });

        // Получаем подпапки и рекурсивно удаляем их содержимое
        const subfolders = db.prepare('SELECT id FROM folders WHERE parent_id = ?').all(fId);
        subfolders.forEach(sub => deleteFolderContent(sub.id));
    }

    deleteFolderContent(folderId);

    // Удаляем физическую директорию на диске
    if (folderRelPath) {
        const diskPathsToCheck = [
            path.join(uploadsDir, uploader, folderRelPath)
        ];
        if (req.user && req.user.username && req.user.username !== uploader) {
            diskPathsToCheck.push(path.join(uploadsDir, req.user.username, folderRelPath));
        }

        diskPathsToCheck.forEach(dp => {
            if (fs.existsSync(dp)) {
                try {
                    fs.rmSync(dp, { recursive: true, force: true });
                } catch (err) {
                    console.error('[Delete Folder Disk Error]', err);
                }
            }
        });
    }

    // Удаляем саму папку (каскадное удаление в БД почистит всё остальное в таблицах)
    db.prepare('DELETE FROM folders WHERE id = ?').run(folderId);
    folderPathCache.clear();
    res.json({ success: true });
});

// Список видео в конкретной папке (или в корне)
app.get('/api/videos', (req, res) => {
    if (req.user) syncUserStorage(req.user.username);
    const folderId = req.query.folder_id ? parseInt(req.query.folder_id, 10) : null;
    const sortBy = req.query.sort_by || 'date';
    const order = (req.query.order || 'desc').toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
    const search = req.query.search ? req.query.search.trim() : (req.query.q ? req.query.q.trim() : '');
    const isRecursive = req.query.recursive === '1' || req.query.recursive === 'true' || search.length > 0;
    const searchLimit = search ? (parseInt(req.query.limit, 10) || 200) : (req.query.limit ? parseInt(req.query.limit, 10) : null);
    const limitClause = searchLimit ? `LIMIT ${searchLimit}` : '';

    let sortCol = 'created_at';
    if (sortBy === 'name') sortCol = 'filename';
    else if (sortBy === 'date') sortCol = 'created_at';
    else if (sortBy === 'size') sortCol = 'size';
    else if (sortBy === 'type') sortCol = 'mime_type';
    else if (sortBy === 'uploader') sortCol = 'uploader_username';

    let videos;
    if (search) {
        if (folderId) {
            videos = db.prepare(`
                WITH RECURSIVE subfolders(id) AS (
                    SELECT id FROM folders WHERE id = ?
                    UNION ALL
                    SELECT child.id FROM folders child JOIN subfolders s ON child.parent_id = s.id
                )
                SELECT * FROM videos 
                WHERE folder_id IN (SELECT id FROM subfolders)
                  AND contains_utf8(filename, ?)
                ORDER BY ${sortCol} ${order}
                ${limitClause}
            `).all(folderId, search);
        } else {
            videos = db.prepare(`
                SELECT * FROM videos 
                WHERE contains_utf8(filename, ?)
                ORDER BY ${sortCol} ${order}
                ${limitClause}
            `).all(search);
        }
    } else if (isRecursive) {
        if (folderId) {
            videos = db.prepare(`
                WITH RECURSIVE subfolders(id) AS (
                    SELECT id FROM folders WHERE id = ?
                    UNION ALL
                    SELECT child.id FROM folders child JOIN subfolders s ON child.parent_id = s.id
                )
                SELECT * FROM videos 
                WHERE folder_id IN (SELECT id FROM subfolders)
                ORDER BY ${sortCol} ${order}
            `).all(folderId);
        } else {
            videos = db.prepare(`
                SELECT * FROM videos 
                ORDER BY ${sortCol} ${order}
            `).all();
        }
    } else {
        if (folderId) {
            videos = db.prepare(`SELECT * FROM videos WHERE folder_id = ? ORDER BY ${sortCol} ${order}`).all(folderId);
        } else {
            videos = db.prepare(`SELECT * FROM videos WHERE folder_id IS NULL ORDER BY ${sortCol} ${order}`).all();
        }
    }

    const mult = order === 'ASC' ? 1 : -1;
    videos.sort((a, b) => {
        let diff = 0;
        if (sortBy === 'name') {
            diff = naturalCompare(a.filename, b.filename);
        } else if (sortBy === 'date') {
            diff = new Date(a.created_at || 0).getTime() - new Date(b.created_at || 0).getTime();
        } else if (sortBy === 'size') {
            diff = (a.size || 0) - (b.size || 0);
        } else if (sortBy === 'type') {
            diff = naturalCompare(a.mime_type, b.mime_type);
        } else if (sortBy === 'uploader') {
            diff = naturalCompare(a.uploader_username, b.uploader_username);
        }
        if (diff !== 0) return diff * mult;
        return naturalCompare(a.filename, b.filename) * mult;
    });

    const videosWithFolder = videos.map(v => ({
        ...v,
        folder_path: getFolderPathFromDb(v.folder_id)
    }));

    res.json(videosWithFolder);
});

// Массовая загрузка видео и папок
app.post('/api/upload', upload.array('files', MAX_FILE_COUNT), (req, res) => {
    if (!req.files || req.files.length === 0) {
        return res.status(400).json({ error: 'No files selected' });
    }

    const baseFolderId = req.body.folder_id ? parseInt(req.body.folder_id) : null;
    if (baseFolderId) {
        const baseFolder = db.prepare('SELECT id, uploader_username FROM folders WHERE id = ?').get(baseFolderId);
        if (!baseFolder) return res.status(404).json({ error: 'Target folder not found' });
    }
    const relativePaths = Array.isArray(req.body.relative_paths)
        ? req.body.relative_paths
        : (req.body.relative_paths ? [req.body.relative_paths] : []);

    const username = req.user.username;
    const results = [];

    try {
        req.files.forEach((file, index) => {
            const rawRelPath = (relativePaths[index] || file.originalname).replace(/\\/g, '/');
            const dirPart = path.posix.dirname(rawRelPath) === '.' ? '' : path.posix.dirname(rawRelPath);
            const targetFolderId = ensureFolderPath(username, dirPart, baseFolderId);

            const folderDbPath = getFolderPathFromDb(targetFolderId);
            const fileRelPath = (folderDbPath ? path.posix.join(username, folderDbPath, file.originalname) : path.posix.join(username, file.originalname)).replace(/\\/g, '/');
            const targetDiskPath = path.join(uploadsDir, fileRelPath);

            fs.mkdirSync(path.dirname(targetDiskPath), { recursive: true });
            fs.renameSync(file.path, targetDiskPath);

            const effectiveMimeType = (file.mimetype && (file.mimetype.startsWith('video/') || file.mimetype.startsWith('image/')))
                ? file.mimetype
                : getMimeType(file.originalname);

            const existingVideo = db.prepare('SELECT id FROM videos WHERE stored_name = ?').get(fileRelPath);
            let videoId;
            if (existingVideo) {
                db.prepare(`
                    UPDATE videos 
                    SET filename = ?, size = ?, mime_type = ?, uploader_username = ?, folder_id = ?, created_at = CURRENT_TIMESTAMP
                    WHERE id = ?
                `).run(file.originalname, file.size, effectiveMimeType, username, targetFolderId, existingVideo.id);
                videoId = existingVideo.id;
            } else {
                const info = db.prepare(`
                    INSERT INTO videos (filename, stored_name, size, mime_type, uploader_username, folder_id)
                    VALUES (?, ?, ?, ?, ?, ?)
                `).run(file.originalname, fileRelPath, file.size, effectiveMimeType, username, targetFolderId);
                videoId = info.lastInsertRowid;
            }

            generateThumbnailForMedia({ id: videoId, stored_name: fileRelPath, mime_type: effectiveMimeType });

            results.push({
                id: videoId,
                filename: file.originalname,
                stored_name: fileRelPath,
                size: file.size,
                mime_type: effectiveMimeType,
                uploader_username: username,
                folder_id: targetFolderId
            });

            if (effectiveMimeType.startsWith('video/')) {
                transcodeQueue.push({
                    input: targetDiskPath,
                    filename: file.originalname
                });
            }
        });

        processQueue();
        res.json({ uploaded: results });
    } catch (err) {
        console.error('[Upload Error]', err);
        res.status(500).json({ error: 'Storage error' });
    }
});

// Получить статус загрузки (для возобновления)
app.get('/api/upload/status', (req, res) => {
    const { uploadId } = req.query;
    if (!uploadId) return res.status(400).json({ error: 'uploadId is required' });

    const destPath = path.join(tempDir, uploadId);
    if (fs.existsSync(destPath)) {
        const stats = fs.statSync(destPath);
        return res.json({ offset: stats.size });
    }
    res.json({ offset: 0 });
});

const CHUNK_SIZE_VAL = 10 * 1024 * 1024; // 10MB optimal chunk size

// Чанковая загрузка (для больших файлов)
app.post('/api/upload/chunk', upload.single('chunk'), async (req, res) => {
    const { uploadId, chunkIndex, totalChunks, filename, folder_id, relativePath, mimeType, chunkSize: reqChunkSize, startOffset: reqStartOffset } = req.body;

    if (!req.file) {
        return res.status(400).json({ error: 'No chunk received' });
    }

    const chunkPath = req.file.path;
    const destPath = path.join(tempDir, uploadId);

    try {
        const chunkSize = parseInt(reqChunkSize) || CHUNK_SIZE_VAL;
        const chunkIndexNum = parseInt(chunkIndex);
        const totalChunksNum = parseInt(totalChunks);
        const startOffset = reqStartOffset !== undefined ? parseInt(reqStartOffset) : chunkIndexNum * chunkSize;

        if (chunkIndexNum === 0 && startOffset === 0) {
            if (fs.existsSync(destPath)) {
                fs.writeFileSync(destPath, '');
            } else {
                fs.closeSync(fs.openSync(destPath, 'w'));
            }
        } else if (!fs.existsSync(destPath)) {
            fs.closeSync(fs.openSync(destPath, 'w'));
        }

        // Асинхронная потоковая запись чанка
        await new Promise((resolvePipe, rejectPipe) => {
            const readStream = fs.createReadStream(chunkPath);
            const writeStream = fs.createWriteStream(destPath, {
                flags: 'r+',
                start: startOffset
            });
            readStream.pipe(writeStream);
            writeStream.on('finish', () => {
                resolvePipe();
            });
            writeStream.on('error', rejectPipe);
            readStream.on('error', rejectPipe);
        });

        try { fs.unlinkSync(chunkPath); } catch (e) {}

        const currentFileSize = fs.existsSync(destPath) ? fs.statSync(destPath).size : 0;

        if (chunkIndexNum === totalChunksNum - 1) {
            const username = req.user.username;
            const rawRelPath = (relativePath || filename).replace(/\\/g, '/');
            const dirPart = path.posix.dirname(rawRelPath) === '.' ? '' : path.posix.dirname(rawRelPath);
            const baseFolderId = folder_id ? parseInt(folder_id) : null;
            if (baseFolderId) {
                const baseFolder = db.prepare('SELECT id, uploader_username FROM folders WHERE id = ?').get(baseFolderId);
                if (!baseFolder) return res.status(404).json({ error: 'Target folder not found' });
            }
            const targetFolderId = ensureFolderPath(username, dirPart, baseFolderId);

            const folderDbPath = getFolderPathFromDb(targetFolderId);
            const fileRelPath = (folderDbPath ? path.posix.join(username, folderDbPath, filename) : path.posix.join(username, filename)).replace(/\\/g, '/');
            const finalDiskPath = path.join(uploadsDir, fileRelPath);

            fs.mkdirSync(path.dirname(finalDiskPath), { recursive: true });
            fs.renameSync(destPath, finalDiskPath);

            const finalStats = fs.statSync(finalDiskPath);

            const effectiveMimeType = (mimeType && (mimeType.startsWith('video/') || mimeType.startsWith('image/')))
                ? mimeType
                : getMimeType(filename);

            const existingVideo = db.prepare('SELECT id FROM videos WHERE stored_name = ?').get(fileRelPath);
            let videoId;
            if (existingVideo) {
                db.prepare(`
                    UPDATE videos 
                    SET filename = ?, size = ?, mime_type = ?, uploader_username = ?, folder_id = ?, created_at = CURRENT_TIMESTAMP
                    WHERE id = ?
                `).run(filename, finalStats.size, effectiveMimeType, username, targetFolderId, existingVideo.id);
                videoId = existingVideo.id;
            } else {
                const info = db.prepare(`
                    INSERT INTO videos (filename, stored_name, size, mime_type, uploader_username, folder_id)
                    VALUES (?, ?, ?, ?, ?, ?)
                `).run(filename, fileRelPath, finalStats.size, effectiveMimeType, username, targetFolderId);
                videoId = info.lastInsertRowid;
            }

            generateThumbnailForMedia({ id: videoId, stored_name: fileRelPath, mime_type: effectiveMimeType });

            const result = {
                id: videoId,
                filename: filename,
                stored_name: fileRelPath,
                size: finalStats.size,
                mime_type: effectiveMimeType,
                uploader_username: username,
                folder_id: targetFolderId
            };

            if (effectiveMimeType.startsWith('video/')) {
                transcodeQueue.push({
                    input: finalDiskPath,
                    filename: filename
                });
                processQueue();
            }

            res.json({ success: true, uploaded: [result] });
        } else {
            res.json({ success: true, message: 'Chunk received', offset: currentFileSize });
        }
    } catch (err) {
        try { if (fs.existsSync(chunkPath)) fs.unlinkSync(chunkPath); } catch (e) {}
        console.error('Chunk upload error:', err);
        res.status(500).json({ error: 'Failed to process chunk' });
    }
});

// Получить информацию о конкретном видео
app.get('/api/videos/:id', (req, res) => {
    const video = db.prepare('SELECT * FROM videos WHERE id = ?').get(req.params.id);
    if (!video) {
        return res.status(404).json({ error: 'Video not found' });
    }
    res.json(video);
});

// Удалить видео
app.delete('/api/videos/:id', (req, res) => {
    const video = db.prepare('SELECT * FROM videos WHERE id = ?').get(req.params.id);
    if (!video) {
        return res.status(404).json({ error: 'Video not found' });
    }
    if (req.user.username !== 'admin' && video.uploader_username !== req.user.username) {
        return res.status(403).json({ error: 'Access denied' });
    }

    // Удаляем файл с диска и его версии качества
    try {
        const ext = path.extname(video.stored_name);
        const baseName = video.stored_name.replace(ext, '');

        const filesToRemove = [
            video.stored_name,
            `${baseName}_1080p.mp4`,
            `${baseName}_720p.mp4`,
            `${baseName}_480p.mp4`,
            `${baseName}_360p.mp4`,
        ];

        filesToRemove.forEach(f => {
            const fp = path.join(uploadsDir, f);
            if (fs.existsSync(fp)) fs.unlinkSync(fp);
        });

        const thumbFp = path.join(thumbsDir, `thumb_${video.id}.jpg`);
        if (fs.existsSync(thumbFp)) fs.unlinkSync(thumbFp);
    } catch (err) {
        console.error('Ошибка удаления файла:', err);
    }

    db.prepare('DELETE FROM videos WHERE id = ?').run(req.params.id);
    res.json({ success: true });
});

// Переименовать видео
app.patch('/api/videos/:id', (req, res) => {
    const { filename } = req.body;
    if (!filename) {
        return res.status(400).json({ error: 'Filename is required' });
    }

    const video = db.prepare('SELECT * FROM videos WHERE id = ?').get(req.params.id);
    if (!video) {
        return res.status(404).json({ error: 'Video not found' });
    }
    if (req.user.username !== 'admin' && video.uploader_username !== req.user.username) {
        return res.status(403).json({ error: 'Access denied' });
    }

    const result = db.prepare('UPDATE videos SET filename = ? WHERE id = ?')
        .run(filename, req.params.id);

    if (result.changes === 0) {
        return res.status(404).json({ error: 'Video not found' });
    }
    res.json({ success: true });
});

// Вычисляем срок действия (по умолчанию 2 месяца от текущей даты)
function getDefaultExpirationDate() {
    const d = new Date();
    d.setMonth(d.getMonth() + 2);
    // Игнорируем миллисекунды для чистой записи, сохраняя как ISO string
    return d.toISOString();
}

// Создать/удалить публичную ссылку
app.post('/api/videos/:id/share', (req, res) => {
    const video = db.prepare('SELECT * FROM videos WHERE id = ?').get(req.params.id);
    if (!video) {
        return res.status(404).json({ error: 'Video not found' });
    }
    if (req.user.username !== 'admin' && video.uploader_username !== req.user.username) {
        return res.status(403).json({ error: 'Access denied' });
    }

    if (video.is_shared) {
        // Выключаем доступ, но сохраняем ID
        db.prepare('UPDATE videos SET is_shared = 0 WHERE id = ?').run(req.params.id);
        res.json({ share_id: null, is_shared: 0 });
    } else {
        // Включаем доступ
        let shareId = video.share_id;
        if (!shareId) {
            shareId = nanoid(10);
        }
        const expiresAt = video.share_expires_at || getDefaultExpirationDate();
        db.prepare('UPDATE videos SET share_id = ?, share_expires_at = ?, is_shared = 1 WHERE id = ?').run(shareId, expiresAt, req.params.id);
        res.json({ share_id: shareId, share_expires_at: expiresAt, is_shared: 1 });
    }
});

// Перегенерировать публичную ссылку
app.post('/api/videos/:id/share/regenerate', (req, res) => {
    const video = db.prepare('SELECT * FROM videos WHERE id = ?').get(req.params.id);
    if (!video) {
        return res.status(404).json({ error: 'Video not found' });
    }
    if (req.user.username !== 'admin' && video.uploader_username !== req.user.username) {
        return res.status(403).json({ error: 'Access denied' });
    }

    const shareId = nanoid(10);
    const expiresAt = video.share_expires_at || getDefaultExpirationDate();
    db.prepare('UPDATE videos SET share_id = ?, share_expires_at = ?, is_shared = 1 WHERE id = ?').run(shareId, expiresAt, req.params.id);
    res.json({ share_id: shareId, share_expires_at: expiresAt, is_shared: 1 });
});

// Изменить срок действия ссылки
app.patch('/api/videos/:id/share/expire', (req, res) => {
    const video = db.prepare('SELECT * FROM videos WHERE id = ?').get(req.params.id);
    if (!video) return res.status(404).json({ error: 'Video not found' });
    if (!video.share_id) return res.status(400).json({ error: 'Video is not shared' });
    if (req.user.username !== 'admin' && video.uploader_username !== req.user.username) {
        return res.status(403).json({ error: 'Access denied' });
    }

    const { expires_at } = req.body;
    if (!expires_at) return res.status(400).json({ error: 'expires_at is required' });

    db.prepare('UPDATE videos SET share_expires_at = ?, is_shared = 1 WHERE id = ?').run(expires_at, req.params.id);
    res.json({ success: true, share_expires_at: expires_at, is_shared: 1 });
});

// Стриминг видео по ID
app.get('/api/stream/:id', (req, res) => {
    const video = db.prepare('SELECT * FROM videos WHERE id = ?').get(req.params.id);
    if (!video) {
        return res.status(404).json({ error: 'Video not found' });
    }
    streamVideo(res, req, video);
});

// Превью/миниатюра видео или изображения по ID
app.get('/api/thumbnail/:id', async (req, res) => {
    const video = db.prepare('SELECT * FROM videos WHERE id = ?').get(req.params.id);
    if (!video) {
        return res.status(404).json({ error: 'Video not found' });
    }
    await serveThumbnail(res, req, video);
});

// Стриминг по публичной ссылке
app.get('/api/share/:shareId/stream', (req, res) => {
    const video = db.prepare('SELECT * FROM videos WHERE share_id = ? AND is_shared = 1').get(req.params.shareId);
    if (!video) {
        return res.status(404).json({ error: 'Video not found or not shared' });
    }
    if (video.share_expires_at && new Date() > new Date(video.share_expires_at)) {
        return res.status(403).json({ error: 'Link expired' });
    }
    streamVideo(res, req, video);
});

// Превью по публичной ссылке
app.get('/api/share/:shareId/thumbnail', async (req, res) => {
    const video = db.prepare('SELECT * FROM videos WHERE share_id = ? AND is_shared = 1').get(req.params.shareId);
    if (!video) {
        return res.status(404).json({ error: 'Video not found or not shared' });
    }
    if (video.share_expires_at && new Date() > new Date(video.share_expires_at)) {
        return res.status(403).json({ error: 'Link expired' });
    }
    await serveThumbnail(res, req, video);
});

// Получение доступных качеств видео
app.get('/api/videos/:id/qualities', (req, res) => {
    const video = db.prepare('SELECT * FROM videos WHERE id = ?').get(req.params.id);
    if (!video) return res.status(404).json({ error: 'Video not found' });
    if (!video.mime_type.startsWith('video/')) return res.json([]);

    const ext = path.extname(video.stored_name);
    const baseName = video.stored_name.replace(ext, '');
    const available = [{ label: 'Original', value: 'original' }];
    const qualities = ['1080p', '720p', '480p', '360p'];

    qualities.forEach(q => {
        if (fs.existsSync(path.join(uploadsDir, `${baseName}_${q}.mp4`))) {
            available.push({ label: q, value: q });
        }
    });
    res.json(available);
});

app.get('/api/share/:shareId/qualities', (req, res) => {
    const video = db.prepare('SELECT * FROM videos WHERE share_id = ? AND is_shared = 1').get(req.params.shareId);
    if (!video) return res.status(404).json({ error: 'Video not found or not shared' });
    if (video.share_expires_at && new Date() > new Date(video.share_expires_at)) {
        return res.status(403).json({ error: 'Link expired' });
    }
    if (!video.mime_type.startsWith('video/')) return res.json([]);

    const ext = path.extname(video.stored_name);
    const baseName = video.stored_name.replace(ext, '');
    const available = [{ label: 'Original', value: 'original' }];
    const qualities = ['1080p', '720p', '480p', '360p'];

    qualities.forEach(q => {
        if (fs.existsSync(path.join(uploadsDir, `${baseName}_${q}.mp4`))) {
            available.push({ label: q, value: q });
        }
    });
    res.json(available);
});

// Информация о публичном видео
app.get('/api/share/:shareId', (req, res) => {
    const video = db.prepare('SELECT id, filename, size, mime_type, created_at, share_expires_at FROM videos WHERE share_id = ? AND is_shared = 1')
        .get(req.params.shareId);
    if (!video) {
        return res.status(404).json({ error: 'Video not found' });
    }
    if (video.share_expires_at && new Date() > new Date(video.share_expires_at)) {
        return res.status(403).json({ error: 'Link expired' });
    }
    res.json(video);
});

// ==================== Шаринг папок ====================

// Создать/удалить публичную ссылку для папки
app.post('/api/folders/:id/share', (req, res) => {
    const folder = db.prepare('SELECT * FROM folders WHERE id = ?').get(req.params.id);
    if (!folder) {
        return res.status(404).json({ error: 'Folder not found' });
    }
    if (req.user.username !== 'admin' && folder.uploader_username !== req.user.username) {
        return res.status(403).json({ error: 'Access denied' });
    }

    if (folder.is_shared) {
        // Выключаем доступ, но сохраняем ID
        db.prepare('UPDATE folders SET is_shared = 0 WHERE id = ?').run(req.params.id);
        res.json({ share_id: null, is_shared: 0 });
    } else {
        // Включаем доступ
        let shareId = folder.share_id;
        if (!shareId) {
            shareId = nanoid(10);
        }
        const expiresAt = folder.share_expires_at || getDefaultExpirationDate();
        db.prepare('UPDATE folders SET share_id = ?, share_expires_at = ?, is_shared = 1 WHERE id = ?').run(shareId, expiresAt, req.params.id);
        res.json({ share_id: shareId, share_expires_at: expiresAt, is_shared: 1 });
    }
});

// Перегенерировать публичную ссылку для папки
app.post('/api/folders/:id/share/regenerate', (req, res) => {
    const folder = db.prepare('SELECT * FROM folders WHERE id = ?').get(req.params.id);
    if (!folder) {
        return res.status(404).json({ error: 'Folder not found' });
    }
    if (req.user.username !== 'admin' && folder.uploader_username !== req.user.username) {
        return res.status(403).json({ error: 'Access denied' });
    }

    const shareId = nanoid(10);
    const expiresAt = folder.share_expires_at || getDefaultExpirationDate();
    db.prepare('UPDATE folders SET share_id = ?, share_expires_at = ?, is_shared = 1 WHERE id = ?').run(shareId, expiresAt, req.params.id);
    res.json({ share_id: shareId, share_expires_at: expiresAt, is_shared: 1 });
});

// Изменить срок действия ссылки для папки
app.patch('/api/folders/:id/share/expire', (req, res) => {
    const folder = db.prepare('SELECT * FROM folders WHERE id = ?').get(req.params.id);
    if (!folder) return res.status(404).json({ error: 'Folder not found' });
    if (!folder.share_id) return res.status(400).json({ error: 'Folder is not shared' });
    if (req.user.username !== 'admin' && folder.uploader_username !== req.user.username) {
        return res.status(403).json({ error: 'Access denied' });
    }

    const { expires_at } = req.body;
    if (!expires_at) return res.status(400).json({ error: 'expires_at is required' });

    db.prepare('UPDATE folders SET share_expires_at = ?, is_shared = 1 WHERE id = ?').run(expires_at, req.params.id);
    res.json({ success: true, share_expires_at: expires_at, is_shared: 1 });
});

// Получить содержимое публичной папки
app.get('/api/share/folder/:shareId', (req, res) => {
    const rootFolder = db.prepare('SELECT * FROM folders WHERE share_id = ? AND is_shared = 1').get(req.params.shareId);
    if (!rootFolder) {
        return res.status(404).json({ error: 'Folder not found' });
    }
    if (rootFolder.share_expires_at && new Date() > new Date(rootFolder.share_expires_at)) {
        return res.status(403).json({ error: 'Link expired' });
    }

    const targetFolderId = req.query.subfolder_id || rootFolder.id;

    // Рекурсивный CTE для проверки, что requested_id находится внутри дерева shareId
    const isInsideTree = db.prepare(`
        WITH RECURSIVE folder_tree(id, parent_id) AS (
            SELECT id, parent_id FROM folders WHERE id = ?
            UNION ALL
            SELECT f.id, f.parent_id FROM folders f
            JOIN folder_tree ft ON f.parent_id = ft.id
        )
        SELECT 1 FROM folder_tree WHERE id = ?
    `).get(rootFolder.id, targetFolderId);

    if (!isInsideTree) {
        return res.status(403).json({ error: 'Access denied: folder is outside the shared tree' });
    }

    const targetFolder = db.prepare('SELECT id, name FROM folders WHERE id = ?').get(targetFolderId);
    const subfoldersRaw = db.prepare('SELECT id, name, created_at FROM folders WHERE parent_id = ?').all(targetFolderId);
    subfoldersRaw.sort((a, b) => naturalCompare(a.name, b.name));
    const subfolders = subfoldersRaw.map(sub => {
        const stats = db.prepare(`
            WITH RECURSIVE subfolders_tree(id) AS (
                SELECT id FROM folders WHERE id = ?
                UNION ALL
                SELECT child.id FROM folders child JOIN subfolders_tree s ON child.parent_id = s.id
            )
            SELECT COUNT(*) as file_count, COALESCE(SUM(size), 0) as total_size 
            FROM videos 
            WHERE folder_id IN (SELECT id FROM subfolders_tree)
        `).get(sub.id);

        return {
            ...sub,
            file_count: stats ? stats.file_count : 0,
            total_size: stats ? stats.total_size : 0
        };
    });
    const videos = db.prepare('SELECT id, filename, size, mime_type, created_at FROM videos WHERE folder_id = ?').all(targetFolderId);
    videos.sort((a, b) => naturalCompare(a.filename, b.filename));

    // Строим хлебные крошки от targetFolderId вверх до rootFolder
    const breadcrumbs = [];
    let currentId = targetFolderId;
    while (currentId !== rootFolder.id) {
        const cur = db.prepare('SELECT id, name, parent_id FROM folders WHERE id = ?').get(currentId);
        if (!cur) break;
        breadcrumbs.unshift({ id: cur.id, name: cur.name });
        currentId = cur.parent_id;
    }
    breadcrumbs.unshift({ id: rootFolder.id, name: rootFolder.name });

    res.json({ folder: targetFolder, subfolders, videos, breadcrumbs, share_expires_at: rootFolder.share_expires_at });
});

// Получить полное дерево файлов в публичной папке (рекурсивно) для прямого скачивания
app.get('/api/share/folder/:shareId/tree', (req, res) => {
    const rootFolder = db.prepare('SELECT * FROM folders WHERE share_id = ? AND is_shared = 1').get(req.params.shareId);
    if (!rootFolder) {
        return res.status(404).json({ error: 'Folder not found' });
    }
    if (rootFolder.share_expires_at && new Date() > new Date(rootFolder.share_expires_at)) {
        return res.status(403).json({ error: 'Link expired' });
    }

    const targetFolderId = req.query.subfolder_id ? parseInt(req.query.subfolder_id) : rootFolder.id;

    const isInsideTree = db.prepare(`
        WITH RECURSIVE folder_tree(id, parent_id) AS (
            SELECT id, parent_id FROM folders WHERE id = ?
            UNION ALL
            SELECT f.id, f.parent_id FROM folders f
            JOIN folder_tree ft ON f.parent_id = ft.id
        )
        SELECT 1 FROM folder_tree WHERE id = ?
    `).get(rootFolder.id, targetFolderId);

    if (!isInsideTree) {
        return res.status(403).json({ error: 'Access denied: folder is outside the shared tree' });
    }

    const targetFolder = db.prepare('SELECT id, name FROM folders WHERE id = ?').get(targetFolderId);
    const files = [];

    function traverseShared(currentFolderId, currentRelDir) {
        const videos = db.prepare('SELECT id, filename, size, mime_type FROM videos WHERE folder_id = ?').all(currentFolderId);
        videos.sort((a, b) => naturalCompare(a.filename, b.filename));
        for (const v of videos) {
            const relPath = currentRelDir ? path.posix.join(currentRelDir, v.filename) : v.filename;
            files.push({
                id: v.id,
                filename: v.filename,
                relativePath: relPath,
                size: v.size,
                mime_type: v.mime_type,
                streamUrl: `/api/share/folder/${rootFolder.share_id}/video/${v.id}/stream`
            });
        }

        const subfolders = db.prepare('SELECT id, name FROM folders WHERE parent_id = ?').all(currentFolderId);
        subfolders.sort((a, b) => naturalCompare(a.name, b.name));
        for (const sub of subfolders) {
            const subRelDir = currentRelDir ? path.posix.join(currentRelDir, sub.name) : sub.name;
            traverseShared(sub.id, subRelDir);
        }
    }

    traverseShared(targetFolderId, '');
    res.json({ folder: targetFolder, files });
});

// Скачать публичную папку в виде ZIP-архива
app.get('/api/share/folder/:shareId/zip', (req, res) => {
    const rootFolder = db.prepare('SELECT * FROM folders WHERE share_id = ? AND is_shared = 1').get(req.params.shareId);
    if (!rootFolder) {
        return res.status(404).json({ error: 'Folder not found or not shared' });
    }
    if (rootFolder.share_expires_at && new Date() > new Date(rootFolder.share_expires_at)) {
        return res.status(403).json({ error: 'Link expired' });
    }

    const targetFolderId = req.query.subfolder_id ? parseInt(req.query.subfolder_id) : rootFolder.id;

    const isInsideTree = db.prepare(`
        WITH RECURSIVE folder_tree(id, parent_id) AS (
            SELECT id, parent_id FROM folders WHERE id = ?
            UNION ALL
            SELECT f.id, f.parent_id FROM folders f
            JOIN folder_tree ft ON f.parent_id = ft.id
        )
        SELECT 1 FROM folder_tree WHERE id = ?
    `).get(rootFolder.id, targetFolderId);

    if (!isInsideTree) {
        return res.status(403).json({ error: 'Access denied: folder is outside the shared tree' });
    }

    const targetFolder = db.prepare('SELECT id, name FROM folders WHERE id = ?').get(targetFolderId);
    if (!targetFolder) {
        return res.status(404).json({ error: 'Folder not found' });
    }

    const files = [];
    function traverseShared(currentFolderId, currentRelDir) {
        const videos = db.prepare('SELECT id, filename, stored_name, size, mime_type FROM videos WHERE folder_id = ?').all(currentFolderId);
        videos.sort((a, b) => naturalCompare(a.filename, b.filename));
        for (const v of videos) {
            const relPath = currentRelDir ? path.posix.join(currentRelDir, v.filename) : v.filename;
            files.push({
                id: v.id,
                filename: v.filename,
                stored_name: v.stored_name,
                relativePath: relPath
            });
        }

        const subfolders = db.prepare('SELECT id, name FROM folders WHERE parent_id = ?').all(currentFolderId);
        subfolders.sort((a, b) => naturalCompare(a.name, b.name));
        for (const sub of subfolders) {
            const subRelDir = currentRelDir ? path.posix.join(currentRelDir, sub.name) : sub.name;
            traverseShared(sub.id, subRelDir);
        }
    }

    traverseShared(targetFolderId, '');

    const rawFolderName = targetFolder.name || 'folder';
    const asciiName = rawFolderName.replace(/[^\w\s.-]/gi, '_').trim() || 'folder';
    const utf8Encoded = encodeURIComponent(rawFolderName);

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${asciiName}.zip"; filename*=UTF-8''${utf8Encoded}.zip`);

    const archive = createZipArchive({
        zlib: { level: 0 }
    });

    archive.on('error', (err) => {
        console.error('[Archive Error]', err);
        if (!res.headersSent) {
            res.status(500).json({ error: 'Failed to create archive' });
        } else {
            res.end();
        }
    });

    res.on('close', () => {
        archive.abort();
    });

    archive.pipe(res);

    for (const f of files) {
        const fullDiskPath = path.join(uploadsDir, f.stored_name);
        if (fs.existsSync(fullDiskPath)) {
            archive.file(fullDiskPath, { name: f.relativePath });
        }
    }

    archive.finalize();
});

// Проверка права доступа к конкретному видео внутри публичной папки
function checkVideoInSharedFolder(shareId, videoId) {
    const rootFolder = db.prepare('SELECT * FROM folders WHERE share_id = ? AND is_shared = 1').get(shareId);
    if (!rootFolder) return { error: 'Folder not found', status: 404 };
    if (rootFolder.share_expires_at && new Date() > new Date(rootFolder.share_expires_at)) {
        return { error: 'Link expired', status: 403 };
    }

    const video = db.prepare('SELECT * FROM videos WHERE id = ?').get(videoId);
    if (!video) return { error: 'Video not found', status: 404 };

    if (!video.folder_id) return { error: 'Access denied', status: 403 };

    const isInsideTree = db.prepare(`
        WITH RECURSIVE folder_tree(id, parent_id) AS (
            SELECT id, parent_id FROM folders WHERE id = ?
            UNION ALL
            SELECT f.id, f.parent_id FROM folders f
            JOIN folder_tree ft ON f.parent_id = ft.id
        )
        SELECT 1 FROM folder_tree WHERE id = ?
    `).get(rootFolder.id, video.folder_id);

    if (!isInsideTree) {
        return { error: 'Access denied: video is outside the shared tree', status: 403 };
    }

    return { video, rootFolder };
}

// Получить информацию о публичном видео в папке
app.get('/api/share/folder/:shareId/video/:videoId', (req, res) => {
    const { video, rootFolder, error, status } = checkVideoInSharedFolder(req.params.shareId, req.params.videoId);
    if (error) return res.status(status).json({ error });

    const videosInFolder = db.prepare('SELECT id, filename FROM videos WHERE folder_id = ?').all(video.folder_id);
    videosInFolder.sort((a, b) => naturalCompare(a.filename, b.filename));
    const currentIndex = videosInFolder.findIndex(v => v.id === video.id);

    let prev_id = null;
    let next_id = null;

    if (currentIndex > 0) prev_id = videosInFolder[currentIndex - 1].id;
    if (currentIndex < videosInFolder.length - 1) next_id = videosInFolder[currentIndex + 1].id;

    res.json({
        id: video.id,
        filename: video.filename,
        size: video.size,
        mime_type: video.mime_type,
        created_at: video.created_at,
        share_expires_at: rootFolder.share_expires_at,
        prev_id,
        next_id
    });
});

// Получить качества публичного видео в папке
app.get('/api/share/folder/:shareId/video/:videoId/qualities', (req, res) => {
    const { video, error, status } = checkVideoInSharedFolder(req.params.shareId, req.params.videoId);
    if (error) return res.status(status).json({ error });
    if (!video.mime_type.startsWith('video/')) return res.json([]);

    const ext = path.extname(video.stored_name);
    const baseName = video.stored_name.replace(ext, '');
    const available = [{ label: 'Original', value: 'original' }];
    const qualities = ['1080p', '720p', '480p', '360p'];

    qualities.forEach(q => {
        if (fs.existsSync(path.join(uploadsDir, `${baseName}_${q}.mp4`))) {
            available.push({ label: q, value: q });
        }
    });
    res.json(available);
});

// Стриминг публичного видео из папки
app.get('/api/share/folder/:shareId/video/:videoId/stream', (req, res) => {
    const { video, error, status } = checkVideoInSharedFolder(req.params.shareId, req.params.videoId);
    if (error) return res.status(status).json({ error });

    streamVideo(res, req, video);
});

// Превью публичного видео из папки
app.get('/api/share/folder/:shareId/video/:videoId/thumbnail', async (req, res) => {
    const { video, error, status } = checkVideoInSharedFolder(req.params.shareId, req.params.videoId);
    if (error) return res.status(status).json({ error });

    await serveThumbnail(res, req, video);
});

// Публичная страница видео
app.get('/s/:shareId', (req, res) => {
    const video = db.prepare('SELECT * FROM videos WHERE share_id = ? AND is_shared = 1').get(req.params.shareId);
    if (!video) {
        return res.status(404).send('Video not found');
    }

    fs.readFile(path.join(__dirname, 'public', 'share.html'), 'utf8', (err, html) => {
        if (err) {
            console.error(err);
            return res.status(500).send('Server error');
        }

        const safeFilename = video.filename
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");

        const siteTitleSetting = db.prepare("SELECT value FROM settings WHERE key = 'site_title'").get();
        const siteTitle = siteTitleSetting ? siteTitleSetting.value : 'Provideo Media Holding';

        const customHtml = html.replace(
            '<title>File — Provideo Media Holding</title>',
            `<title>${safeFilename} — ${siteTitle}</title>\n    <meta property="og:title" content="${safeFilename}">\n    <meta property="og:site_name" content="${siteTitle}">`
        );

        res.send(customHtml);
    });
});

// Публичная страница папки
app.get('/s/f/:shareId', (req, res) => {
    const folder = db.prepare('SELECT * FROM folders WHERE share_id = ? AND is_shared = 1').get(req.params.shareId);
    if (!folder) {
        return res.status(404).send('Folder not found or not shared');
    }

    fs.readFile(path.join(__dirname, 'public', 'share-folder.html'), 'utf8', (err, html) => {
        if (err) {
            console.error(err);
            return res.status(500).send('Server error');
        }

        const safeFolderName = folder.name
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");

        const siteTitleSetting = db.prepare("SELECT value FROM settings WHERE key = 'site_title'").get();
        const siteTitle = siteTitleSetting ? siteTitleSetting.value : 'Provideo Media Holding';

        const customHtml = html.replace(
            '<title>Folder — Provideo Media Holding</title>',
            `<title>${safeFolderName} — ${siteTitle}</title>\n    <meta property="og:title" content="${safeFolderName}">\n    <meta property="og:site_name" content="${siteTitle}">`
        );

        res.send(customHtml);
    });
});

// Публичная страница видео внутри папки
app.get('/s/f/:shareId/v/:videoId', (req, res) => {
    // Проверяем, что папка расшарена
    const folder = db.prepare('SELECT * FROM folders WHERE share_id = ? AND is_shared = 1').get(req.params.shareId);
    if (!folder) {
        return res.status(404).send('Folder not found or not shared');
    }

    const video = db.prepare('SELECT * FROM videos WHERE id = ?').get(req.params.videoId);
    if (!video) {
        return res.status(404).send('Video not found');
    }

    fs.readFile(path.join(__dirname, 'public', 'share.html'), 'utf8', (err, html) => {
        if (err) {
            console.error(err);
            return res.status(500).send('Server error');
        }

        const safeFilename = video.filename
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");

        const siteTitleSetting = db.prepare("SELECT value FROM settings WHERE key = 'site_title'").get();
        const siteTitle = siteTitleSetting ? siteTitleSetting.value : 'Provideo Media Holding';

        const customHtml = html.replace(
            '<title>File — Provideo Media Holding</title>',
            `<title>${safeFilename} — ${siteTitle}</title>\n    <meta property="og:title" content="${safeFilename}">\n    <meta property="og:site_name" content="${siteTitle}">`
        );

        res.send(customHtml);
    });
});

// ==================== Стриминг ====================

function streamVideo(res, req, video) {
    let fileName = video.stored_name;
    const quality = req.query.q;

    if (quality && quality !== 'original' && video.mime_type.startsWith('video/')) {
        const ext = path.extname(video.stored_name);
        const baseName = fileName.replace(ext, '');
        const qualityName = `${baseName}_${quality}.mp4`;
        if (fs.existsSync(path.join(uploadsDir, qualityName))) {
            fileName = qualityName;
        }
    }

    const filePath = path.join(uploadsDir, fileName);

    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'File not found on disk' });
    }

    const mimeType = fileName !== video.stored_name ? 'video/mp4' : video.mime_type;
    const isDownload = req.query.download === '1' || req.query.dl === '1' || req.path.includes('/download');

    const headers = {
        'Content-Type': mimeType,
        'Access-Control-Allow-Origin': '*'
    };

    if (isDownload) {
        const rawName = video.filename || fileName;
        const asciiName = rawName.replace(/[^\x20-\x7E]/g, '_');
        const utf8Encoded = encodeURIComponent(rawName).replace(/['()]/g, escape).replace(/\*/g, '%2A');
        headers['Content-Disposition'] = `attachment; filename="${asciiName}"; filename*=UTF-8''${utf8Encoded}`;
    }

    res.sendFile(filePath, {
        acceptRanges: true,
        cacheControl: !isDownload,
        maxAge: isDownload ? 0 : '7d',
        headers
    }, (err) => {
        if (err && !res.headersSent) {
            console.error('[Stream Error]', err.message);
            res.status(err.status || 500).end();
        }
    });
}

function generateThumbnailForMedia(video) {
    if (!video || !video.id || !video.stored_name) return Promise.resolve(null);
    const inputPath = path.join(uploadsDir, video.stored_name);
    if (!fs.existsSync(inputPath)) return Promise.resolve(null);

    const thumbFilename = `thumb_${video.id}.jpg`;
    const thumbPath = path.join(thumbsDir, thumbFilename);

    // If thumbnail already exists and is non-empty, return it
    if (fs.existsSync(thumbPath)) {
        try {
            const stat = fs.statSync(thumbPath);
            if (stat.size > 0) return Promise.resolve(thumbPath);
            fs.unlinkSync(thumbPath);
        } catch (e) {}
    }

    // Deduplicate in-flight generation
    if (inFlightThumbnails.has(video.id)) {
        return inFlightThumbnails.get(video.id);
    }

    const isImage = video.mime_type && video.mime_type.startsWith('image/');
    const isVideo = video.mime_type && video.mime_type.startsWith('video/');

    if (!isImage && !isVideo) return Promise.resolve(null);

    const genPromise = new Promise((resolve) => {
        const tempFilename = `thumb_${video.id}.tmp_${Date.now()}_${nanoid(6)}.jpg`;
        const tempPath = path.join(thumbsDir, tempFilename);

        const cleanUpTemp = () => {
            try {
                if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
            } catch (e) {}
        };

        const tryFinalize = () => {
            if (fs.existsSync(tempPath)) {
                try {
                    const stat = fs.statSync(tempPath);
                    if (stat.size > 0) {
                        fs.renameSync(tempPath, thumbPath);
                        return thumbPath;
                    }
                } catch (e) {}
                cleanUpTemp();
            }
            return null;
        };

        const args = isImage
            ? ['-y', '-i', inputPath, '-vf', "scale='min(600,iw)':-2", '-q:v', '2', tempPath]
            : ['-y', '-ss', '00:00:01', '-i', inputPath, '-vframes', '1', '-vf', "scale='min(600,iw)':-2", '-q:v', '2', tempPath];

        const child = spawn('ffmpeg', args, { stdio: 'ignore' });
        const timer = setTimeout(() => {
            try { child.kill('SIGKILL'); } catch (e) {}
        }, 20000);

        child.on('close', (code) => {
            clearTimeout(timer);
            if (code === 0) {
                const finalThumb = tryFinalize();
                resolve(finalThumb);
            } else if (isVideo) {
                const fallbackArgs = ['-y', '-ss', '00:00:00', '-i', inputPath, '-vframes', '1', '-vf', "scale='min(600,iw)':-2", '-q:v', '2', tempPath];
                const fallbackChild = spawn('ffmpeg', fallbackArgs, { stdio: 'ignore' });
                const fallbackTimer = setTimeout(() => {
                    try { fallbackChild.kill('SIGKILL'); } catch (e) {}
                }, 20000);
                fallbackChild.on('close', (fCode) => {
                    clearTimeout(fallbackTimer);
                    const finalThumb = tryFinalize();
                    resolve(finalThumb);
                });
                fallbackChild.on('error', () => {
                    clearTimeout(fallbackTimer);
                    cleanUpTemp();
                    resolve(null);
                });
            } else {
                cleanUpTemp();
                resolve(null);
            }
        });

        child.on('error', (err) => {
            clearTimeout(timer);
            console.error(`[Thumbnail Spawn Error] video ${video.id}:`, err.message);
            cleanUpTemp();
            resolve(null);
        });
    }).finally(() => {
        inFlightThumbnails.delete(video.id);
    });

    inFlightThumbnails.set(video.id, genPromise);
    return genPromise;
}

function ensureAllThumbnails() {
    setImmediate(async () => {
        try {
            const videos = db.prepare('SELECT id, stored_name, mime_type FROM videos').all();
            const queue = [];
            for (const v of videos) {
                const thumbPath = path.join(thumbsDir, `thumb_${v.id}.jpg`);
                let needGen = true;
                if (fs.existsSync(thumbPath)) {
                    try {
                        const stat = fs.statSync(thumbPath);
                        if (stat.size > 0) needGen = false;
                    } catch (e) {}
                }
                if (needGen) {
                    queue.push(v);
                }
            }

            const concurrency = 4;
            let index = 0;
            async function worker() {
                while (index < queue.length) {
                    const item = queue[index++];
                    if (!item) break;
                    try {
                        await generateThumbnailForMedia(item);
                    } catch (e) {}
                }
            }
            await Promise.all(Array.from({ length: concurrency }, () => worker()));
        } catch (e) {
            console.error('[Thumbnail Background Error]', e);
        }
    });
}

async function getThumbnailPath(video) {
    if (!video || !video.stored_name) return null;
    const inputPath = path.join(uploadsDir, video.stored_name);
    if (!fs.existsSync(inputPath)) return null;

    const thumbFilename = `thumb_${video.id}.jpg`;
    const thumbPath = path.join(thumbsDir, thumbFilename);

    if (fs.existsSync(thumbPath)) {
        try {
            const stat = fs.statSync(thumbPath);
            if (stat.size > 0) return thumbPath;
            fs.unlinkSync(thumbPath);
        } catch (e) {}
    }

    const generatedPath = await generateThumbnailForMedia(video);
    if (generatedPath && fs.existsSync(generatedPath)) {
        return generatedPath;
    }

    if (video.mime_type && video.mime_type.startsWith('image/')) {
        return inputPath;
    }

    return null;
}

async function serveThumbnail(res, req, video) {
    if (!video) return res.status(404).json({ error: 'Video not found' });
    try {
        const thumbPath = await getThumbnailPath(video);
        if (thumbPath && fs.existsSync(thumbPath)) {
            const ext = path.extname(thumbPath).toLowerCase();
            let mimeType = 'image/jpeg';
            if (ext === '.png') mimeType = 'image/png';
            else if (ext === '.webp') mimeType = 'image/webp';
            else if (ext === '.gif') mimeType = 'image/gif';
            else if (video.mime_type && video.mime_type.startsWith('image/')) mimeType = video.mime_type;

            return res.sendFile(thumbPath, {
                acceptRanges: true,
                cacheControl: true,
                maxAge: '7d',
                headers: {
                    'Content-Type': mimeType,
                    'Access-Control-Allow-Origin': '*'
                }
            }, (err) => {
                if (err && !res.headersSent) {
                    res.status(err.status || 404).end();
                }
            });
        }
        res.status(404).json({ error: 'Thumbnail not found' });
    } catch (err) {
        console.error('[ServeThumbnail Error]', err);
        if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
    }
}

// Обработка ошибок multer
app.use((err, req, res, next) => {
    if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
            return res.status(413).json({ error: 'File is too large (max 2 GB)' });
        }
        return res.status(400).json({ error: err.message });
    }
    if (err) {
        return res.status(400).json({ error: err.message });
    }
    next();
});

app.listen(PORT, () => {
    console.log(`\n🎬 Provideo Media Holding запущен на http://localhost:${PORT}\n`);
});

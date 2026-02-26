const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { spawn, exec } = require('child_process');
const crypto = require('crypto');
const cookieParser = require('cookie-parser');
const { nanoid } = require('nanoid');
const bcrypt = require('bcrypt');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

// ==================== Авторизация ====================
const AUTH_SECRET = process.env.AUTH_SECRET || crypto.randomBytes(32).toString('hex');
const TOKEN_MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 7 дней

function generateToken(username) {
    const expires = Date.now() + TOKEN_MAX_AGE;
    const data = `auth:${username}:${expires}`;
    const hmac = crypto.createHmac('sha256', AUTH_SECRET).update(data).digest('hex');
    return `${username}.${expires}.${hmac}`;
}

function verifyToken(token) {
    if (!token) return false;
    const parts = token.split('.');
    if (parts.length !== 3) return false;
    const [username, expires, hmac] = parts;
    if (Date.now() > parseInt(expires)) return false;
    const expected = crypto.createHmac('sha256', AUTH_SECRET).update(`auth:${username}:${expires}`).digest('hex');
    const isValid = crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(expected));
    return isValid ? username : false;
}

// Создаём пользователя по умолчанию, если БД пуста
try {
    const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get().count;
    if (userCount === 0) {
        const defaultPassword = process.env.AUTH_PASSWORD || 'admin';
        const hash = bcrypt.hashSync(defaultPassword, 10);
        db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)')
            .run('admin', hash);
        console.log(`Создан пользователь по умолчанию: admin / ${process.env.AUTH_PASSWORD ? 'пароль из AUTH_PASSWORD' : 'admin'}`);
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
        pathname === '/api/settings' ||
        pathname.startsWith('/s/') ||
        pathname.startsWith('/api/share/') ||
        pathname === '/style.css' ||
        pathname === '/favicon.ico' ||
        pathname === '/app.js'
    );
}

// Создание папки uploads
const storagePath = process.env.STORAGE_PATH ? path.resolve(process.env.STORAGE_PATH) : __dirname;
const uploadsDir = path.join(storagePath, 'uploads');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}

// Настройка multer
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadsDir),
    filename: (req, file, cb) => {
        // Декодируем оригинальное имя файла для поддержки UTF-8 (кириллицы)
        file.originalname = Buffer.from(file.originalname, 'latin1').toString('utf8');

        const ext = path.extname(file.originalname);
        const storedName = nanoid(16) + ext;
        cb(null, storedName);
    }
});

const fileFilter = (req, file, cb) => {
    if (file.mimetype.startsWith('video/') || file.mimetype.startsWith('image/')) {
        cb(null, true);
    } else {
        cb(new Error('Only video and photo files are allowed'), false);
    }
};

const upload = multer({
    storage,
    fileFilter,
    limits: { fileSize: 150 * 1024 * 1024 * 1024 } // 150 GB
});

// ==================== Очередь перекодирования ====================
const transcodeQueue = [];
let isTranscoding = false;

function getOriginalResolution(filePath) {
    return new Promise((resolve) => {
        exec(`ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=s=x:p=0 "${filePath}"`, (err, stdout) => {
            if (err) return resolve(null);
            const [w, h] = stdout.trim().split('x').map(Number);
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
                '-preset', 'fast',
                '-crf', '28',
                '-c:a', 'aac',
                '-b:a', '128k',
                '-y', outputName
            ];

            const ffmpeg = spawn('ffmpeg', args);

            ffmpeg.on('close', (code) => {
                if (code === 0) {
                    console.log(`[FFmpeg] Успешно создано качество ${q}p для ${task.filename}`);
                } else {
                    console.error(`[FFmpeg] Ошибка создания ${q}p для ${task.filename}`);
                }
                processNextQuality(index + 1);
            });
        };

        processNextQuality(0);
    });
}

// Middleware
app.use(cookieParser());
app.use(express.json());

// Middleware авторизации
app.use((req, res, next) => {
    const token = req.cookies.auth_token;
    const username = verifyToken(token);
    if (username) {
        req.user = { username };
    }

    if (isPublicPath(req.path)) return next();

    if (req.user) return next();

    // Для API — 401, для страниц — скрываем страницу логина (отдаем 404)
    if (req.path.startsWith('/api/')) {
        return res.status(401).json({ error: 'Authorization required' });
    }
    return res.status(404).send('Not found');
});

// Статические файлы (после middleware авторизации)
app.use(express.static(path.join(__dirname, 'public')));

// Роут для страницы входа
app.get('/secure-admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'secure-admin.html')));

// ==================== Аутентификация ====================

app.get('/api/me', (req, res) => res.json({ username: req.user.username }));

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
        res.cookie('auth_token', token, {
            httpOnly: true,
            maxAge: TOKEN_MAX_AGE,
            sameSite: 'lax'
        });
        res.json({ success: true });
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

// Выход
app.post('/api/logout', (req, res) => {
    res.clearCookie('auth_token');
    res.json({ success: true });
});

// ==================== Настройки ====================

app.get('/api/settings', (req, res) => {
    const settings = {};
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

// Список всех папок (только для авторизованного пользователя)
app.get('/api/folders', (req, res) => {
    const parentId = req.query.parent_id || null;
    let folders;
    if (parentId) {
        folders = db.prepare('SELECT * FROM folders WHERE parent_id = ? ORDER BY name ASC').all(parentId);
    } else {
        folders = db.prepare('SELECT * FROM folders WHERE parent_id IS NULL ORDER BY name ASC').all();
    }
    // Так как у нас нет строгого ограничения на просмотр "чужих" папок (судя по `videos`),
    // но можно отфильтровать или просто отдаем все. 
    // Поскольку у нас загружаются и шарятся все видео вместе, папки тоже общие.
    res.json(folders);
});

// Создать папку
app.post('/api/folders', (req, res) => {
    const { name, parent_id } = req.body;
    if (!name) return res.status(400).json({ error: 'Folder name is required' });

    try {
        const info = db.prepare('INSERT INTO folders (name, parent_id, uploader_username) VALUES (?, ?, ?)')
            .run(name, parent_id || null, req.user.username);
        res.json({ id: info.lastInsertRowid, name, parent_id: parent_id || null, uploader_username: req.user.username });
    } catch (err) {
        res.status(500).json({ error: 'Failed to create folder' });
    }
});

// Переименовать папку
app.patch('/api/folders/:id', (req, res) => {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'Folder name is required' });

    const result = db.prepare('UPDATE folders SET name = ? WHERE id = ?').run(name, req.params.id);
    if (result.changes === 0) return res.status(404).json({ error: 'Folder not found' });
    res.json({ success: true });
});

// Удалить папку (и всё её содержимое)
// Поскольку PRAGMA foreign_keys = ON и мы настроили CASCADE для parent_id и folder_id,
// БД автоматически удалит вложенные папки и записи о видео. 
// НО нам нужно также удалить файлы с диска!
app.delete('/api/folders/:id', (req, res) => {
    // Рекурсивный сбор всех видео в этой папке и подпапках
    function deleteFolderContent(folderId) {
        // Получаем все видео в этой папке
        const videos = db.prepare('SELECT * FROM videos WHERE folder_id = ?').all(folderId);
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
            } catch (err) { }
        });

        // Получаем подпапки и рекурсивно удаляем их содержимое
        const subfolders = db.prepare('SELECT id FROM folders WHERE parent_id = ?').all(folderId);
        subfolders.forEach(sub => deleteFolderContent(sub.id));
    }

    deleteFolderContent(req.params.id);

    // Удаляем саму папку (каскадное удаление в БД почистит всё остальное в таблицах)
    db.prepare('DELETE FROM folders WHERE id = ?').run(req.params.id);
    res.json({ success: true });
});

// Список видео в конкретной папке (или в корне)
app.get('/api/videos', (req, res) => {
    const folderId = req.query.folder_id || null;
    let videos;
    if (folderId) {
        videos = db.prepare('SELECT * FROM videos WHERE folder_id = ? ORDER BY created_at DESC').all(folderId);
    } else {
        videos = db.prepare('SELECT * FROM videos WHERE folder_id IS NULL ORDER BY created_at DESC').all();
    }
    res.json(videos);
});

// Массовая загрузка видео
app.post('/api/upload', upload.array('files', 50), (req, res) => {
    if (!req.files || req.files.length === 0) {
        return res.status(400).json({ error: 'No files selected' });
    }

    const folderId = req.body.folder_id || null;

    const insert = db.prepare(`
    INSERT INTO videos (filename, stored_name, size, mime_type, uploader_username, folder_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

    const insertMany = db.transaction((files) => {
        const results = [];
        for (const file of files) {
            const info = insert.run(
                file.originalname,
                file.filename,
                file.size,
                file.mimetype,
                req.user.username,
                folderId
            );
            results.push({
                id: info.lastInsertRowid,
                filename: file.originalname,
                stored_name: file.filename,
                size: file.size,
                mime_type: file.mimetype,
                uploader_username: req.user.username,
                folder_id: folderId
            });
        }
        return results;
    });

    try {
        const results = insertMany(req.files);

        // Добавляем видео в очередь перекодирования
        req.files.forEach(file => {
            if (file.mimetype.startsWith('video/')) {
                transcodeQueue.push({
                    input: path.join(uploadsDir, file.filename),
                    filename: file.originalname
                });
            }
        });
        processQueue(); // Запускаем очередь, если она стоит

        res.json({ uploaded: results });
    } catch (err) {
        res.status(500).json({ error: 'Storage error' });
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

    if (video.share_id) {
        // Удаляем ссылку
        db.prepare('UPDATE videos SET share_id = NULL, share_expires_at = NULL WHERE id = ?').run(req.params.id);
        res.json({ share_id: null });
    } else {
        // Создаём ссылку
        const shareId = nanoid(10);
        const expiresAt = getDefaultExpirationDate();
        db.prepare('UPDATE videos SET share_id = ?, share_expires_at = ? WHERE id = ?').run(shareId, expiresAt, req.params.id);
        res.json({ share_id: shareId, share_expires_at: expiresAt });
    }
});

// Перегенерировать публичную ссылку
app.post('/api/videos/:id/share/regenerate', (req, res) => {
    const video = db.prepare('SELECT * FROM videos WHERE id = ?').get(req.params.id);
    if (!video) {
        return res.status(404).json({ error: 'Video not found' });
    }

    const shareId = nanoid(10);
    const expiresAt = getDefaultExpirationDate();
    db.prepare('UPDATE videos SET share_id = ?, share_expires_at = ? WHERE id = ?').run(shareId, expiresAt, req.params.id);
    res.json({ share_id: shareId, share_expires_at: expiresAt });
});

// Изменить срок действия ссылки
app.patch('/api/videos/:id/share/expire', (req, res) => {
    const video = db.prepare('SELECT * FROM videos WHERE id = ?').get(req.params.id);
    if (!video) return res.status(404).json({ error: 'Video not found' });
    if (!video.share_id) return res.status(400).json({ error: 'Video is not shared' });

    const { expires_at } = req.body;
    if (!expires_at) return res.status(400).json({ error: 'expires_at is required' });

    db.prepare('UPDATE videos SET share_expires_at = ? WHERE id = ?').run(expires_at, req.params.id);
    res.json({ success: true, share_expires_at: expires_at });
});

// Стриминг видео по ID
app.get('/api/stream/:id', (req, res) => {
    const video = db.prepare('SELECT * FROM videos WHERE id = ?').get(req.params.id);
    if (!video) {
        return res.status(404).json({ error: 'Video not found' });
    }
    streamVideo(res, req, video);
});

// Стриминг по публичной ссылке
app.get('/api/share/:shareId/stream', (req, res) => {
    const video = db.prepare('SELECT * FROM videos WHERE share_id = ?').get(req.params.shareId);
    if (!video) {
        return res.status(404).json({ error: 'Video not found' });
    }
    if (video.share_expires_at && new Date() > new Date(video.share_expires_at)) {
        return res.status(403).json({ error: 'Link expired' });
    }
    streamVideo(res, req, video);
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
    const video = db.prepare('SELECT * FROM videos WHERE share_id = ?').get(req.params.shareId);
    if (!video) return res.status(404).json({ error: 'Video not found' });
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
    const video = db.prepare('SELECT id, filename, size, mime_type, created_at, share_expires_at FROM videos WHERE share_id = ?')
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

    if (folder.share_id) {
        // Удаляем ссылку
        db.prepare('UPDATE folders SET share_id = NULL, share_expires_at = NULL WHERE id = ?').run(req.params.id);
        res.json({ share_id: null });
    } else {
        // Создаём ссылку
        const shareId = nanoid(10);
        const expiresAt = getDefaultExpirationDate();
        db.prepare('UPDATE folders SET share_id = ?, share_expires_at = ? WHERE id = ?').run(shareId, expiresAt, req.params.id);
        res.json({ share_id: shareId, share_expires_at: expiresAt });
    }
});

// Перегенерировать публичную ссылку для папки
app.post('/api/folders/:id/share/regenerate', (req, res) => {
    const folder = db.prepare('SELECT * FROM folders WHERE id = ?').get(req.params.id);
    if (!folder) {
        return res.status(404).json({ error: 'Folder not found' });
    }

    const shareId = nanoid(10);
    const expiresAt = getDefaultExpirationDate();
    db.prepare('UPDATE folders SET share_id = ?, share_expires_at = ? WHERE id = ?').run(shareId, expiresAt, req.params.id);
    res.json({ share_id: shareId, share_expires_at: expiresAt });
});

// Изменить срок действия ссылки для папки
app.patch('/api/folders/:id/share/expire', (req, res) => {
    const folder = db.prepare('SELECT * FROM folders WHERE id = ?').get(req.params.id);
    if (!folder) return res.status(404).json({ error: 'Folder not found' });
    if (!folder.share_id) return res.status(400).json({ error: 'Folder is not shared' });

    const { expires_at } = req.body;
    if (!expires_at) return res.status(400).json({ error: 'expires_at is required' });

    db.prepare('UPDATE folders SET share_expires_at = ? WHERE id = ?').run(expires_at, req.params.id);
    res.json({ success: true, share_expires_at: expires_at });
});

// Получить содержимое публичной папки
app.get('/api/share/folder/:shareId', (req, res) => {
    const rootFolder = db.prepare('SELECT * FROM folders WHERE share_id = ?').get(req.params.shareId);
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
    const subfolders = db.prepare('SELECT id, name, created_at FROM folders WHERE parent_id = ? ORDER BY name ASC').all(targetFolderId);
    const videos = db.prepare('SELECT id, filename, size, mime_type, created_at FROM videos WHERE folder_id = ? ORDER BY created_at DESC').all(targetFolderId);

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

    res.json({ folder: targetFolder, subfolders, videos, breadcrumbs });
});

// Проверка права доступа к конкретному видео внутри публичной папки
function checkVideoInSharedFolder(shareId, videoId) {
    const rootFolder = db.prepare('SELECT * FROM folders WHERE share_id = ?').get(shareId);
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
    const { video, error, status } = checkVideoInSharedFolder(req.params.shareId, req.params.videoId);
    if (error) return res.status(status).json({ error });

    const videosInFolder = db.prepare('SELECT id FROM videos WHERE folder_id = ? ORDER BY created_at DESC').all(video.folder_id);
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

// Публичная страница видео
app.get('/s/:shareId', (req, res) => {
    const video = db.prepare('SELECT * FROM videos WHERE share_id = ?').get(req.params.shareId);
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
    const folder = db.prepare('SELECT * FROM folders WHERE share_id = ?').get(req.params.shareId);
    if (!folder) {
        return res.status(404).send('Folder not found');
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

    const stat = fs.statSync(filePath);
    const fileSize = stat.size;
    const range = req.headers.range;
    const mimeType = fileName !== video.stored_name ? 'video/mp4' : video.mime_type;

    if (range) {
        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
        const chunkSize = end - start + 1;

        const stream = fs.createReadStream(filePath, { start, end });

        res.writeHead(206, {
            'Content-Range': `bytes ${start}-${end}/${fileSize}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': chunkSize,
            'Content-Type': mimeType,
        });

        stream.pipe(res);
    } else {
        res.writeHead(200, {
            'Content-Length': fileSize,
            'Content-Type': mimeType,
        });

        fs.createReadStream(filePath).pipe(res);
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

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
        pathname === '/login.html' ||
        pathname === '/api/login' ||
        pathname === '/api/register' ||
        pathname.startsWith('/s/') ||
        pathname.startsWith('/api/share/') ||
        pathname === '/style.css' ||
        pathname === '/favicon.ico'
    );
}

// Создание папки uploads
const uploadsDir = path.join(__dirname, 'uploads');
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
    limits: { fileSize: 2 * 1024 * 1024 * 1024 } // 2 GB
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
    if (isPublicPath(req.path)) return next();

    const token = req.cookies.auth_token;
    const username = verifyToken(token);
    if (username) {
        req.user = { username };
        return next();
    }

    // Для API — 401, для страниц — редирект на логин
    if (req.path.startsWith('/api/')) {
        return res.status(401).json({ error: 'Պահանջվում է թույլտվություն' });
    }
    return res.redirect('/login.html?redirect=' + encodeURIComponent(req.originalUrl));
});

// Статические файлы (после middleware авторизации)
app.use(express.static(path.join(__dirname, 'public')));

// ==================== Аутентификация ====================

app.get('/api/me', (req, res) => res.json({ username: req.user.username }));

// Логин
app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ error: 'Մուտքագրեք անունը և գաղտնաբառը' });
    }

    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (!user) {
        return res.status(401).json({ error: 'Սխալ անուն կամ գաղտնաբառ' });
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
        res.status(401).json({ error: 'Սխալ անուն կամ գաղտնաբառ' });
    }
});

// Регистрация
app.post('/api/register', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ error: 'Մուտքագրեք անունը և գաղտնաբառը' });
    }

    const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
    if (existing) {
        return res.status(400).json({ error: 'Այդ անունով օգտատեր արդեն գոյություն ունի' });
    }

    try {
        const hash = await bcrypt.hash(password, 10);
        db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(username, hash);

        const token = generateToken(username);
        res.cookie('auth_token', token, {
            httpOnly: true,
            maxAge: TOKEN_MAX_AGE,
            sameSite: 'lax'
        });
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Գրանցման սխալ' });
    }
});

// Выход
app.post('/api/logout', (req, res) => {
    res.clearCookie('auth_token');
    res.json({ success: true });
});

// ==================== API ====================

// Список всех видео
app.get('/api/videos', (req, res) => {
    const videos = db.prepare('SELECT * FROM videos ORDER BY created_at DESC').all();
    res.json(videos);
});

// Массовая загрузка видео
app.post('/api/upload', upload.array('files', 50), (req, res) => {
    if (!req.files || req.files.length === 0) {
        return res.status(400).json({ error: 'No files selected' });
    }

    const insert = db.prepare(`
    INSERT INTO videos (filename, stored_name, size, mime_type, uploader_username)
    VALUES (?, ?, ?, ?, ?)
  `);

    const insertMany = db.transaction((files) => {
        const results = [];
        for (const file of files) {
            const info = insert.run(
                file.originalname,
                file.filename,
                file.size,
                file.mimetype,
                req.user.username
            );
            results.push({
                id: info.lastInsertRowid,
                filename: file.originalname,
                stored_name: file.filename,
                size: file.size,
                mime_type: file.mimetype,
                uploader_username: req.user.username
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
        return res.status(404).json({ error: 'Վիդեոն չի գտնվել' });
    }
    res.json({ success: true });
});

// Создать/удалить публичную ссылку
app.post('/api/videos/:id/share', (req, res) => {
    const video = db.prepare('SELECT * FROM videos WHERE id = ?').get(req.params.id);
    if (!video) {
        return res.status(404).json({ error: 'Վիդեոն չի գտնվել' });
    }

    if (video.share_id) {
        // Удаляем ссылку
        db.prepare('UPDATE videos SET share_id = NULL WHERE id = ?').run(req.params.id);
        res.json({ share_id: null });
    } else {
        // Создаём ссылку
        const shareId = nanoid(10);
        db.prepare('UPDATE videos SET share_id = ? WHERE id = ?').run(shareId, req.params.id);
        res.json({ share_id: shareId });
    }
});

// Стриминг видео по ID
app.get('/api/stream/:id', (req, res) => {
    const video = db.prepare('SELECT * FROM videos WHERE id = ?').get(req.params.id);
    if (!video) {
        return res.status(404).json({ error: 'Վիդեոն չի գտնվել' });
    }
    streamVideo(res, req, video);
});

// Стриминг по публичной ссылке
app.get('/api/share/:shareId/stream', (req, res) => {
    const video = db.prepare('SELECT * FROM videos WHERE share_id = ?').get(req.params.shareId);
    if (!video) {
        return res.status(404).json({ error: 'Վիդեոն չի գտնվել' });
    }
    streamVideo(res, req, video);
});

// Получение доступных качеств видео
app.get('/api/videos/:id/qualities', (req, res) => {
    const video = db.prepare('SELECT * FROM videos WHERE id = ?').get(req.params.id);
    if (!video) return res.status(404).json({ error: 'Վիդեոն չի գտնվել' });
    if (!video.mime_type.startsWith('video/')) return res.json([]);

    const ext = path.extname(video.stored_name);
    const baseName = video.stored_name.replace(ext, '');
    const available = [{ label: 'Օրիգինալ', value: 'original' }];
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
    if (!video) return res.status(404).json({ error: 'Վիդեոն չի գտնվել' });
    if (!video.mime_type.startsWith('video/')) return res.json([]);

    const ext = path.extname(video.stored_name);
    const baseName = video.stored_name.replace(ext, '');
    const available = [{ label: 'Օրիգինալ', value: 'original' }];
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
    const video = db.prepare('SELECT id, filename, size, mime_type, created_at FROM videos WHERE share_id = ?')
        .get(req.params.shareId);
    if (!video) {
        return res.status(404).json({ error: 'Վիդեոն չի գտնվել' });
    }
    res.json(video);
});

// Публичная страница
app.get('/s/:shareId', (req, res) => {
    const video = db.prepare('SELECT * FROM videos WHERE share_id = ?').get(req.params.shareId);
    if (!video) {
        return res.status(404).send('Վիդեոն չի գտնվել');
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

        const customHtml = html.replace(
            '<title>File — Provideo Media Holding</title>',
            `<title>${safeFilename} — Provideo Media Holding</title>\n    <meta property="og:title" content="${safeFilename}">\n    <meta property="og:site_name" content="Provideo Media Holding">`
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

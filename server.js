const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const cookieParser = require('cookie-parser');
const { nanoid } = require('nanoid');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

// ==================== Авторизация ====================
const AUTH_PASSWORD = process.env.AUTH_PASSWORD || 'admin';
const AUTH_SECRET = process.env.AUTH_SECRET || crypto.randomBytes(32).toString('hex');
const TOKEN_MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 7 дней

function generateToken() {
    const expires = Date.now() + TOKEN_MAX_AGE;
    const data = `auth:${expires}`;
    const hmac = crypto.createHmac('sha256', AUTH_SECRET).update(data).digest('hex');
    return `${expires}.${hmac}`;
}

function verifyToken(token) {
    if (!token) return false;
    const parts = token.split('.');
    if (parts.length !== 2) return false;
    const [expires, hmac] = parts;
    if (Date.now() > parseInt(expires)) return false;
    const expected = crypto.createHmac('sha256', AUTH_SECRET).update(`auth:${expires}`).digest('hex');
    return crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(expected));
}

// Публичные пути (не требуют авторизации)
function isPublicPath(pathname) {
    return (
        pathname === '/login.html' ||
        pathname === '/api/login' ||
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
    if (file.mimetype.startsWith('video/')) {
        cb(null, true);
    } else {
        cb(new Error('Թույլատրվում են միայն վիդեո ֆայլեր'), false);
    }
};

const upload = multer({
    storage,
    fileFilter,
    limits: { fileSize: 2 * 1024 * 1024 * 1024 } // 2 GB
});

// Middleware
app.use(cookieParser());
app.use(express.json());

// Middleware авторизации
app.use((req, res, next) => {
    if (isPublicPath(req.path)) return next();

    const token = req.cookies.auth_token;
    if (verifyToken(token)) return next();

    // Для API — 401, для страниц — редирект на логин
    if (req.path.startsWith('/api/')) {
        return res.status(401).json({ error: 'Պահանջվում է թույլտվություն' });
    }
    return res.redirect('/login.html?redirect=' + encodeURIComponent(req.originalUrl));
});

// Статические файлы (после middleware авторизации)
app.use(express.static(path.join(__dirname, 'public')));

// ==================== Аутентификация ====================

// Логин
app.post('/api/login', (req, res) => {
    const { password } = req.body;
    if (password === AUTH_PASSWORD) {
        const token = generateToken();
        res.cookie('auth_token', token, {
            httpOnly: true,
            maxAge: TOKEN_MAX_AGE,
            sameSite: 'lax'
        });
        res.json({ success: true });
    } else {
        res.status(401).json({ error: 'Սխալ գաղտնաբառ' });
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
        return res.status(400).json({ error: 'Ֆայլեր ընտրված չեն' });
    }

    const insert = db.prepare(`
    INSERT INTO videos (filename, stored_name, size, mime_type)
    VALUES (?, ?, ?, ?)
  `);

    const insertMany = db.transaction((files) => {
        const results = [];
        for (const file of files) {
            const info = insert.run(
                file.originalname,
                file.filename,
                file.size,
                file.mimetype
            );
            results.push({
                id: info.lastInsertRowid,
                filename: file.originalname,
                stored_name: file.filename,
                size: file.size,
                mime_type: file.mimetype
            });
        }
        return results;
    });

    try {
        const results = insertMany(req.files);
        res.json({ uploaded: results });
    } catch (err) {
        res.status(500).json({ error: 'Պահպանման սխալ' });
    }
});

// Удалить видео
app.delete('/api/videos/:id', (req, res) => {
    const video = db.prepare('SELECT * FROM videos WHERE id = ?').get(req.params.id);
    if (!video) {
        return res.status(404).json({ error: 'Վիդեոն չի գտնվել' });
    }

    // Удаляем файл с диска
    const filePath = path.join(uploadsDir, video.stored_name);
    try {
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
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
        return res.status(400).json({ error: 'Ֆայլի անունը պարտադիր է' });
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
    res.sendFile(path.join(__dirname, 'public', 'share.html'));
});

// ==================== Стриминг ====================

function streamVideo(res, req, video) {
    const filePath = path.join(uploadsDir, video.stored_name);

    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'Ֆայլը սկավառակի վրա չի գտնվել' });
    }

    const stat = fs.statSync(filePath);
    const fileSize = stat.size;
    const range = req.headers.range;

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
            'Content-Type': video.mime_type,
        });

        stream.pipe(res);
    } else {
        res.writeHead(200, {
            'Content-Length': fileSize,
            'Content-Type': video.mime_type,
        });

        fs.createReadStream(filePath).pipe(res);
    }
}

// Обработка ошибок multer
app.use((err, req, res, next) => {
    if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
            return res.status(413).json({ error: 'Ֆայլը չափազանց մեծ է (առավելագույնը 2 ԳԲ)' });
        }
        return res.status(400).json({ error: err.message });
    }
    if (err) {
        return res.status(400).json({ error: err.message });
    }
    next();
});

app.listen(PORT, () => {
    console.log(`\n🎬 Media Storage запущен на http://localhost:${PORT}`);
    console.log(`🔒 Пароль: ${AUTH_PASSWORD}\n`);
});

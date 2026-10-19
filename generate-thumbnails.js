const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const db = require('./db');

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

const thumbsDir = path.join(uploadsDir, '.thumbs');

if (!fs.existsSync(thumbsDir)) {
    fs.mkdirSync(thumbsDir, { recursive: true });
}

const force = process.argv.includes('--force');
let concurrency = 8;
const concArg = process.argv.find(a => a.startsWith('--concurrency='));
if (concArg) {
    const val = parseInt(concArg.split('=')[1]);
    if (val > 0) concurrency = val;
}

async function runGenerator() {
    console.log('🖼️  Запуск генерации превью для медиа-файлов...');
    console.log(`📁 Директория хранилища: ${storagePath}`);
    console.log(`📁 Директория uploads:    ${uploadsDir}`);
    console.log(`📁 Директория .thumbs:    ${thumbsDir}`);
    console.log(`⚡ Параллельность:         ${concurrency} параллельных процессов\n`);

    const videos = db.prepare('SELECT id, filename, stored_name, mime_type FROM videos').all();
    const total = videos.length;
    console.log(`Найдено записей в базе данных: ${total}`);

    let createdCount = 0;
    let skippedCount = 0;
    let fileNotFoundCount = 0;
    let errorCount = 0;
    let processed = 0;

    const queue = [...videos];
    const startTime = Date.now();

    function processNext() {
        if (queue.length === 0) return Promise.resolve();

        const video = queue.shift();
        return new Promise((resolve) => {
            const inputPath = path.join(uploadsDir, video.stored_name);
            if (!fs.existsSync(inputPath)) {
                fileNotFoundCount++;
                processed++;
                resolve();
                return;
            }

            const thumbFilename = `thumb_${video.id}.jpg`;
            const thumbPath = path.join(thumbsDir, thumbFilename);

            if (fs.existsSync(thumbPath) && !force) {
                try {
                    const stat = fs.statSync(thumbPath);
                    if (stat.size > 0) {
                        skippedCount++;
                        processed++;
                        resolve();
                        return;
                    }
                    fs.unlinkSync(thumbPath);
                } catch (e) {}
            }

            const tempFilename = `thumb_${video.id}.tmp_${Date.now()}_${Math.random().toString(36).substring(2, 8)}.jpg`;
            const tempPath = path.join(thumbsDir, tempFilename);

            const cleanUpTemp = () => {
                try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch (e) {}
            };

            const tryFinalize = () => {
                if (fs.existsSync(tempPath)) {
                    try {
                        const stat = fs.statSync(tempPath);
                        if (stat.size > 0) {
                            fs.renameSync(tempPath, thumbPath);
                            return true;
                        }
                    } catch (e) {}
                    cleanUpTemp();
                }
                return false;
            };

            let args = [];
            if (video.mime_type && video.mime_type.startsWith('image/')) {
                args = ['-y', '-i', inputPath, '-vf', "scale='min(600,iw)':-2", '-q:v', '2', tempPath];
            } else if (video.mime_type && video.mime_type.startsWith('video/')) {
                args = ['-y', '-ss', '00:00:01', '-i', inputPath, '-vframes', '1', '-vf', "scale='min(600,iw)':-2", '-q:v', '2', tempPath];
            } else {
                skippedCount++;
                processed++;
                resolve();
                return;
            }

            const { spawn } = require('child_process');
            const child = spawn('ffmpeg', args, { stdio: 'ignore' });
            let finished = false;
            const timer = setTimeout(() => {
                try { child.kill('SIGKILL'); } catch (e) {}
            }, 20000);

            const handleFinish = (code) => {
                if (finished) return;
                finished = true;
                clearTimeout(timer);
                if (code === 0 && tryFinalize()) {
                    createdCount++;
                    processed++;
                    logProgress();
                    resolve();
                } else if (video.mime_type.startsWith('video/')) {
                    const fallbackArgs = ['-y', '-ss', '00:00:00', '-i', inputPath, '-vframes', '1', '-vf', "scale='min(600,iw)':-2", '-q:v', '2', tempPath];
                    const fallbackChild = spawn('ffmpeg', fallbackArgs, { stdio: 'ignore' });
                    const fallbackTimer = setTimeout(() => {
                        try { fallbackChild.kill('SIGKILL'); } catch (e) {}
                    }, 20000);
                    fallbackChild.on('close', (fCode) => {
                        clearTimeout(fallbackTimer);
                        if (fCode === 0 && tryFinalize()) {
                            createdCount++;
                        } else {
                            cleanUpTemp();
                            errorCount++;
                        }
                        processed++;
                        logProgress();
                        resolve();
                    });
                    fallbackChild.on('error', () => {
                        clearTimeout(fallbackTimer);
                        cleanUpTemp();
                        errorCount++;
                        processed++;
                        logProgress();
                        resolve();
                    });
                } else {
                    cleanUpTemp();
                    errorCount++;
                    processed++;
                    logProgress();
                    resolve();
                }
            };

            child.on('close', handleFinish);
            child.on('error', () => handleFinish(1));
        }).then(() => processNext());
    }

    let lastLogTime = 0;
    function logProgress() {
        const now = Date.now();
        if (now - lastLogTime < 500 && processed < total) return;
        lastLogTime = now;

        const percent = ((processed / total) * 100).toFixed(1);
        const elapsed = ((now - startTime) / 1000).toFixed(1);
        const speed = (processed / (elapsed || 1)).toFixed(1);
        process.stdout.write(`\r[⏳ Прогресс] ${processed}/${total} (${percent}%) | Создано: ${createdCount} | Уже есть: ${skippedCount} | Не найдено: ${fileNotFoundCount} | Ошибок: ${errorCount} | Ск: ${speed} шт/сек `);
    }

    const workers = [];
    for (let i = 0; i < concurrency; i++) {
        workers.push(processNext());
    }

    await Promise.all(workers);
    process.stdout.write('\n');

    const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log('\n========================================');
    console.log(`🎉 Завершено за ${totalTime} сек!`);
    console.log(`Всего файлов: ${total}`);
    console.log(`Создано превью: ${createdCount}`);
    console.log(`Пропущено (уже созданы): ${skippedCount}`);
    console.log(`Не найдено исходных файлов: ${fileNotFoundCount}`);
    console.log(`Ошибок создания: ${errorCount}`);
    console.log('========================================\n');
}

runGenerator();

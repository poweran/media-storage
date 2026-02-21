// ============================
// Утилиты
// ============================
function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' Б';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' КБ';
    if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' МБ';
    return (bytes / 1073741824).toFixed(2) + ' ГБ';
}

function showToast(message, type = 'success') {
    const container = document.getElementById('toastContainer');
    const toast = document.createElement('div');
    toast.className = 'toast ' + type;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
}

// ============================
// Загрузка видео (Upload)
// ============================
const uploadZone = document.getElementById('uploadZone');
const fileInput = document.getElementById('fileInput');
const progressContainer = document.getElementById('progressContainer');
const progressFill = document.getElementById('progressFill');
const progressText = document.getElementById('progressText');
const progressPercent = document.getElementById('progressPercent');

if (uploadZone) {
    // Drag & Drop
    ['dragenter', 'dragover'].forEach(event => {
        uploadZone.addEventListener(event, (e) => {
            e.preventDefault();
            uploadZone.classList.add('dragover');
        });
    });

    ['dragleave', 'drop'].forEach(event => {
        uploadZone.addEventListener(event, (e) => {
            e.preventDefault();
            uploadZone.classList.remove('dragover');
        });
    });

    uploadZone.addEventListener('drop', (e) => {
        const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('video/'));
        if (files.length > 0) uploadFiles(files);
        else showToast('Թույլատրվում են միայն վիդեո ֆայլեր', 'error');
    });

    // Клик на зону загрузки тоже открывает выбор файлов
    uploadZone.addEventListener('click', (e) => {
        if (e.target.tagName !== 'LABEL' && e.target.tagName !== 'INPUT') {
            fileInput.click();
        }
    });

    fileInput.addEventListener('change', () => {
        if (fileInput.files.length > 0) {
            uploadFiles(Array.from(fileInput.files));
        }
    });
}

function uploadFiles(files) {
    const formData = new FormData();
    files.forEach(file => formData.append('files', file));

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload');

    // Показать прогресс
    progressContainer.style.display = 'block';
    progressText.textContent = `Բեռնվում է ${files.length} ֆայլ...`;

    xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable) {
            const percent = Math.round((e.loaded / e.total) * 100);
            progressFill.style.width = percent + '%';
            progressPercent.textContent = percent + '%';
            progressText.textContent = `Բեռնվում է ${files.length} ֆայլ... (${formatSize(e.loaded)} / ${formatSize(e.total)})`;
        }
    });

    xhr.addEventListener('load', () => {
        if (xhr.status === 200) {
            const data = JSON.parse(xhr.responseText);
            showToast(`Բեռնվել է ${data.uploaded.length} ֆայլ`);
            loadVideos();
        } else {
            try {
                const err = JSON.parse(xhr.responseText);
                showToast(err.error || 'Բեռնման սխալ', 'error');
            } catch {
                showToast('Բեռնման սխալ', 'error');
            }
        }

        // Скрыть прогресс через 1.5 сек
        setTimeout(() => {
            progressContainer.style.display = 'none';
            progressFill.style.width = '0%';
        }, 1500);

        fileInput.value = '';
    });

    xhr.addEventListener('error', () => {
        showToast('Ցանցի սխալ', 'error');
        progressContainer.style.display = 'none';
        fileInput.value = '';
    });

    xhr.send(formData);
}

// ============================
// Список видео
// ============================
const videosGrid = document.getElementById('videosGrid');
const emptyState = document.getElementById('emptyState');
const videosCount = document.getElementById('videosCount');
const headerStats = document.getElementById('headerStats');

async function loadVideos() {
    if (!videosGrid) return;

    try {
        const res = await fetch('/api/videos');
        const videos = await res.json();

        if (videos.length === 0) {
            videosGrid.style.display = 'none';
            emptyState.style.display = 'block';
            videosCount.textContent = '';
            if (headerStats) headerStats.innerHTML = '';
            return;
        }

        videosGrid.style.display = 'grid';
        emptyState.style.display = 'none';
        videosCount.textContent = `${videos.length} վիդեո`;

        // Статистика в хедере
        const totalSize = videos.reduce((sum, v) => sum + v.size, 0);
        if (headerStats) {
            headerStats.innerHTML = `
        <span>${videos.length} ֆայլ</span>
        <span>${formatSize(totalSize)}</span>
      `;
        }

        videosGrid.innerHTML = videos.map(video => `
      <div class="video-card" data-id="${video.id}">
        <div class="video-thumb" onclick="playVideo(${video.id})">
          <div class="play-icon">
            <svg viewBox="0 0 24 24" fill="currentColor" stroke="none">
              <polygon points="5 3 19 12 5 21 5 3"/>
            </svg>
          </div>
        </div>
        <div class="video-info">
          <div class="video-name" title="${escapeHtml(video.filename)}">${escapeHtml(video.filename)}</div>
          <div class="video-meta">
            <span>${formatSize(video.size)}</span>
            <span>${new Date(video.created_at).toLocaleDateString('hy-AM')}</span>
          </div>
        </div>
        <div class="video-actions">
          <button class="icon-btn ${video.share_id ? 'shared' : ''}" onclick="toggleShare(${video.id})" title="${video.share_id ? 'Հեռացնել հղումը' : 'Կիսվել'}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
              <circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/>
              <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/>
              <line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>
            </svg>
            ${video.share_id ? 'Հղում' : 'Կիսվել'}
          </button>
          <button class="icon-btn" onclick="openRenameModal(${video.id}, '${escapeJs(video.filename)}')" title="Անվանափոխել">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
            </svg>
          </button>
          <div class="btn-spacer"></div>
          <button class="icon-btn danger" onclick="deleteVideo(${video.id}, '${escapeJs(video.filename)}')" title="Ջնջել">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
              <polyline points="3 6 5 6 21 6"/>
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
            </svg>
          </button>
        </div>
      </div>
    `).join('');

    } catch (err) {
        console.error('Ցուցակի բեռնման սխալ.', err);
    }
}

// ============================
// Действия с видео
// ============================
function playVideo(id) {
    window.location.href = '/player.html?id=' + id;
}

async function toggleShare(id) {
    try {
        const res = await fetch(`/api/videos/${id}/share`, { method: 'POST' });
        const data = await res.json();

        if (data.share_id) {
            const url = window.location.origin + '/s/' + data.share_id;
            try {
                await navigator.clipboard.writeText(url);
                showToast('Հղումը պատճենվեց սեղմատախտակի մեջ։');
            } catch {
                // Fallback: показать ссылку
                prompt('Հանրային հղում․', url);
            }
        } else {
            showToast('Հանրային հղումը հեռացված է');
        }

        loadVideos();
    } catch (err) {
        showToast('Սխալ', 'error');
    }
}

async function deleteVideo(id, filename) {
    if (!confirm(`Ջնջե՞լ "${filename}"։`)) return;

    try {
        const res = await fetch(`/api/videos/${id}`, { method: 'DELETE' });
        if (res.ok) {
            showToast('Վիդեոն ջնջված է');
            loadVideos();
        } else {
            showToast('Ջնջման սխալ', 'error');
        }
    } catch (err) {
        showToast('Ցանցի սխալ', 'error');
    }
}

// ============================
// Переименование
// ============================
let renameVideoId = null;

function openRenameModal(id, currentName) {
    renameVideoId = id;
    const modal = document.getElementById('renameModal');
    const input = document.getElementById('renameInput');
    modal.style.display = 'flex';
    input.value = currentName;
    input.focus();
    input.select();
}

function closeRenameModal() {
    document.getElementById('renameModal').style.display = 'none';
    renameVideoId = null;
}

async function confirmRename() {
    const input = document.getElementById('renameInput');
    const newName = input.value.trim();

    if (!newName) {
        showToast('Անունը չի կարող դատարկ լինել', 'error');
        return;
    }

    try {
        const res = await fetch(`/api/videos/${renameVideoId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filename: newName })
        });

        if (res.ok) {
            showToast('Անվանափոխված է');
            closeRenameModal();
            loadVideos();
        } else {
            showToast('Սխալ', 'error');
        }
    } catch (err) {
        showToast('Ցանցի սխալ', 'error');
    }
}

// Enter для подтверждения переименования
const renameInput = document.getElementById('renameInput');
if (renameInput) {
    renameInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') confirmRename();
        if (e.key === 'Escape') closeRenameModal();
    });
}

// Закрытие модалки по клику на оверлей
const renameModal = document.getElementById('renameModal');
if (renameModal) {
    renameModal.addEventListener('click', (e) => {
        if (e.target === renameModal) closeRenameModal();
    });
}

// ============================
// Helpers
// ============================
function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function escapeJs(str) {
    return str.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '\\"');
}

// ============================
// Выход
// ============================
async function logout() {
    await fetch('/api/logout', { method: 'POST' });
    window.location.href = '/login.html';
}

// ============================
// Инициализация
// ============================
if (videosGrid) {
    loadVideos();
}

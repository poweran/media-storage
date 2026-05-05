// ============================
// Утилиты
// ============================
function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
    return (bytes / 1073741824).toFixed(2) + ' GB';
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
        const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('video/') || f.type.startsWith('image/'));
        if (files.length > 0) uploadFiles(files);
        else showToast('Only video and photo files are allowed', 'error');
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

// ============================
// Состояние папок
// ============================
let currentFolderId = null;
let pathHistory = [];

function navigateTo(folderId, folderName) {
    if (folderId === null) {
        currentFolderId = null;
        pathHistory = [];
    } else {
        const idx = pathHistory.findIndex(p => p.id === folderId);
        if (idx !== -1) {
            pathHistory = pathHistory.slice(0, idx + 1);
        } else {
            pathHistory.push({ id: folderId, name: folderName });
        }
        currentFolderId = folderId;
    }
    updateBreadcrumbs();
    loadVideos();
}

function updateBreadcrumbs() {
    const bc = document.getElementById('breadcrumbs');
    if (!bc) return;
    let html = `<span class="crumb ${currentFolderId === null ? 'active' : ''}" onclick="navigateTo(null, 'Root')">Root</span>`;
    pathHistory.forEach((p, idx) => {
        const isActive = idx === pathHistory.length - 1;
        html += `<span class="crumb ${isActive ? 'active' : ''}" onclick="navigateTo(${p.id}, '${escapeJs(p.name)}')">${escapeHtml(p.name)}</span>`;
    });
    bc.innerHTML = html;
}

function uploadFiles(files) {
    const formData = new FormData();
    files.forEach(file => formData.append('files', file));
    if (currentFolderId) {
        formData.append('folder_id', currentFolderId);
    }

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload');

    // Показать прогресс
    progressContainer.style.display = 'block';
    progressText.textContent = `Uploading ${files.length} files...`;

    xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable) {
            const percent = Math.round((e.loaded / e.total) * 100);
            progressFill.style.width = percent + '%';
            progressPercent.textContent = percent + '%';
            progressText.textContent = `Uploading ${files.length} files... (${formatSize(e.loaded)} / ${formatSize(e.total)})`;
        }
    });

    xhr.addEventListener('load', () => {
        if (xhr.status === 200) {
            const data = JSON.parse(xhr.responseText);
            showToast(`Uploaded ${data.uploaded.length} files`);
            loadVideos();
        } else {
            try {
                const err = JSON.parse(xhr.responseText);
                showToast(err.error || 'Upload error', 'error');
            } catch {
                showToast('Upload error', 'error');
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
        showToast('Network error', 'error');
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
const searchInput = document.getElementById('searchInput');

let currentSearchQuery = '';
if (searchInput) {
    searchInput.addEventListener('input', (e) => {
        currentSearchQuery = e.target.value.toLowerCase().trim();
        loadVideos();
    });
}

async function loadVideos() {
    if (!videosGrid) return;

    try {
        const query = currentFolderId ? `?folder_id=${currentFolderId}` : '';
        const parentQuery = currentFolderId ? `?parent_id=${currentFolderId}` : '';

        const [resVideos, resFolders] = await Promise.all([
            fetch('/api/videos' + query),
            fetch('/api/folders' + parentQuery)
        ]);

        let videos = await resVideos.json();
        let folders = await resFolders.json();

        if (typeof currentSearchQuery !== 'undefined' && currentSearchQuery) {
            videos = videos.filter(v => v.filename && v.filename.toLowerCase().includes(currentSearchQuery));
            folders = folders.filter(f => f.name && f.name.toLowerCase().includes(currentSearchQuery));
        }

        if (videos.length === 0 && folders.length === 0) {
            videosGrid.style.display = 'none';
            emptyState.style.display = 'block';
            videosCount.textContent = '';
            if (headerStats) headerStats.innerHTML = '';
            return;
        }

        videosGrid.style.display = 'grid';
        emptyState.style.display = 'none';

        const totalItems = folders.length + videos.length;
        videosCount.textContent = `${totalItems} items`;

        // Статистика в хедере
        const totalSize = videos.reduce((sum, v) => sum + v.size, 0);
        if (headerStats) {
            headerStats.innerHTML = `
        <span>${totalItems} items</span>
        <span>${formatSize(totalSize)}</span>
      `;
        }

        let html = '';

        // Рендерим папки
        html += folders.map(folder => {
            let expireTag = '';
            if (folder.share_id && folder.share_expires_at) {
                const expDate = new Date(folder.share_expires_at);
                const now = new Date();
                const diffMs = expDate - now;
                const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

                if (diffMs < 0) {
                    expireTag = `<span style="color: var(--danger); font-weight: 600;">⚠️ Expired</span>`;
                } else if (diffDays <= 7) {
                    expireTag = `<span style="color: var(--danger); font-weight: 600;">⚠️ Exp. in ${diffDays}d</span>`;
                } else {
                    expireTag = `<span>Exp. in ${diffDays}d</span>`;
                }
            }

            return `
      <div class="video-card folder-card" data-id="${folder.id}">
        <div class="folder-thumb" onclick="navigateTo(${folder.id}, '${escapeJs(folder.name)}')">
          <svg class="folder-icon" viewBox="0 0 24 24" fill="currentColor">
            <path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/>
          </svg>
        </div>
        <div class="video-info">
          <div class="video-name" title="${escapeHtml(folder.name)}">${escapeHtml(folder.name)}</div>
          <div class="video-meta" style="flex-wrap: wrap; gap: 8px;">
            <span>Folder</span>
            <span>${new Date(folder.created_at).toLocaleDateString()}</span>
            ${expireTag}
          </div>
        </div>
        <div class="video-actions">
          <button class="icon-btn ${folder.is_shared ? 'shared' : ''}" onclick="toggleFolderShare(${folder.id})" title="${folder.is_shared ? 'Remove link' : 'Share folder'}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
              <circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/>
              <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/>
              <line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>
            </svg>
            ${folder.is_shared ? 'Link' : 'Share'}
          </button>
          ${folder.is_shared ? `
          <button class="icon-btn" onclick="openExpireModal(${folder.id}, '${folder.share_expires_at}', true)" title="Change expiration">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
              <circle cx="12" cy="12" r="10"></circle>
              <polyline points="12 6 12 12 16 14"></polyline>
            </svg>
          </button>
          <button class="icon-btn" onclick="regenerateFolderShareLink(${folder.id})" title="Regenerate link">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
              <polyline points="23 4 23 10 17 10"></polyline>
              <polyline points="1 20 1 14 7 14"></polyline>
              <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>
            </svg>
          </button>
          ` : ''}
          <button class="icon-btn" onclick="openRenameFolderModal(${folder.id}, '${escapeJs(folder.name)}')" title="Rename">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
            </svg>
          </button>
          <div class="btn-spacer"></div>
          <button class="icon-btn danger" onclick="deleteFolder(${folder.id}, '${escapeJs(folder.name)}')" title="Delete">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
              <polyline points="3 6 5 6 21 6"/>
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
            </svg>
          </button>
        </div>
      </div>
        `;
        }).join('');

        // Рендерим файлы
        html += videos.map(video => {
            let expireTag = '';
            if (video.share_id && video.share_expires_at) {
                const expDate = new Date(video.share_expires_at);
                const now = new Date();
                const diffMs = expDate - now;
                const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

                if (diffMs < 0) {
                    expireTag = `<span style="color: var(--danger); font-weight: 600;">⚠️ Expired</span>`;
                } else if (diffDays <= 7) {
                    expireTag = `<span style="color: var(--danger); font-weight: 600;">⚠️ Exp. in ${diffDays}d</span>`;
                } else {
                    expireTag = `<span>Exp. in ${diffDays}d</span>`;
                }
            }

            return `
      <div class="video-card" data-id="${video.id}">
        <div class="video-thumb" onclick="playVideo(${video.id})">
          <div class="play-icon">
            ${video.mime_type && video.mime_type.startsWith('image/') ?
                    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="24" height="24">
                 <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                 <circle cx="8.5" cy="8.5" r="1.5" />
                 <polyline points="21 15 16 10 5 21" />
               </svg>`
                    : `<svg viewBox="0 0 24 24" fill="currentColor" stroke="none">
                 <polygon points="5 3 19 12 5 21 5 3"/>
               </svg>`
                }
          </div>
        </div>
        <div class="video-info">
          <div class="video-name" title="${escapeHtml(video.filename)}">${escapeHtml(video.filename)}</div>
          <div class="video-meta" style="flex-wrap: wrap; gap: 8px;">
            <span>${formatSize(video.size)}</span>
            <span>${new Date(video.created_at).toLocaleDateString('hy-AM')}</span>
            ${expireTag}
            ${video.uploader_username ? `<span class="video-uploader" style="background: var(--bg-tertiary); padding: 2px 6px; border-radius: 4px; font-size: 11px; margin-left: auto;">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="10" height="10" style="vertical-align: -1px; margin-right: 2px;">
                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path>
                <circle cx="12" cy="7" r="4"></circle>
              </svg>
              ${escapeHtml(video.uploader_username)}
            </span>` : ''}
          </div>
        </div>
        <div class="video-actions">
          <button class="icon-btn ${video.is_shared ? 'shared' : ''}" onclick="toggleShare(${video.id})" title="${video.is_shared ? 'Remove link' : 'Share'}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
              <circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/>
              <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/>
              <line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>
            </svg>
            ${video.is_shared ? 'Link' : 'Share'}
          </button>
          ${video.is_shared ? `
          <button class="icon-btn" onclick="openExpireModal(${video.id}, '${video.share_expires_at}', false)" title="Change expiration">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
              <circle cx="12" cy="12" r="10"></circle>
              <polyline points="12 6 12 12 16 14"></polyline>
            </svg>
          </button>
          <button class="icon-btn" onclick="regenerateShareLink(${video.id})" title="Regenerate link">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
              <polyline points="23 4 23 10 17 10"></polyline>
              <polyline points="1 20 1 14 7 14"></polyline>
              <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>
            </svg>
          </button>
          ` : ''}
          <button class="icon-btn" onclick="openRenameModal(${video.id}, '${escapeJs(video.filename)}')" title="Rename">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
            </svg>
          </button>
          <div class="btn-spacer"></div>
          <button class="icon-btn danger" onclick="deleteVideo(${video.id}, '${escapeJs(video.filename)}')" title="Delete">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
              <polyline points="3 6 5 6 21 6"/>
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
            </svg>
          </button>
        </div>
      </div>
    `;
        }).join('');

        videosGrid.innerHTML = html;

    } catch (err) {
        console.error('List loading error:', err);
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

        if (data.is_shared) {
            const url = window.location.origin + '/s/' + data.share_id;
            try {
                await navigator.clipboard.writeText(url);
                showToast('Link copied to clipboard.');
            } catch {
                // Fallback: показать ссылку
                prompt('Public link:', url);
            }
        } else {
            showToast('Public link removed');
        }

        loadVideos();
    } catch (err) {
        showToast('Error', 'error');
    }
}

async function regenerateShareLink(id) {
    if (!confirm('Are you sure you want to regenerate the link? The old link will stop working.')) return;
    try {
        const res = await fetch(`/api/videos/${id}/share/regenerate`, { method: 'POST' });
        const data = await res.json();

        if (data.share_id) {
            const url = window.location.origin + '/s/' + data.share_id;
            try {
                await navigator.clipboard.writeText(url);
                showToast('New link copied to clipboard');
            } catch {
                prompt('New public link:', url);
            }
            loadVideos();
        } else {
            showToast('Error generating link', 'error');
        }
    } catch (err) {
        showToast('Network error', 'error');
    }
}

async function toggleFolderShare(id) {
    try {
        const res = await fetch(`/api/folders/${id}/share`, { method: 'POST' });
        const data = await res.json();

        if (data.is_shared) {
            const url = window.location.origin + '/s/f/' + data.share_id;
            try {
                await navigator.clipboard.writeText(url);
                showToast('Folder link copied to clipboard.');
            } catch {
                prompt('Public folder link:', url);
            }
        } else {
            showToast('Public folder link removed');
        }

        loadVideos();
    } catch (err) {
        showToast('Error', 'error');
    }
}

async function regenerateFolderShareLink(id) {
    if (!confirm('Are you sure you want to regenerate the link? The old link will stop working.')) return;
    try {
        const res = await fetch(`/api/folders/${id}/share/regenerate`, { method: 'POST' });
        const data = await res.json();

        if (data.share_id) {
            const url = window.location.origin + '/s/f/' + data.share_id;
            try {
                await navigator.clipboard.writeText(url);
                showToast('New folder link copied to clipboard');
            } catch {
                prompt('New public folder link:', url);
            }
            loadVideos();
        } else {
            showToast('Error generating link', 'error');
        }
    } catch (err) {
        showToast('Network error', 'error');
    }
}

async function deleteVideo(id, filename) {
    if (!confirm(`Delete "${filename}"?`)) return;

    try {
        const res = await fetch(`/api/videos/${id}`, { method: 'DELETE' });
        if (res.ok) {
            showToast('File deleted');
            loadVideos();
        } else {
            showToast('Deletion error', 'error');
        }
    } catch (err) {
        showToast('Network error', 'error');
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
        showToast('Name cannot be empty', 'error');
        return;
    }

    try {
        const res = await fetch(`/api/videos/${renameVideoId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filename: newName })
        });

        if (res.ok) {
            showToast('Renamed');
            closeRenameModal();
            loadVideos();
        } else {
            showToast('Error', 'error');
        }
    } catch (err) {
        showToast('Network error', 'error');
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
// Изменение срока действия (Expiration)
// ============================
let expireVideoId = null;
let isExpireForFolder = false;

function openExpireModal(id, currentDate, isFolder = false) {
    expireVideoId = id;
    isExpireForFolder = isFolder;
    const modal = document.getElementById('expireModal');
    const input = document.getElementById('expireInput');
    modal.style.display = 'flex';
    if (currentDate && currentDate !== 'null') {
        const d = new Date(currentDate);
        // Форматируем в YYYY-MM-DD для input type="date"
        input.value = d.toISOString().split('T')[0];
    } else {
        input.value = '';
    }
    input.focus();
}

function closeExpireModal() {
    document.getElementById('expireModal').style.display = 'none';
    expireVideoId = null;
}

async function confirmExpire() {
    const input = document.getElementById('expireInput');
    const newDateStr = input.value;
    if (!newDateStr) {
        showToast('Please select a date', 'error');
        return;
    }

    // Сохраняем в конец выбранного дня или начало (лучше брать текущее время в этот день или 23:59:59Z)
    const newDateStrFull = newDateStr + 'T23:59:59.000Z';

    const endpoint = isExpireForFolder
        ? `/api/folders/${expireVideoId}/share/expire`
        : `/api/videos/${expireVideoId}/share/expire`;

    try {
        const res = await fetch(endpoint, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ expires_at: newDateStrFull })
        });

        if (res.ok) {
            showToast('Expiration date updated');
            closeExpireModal();
            loadVideos();
        } else {
            const data = await res.json();
            showToast(data.error || 'Error updating date', 'error');
        }
    } catch (err) {
        showToast('Network error', 'error');
    }
}

const expireModal = document.getElementById('expireModal');
if (expireModal) {
    expireModal.addEventListener('click', (e) => {
        if (e.target === expireModal) closeExpireModal();
    });
}

// ============================
// Управление папками
// ============================
let isFolderModalRename = false;
let renameFolderTargetId = null;

function openFolderModal() {
    isFolderModalRename = false;
    document.getElementById('folderModal').style.display = 'flex';
    document.getElementById('folderModalTitle').textContent = 'Create Folder';
    const input = document.getElementById('folderInput');
    input.value = '';
    input.focus();
}

function openRenameFolderModal(id, currentName) {
    isFolderModalRename = true;
    renameFolderTargetId = id;
    document.getElementById('folderModal').style.display = 'flex';
    document.getElementById('folderModalTitle').textContent = 'Rename Folder';
    const input = document.getElementById('folderInput');
    input.value = currentName;
    input.focus();
    input.select();
}

function closeFolderModal() {
    document.getElementById('folderModal').style.display = 'none';
}

async function confirmCreateFolder() {
    const input = document.getElementById('folderInput');
    const name = input.value.trim();
    if (!name) return showToast('Name cannot be empty', 'error');

    if (isFolderModalRename) {
        try {
            const res = await fetch(`/api/folders/${renameFolderTargetId}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name })
            });
            if (res.ok) {
                showToast('Folder renamed');
                closeFolderModal();
                // Обновляем крошки если мы внутри этой папки
                const pItem = pathHistory.find(p => p.id === renameFolderTargetId);
                if (pItem) {
                    pItem.name = name;
                    updateBreadcrumbs();
                }
                loadVideos();
            } else {
                showToast('Error', 'error');
            }
        } catch (err) {
            showToast('Network error', 'error');
        }
    } else {
        try {
            const res = await fetch('/api/folders', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, parent_id: currentFolderId })
            });
            if (res.ok) {
                showToast('Folder created');
                closeFolderModal();
                loadVideos();
            } else {
                showToast('Error', 'error');
            }
        } catch (err) {
            showToast('Network error', 'error');
        }
    }
}

async function deleteFolder(id, name) {
    if (!confirm(`Delete folder "${name}" and all its content?`)) return;
    try {
        const res = await fetch(`/api/folders/${id}`, { method: 'DELETE' });
        if (res.ok) {
            showToast('Folder deleted');
            loadVideos();
        } else {
            showToast('Deletion error', 'error');
        }
    } catch (err) {
        showToast('Network error', 'error');
    }
}

const folderModal = document.getElementById('folderModal');
if (folderModal) {
    folderModal.addEventListener('click', (e) => {
        if (e.target === folderModal) closeFolderModal();
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
    window.location.href = '/secure-admin';
}

// ============================
// Добавление пользователя (Только для Admin)
// ============================
function openAddUserModal() {
    const modal = document.getElementById('addUserModal');
    const inputUser = document.getElementById('newUsernameInput');
    const inputPass = document.getElementById('newUserPasswordInput');
    modal.style.display = 'flex';
    inputUser.value = '';
    inputPass.value = '';
    inputUser.focus();
}

function closeAddUserModal() {
    document.getElementById('addUserModal').style.display = 'none';
}

async function confirmAddUser() {
    const username = document.getElementById('newUsernameInput').value.trim();
    const password = document.getElementById('newUserPasswordInput').value;

    if (!username || !password) {
        showToast('Username and password are required', 'error');
        return;
    }

    try {
        const res = await fetch('/api/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });

        const data = await res.json();

        if (res.ok) {
            showToast('User created successfully');
            closeAddUserModal();
        } else {
            showToast(data.error || 'Error creating user', 'error');
        }
    } catch (err) {
        showToast('Network error', 'error');
    }
}

const addUserModal = document.getElementById('addUserModal');
if (addUserModal) {
    addUserModal.addEventListener('click', (e) => {
        if (e.target === addUserModal) closeAddUserModal();
    });
}
const addUserInput = document.getElementById('newUserPasswordInput');
if (addUserInput) {
    addUserInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') confirmAddUser();
        if (e.key === 'Escape') closeAddUserModal();
    });
}

// ============================
// Настройки (Site Title)
// ============================
function openSettingsModal() {
    const modal = document.getElementById('settingsModal');
    const input = document.getElementById('siteTitleInput');
    modal.style.display = 'flex';
    // подставим текущее значение
    input.value = document.title === 'Provideo Media Holding' || !document.title.includes(' — ')
        ? document.title
        : document.title.split(' — ')[1] || document.title;

    const logoTexts = document.querySelectorAll('.logo-text');
    if (logoTexts.length > 0) {
        input.value = logoTexts[0].textContent;
    }
    input.focus();
}

function closeSettingsModal() {
    document.getElementById('settingsModal').style.display = 'none';
}

async function saveSettings() {
    const siteTitle = document.getElementById('siteTitleInput').value.trim();
    if (!siteTitle) {
        showToast('Site title cannot be empty', 'error');
        return;
    }

    try {
        const res = await fetch('/api/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ site_title: siteTitle })
        });

        if (res.ok) {
            showToast('Settings saved');
            closeSettingsModal();
            loadSettings(); // refresh title immediately
        } else {
            const data = await res.json();
            showToast(data.error || 'Error saving settings', 'error');
        }
    } catch (err) {
        showToast('Network error', 'error');
    }
}

async function loadSettings() {
    try {
        const res = await fetch('/api/settings');
        if (res.ok) {
            const data = await res.json();
            if (data.site_title) {
                window.siteTitle = data.site_title; // save globally

                // Изменяем title документа
                if (document.title.includes(' — Provideo Media Holding')) {
                    document.title = document.title.replace(' — Provideo Media Holding', ' — ' + data.site_title);
                } else if (document.title.includes(' — ')) {
                    const parts = document.title.split(' — ');
                    // Сохраняем первую часть (до первого ' — ') и заменяем остальное
                    document.title = parts[0] + ' — ' + data.site_title;
                } else {
                    document.title = data.site_title;
                }

                // Изменяем текст логотипа
                const logoTexts = document.querySelectorAll('.logo-text, .login-logo span');
                logoTexts.forEach(el => el.textContent = data.site_title);
            }
        }
    } catch {
        // ignore
    }
}

const settingsModal = document.getElementById('settingsModal');
if (settingsModal) {
    settingsModal.addEventListener('click', (e) => {
        if (e.target === settingsModal) closeSettingsModal();
    });
}
const siteTitleInput = document.getElementById('siteTitleInput');
if (siteTitleInput) {
    siteTitleInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') saveSettings();
        if (e.key === 'Escape') closeSettingsModal();
    });
}

// Загружаем настройки на всех страницах
loadSettings();

// ============================
// Инициализация
// ============================
async function loadUserProfile() {
    try {
        const res = await fetch('/api/me');
        if (res.ok) {
            const data = await res.json();
            const display = document.getElementById('usernameDisplay');
            if (display) display.textContent = data.username;

            if (data.username === 'admin') {
                const addUserBtn = document.getElementById('addUserBtn');
                if (addUserBtn) addUserBtn.style.display = 'inline-flex';
                const settingsBtn = document.getElementById('settingsBtn');
                if (settingsBtn) settingsBtn.style.display = 'inline-flex';
            }
        }
    } catch {
        // ignore
    }
}

if (videosGrid) {
    loadUserProfile();
    loadVideos();
}

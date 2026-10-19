// ============================
// Отладочная консоль (Debug Console)
// ============================
(function () {
    const logs = [];
    const MAX_LOGS = 300;
    let currentFilter = 'all';
    let searchQuery = '';
    let isMinimized = true;
    let isHeightExpanded = false;
    let isEnabled = localStorage.getItem('debug_console_enabled') === 'true';
    let errorCount = 0;
    let reqCount = 0;

    function formatTime(date) {
        return date.toTimeString().split(' ')[0] + '.' + String(date.getMilliseconds()).padStart(3, '0');
    }

    function createUI() {
        if (document.getElementById('debugConsoleContainer')) return;

        const container = document.createElement('div');
        container.id = 'debugConsoleContainer';
        container.className = 'debug-console-container minimized';
        if (!isEnabled) {
            container.style.display = 'none';
        }

        container.innerHTML = `
            <div class="debug-console-header" id="debugConsoleHeader">
                <div class="debug-console-title">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 18 22 12 16 6"></polyline><polyline points="8 6 2 12 8 18"></polyline></svg>
                    <span>Debug Console</span>
                    <div class="debug-console-badges">
                        <span class="debug-console-count req" id="debugReqCount">0 req</span>
                        <span class="debug-console-count err" id="debugErrCount">0 err</span>
                    </div>
                </div>
                <div class="debug-console-controls" onclick="event.stopPropagation();">
                    <input type="text" id="debugConsoleSearch" class="debug-console-search" placeholder="Filter..." />
                    <div class="debug-console-tabs">
                        <button class="debug-console-tab active" data-filter="all">All</button>
                        <button class="debug-console-tab" data-filter="network">XHR/Fetch</button>
                        <button class="debug-console-tab" data-filter="errors">Errors</button>
                        <button class="debug-console-tab" data-filter="logs">Logs</button>
                    </div>
                    <button class="debug-console-btn" id="debugConsoleExpandBtn" title="Expand/Collapse Height">⇳</button>
                    <button class="debug-console-btn" id="debugConsoleCopyBtn" title="Copy logs">Copy</button>
                    <button class="debug-console-btn" id="debugConsoleClearBtn" title="Clear logs">Clear</button>
                    <button class="debug-console-btn" id="debugConsoleMinimizeBtn" title="Minimize">▼</button>
                </div>
            </div>
            <div class="debug-console-body" id="debugConsoleBody"></div>
        `;

        const toggleBtn = document.createElement('button');
        toggleBtn.id = 'debugConsoleToggleBtn';
        toggleBtn.className = 'debug-console-toggle-btn';
        toggleBtn.innerHTML = `🛠 Debug <span id="debugConsoleBadge">0</span>`;
        toggleBtn.style.display = isEnabled ? 'flex' : 'none';
        toggleBtn.onclick = () => toggleConsole();

        const mount = () => {
            if (!document.body.contains(container)) {
                document.body.appendChild(container);
                document.body.appendChild(toggleBtn);
                bindEvents();
                render();
            }
        };

        if (document.body) {
            mount();
        } else {
            document.addEventListener('DOMContentLoaded', mount);
        }
    }

    function setEnabled(val) {
        isEnabled = !!val;
        localStorage.setItem('debug_console_enabled', isEnabled ? 'true' : 'false');
        const container = document.getElementById('debugConsoleContainer');
        const toggleBtn = document.getElementById('debugConsoleToggleBtn');
        if (!isEnabled) {
            isMinimized = true;
            if (container) {
                container.classList.add('minimized');
                container.style.display = 'none';
            }
            if (toggleBtn) {
                toggleBtn.style.display = 'none';
            }
        } else {
            if (container) {
                container.style.display = '';
            }
            if (toggleBtn) {
                toggleBtn.style.display = isMinimized ? 'flex' : 'none';
            }
        }
    }

    function toggleConsole(show) {
        if (!isEnabled) {
            setEnabled(true);
        }
        const container = document.getElementById('debugConsoleContainer');
        const toggleBtn = document.getElementById('debugConsoleToggleBtn');
        if (!container) return;

        if (typeof show === 'boolean') {
            isMinimized = !show;
        } else {
            isMinimized = !isMinimized;
        }

        if (isMinimized) {
            container.classList.add('minimized');
            if (toggleBtn && isEnabled) toggleBtn.style.display = 'flex';
        } else {
            container.classList.remove('minimized');
            if (toggleBtn) toggleBtn.style.display = 'none';
        }
    }

    function bindEvents() {
        const header = document.getElementById('debugConsoleHeader');
        const minimizeBtn = document.getElementById('debugConsoleMinimizeBtn');
        const expandBtn = document.getElementById('debugConsoleExpandBtn');
        const clearBtn = document.getElementById('debugConsoleClearBtn');
        const copyBtn = document.getElementById('debugConsoleCopyBtn');
        const searchInput = document.getElementById('debugConsoleSearch');
        const tabs = document.querySelectorAll('.debug-console-tab');
        const container = document.getElementById('debugConsoleContainer');

        if (header) {
            header.onclick = () => toggleConsole();
        }

        if (minimizeBtn) {
            minimizeBtn.onclick = (e) => {
                e.stopPropagation();
                toggleConsole(false);
            };
        }

        if (expandBtn) {
            expandBtn.onclick = (e) => {
                e.stopPropagation();
                isHeightExpanded = !isHeightExpanded;
                container.style.height = isHeightExpanded ? '450px' : '260px';
                expandBtn.textContent = isHeightExpanded ? '🗗' : '⇳';
            };
        }

        if (clearBtn) {
            clearBtn.onclick = (e) => {
                e.stopPropagation();
                logs.length = 0;
                errorCount = 0;
                reqCount = 0;
                updateCounts();
                render();
            };
        }

        if (copyBtn) {
            copyBtn.onclick = (e) => {
                e.stopPropagation();
                const text = logs.map(l => `[${formatTime(l.date)}] [${l.type}] ${l.message}\n${l.details || ''}`).join('\n---\n');
                navigator.clipboard.writeText(text).then(() => {
                    copyBtn.textContent = 'Copied!';
                    setTimeout(() => copyBtn.textContent = 'Copy', 1500);
                }).catch(() => {});
            };
        }

        if (searchInput) {
            searchInput.oninput = (e) => {
                searchQuery = e.target.value.toLowerCase();
                render();
            };
        }

        tabs.forEach(tab => {
            tab.onclick = (e) => {
                e.stopPropagation();
                tabs.forEach(t => t.classList.remove('active'));
                tab.classList.add('active');
                currentFilter = tab.dataset.filter;
                render();
            };
        });
    }

    function updateCounts() {
        const badge = document.getElementById('debugConsoleBadge');
        const reqEl = document.getElementById('debugReqCount');
        const errEl = document.getElementById('debugErrCount');

        if (badge) badge.textContent = logs.length;
        if (reqEl) reqEl.textContent = `${reqCount} req`;
        if (errEl) errEl.textContent = `${errorCount} err`;
    }

    function addLog(entry) {
        const date = new Date();
        const item = {
            id: Math.random().toString(36).substring(2, 9),
            date,
            type: entry.type || 'LOG',
            level: entry.level || 'info',
            message: String(entry.message || ''),
            details: entry.details ? String(entry.details) : null
        };

        if (item.type.includes('XHR') || item.type.includes('FETCH')) {
            reqCount++;
        }
        if (item.level === 'error' || item.type.includes('ERR')) {
            errorCount++;
        }

        logs.push(item);
        if (logs.length > MAX_LOGS) logs.shift();

        updateCounts();
        renderItem(item);
    }

    function shouldDisplay(item) {
        if (currentFilter === 'network' && !item.type.includes('XHR') && !item.type.includes('FETCH')) return false;
        if (currentFilter === 'errors' && item.level !== 'error' && !item.type.includes('ERR')) return false;
        if (currentFilter === 'logs' && (item.type.includes('XHR') || item.type.includes('FETCH') || item.type.includes('ERR'))) return false;

        if (searchQuery) {
            const haystack = (item.type + ' ' + item.message + ' ' + (item.details || '')).toLowerCase();
            if (!haystack.includes(searchQuery)) return false;
        }

        return true;
    }

    function createRowEl(item) {
        const row = document.createElement('div');
        let statusClass = item.level;
        if (item.message.includes('[200') || item.message.includes('[201') || item.message.includes('[304')) {
            statusClass = 'xhr-2xx';
        } else if (item.message.includes('[4') || item.message.includes('[5') || item.type.includes('ERR')) {
            statusClass = 'xhr-4xx';
        }

        row.className = `debug-console-row ${statusClass}`;
        row.onclick = () => row.classList.toggle('expanded');

        const headerDiv = document.createElement('div');
        headerDiv.className = 'debug-console-row-header';

        const timeSpan = document.createElement('span');
        timeSpan.className = 'debug-console-time';
        timeSpan.textContent = formatTime(item.date);

        const typeSpan = document.createElement('span');
        typeSpan.className = `debug-console-type ${item.type.toLowerCase().split('_')[0]}`;
        typeSpan.textContent = item.type;

        const textSpan = document.createElement('span');
        textSpan.className = 'debug-console-text';
        textSpan.textContent = item.message;

        headerDiv.appendChild(timeSpan);
        headerDiv.appendChild(typeSpan);
        headerDiv.appendChild(textSpan);
        row.appendChild(headerDiv);

        if (item.details) {
            const detailsDiv = document.createElement('div');
            detailsDiv.className = 'debug-console-details';
            detailsDiv.textContent = item.details;
            row.appendChild(detailsDiv);
        }

        return row;
    }

    function renderItem(item) {
        const body = document.getElementById('debugConsoleBody');
        if (!body) return;
        if (!shouldDisplay(item)) return;
        body.appendChild(createRowEl(item));
        body.scrollTop = body.scrollHeight;
    }

    function render() {
        const body = document.getElementById('debugConsoleBody');
        if (!body) return;
        body.innerHTML = '';
        const filtered = logs.filter(shouldDisplay);
        filtered.forEach(item => {
            body.appendChild(createRowEl(item));
        });
        body.scrollTop = body.scrollHeight;
    }

    // Capture JS errors
    window.addEventListener('error', function (e) {
        addLog({
            type: 'JS_ERROR',
            level: 'error',
            message: `${e.message} (${e.filename || 'inline'}:${e.lineno || 0}:${e.colno || 0})`,
            details: e.error ? e.error.stack : `${e.message} at ${e.filename}:${e.lineno}:${e.colno}`
        });
    });

    window.addEventListener('unhandledrejection', function (e) {
        const reason = e.reason;
        const msg = reason ? (reason.message || String(reason)) : 'Unhandled Promise Rejection';
        addLog({
            type: 'PROMISE_ERR',
            level: 'error',
            message: msg,
            details: reason && reason.stack ? reason.stack : msg
        });
    });

    // Capture Console
    const origLog = console.log;
    const origWarn = console.warn;
    const origError = console.error;
    const origInfo = console.info;

    function formatArg(arg) {
        if (arg === null) return 'null';
        if (arg === undefined) return 'undefined';
        if (typeof arg === 'object') {
            try { return JSON.stringify(arg); } catch { return String(arg); }
        }
        return String(arg);
    }

    console.log = function (...args) {
        origLog.apply(console, args);
        addLog({ type: 'LOG', level: 'info', message: args.map(formatArg).join(' ') });
    };
    console.warn = function (...args) {
        origWarn.apply(console, args);
        addLog({ type: 'WARN', level: 'warn', message: args.map(formatArg).join(' ') });
    };
    console.error = function (...args) {
        origError.apply(console, args);
        addLog({ type: 'ERROR', level: 'error', message: args.map(formatArg).join(' ') });
    };
    console.info = function (...args) {
        origInfo.apply(console, args);
        addLog({ type: 'INFO', level: 'info', message: args.map(formatArg).join(' ') });
    };

    createUI();

    window.DebugConsole = {
        addLog,
        toggle: toggleConsole,
        enable: () => setEnabled(true),
        disable: () => setEnabled(false),
        setEnabled: (val) => setEnabled(val),
        isEnabled: () => isEnabled,
        clear: () => {
            logs.length = 0;
            render();
        }
    };
})();

// ============================
// Глобальный перехват ошибок доступа (401) и логирование XHR / Fetch
// ============================
(function () {
    const checkAndRedirect = (status, url) => {
        const path = window.location.pathname;
        const isPublic = path.startsWith('/s/') || path.includes('secure-admin');

        if (status === 401 && !isPublic) {
            console.warn(`[Auth] Access denied (401) for ${url}. Redirecting to login...`);
            localStorage.removeItem('auth_token');
            const redirectUrl = '/secure-admin?redirect=' + encodeURIComponent(window.location.pathname + window.location.search);
            window.location.replace(redirectUrl);
        }
    };

    // Перехват fetch
    const originalFetch = window.fetch;
    window.fetch = async function (resource, config) {
        config = config || {};
        const token = localStorage.getItem('auth_token');
        if (token) {
            config.headers = config.headers || {};
            if (config.headers instanceof Headers) {
                if (!config.headers.has('Authorization')) {
                    config.headers.set('Authorization', 'Bearer ' + token);
                }
            } else if (Array.isArray(config.headers)) {
                const hasAuth = config.headers.some(h => h[0] && h[0].toLowerCase() === 'authorization');
                if (!hasAuth) {
                    config.headers.push(['Authorization', 'Bearer ' + token]);
                }
            } else {
                let hasAuth = false;
                for (let k in config.headers) {
                    if (k.toLowerCase() === 'authorization') {
                        hasAuth = true;
                        break;
                    }
                }
                if (!hasAuth) {
                    config.headers['Authorization'] = 'Bearer ' + token;
                }
            }
        }
        const method = (config.method || 'GET').toUpperCase();
        const url = typeof resource === 'string' ? resource : resource?.url || resource;
        const startTime = Date.now();

        try {
            const response = await originalFetch.call(this, resource, config);
            const duration = Date.now() - startTime;
            if (window.DebugConsole) {
                const isOk = response.ok;
                window.DebugConsole.addLog({
                    type: 'FETCH',
                    level: isOk ? 'info' : 'error',
                    message: `${method} ${url} [${response.status} ${response.statusText}] (${duration}ms)`,
                    details: `URL: ${url}\nMethod: ${method}\nStatus: ${response.status} ${response.statusText}\nDuration: ${duration}ms`
                });
            }
            checkAndRedirect(response.status, url);
            return response;
        } catch (err) {
            const duration = Date.now() - startTime;
            if (window.DebugConsole) {
                window.DebugConsole.addLog({
                    type: 'FETCH_ERR',
                    level: 'error',
                    message: `${method} ${url} [FAILED] (${duration}ms) - ${err.message}`,
                    details: `URL: ${url}\nMethod: ${method}\nError: ${err.message}\nDuration: ${duration}ms`
                });
            }
            throw err;
        }
    };

    // Перехват XMLHttpRequest
    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url) {
        this._xhrMethod = method;
        this._xhrUrl = url;
        this._xhrStartTime = Date.now();
        this.addEventListener('load', () => {
            const duration = Date.now() - (this._xhrStartTime || Date.now());
            if (window.DebugConsole) {
                const isSuccess = this.status >= 200 && this.status < 400;
                window.DebugConsole.addLog({
                    type: 'XHR',
                    level: isSuccess ? 'info' : 'error',
                    message: `${(this._xhrMethod || 'GET').toUpperCase()} ${this._xhrUrl} [${this.status} ${this.statusText}] (${duration}ms)`,
                    details: `URL: ${this._xhrUrl}\nMethod: ${this._xhrMethod}\nStatus: ${this.status} ${this.statusText}\nDuration: ${duration}ms`
                });
            }
            checkAndRedirect(this.status, url);
        });
        this.addEventListener('error', () => {
            const duration = Date.now() - (this._xhrStartTime || Date.now());
            if (window.DebugConsole) {
                window.DebugConsole.addLog({
                    type: 'XHR_ERR',
                    level: 'error',
                    message: `${(this._xhrMethod || 'GET').toUpperCase()} ${this._xhrUrl} [NETWORK ERROR] (${duration}ms)`,
                    details: `URL: ${this._xhrUrl}\nMethod: ${this._xhrMethod}\nNetwork Error\nDuration: ${duration}ms`
                });
            }
        });
        return originalOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function () {
        const token = localStorage.getItem('auth_token');
        if (token) {
            try {
                this.setRequestHeader('Authorization', 'Bearer ' + token);
            } catch (e) {}
        }
        return originalSend.apply(this, arguments);
    };
})();

// ============================
// Утилиты
// ============================
function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
    return (bytes / 1073741824).toFixed(2) + ' GB';
}

function showToast(message, type = 'success', onRetry = null) {
    let container = document.getElementById('toastContainer');
    if (!container) {
        container = document.createElement('div');
        container.id = 'toastContainer';
        container.className = 'toast-container';
        document.body.appendChild(container);
    }
    const toast = document.createElement('div');
    toast.className = 'toast ' + type;

    const isError = type === 'error';

    if (isError) {
        const icon = document.createElement('span');
        icon.style.cssText = 'color: #ef4444; font-size: 16px; flex-shrink: 0; display: inline-flex; align-items: center;';
        icon.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>`;
        toast.appendChild(icon);
    }

    const textSpan = document.createElement('span');
    textSpan.style.cssText = 'flex: 1; line-height: 1.4;';
    textSpan.textContent = message;
    toast.appendChild(textSpan);

    if (typeof onRetry === 'function') {
        const retryBtn = document.createElement('button');
        retryBtn.className = 'toast-retry-btn';
        retryBtn.textContent = 'Retry';
        retryBtn.onclick = (e) => {
            e.stopPropagation();
            toast.remove();
            onRetry();
        };
        toast.appendChild(retryBtn);
    }

    // Кнопка закрытия (✕) для ошибок или уведомлений с повтором
    if (isError || onRetry) {
        const closeBtn = document.createElement('button');
        closeBtn.className = 'toast-close-btn';
        closeBtn.title = 'Close';
        closeBtn.innerHTML = '✕';
        closeBtn.onclick = (e) => {
            e.stopPropagation();
            toast.remove();
        };
        toast.appendChild(closeBtn);
    }

    container.appendChild(toast);

    // Уведомления об ошибках НЕ исчезают, пока пользователь сам их не закроет или не нажмет Retry
    if (!isError) {
        setTimeout(() => {
            if (toast.parentElement) toast.remove();
        }, 3500);
    }
}

// ============================
// Загрузка видео (Upload)
// ============================
const uploadZone = document.getElementById('uploadZone');
const fileInput = document.getElementById('fileInput');
const folderInputSelect = document.getElementById('folderInputSelect');
const progressContainer = document.getElementById('progressContainer');
const progressFill = document.getElementById('progressFill');
const progressText = document.getElementById('progressText');
const progressPercent = document.getElementById('progressPercent');

function isMediaFile(file) {
    if (!file) return false;
    const name = file.name || '';
    if (name.startsWith('.') || name === 'Thumbs.db' || name === 'desktop.ini') return false;
    if (file.type && (file.type.startsWith('video/') || file.type.startsWith('image/'))) {
        return true;
    }
    const lastDot = name.lastIndexOf('.');
    if (lastDot === -1) return true;
    const ext = name.slice(lastDot).toLowerCase();
    const mediaExtensions = [
        '.mp4', '.mkv', '.webm', '.avi', '.mov', '.m4v', '.wmv', '.flv', '.3gp', '.3g2',
        '.ts', '.m2ts', '.mts', '.m2t', '.vob', '.ogv', '.ogg', '.mpg', '.mpeg', '.m2v',
        '.m4p', '.divx', '.xvid', '.rm', '.rmvb', '.asf', '.f4v', '.264', '.h264', '.265', '.hevc',
        '.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.bmp', '.ico', '.tiff', '.tif',
        '.heic', '.heif', '.avif', '.raw', '.cr2', '.cr3', '.nef', '.arw', '.dng', '.orf', '.rw2', '.pef'
    ];
    return mediaExtensions.includes(ext);
}

async function getAllFileEntries(dataTransferItems) {
    const files = [];

    function readEntriesPromise(dirReader) {
        return new Promise((resolve) => {
            dirReader.readEntries((entries) => {
                resolve(entries || []);
            }, (err) => {
                console.warn('[DragDrop] readEntries error:', err);
                resolve([]);
            });
        });
    }

    async function readAllDirectoryEntries(directoryReader) {
        let allEntries = [];
        let readMore = true;
        while (readMore) {
            const entries = await readEntriesPromise(directoryReader);
            if (entries && entries.length > 0) {
                allEntries = allEntries.concat(entries);
            } else {
                readMore = false;
            }
        }
        return allEntries;
    }

    function getFilePromise(entry) {
        return new Promise((resolve) => {
            entry.file((file) => {
                resolve(file);
            }, (err) => {
                console.warn('[DragDrop] entry.file error:', err);
                resolve(null);
            });
        });
    }

    async function traverseEntry(entry, currentPath = '') {
        if (!entry) return;
        if (entry.isFile) {
            const file = await getFilePromise(entry);
            if (file) {
                const relPath = (currentPath + file.name).replace(/\\/g, '/');
                try {
                    file.relativePath = relPath;
                } catch (e) {}
                try {
                    Object.defineProperty(file, 'relativePath', {
                        value: relPath,
                        writable: true,
                        configurable: true
                    });
                } catch (e) {}
                if (isMediaFile(file)) {
                    files.push(file);
                }
            }
        } else if (entry.isDirectory) {
            const dirReader = entry.createReader();
            const entries = await readAllDirectoryEntries(dirReader);
            for (const child of entries) {
                await traverseEntry(child, currentPath + entry.name + '/');
            }
        }
    }

    for (let i = 0; i < dataTransferItems.length; i++) {
        const item = dataTransferItems[i];
        const entry = item.webkitGetAsEntry ? item.webkitGetAsEntry() : (item.getAsEntry ? item.getAsEntry() : null);
        if (entry) {
            await traverseEntry(entry, '');
        }
    }
    return files;
}

async function getFilesFromDirectoryHandle(dirHandle) {
    const files = [];

    async function scanDir(handle, currentPath = '') {
        for await (const entry of handle.values()) {
            if (entry.kind === 'file') {
                try {
                    const file = await entry.getFile();
                    const relPath = (currentPath + file.name).replace(/\\/g, '/');
                    try { file.relativePath = relPath; } catch (e) {}
                    try {
                        Object.defineProperty(file, 'relativePath', {
                            value: relPath,
                            writable: true,
                            configurable: true
                        });
                    } catch (e) {}
                    if (isMediaFile(file)) {
                        files.push(file);
                    }
                } catch (e) {
                    console.warn('[DirectoryPicker] Error reading file entry:', entry.name, e);
                }
            } else if (entry.kind === 'directory') {
                await scanDir(entry, `${currentPath}${entry.name}/`);
            }
        }
    }

    await scanDir(dirHandle, `${dirHandle.name}/`);
    return files;
}

function triggerFileInput(e) {
    if (e) {
        if (e.stopPropagation) e.stopPropagation();
        if (e.preventDefault) e.preventDefault();
    }
    if (fileInput) fileInput.click();
}
window.triggerFileInput = triggerFileInput;

async function selectFolder(e) {
    if (e) {
        if (e.stopPropagation) e.stopPropagation();
        if (e.preventDefault) e.preventDefault();
    }

    if (typeof window.showDirectoryPicker === 'function') {
        try {
            const dirHandle = await window.showDirectoryPicker();
            if (!dirHandle) return;

            const files = await getFilesFromDirectoryHandle(dirHandle);
            if (files.length > 0) {
                uploadFiles(files);
            } else {
                showToast('No valid media files found in selected folder', 'error');
            }
            return;
        } catch (err) {
            if (err.name === 'AbortError') {
                return;
            }
            console.warn('[DirectoryPicker] showDirectoryPicker failed, falling back to input:', err);
        }
    }

    // Dynamic input fallback without 'multiple' to ensure folder selection mode in all OSes/browsers
    const dynamicFolderInput = document.createElement('input');
    dynamicFolderInput.type = 'file';
    dynamicFolderInput.webkitdirectory = true;
    dynamicFolderInput.mozdirectory = true;
    dynamicFolderInput.directory = true;
    dynamicFolderInput.setAttribute('webkitdirectory', '');
    dynamicFolderInput.setAttribute('mozdirectory', '');
    dynamicFolderInput.setAttribute('directory', '');
    dynamicFolderInput.style.display = 'none';

    dynamicFolderInput.addEventListener('change', () => {
        if (dynamicFolderInput.files && dynamicFolderInput.files.length > 0) {
            const files = Array.from(dynamicFolderInput.files).filter(isMediaFile);
            files.forEach(f => {
                const p = (f.webkitRelativePath || f.name).replace(/\\/g, '/');
                try { f.relativePath = p; } catch (e) {}
                try {
                    Object.defineProperty(f, 'relativePath', {
                        value: p,
                        writable: true,
                        configurable: true
                    });
                } catch (e) {}
            });
            if (files.length > 0) {
                uploadFiles(files);
            } else {
                showToast('No valid media files found in selected folder', 'error');
            }
        }
        setTimeout(() => dynamicFolderInput.remove(), 1000);
    });

    document.body.appendChild(dynamicFolderInput);
    dynamicFolderInput.click();
}
window.selectFolder = selectFolder;

if (folderInputSelect) {
    folderInputSelect.webkitdirectory = true;
    folderInputSelect.mozdirectory = true;
    folderInputSelect.directory = true;
    folderInputSelect.removeAttribute('multiple');
}

if (uploadZone) {
    // Prevent accidental browser navigation when dragging files over the window
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => e.preventDefault());

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

    uploadZone.addEventListener('drop', async (e) => {
        e.preventDefault();
        const items = e.dataTransfer.items;
        if (items && items.length > 0 && (items[0].webkitGetAsEntry || items[0].getAsEntry)) {
            const files = await getAllFileEntries(items);
            if (files.length > 0) uploadFiles(files);
            else showToast('No valid video or photo files found in dropped items', 'error');
        } else {
            const files = Array.from(e.dataTransfer.files).filter(isMediaFile);
            if (files.length > 0) uploadFiles(files);
            else showToast('Only video and photo files are allowed', 'error');
        }
    });

    uploadZone.addEventListener('click', (e) => {
        if (e.target.closest('.upload-btn') || e.target.closest('label') || e.target.closest('button') || e.target.tagName === 'BUTTON' || e.target.tagName === 'LABEL' || e.target.tagName === 'INPUT') {
            return;
        }
        if (fileInput) fileInput.click();
    });

    ['selectFilesBtn', 'selectFolderBtn'].forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            el.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    const inp = el.querySelector('input');
                    if (inp) inp.click();
                }
            });
        }
    });

    fileInput.addEventListener('change', () => {
        if (fileInput.files.length > 0) {
            const files = Array.from(fileInput.files).filter(isMediaFile);
            files.forEach(f => {
                const p = (f.webkitRelativePath || f.name).replace(/\\/g, '/');
                try { f.relativePath = p; } catch (e) {}
            });
            fileInput.value = '';
            if (files.length > 0) uploadFiles(files);
            else showToast('No valid video or photo files selected', 'error');
        }
    });

    if (folderInputSelect) {
        folderInputSelect.addEventListener('change', () => {
            if (folderInputSelect.files && folderInputSelect.files.length > 0) {
                const files = Array.from(folderInputSelect.files).filter(isMediaFile);
                files.forEach(f => {
                    const p = (f.webkitRelativePath || f.name).replace(/\\/g, '/');
                    try { f.relativePath = p; } catch (e) {}
                    try {
                        Object.defineProperty(f, 'relativePath', {
                            value: p,
                            writable: true,
                            configurable: true
                        });
                    } catch (e) {}
                });
                folderInputSelect.value = '';
                if (files.length > 0) uploadFiles(files);
                else showToast('No valid media files found in selected folder', 'error');
            }
        });
    }
}

// ============================
// Состояние папок, Навигация браузера & Менеджер скролла
// ============================
if ('scrollRestoration' in history) {
    try {
        history.scrollRestoration = 'manual';
    } catch (e) {}
}

const folderScrollMap = new Map();
let isRestoringScroll = false;
let currentLoadVideosToken = 0;

function getWindowScrollY() {
    return window.scrollY || window.pageYOffset || document.documentElement.scrollTop || document.body.scrollTop || 0;
}

function setWindowScrollY(targetY) {
    const y = Math.max(0, parseInt(targetY, 10) || 0);
    window.scrollTo({ top: y, left: 0, behavior: 'instant' });
    document.documentElement.scrollTop = y;
    document.body.scrollTop = y;
}

function getFolderScrollStorageKey(folderId) {
    return `media_scroll_pos_${folderId !== null && folderId !== undefined ? folderId : 'root'}`;
}

function saveCurrentFolderScroll() {
    if (isRestoringScroll) return;
    const key = getFolderScrollStorageKey(currentFolderId);
    const scrollY = getWindowScrollY();
    folderScrollMap.set(key, scrollY);
    try {
        sessionStorage.setItem(key, String(scrollY));
    } catch (e) {}
}

function getSavedFolderScroll(folderId) {
    const key = getFolderScrollStorageKey(folderId);
    if (folderScrollMap.has(key)) {
        return folderScrollMap.get(key);
    }
    try {
        const stored = sessionStorage.getItem(key);
        if (stored !== null) {
            const parsed = parseInt(stored, 10);
            if (!isNaN(parsed)) return parsed;
        }
    } catch (e) {}
    return null;
}

// Отслеживаем скролл пользователя в реальном времени с троттлингом (только если не идёт восстановление)
let scrollRecordTimer = null;
window.addEventListener('scroll', () => {
    if (isRestoringScroll) return;
    if (scrollRecordTimer) clearTimeout(scrollRecordTimer);
    scrollRecordTimer = setTimeout(() => {
        if (!isRestoringScroll) {
            saveCurrentFolderScroll();
        }
    }, 60);
}, { passive: true });

window.addEventListener('beforeunload', () => {
    saveCurrentFolderScroll();
});

let currentFolderId = null;
let pathHistory = [];

function navigateTo(folderId, folderName, pushState = true) {
    saveCurrentFolderScroll();

    if (searchInput && searchInput.value) {
        searchInput.value = '';
        currentSearchQuery = '';
        if (typeof updateSearchUrl === 'function') updateSearchUrl();
    }

    if (folderId === null) {
        currentFolderId = null;
        pathHistory = [];
        if (pushState) {
            history.pushState({ folderId: null, pathHistory: [] }, '', '/');
        }
    } else {
        const idx = pathHistory.findIndex(p => p.id === folderId);
        if (idx !== -1) {
            pathHistory = pathHistory.slice(0, idx + 1);
        } else {
            pathHistory.push({ id: folderId, name: folderName });
        }
        currentFolderId = folderId;
        if (pushState) {
            history.pushState({ folderId, pathHistory }, '', `/?folder_id=${folderId}`);
        }
    }
    updateBreadcrumbs();

    // Получаем сохранённый скролл для целевой папки
    const saved = getSavedFolderScroll(currentFolderId);
    loadVideos(saved !== null ? saved : 0);
}

async function navigateToFolderById(folderId) {
    if (!folderId) return;
    if (searchInput) {
        searchInput.value = '';
        currentSearchQuery = '';
        if (typeof updateSearchUrl === 'function') updateSearchUrl();
    }
    await restoreFolderFromUrl(folderId, true);
}

function openFolderFromCard(folderId, folderName) {
    if (typeof currentSearchQuery !== 'undefined' && currentSearchQuery) {
        if (searchInput) {
            searchInput.value = '';
            currentSearchQuery = '';
            if (typeof updateSearchUrl === 'function') updateSearchUrl();
        }
        restoreFolderFromUrl(folderId, true);
    } else {
        navigateTo(folderId, folderName);
    }
}

function clearSearchInput() {
    if (searchInput) {
        searchInput.value = '';
        currentSearchQuery = '';
        if (typeof updateSearchUrl === 'function') updateSearchUrl();
        loadVideos();
    }
}

async function restoreFolderFromUrl(targetFolderId, pushState = false, explicitScrollY = null) {
    const targetScroll = explicitScrollY !== null ? explicitScrollY : getSavedFolderScroll(targetFolderId);

    if (!targetFolderId) {
        currentFolderId = null;
        pathHistory = [];
        if (pushState) {
            history.pushState({ folderId: null, pathHistory: [] }, '', '/');
        } else {
            history.replaceState({ folderId: null, pathHistory: [] }, '', '/');
        }
        updateBreadcrumbs();
        loadVideos(targetScroll !== null ? targetScroll : 0);
        return;
    }

    try {
        const res = await fetch(`/api/folders/${targetFolderId}`);
        if (res.ok) {
            const data = await res.json();
            currentFolderId = targetFolderId;
            pathHistory = (data.breadcrumbs && data.breadcrumbs.length > 0)
                ? data.breadcrumbs
                : [{ id: targetFolderId, name: data.name }];
            const url = `/?folder_id=${targetFolderId}`;
            if (pushState) {
                history.pushState({ folderId: currentFolderId, pathHistory }, '', url);
            } else {
                history.replaceState({ folderId: currentFolderId, pathHistory }, '', url);
            }
            updateBreadcrumbs();
            loadVideos(targetScroll !== null ? targetScroll : 0);
        } else {
            showToast('Folder not found or inaccessible', 'error');
            navigateTo(null, 'Root', false);
        }
    } catch (err) {
        console.error('Failed to restore folder state:', err);
        showToast('Network error: ' + (err.message || 'Failed to connect to server'), 'error');
        navigateTo(null, 'Root', false);
    }
}

// Навигация кнопками Назад/Вперёд в браузере
window.addEventListener('popstate', async (e) => {
    const urlParams = new URLSearchParams(window.location.search);
    const folderIdParam = urlParams.get('folder_id');
    const folderId = folderIdParam ? parseInt(folderIdParam, 10) : null;
    const targetScroll = getSavedFolderScroll(folderId);

    if (e.state && Array.isArray(e.state.pathHistory)) {
        currentFolderId = e.state.folderId;
        pathHistory = e.state.pathHistory;
        updateBreadcrumbs();
        loadVideos(targetScroll !== null ? targetScroll : 0);
    } else {
        await restoreFolderFromUrl(folderId, false, targetScroll);
    }
});

function updateBreadcrumbs() {
    const bc = document.getElementById('breadcrumbs');
    if (!bc) return;
    let html = `<span class="crumb ${currentFolderId === null ? 'active' : ''}" onclick="navigateTo(null, 'Root')">Root</span>`;
    pathHistory.forEach((p, idx) => {
        const isActive = idx === pathHistory.length - 1;
        html += `<span class="crumb ${isActive ? 'active' : ''}" onclick="navigateTo(${p.id}, '${escapeJs(p.name)}')">${escapeHtml(p.name)}</span>`;
    });
    bc.innerHTML = html;

    const dlBtn = document.getElementById('downloadCurrentFolderBtn');
    if (dlBtn) {
        if (currentFolderId !== null && pathHistory.length > 0) {
            dlBtn.style.display = 'inline-flex';
            const cur = pathHistory[pathHistory.length - 1];
            dlBtn.onclick = () => openFolderDownloadModal(cur.id, cur.name);
        } else {
            dlBtn.style.display = 'none';
        }
    }
}

let currentDownloadFolderInfo = null;

function openFolderDownloadModal(folderId, folderName, isShare = false, shareId = null) {
    currentDownloadFolderInfo = { folderId, folderName, isShare, shareId };
    const modal = document.getElementById('folderDownloadModal');
    const nameEl = document.getElementById('dlModalFolderName');
    if (nameEl) nameEl.textContent = folderName || 'Folder';
    if (modal) modal.style.display = 'flex';
}

function closeFolderDownloadModal() {
    const modal = document.getElementById('folderDownloadModal');
    if (modal) modal.style.display = 'none';
    currentDownloadFolderInfo = null;
}

function confirmDownloadZip() {
    if (!currentDownloadFolderInfo) return;
    const { folderId, folderName, isShare, shareId } = currentDownloadFolderInfo;
    closeFolderDownloadModal();
    downloadFolderZip(folderId, folderName, isShare, shareId);
}

function confirmDownloadDirect() {
    if (!currentDownloadFolderInfo) return;
    const { folderId, folderName, isShare, shareId } = currentDownloadFolderInfo;
    closeFolderDownloadModal();
    startDirectFolderDownload(folderId, folderName, isShare, shareId);
}

function downloadFolderZip(folderId, folderName, isShare = false, shareId = null) {
    const zipUrl = isShare 
        ? `/api/share/folder/${shareId}/zip${folderId ? `?subfolder_id=${folderId}` : ''}`
        : `/api/folders/${folderId}/zip`;

    showToast(`Downloading "${folderName}" as ZIP archive...`, 'info');
    const a = document.createElement('a');
    a.href = zipUrl;
    a.download = `${folderName || 'folder'}.zip`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => a.remove(), 1000);
}

function showFolderDownloadProgress(folderName) {
    let cancelled = false;
    const container = document.createElement('div');
    container.className = 'folder-download-modal';
    container.style.cssText = `
        position: fixed;
        bottom: 24px;
        right: 24px;
        z-index: 10000;
        background: var(--bg-secondary, #1e1e24);
        border: 1px solid var(--border, #333);
        border-radius: 12px;
        padding: 16px 20px;
        width: 360px;
        max-width: calc(100vw - 48px);
        box-shadow: 0 10px 30px rgba(0,0,0,0.5);
        color: var(--text-primary, #fff);
        font-family: inherit;
        backdrop-filter: blur(10px);
        transition: all 0.3s ease;
    `;

    container.innerHTML = `
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
            <div style="font-weight: 600; font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; padding-right: 8px;">
                📁 ${escapeHtml(folderName)}
            </div>
            <button id="folderDlCancelBtn" style="background: none; border: none; color: var(--text-secondary, #888); cursor: pointer; font-size: 18px; line-height: 1; padding: 0 4px;" title="Cancel">&times;</button>
        </div>
        <div id="folderDlText" style="font-size: 12px; color: var(--text-secondary, #aaa); margin-bottom: 6px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
            Preparing download...
        </div>
        <div style="background: rgba(255,255,255,0.1); border-radius: 4px; height: 6px; overflow: hidden; margin-bottom: 6px;">
            <div id="folderDlFill" style="background: var(--primary, #6366f1); height: 100%; width: 0%; transition: width 0.2s;"></div>
        </div>
        <div style="display: flex; justify-content: space-between; font-size: 11px; color: var(--text-secondary, #888);">
            <span id="folderDlSubtext">0 MB</span>
            <span id="folderDlPercent">0%</span>
        </div>
    `;

    document.body.appendChild(container);

    const cancelBtn = container.querySelector('#folderDlCancelBtn');
    const textEl = container.querySelector('#folderDlText');
    const fillEl = container.querySelector('#folderDlFill');
    const subtextEl = container.querySelector('#folderDlSubtext');
    const percentEl = container.querySelector('#folderDlPercent');

    cancelBtn.addEventListener('click', () => {
        cancelled = true;
        textEl.textContent = 'Cancelling download...';
    });

    return {
        isCancelled: () => cancelled,
        update: ({ text, subtext, progress, done, error }) => {
            if (text) textEl.textContent = text;
            if (subtext) subtextEl.textContent = subtext;
            if (progress !== undefined) {
                fillEl.style.width = progress + '%';
                percentEl.textContent = progress + '%';
            }
            if (done) {
                fillEl.style.background = '#10b981';
                cancelBtn.style.display = 'none';
            }
            if (error) {
                fillEl.style.background = '#ef4444';
                textEl.style.color = '#ef4444';
                cancelBtn.style.display = 'none';
            }
        },
        close: () => {
            container.style.opacity = '0';
            container.style.transform = 'translateY(10px)';
            setTimeout(() => container.remove(), 300);
        }
    };
}

async function startDirectFolderDownload(folderId, folderName, isShare = false, shareId = null) {
    if (!window.showDirectoryPicker) {
        showToast('Direct folder download is only supported on PC in Chrome/Edge. Downloading ZIP archive...', 'info');
        downloadFolderZip(folderId, folderName, isShare, shareId);
        return;
    }

    let destDirHandle;
    try {
        destDirHandle = await window.showDirectoryPicker({
            mode: 'readwrite',
            startIn: 'downloads'
        });
    } catch (e) {
        if (e.name === 'AbortError') {
            showToast('Folder selection was cancelled or blocked by browser. You can use "Download ZIP Archive" instead.', 'info');
            return;
        }
        console.warn('[DirectoryPicker error, falling back to ZIP]', e);
        showToast(`Falling back to ZIP archive for "${folderName}"...`, 'info');
        downloadFolderZip(folderId, folderName, isShare, shareId);
        return;
    }

    const progressEl = showFolderDownloadProgress(folderName);

    try {
        let url = isShare 
            ? `/api/share/folder/${shareId}/tree${folderId ? `?subfolder_id=${folderId}` : ''}`
            : `/api/folders/${folderId}/tree`;

        const res = await fetch(url);
        if (!res.ok) {
            const errData = await res.json().catch(() => ({}));
            throw new Error(errData.error || 'Failed to load folder tree');
        }

        const data = await res.json();
        const { folder, files } = data;
        const targetFolderName = (folder && folder.name) ? folder.name : folderName;

        if (!files || files.length === 0) {
            progressEl.update({ text: 'Folder is empty', progress: 100, done: true });
            setTimeout(() => progressEl.close(), 2500);
            return;
        }

        const rootFolderHandle = await destDirHandle.getDirectoryHandle(targetFolderName, { create: true });
        const dirCache = new Map();
        dirCache.set('', rootFolderHandle);

        async function getOrCreateSubDirHandle(relDir) {
            if (!relDir || relDir === '.') return rootFolderHandle;
            if (dirCache.has(relDir)) return dirCache.get(relDir);

            const parts = relDir.split('/').filter(Boolean);
            let cur = rootFolderHandle;
            let curPath = '';
            for (const part of parts) {
                curPath = curPath ? `${curPath}/${part}` : part;
                if (dirCache.has(curPath)) {
                    cur = dirCache.get(curPath);
                } else {
                    cur = await cur.getDirectoryHandle(part, { create: true });
                    dirCache.set(curPath, cur);
                }
            }
            return cur;
        }

        const totalFiles = files.length;
        let downloadedCount = 0;
        let totalBytes = files.reduce((sum, f) => sum + (f.size || 0), 0);
        let downloadedBytes = 0;

        for (let i = 0; i < files.length; i++) {
            if (progressEl.isCancelled()) {
                throw new Error('Download cancelled by user');
            }

            const file = files[i];
            const relDir = file.relativePath.includes('/') ? file.relativePath.slice(0, file.relativePath.lastIndexOf('/')) : '';
            const dirHandle = await getOrCreateSubDirHandle(relDir);

            progressEl.update({
                text: `[${i + 1}/${totalFiles}] ${file.relativePath}`,
                subtext: `${formatSize(downloadedBytes)} of ${formatSize(totalBytes)}`,
                progress: totalBytes > 0 ? Math.round((downloadedBytes / totalBytes) * 100) : Math.round((i / totalFiles) * 100)
            });

            const fileHandle = await dirHandle.getFileHandle(file.filename, { create: true });
            const writable = await fileHandle.createWritable();

            const fileRes = await fetch(file.streamUrl);
            if (!fileRes.ok) {
                await writable.abort();
                throw new Error(`Error downloading ${file.filename}: HTTP ${fileRes.status}`);
            }

            if (fileRes.body && window.ReadableStream) {
                const reader = fileRes.body.getReader();
                let fileLoaded = 0;
                while (true) {
                    if (progressEl.isCancelled()) {
                        reader.cancel();
                        await writable.abort();
                        throw new Error('Download cancelled by user');
                    }
                    const { done, value } = await reader.read();
                    if (done) break;
                    await writable.write(value);
                    fileLoaded += value.length;
                    downloadedBytes += value.length;

                    progressEl.update({
                        text: `[${i + 1}/${totalFiles}] ${file.relativePath}`,
                        subtext: `${formatSize(downloadedBytes)} of ${formatSize(totalBytes)}`,
                        progress: totalBytes > 0 ? Math.round((downloadedBytes / totalBytes) * 100) : Math.round((i / totalFiles) * 100)
                    });
                }
                await writable.close();
            } else {
                const blob = await fileRes.blob();
                await writable.write(blob);
                await writable.close();
                downloadedBytes += (file.size || blob.size);
            }

            downloadedCount++;
        }

        progressEl.update({
            text: `Folder "${targetFolderName}" downloaded successfully!`,
            subtext: `Downloaded ${downloadedCount} files (${formatSize(downloadedBytes)})`,
            progress: 100,
            done: true
        });

        setTimeout(() => progressEl.close(), 3000);

    } catch (err) {
        console.error('[FolderDownload] Error:', err);
        progressEl.update({
            text: 'Download failed: ' + err.message,
            error: true
        });
        setTimeout(() => progressEl.close(), 4000);
    }
}

// Алиас для обратной совместимости
const downloadFolderDirectly = openFolderDownloadModal;

const folderDownloadModal = document.getElementById('folderDownloadModal');
if (folderDownloadModal) {
    folderDownloadModal.addEventListener('click', (e) => {
        if (e.target === folderDownloadModal) closeFolderDownloadModal();
    });
}

const CHUNK_SIZE = 10 * 1024 * 1024; // 10MB chunks (optimal for Cloudflare & network stability)

// ============================
// Управление очередью загрузки (Persistence)
// ============================
let uploadQueue = [];
try {
    const rawQueue = localStorage.getItem('uploadQueue');
    uploadQueue = rawQueue ? JSON.parse(rawQueue) : [];
    if (!Array.isArray(uploadQueue)) uploadQueue = [];
} catch (e) {
    uploadQueue = [];
}

function saveQueue(renderHint = true) {
    try {
        localStorage.setItem('uploadQueue', JSON.stringify(uploadQueue));
    } catch (e) {}
    if (renderHint) {
        updateResumeHint();
    }
}

function updateResumeHint() {
    const hint = document.getElementById('resumeHint');
    if (!hint) return;
    
    if (uploadQueue.length > 0) {
        hint.style.display = 'block';
        const fileNames = uploadQueue.slice(0, 10).map(q => q.name).join(', ') + (uploadQueue.length > 10 ? ` ... (+${uploadQueue.length - 10} more)` : '');
        hint.innerHTML = `
            <div class="resume-banner">
                <div style="flex: 1; min-width: 0;">
                    <strong style="display: block; margin-bottom: 4px;">Interrupted upload (${uploadQueue.length} files):</strong>
                    <span style="font-size: 13px; color: var(--text-secondary); word-break: break-all;">${escapeHtml(fileNames)}</span>
                </div>
                <div style="display: flex; gap: 8px; flex-shrink: 0;">
                    <button class="modal-btn modal-btn-confirm" onclick="triggerResume()" style="padding: 6px 16px; font-size: 13px; white-space: nowrap;">Resume</button>
                    <button class="modal-btn modal-btn-cancel" onclick="clearQueue()" style="padding: 6px 16px; font-size: 13px; background: rgba(255,255,255,0.05); border: 1px solid var(--border); white-space: nowrap;">Cancel</button>
                </div>
            </div>
        `;
    } else {
        hint.style.display = 'none';
    }
}

function triggerResume() {
    fileInput.click();
}

function clearQueue() {
    if (confirm('Are you sure you want to clear the interrupted uploads list?')) {
        uploadQueue = [];
        saveQueue();
    }
}

// Вызываем сразу и по готовности DOM
function init() {
    updateSortUI();
    updateResumeHint();
    setupMobileModalKeyboardAdjustment();
    if (videosGrid) {
        loadUserProfile();
        const urlParams = new URLSearchParams(window.location.search);
        const folderIdParam = urlParams.get('folder_id');
        const folderId = folderIdParam ? parseInt(folderIdParam) : null;
        const initialSavedScroll = getSavedFolderScroll(folderId);
        const searchParam = (urlParams.get('search') || urlParams.get('q') || '').trim();
        if (searchParam && searchInput) {
            searchInput.value = searchParam;
            currentSearchQuery = searchParam.toLowerCase();
        }
        if (folderId) {
            restoreFolderFromUrl(folderId, false, initialSavedScroll);
        } else {
            history.replaceState({ folderId: null, pathHistory: [] }, '', window.location.pathname + window.location.search);
            loadVideos(initialSavedScroll !== null ? initialSavedScroll : 0);
        }
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}

const CHUNK_UPLOAD_THRESHOLD = 100 * 1024 * 1024; // Чанкуем только действительно большие файлы (> 100MB)

async function uploadFiles(files) {
    console.log('[Upload] uploadFiles called with', files.length, 'files');
    if (!files || files.length === 0) return;

    progressContainer.style.display = 'block';
    let totalUploadedCount = 0;

    // Добавляем новые файлы в очередь, если их там нет
    files.forEach(f => {
        const relPath = f.relativePath || f.webkitRelativePath || f.name;
        const exists = uploadQueue.find(q => (q.relativePath || q.name) === relPath && q.size === f.size);
        if (!exists) {
            uploadQueue.push({ 
                name: f.name, 
                relativePath: relPath, 
                size: f.size, 
                type: f.type, 
                folderId: currentFolderId 
            });
        }
    });
    saveQueue(false);

    // Временно скрываем плашку возобновления, пока идет активный процесс
    const hint = document.getElementById('resumeHint');
    if (hint) hint.style.display = 'none';

    // Расчет общего размера для плавного глобального прогресс-бара со скоростью и ETA
    const totalBytesAll = files.reduce((acc, f) => acc + f.size, 0);
    const uploadedBytesPerFile = new Array(files.length).fill(0);

    const startTimeUpload = Date.now();
    let lastBytesSample = 0;
    let lastTimeSample = Date.now();
    let currentSpeed = 0; // bytes/sec

    let progressRafId = null;
    const updateOverallProgress = () => {
        if (progressRafId) return;
        progressRafId = requestAnimationFrame(() => {
            progressRafId = null;
            const now = Date.now();
            const totalUploadedBytes = uploadedBytesPerFile.reduce((a, b) => a + b, 0);
            const dt = (now - lastTimeSample) / 1000;
            if (dt >= 0.5) {
                const db = totalUploadedBytes - lastBytesSample;
                currentSpeed = Math.max(0, db / dt);
                lastBytesSample = totalUploadedBytes;
                lastTimeSample = now;
            } else if (currentSpeed === 0 && now - startTimeUpload > 1000) {
                currentSpeed = totalUploadedBytes / ((now - startTimeUpload) / 1000);
            }

            const overallPercent = totalBytesAll > 0 ? Math.min(100, Math.round((totalUploadedBytes / totalBytesAll) * 100)) : 0;
            progressFill.style.width = overallPercent + '%';
            progressPercent.textContent = overallPercent + '%';

            let speedText = '';
            let etaText = '';
            if (currentSpeed > 0 && totalUploadedBytes < totalBytesAll) {
                const speedMb = (currentSpeed / (1024 * 1024)).toFixed(1);
                const speedMbps = ((currentSpeed * 8) / (1000 * 1000)).toFixed(1);
                speedText = ` • ${speedMb} MB/s (${speedMbps} Mbps)`;

                const remainingBytes = Math.max(0, totalBytesAll - totalUploadedBytes);
                const etaSec = Math.ceil(remainingBytes / currentSpeed);
                if (etaSec > 0 && etaSec < 86400) {
                    etaText = etaSec > 60 ? ` • ETA ${Math.floor(etaSec / 60)}m ${etaSec % 60}s` : ` • ETA ${etaSec}s`;
                }
            }

            progressText.textContent = `Uploading ${totalUploadedCount}/${files.length} files (${formatSize(totalUploadedBytes)} / ${formatSize(totalBytesAll)} - ${overallPercent}%)${speedText}${etaText}`;
        });
    };

    updateOverallProgress();

    // Пул параллельной загрузки: 4 одновременных файла (или 2 для больших файлов > 100MB)
    const CONCURRENCY = files.some(f => f.size > CHUNK_UPLOAD_THRESHOLD) ? 2 : 4;
    let nextIndex = 0;

    const uploadWorker = async () => {
        while (nextIndex < files.length) {
            const index = nextIndex++;
            const file = files[index];
            const displayPath = file.relativePath || file.webkitRelativePath || file.name;

            const onProgress = (loaded) => {
                uploadedBytesPerFile[index] = loaded;
                updateOverallProgress();
            };

            try {
                const result = await (file.size > CHUNK_UPLOAD_THRESHOLD
                    ? uploadFileInChunks(file, index, files.length, onProgress)
                    : uploadFileNormal(file, index, files.length, onProgress));

                if (result && result.uploaded) {
                    totalUploadedCount += result.uploaded.length;
                    uploadedBytesPerFile[index] = file.size;
                    updateOverallProgress();
                    uploadQueue = uploadQueue.filter(q => !((q.relativePath || q.name) === displayPath && q.size === file.size));
                    saveQueue(false);
                }
            } catch (err) {
                console.error('[Upload] Error uploading', displayPath, ':', err);
                showToast(`Failed to upload ${displayPath}: ${err.message}`, 'error');
            }
        }
    };

    const workers = [];
    for (let w = 0; w < Math.min(CONCURRENCY, files.length); w++) {
        workers.push(uploadWorker());
    }
    await Promise.all(workers);

    if (totalUploadedCount > 0) {
        showToast(`Uploaded ${totalUploadedCount} file(s)`);
        loadVideos();
    }

    setTimeout(() => {
        if (uploadQueue.length === 0) {
            progressContainer.style.display = 'none';
        }
        progressFill.style.width = '0%';
        updateResumeHint();
    }, 1500);

    if (fileInput) fileInput.value = '';
    if (folderInputSelect) folderInputSelect.value = '';
}

function uploadFileNormal(file, fileIndex = 0, totalFiles = 1, onProgress = null) {
    return new Promise((resolve, reject) => {
        const formData = new FormData();
        formData.append('files', file);
        if (currentFolderId) {
            formData.append('folder_id', currentFolderId);
        }
        const relPath = file.relativePath || file.webkitRelativePath || file.name;
        if (relPath) {
            formData.append('relative_paths', relPath);
        }

        const xhr = new XMLHttpRequest();
        xhr.open('POST', '/api/upload');
        xhr.timeout = 180000;

        xhr.upload.addEventListener('progress', (e) => {
            if (e.lengthComputable && onProgress) {
                onProgress(e.loaded);
            }
        });

        xhr.onload = () => {
            if (xhr.status === 200) {
                if (onProgress) onProgress(file.size);
                resolve(JSON.parse(xhr.responseText));
            } else {
                try {
                    const err = JSON.parse(xhr.responseText);
                    reject(new Error(err.error || 'Upload error'));
                } catch {
                    reject(new Error('Upload error'));
                }
            }
        };

        xhr.onerror = () => reject(new Error('Network error'));
        xhr.ontimeout = () => reject(new Error('Upload timeout'));
        xhr.send(formData);
    });
}

function uploadFileInChunks(file, fileIndex = 0, totalFiles = 1, onProgress = null) {
    return new Promise(async (resolve, reject) => {
        const relPath = file.relativePath || file.webkitRelativePath || file.name;
        const uploadId = btoa(unescape(encodeURIComponent(relPath + file.size))).replace(/[/+=]/g, '').substr(0, 32);
        const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

        let offset = 0;
        try {
            const statusRes = await fetch(`/api/upload/status?uploadId=${uploadId}`);
            const statusData = await statusRes.json();
            offset = statusData.offset || 0;
            console.log(`[Upload] Resuming ${relPath} from offset ${offset}`);
        } catch (err) {
            console.error('[Upload] Failed to get status, starting from 0', err);
        }

        let startChunk = Math.floor(offset / CHUNK_SIZE);
        const chunkLoadedBytes = new Array(totalChunks).fill(0);
        for (let c = 0; c < startChunk; c++) {
            chunkLoadedBytes[c] = Math.min(CHUNK_SIZE, file.size - c * CHUNK_SIZE);
        }

        const updateChunkProgress = () => {
            const sumLoaded = chunkLoadedBytes.reduce((a, b) => a + b, 0);
            if (onProgress) onProgress(sumLoaded);
        };

        updateChunkProgress();

        const qItem = uploadQueue.find(q => (q.relativePath || q.name) === relPath && q.size === file.size);
        const folderId = currentFolderId || (qItem ? qItem.folderId : null);

        const MAX_RETRIES = 5;

        const sendSingleChunk = (chunkIdx, retryCount = 0) => {
            return new Promise((resChunk, rejChunk) => {
                const start = chunkIdx * CHUNK_SIZE;
                const end = Math.min(start + CHUNK_SIZE, file.size);
                const chunk = file.slice(start, end);

                const formData = new FormData();
                formData.append('chunk', chunk);
                formData.append('uploadId', uploadId);
                formData.append('chunkIndex', chunkIdx);
                formData.append('totalChunks', totalChunks);
                formData.append('chunkSize', CHUNK_SIZE);
                formData.append('startOffset', start);
                formData.append('filename', file.name);
                formData.append('mimeType', file.type || '');
                formData.append('relativePath', relPath);

                if (folderId) {
                    formData.append('folder_id', folderId);
                }

                const xhr = new XMLHttpRequest();
                xhr.open('POST', '/api/upload/chunk');
                xhr.timeout = 90000;

                xhr.upload.addEventListener('progress', (e) => {
                    if (e.lengthComputable) {
                        chunkLoadedBytes[chunkIdx] = e.loaded;
                        updateChunkProgress();
                    }
                });

                xhr.onload = () => {
                    if (xhr.status === 200) {
                        chunkLoadedBytes[chunkIdx] = end - start;
                        updateChunkProgress();
                        resChunk(JSON.parse(xhr.responseText));
                    } else {
                        rejChunk(new Error(`Server error ${xhr.status}`));
                    }
                };

                xhr.onerror = () => rejChunk(new Error('Network error'));
                xhr.ontimeout = () => rejChunk(new Error('Chunk timeout'));
                xhr.send(formData);
            }).catch(async (err) => {
                if (retryCount < MAX_RETRIES) {
                    console.warn(`[Upload] Chunk ${chunkIdx} failed (${err.message}). Retrying in 2s...`);
                    await new Promise(r => setTimeout(r, 2000));
                    return sendSingleChunk(chunkIdx, retryCount + 1);
                }
                throw err;
            });
        };

        // Sequential chunk sender to guarantee data integrity and prevent chunk race conditions
        try {
            let lastResult = null;
            for (let cIdx = startChunk; cIdx < totalChunks; cIdx++) {
                lastResult = await sendSingleChunk(cIdx);
            }
            if (onProgress) onProgress(file.size);
            resolve(lastResult);
        } catch (err) {
            reject(err);
        }
    });
}

// ============================
// Список видео & Сортировка
// ============================
const videosGrid = document.getElementById('videosGrid');
const emptyState = document.getElementById('emptyState');
const videosCount = document.getElementById('videosCount');
const headerStats = document.getElementById('headerStats');
const searchInput = document.getElementById('searchInput');

let currentSearchQuery = '';
let searchDebounceTimer = null;

function updateSearchUrl() {
    try {
        const url = new URL(window.location.href);
        if (currentSearchQuery) {
            url.searchParams.set('search', currentSearchQuery);
        } else {
            url.searchParams.delete('search');
            url.searchParams.delete('q');
        }
        history.replaceState(history.state, '', url.pathname + url.search);
    } catch (e) {}
}

if (searchInput) {
    searchInput.addEventListener('input', (e) => {
        const val = e.target.value.trim();
        currentSearchQuery = val.toLowerCase();
        updateSearchUrl();
        if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
        if (!val) {
            loadVideos();
        } else {
            searchDebounceTimer = setTimeout(() => {
                loadVideos();
            }, 250);
        }
    });

    searchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
            loadVideos();
        }
    });
}

// Переменные состояния сортировки
let currentSortKey = localStorage.getItem('media_sort_key') || 'date';
let currentSortOrder = localStorage.getItem('media_sort_order') || 'desc';
let currentFoldersFirst = localStorage.getItem('media_folders_first') !== 'false';

const sortLabels = {
    date: 'Date',
    name: 'Name',
    size: 'Size',
    type: 'Type',
    uploader: 'Owner'
};

function toggleSortDropdown(e) {
    if (e) e.stopPropagation();
    const dropdown = document.getElementById('sortDropdown');
    if (dropdown) {
        dropdown.classList.toggle('open');
    }
}

function selectSortOption(key, label) {
    setSortKey(key);
    const dropdown = document.getElementById('sortDropdown');
    if (dropdown) {
        dropdown.classList.remove('open');
    }
}

// Закрытие выпадающего списка при клике вне него
document.addEventListener('click', (e) => {
    const dropdown = document.getElementById('sortDropdown');
    if (dropdown && !dropdown.contains(e.target)) {
        dropdown.classList.remove('open');
    }
});

function setSortKey(key) {
    currentSortKey = key;
    localStorage.setItem('media_sort_key', key);
    updateSortUI();
    loadVideos();
}

function toggleSortOrder() {
    currentSortOrder = currentSortOrder === 'asc' ? 'desc' : 'asc';
    localStorage.setItem('media_sort_order', currentSortOrder);
    updateSortUI();
    loadVideos();
}

function toggleFoldersFirst() {
    currentFoldersFirst = !currentFoldersFirst;
    localStorage.setItem('media_folders_first', currentFoldersFirst ? 'true' : 'false');
    updateSortUI();
    loadVideos();
}

function updateSortUI() {
    const labelEl = document.getElementById('sortDropdownLabel');
    if (labelEl) {
        labelEl.textContent = sortLabels[currentSortKey] || 'Date';
    }
    const items = document.querySelectorAll('#sortDropdownMenu .custom-dropdown-item');
    items.forEach(item => {
        if (item.dataset.value === currentSortKey) {
            item.classList.add('active');
        } else {
            item.classList.remove('active');
        }
    });

    const orderIcon = document.getElementById('sortOrderIcon');
    const orderBtn = document.getElementById('sortOrderBtn');
    if (orderIcon && orderBtn) {
        if (currentSortOrder === 'asc') {
            orderIcon.innerHTML = '<path d="M12 19V5M5 12l7-7 7 7"/>';
            orderBtn.title = 'Sort order: Ascending';
        } else {
            orderIcon.innerHTML = '<path d="M12 5v14M19 12l-7 7-7-7"/>';
            orderBtn.title = 'Sort order: Descending';
        }
    }
    const foldersFirstBtn = document.getElementById('foldersFirstBtn');
    if (foldersFirstBtn) {
        if (currentFoldersFirst) {
            foldersFirstBtn.classList.add('active', 'sort-btn-active');
            foldersFirstBtn.setAttribute('aria-pressed', 'true');
        } else {
            foldersFirstBtn.classList.remove('active', 'sort-btn-active');
            foldersFirstBtn.setAttribute('aria-pressed', 'false');
        }
    }
}

function naturalCompare(a, b) {
    if (a === b) return 0;
    const strA = String(a || '');
    const strB = String(b || '');
    const res = strA.localeCompare(strB, undefined, { numeric: true, sensitivity: 'base' });
    if (res !== 0) return res;
    return strA.localeCompare(strB, undefined, { numeric: true });
}

function compareMediaItems(a, b, isFolderA, isFolderB, sortKey, sortOrder) {
    const dir = sortOrder === 'asc' ? 1 : -1;
    const nameA = isFolderA ? (a.name || '') : (a.filename || a.name || '');
    const nameB = isFolderB ? (b.name || '') : (b.filename || b.name || '');

    if (sortKey === 'name') {
        return naturalCompare(nameA, nameB) * dir;
    } else if (sortKey === 'date') {
        const valA = new Date(a.created_at || 0).getTime();
        const valB = new Date(b.created_at || 0).getTime();
        const diff = (valA - valB) * dir;
        if (diff !== 0) return diff;
        return naturalCompare(nameA, nameB) * dir;
    } else if (sortKey === 'size') {
        const valA = isFolderA ? 0 : (a.size || 0);
        const valB = isFolderB ? 0 : (b.size || 0);
        const diff = (valA - valB) * dir;
        if (diff !== 0) return diff;
        return naturalCompare(nameA, nameB) * dir;
    } else if (sortKey === 'type') {
        const valA = isFolderA ? 'folder' : (a.mime_type || (a.filename ? a.filename.split('.').pop() : ''));
        const valB = isFolderB ? 'folder' : (b.mime_type || (b.filename ? b.filename.split('.').pop() : ''));
        const diff = naturalCompare(valA, valB) * dir;
        if (diff !== 0) return diff;
        return naturalCompare(nameA, nameB) * dir;
    } else if (sortKey === 'uploader') {
        const valA = a.uploader_username || '';
        const valB = b.uploader_username || '';
        const diff = naturalCompare(valA, valB) * dir;
        if (diff !== 0) return diff;
        return naturalCompare(nameA, nameB) * dir;
    }
    return 0;
}

function renderFolderCardHtml(folder) {
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

    const folderFilesCount = folder.file_count || 0;
    const folderFilesText = `${folderFilesCount} ${folderFilesCount === 1 ? 'file' : 'files'}`;
    const folderSizeText = formatSize(folder.total_size || 0);

    return `
      <div class="video-card folder-card" data-id="${folder.id}">
        <div class="folder-thumb" onclick="openFolderFromCard(${folder.id}, '${escapeJs(folder.name)}')">
          <svg class="folder-icon" viewBox="0 0 24 24" fill="currentColor">
            <path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/>
          </svg>
        </div>
        <div class="video-info">
          <div class="video-name" title="${escapeHtml(folder.name)}" onclick="openFolderFromCard(${folder.id}, '${escapeJs(folder.name)}')" style="cursor: pointer;">${escapeHtml(folder.name)}</div>
          <div class="video-meta" style="flex-wrap: wrap; gap: 8px;">
            <span>${folderFilesText}</span>
            <span>${folderSizeText}</span>
            <span>${new Date(folder.created_at).toLocaleDateString()}</span>
            ${expireTag}
            ${folder.parent_id && folder.folder_path ? `<span class="folder-path-badge" title="Location: ${escapeHtml(folder.folder_path)}">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="10" height="10" style="vertical-align: -1px; margin-right: 2px;">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
              </svg>
              ${escapeHtml(folder.folder_path)}
            </span>` : ''}
            ${folder.uploader_username ? `<span class="video-uploader" style="background: var(--bg-tertiary); padding: 2px 6px; border-radius: 4px; font-size: 11px; margin-left: auto;">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="10" height="10" style="vertical-align: -1px; margin-right: 2px;">
                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path>
                <circle cx="12" cy="7" r="4"></circle>
              </svg>
              ${escapeHtml(folder.uploader_username)}
            </span>` : ''}
          </div>
        </div>
        <div class="video-actions">
          <div class="share-container">
            <button class="icon-btn ${folder.is_shared ? 'shared' : ''}" onclick="${folder.is_shared ? `toggleShareMenu(event, ${folder.id}, true)` : `toggleFolderShare(${folder.id})`}" title="${folder.is_shared ? 'Share options' : 'Share folder'}">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
                <circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/>
                <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/>
                <line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>
              </svg>
              ${folder.is_shared ? 'Link' : 'Share'}
            </button>
            <div class="share-menu" id="share-menu-f-${folder.id}">
              <button class="icon-btn" onclick="copyShareLink(${folder.id}, true)">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
                copy
              </button>
              <button class="icon-btn danger" onclick="unshareItem(${folder.id}, true)">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M18.36 6.64a9 9 0 1 1-12.73 0"></path><line x1="12" y1="2" x2="12" y2="12"></line></svg>
                unshare
              </button>
            </div>
          </div>
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
          <button class="icon-btn" onclick="downloadFolderDirectly(${folder.id}, '${escapeJs(folder.name)}')" title="Download folder">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
          </button>
          <button class="icon-btn danger" onclick="deleteFolder(${folder.id}, '${escapeJs(folder.name)}')" title="Delete">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
              <polyline points="3 6 5 6 21 6"/>
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
            </svg>
          </button>
        </div>
      </div>
    `;
}

function renderVideoCardHtml(video) {
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

    const isImage = video.mime_type && video.mime_type.startsWith('image/');
    const streamUrl = `/api/stream/${video.id}`;
    const thumbUrl = `/api/thumbnail/${video.id}`;

    const mediaTag = isImage
        ? `<img src="${thumbUrl}" alt="${escapeHtml(video.filename)}" loading="lazy" decoding="async" onerror="this.onerror=null; this.src='${streamUrl}';">`
        : `<img src="${thumbUrl}" alt="${escapeHtml(video.filename)}" loading="lazy" decoding="async" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';"><div class="video-placeholder-fallback" style="display:none; width:100%; height:100%; align-items:center; justify-content:center; background:var(--bg-tertiary); color:var(--text-secondary);"><svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='1.5' width='36' height='36'><polygon points='23 7 16 12 23 17 23 7'></polygon><rect x='1' y='5' width='15' height='14' rx='2' ry='2'></rect></svg></div>`;

    return `
      <div class="video-card" data-id="${video.id}">
        <div class="video-thumb" onclick="playVideo(${video.id})">
          ${mediaTag}
          <div class="play-icon">
            ${isImage ?
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
            ${video.folder_path ? `<span class="video-folder-badge" onclick="event.stopPropagation(); navigateToFolderById(${video.folder_id})" title="Folder: ${escapeHtml(video.folder_path)}">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="10" height="10" style="vertical-align: -1px; margin-right: 2px;">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
              </svg>
              ${escapeHtml(video.folder_path)}
            </span>` : ''}
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
          <div class="share-container">
            <button class="icon-btn ${video.is_shared ? 'shared' : ''}" onclick="${video.is_shared ? `toggleShareMenu(event, ${video.id}, false)` : `toggleShare(${video.id})`}" title="${video.is_shared ? 'Share options' : 'Share'}">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
                <circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/>
                <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/>
                <line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>
              </svg>
              ${video.is_shared ? 'Link' : 'Share'}
            </button>
            <div class="share-menu" id="share-menu-v-${video.id}">
              <button class="icon-btn" onclick="copyShareLink(${video.id}, false)">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
                copy
              </button>
              <button class="icon-btn danger" onclick="unshareItem(${video.id}, false)">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M18.36 6.64a9 9 0 1 1-12.73 0"></path><line x1="12" y1="2" x2="12" y2="12"></line></svg>
                unshare
              </button>
            </div>
          </div>
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
          <a href="/api/stream/${video.id}?download=1" class="icon-btn" title="Download" download="${escapeHtml(video.filename)}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
          </a>
          <button class="icon-btn danger" onclick="deleteVideo(${video.id}, '${escapeJs(video.filename)}')" title="Delete">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
              <polyline points="3 6 5 6 21 6"/>
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
            </svg>
          </button>
        </div>
      </div>
    `;
}

let navLoadingBar = null;

function showNavLoader() {
    if (!navLoadingBar) {
        navLoadingBar = document.createElement('div');
        navLoadingBar.className = 'nav-loading-bar';
        document.body.appendChild(navLoadingBar);
    }
    navLoadingBar.classList.remove('done');
    navLoadingBar.classList.add('active');

    const breadcrumbs = document.getElementById('breadcrumbs');
    if (breadcrumbs) {
        let sp = breadcrumbs.querySelector('.nav-spinner');
        if (!sp) {
            sp = document.createElement('span');
            sp.className = 'nav-spinner';
            breadcrumbs.appendChild(sp);
        }
        sp.classList.add('active');
    }
}

function hideNavLoader() {
    if (navLoadingBar) {
        navLoadingBar.classList.remove('active');
        navLoadingBar.classList.add('done');
        setTimeout(() => {
            if (navLoadingBar) navLoadingBar.classList.remove('done');
        }, 400);
    }
    const breadcrumbs = document.getElementById('breadcrumbs');
    if (breadcrumbs) {
        const sp = breadcrumbs.querySelector('.nav-spinner');
        if (sp) sp.classList.remove('active');
    }
}

const folderDataCache = new Map();

function getFolderCacheKey(folderId, sortKey, sortOrder, foldersFirst, search) {
    return `${folderId || 'root'}_${sortKey}_${sortOrder}_${foldersFirst ? 1 : 0}_${search || ''}`;
}

function invalidateFolderDataCache() {
    folderDataCache.clear();
}

let currentLoadAbortController = null;

async function loadVideos(targetScrollY = null) {
    if (!videosGrid) return;

    if (currentLoadAbortController) {
        try {
            currentLoadAbortController.abort();
        } catch (e) {}
    }
    currentLoadAbortController = new AbortController();
    const { signal } = currentLoadAbortController;

    const thisLoadToken = ++currentLoadVideosToken;
    isRestoringScroll = true;

    const preserveCurrentScroll = targetScrollY === null;
    const currentY = getWindowScrollY();
    const desiredScrollY = preserveCurrentScroll ? currentY : (targetScrollY || 0);

    const cacheKey = getFolderCacheKey(currentFolderId, currentSortKey, currentSortOrder, currentFoldersFirst, typeof currentSearchQuery !== 'undefined' ? currentSearchQuery : '');

    // Если это мутация/ручное обновление, сбрасываем запись кэша
    if (preserveCurrentScroll) {
        folderDataCache.delete(cacheKey);
    }

    function renderData(videos, folders) {
        const isSearch = typeof currentSearchQuery !== 'undefined' && Boolean(currentSearchQuery);

        if (videos.length === 0 && folders.length === 0) {
            videosGrid.style.display = 'none';
            emptyState.style.display = 'block';
            if (isSearch) {
                const queryText = searchInput ? searchInput.value.trim() : currentSearchQuery;
                emptyState.innerHTML = `
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="48" height="48" style="color: var(--text-secondary); margin-bottom: 12px;">
                        <circle cx="11" cy="11" r="8"></circle>
                        <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
                    </svg>
                    <p style="font-size: 16px; font-weight: 600; margin-bottom: 6px;">No results found</p>
                    <span style="font-size: 13px; color: var(--text-secondary); margin-bottom: 16px;">No files or folders match "${escapeHtml(queryText)}"</span>
                    <button class="grid-error-btn" onclick="clearSearchInput()" style="margin: 0 auto;">Clear search</button>
                `;
            } else {
                emptyState.innerHTML = `
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1">
                        <polygon points="23 7 16 12 23 17 23 7" />
                        <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
                    </svg>
                    <p>No uploaded files</p>
                    <span>Drag files to the area above or click "Select files"</span>
                `;
            }
            if (videosCount) {
                videosCount.innerHTML = '';
                videosCount.style.display = 'none';
            }
            if (headerStats) headerStats.innerHTML = '';
            setWindowScrollY(0);
            return;
        }

        videosGrid.style.display = 'grid';
        emptyState.style.display = 'none';

        const totalFolders = folders.length;
        const totalFiles = isSearch
            ? videos.length
            : (videos.length + folders.reduce((sum, f) => sum + (f.file_count || 0), 0));
        const totalSize = isSearch
            ? videos.reduce((sum, v) => sum + (v.size || 0), 0)
            : (videos.reduce((sum, v) => sum + (v.size || 0), 0) + folders.reduce((sum, f) => sum + (f.total_size || 0), 0));

        const folderWord = totalFolders === 1 ? 'folder' : 'folders';
        const fileWord = totalFiles === 1 ? 'file' : 'files';
        const sizeFormatted = formatSize(totalSize);

        const fileCountText = (isSearch && totalFiles >= 200) ? '200+' : totalFiles;
        const folderCountText = (isSearch && totalFolders >= 100) ? '100+' : totalFolders;

        // Строка со статистикой на всю ширину над списком файлов
        if (videosCount) {
            videosCount.style.display = 'flex';
            videosCount.innerHTML = `
                ${isSearch ? `
                <div class="stats-item" style="color: var(--primary);">
                    <svg class="stats-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
                        <circle cx="11" cy="11" r="8"></circle>
                        <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
                    </svg>
                    <span class="stats-label" style="color: var(--text-primary); font-weight: 500;">Search results:</span>
                </div>
                ` : ''}
                <div class="stats-item">
                    <svg class="stats-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
                        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
                    </svg>
                    <span class="stats-val">${folderCountText}</span>
                    <span class="stats-label">${folderWord}</span>
                </div>
                <div class="stats-item">
                    <svg class="stats-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                        <polyline points="14 2 14 8 20 8"></polyline>
                    </svg>
                    <span class="stats-val">${fileCountText}</span>
                    <span class="stats-label">${fileWord}</span>
                </div>
                <div class="stats-item">
                    <svg class="stats-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
                        <line x1="22" y1="12" x2="2" y2="12"></line>
                        <path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"></path>
                        <line x1="6" y1="16" x2="6.01" y2="16"></line>
                        <line x1="10" y1="16" x2="10.01" y2="16"></line>
                    </svg>
                    <span class="stats-val">${sizeFormatted}</span>
                </div>
            `;
        }

        // Статистика в хедере
        if (headerStats) {
            headerStats.innerHTML = `
                <span>${folderCountText} ${folderWord}</span>
                <span>${fileCountText} ${fileWord}</span>
                <span>${sizeFormatted}</span>
            `;
        }

        let html = '';

        if (currentFoldersFirst) {
            folders.sort((a, b) => compareMediaItems(a, b, true, true, currentSortKey, currentSortOrder));
            videos.sort((a, b) => compareMediaItems(a, b, false, false, currentSortKey, currentSortOrder));
            html = folders.map(renderFolderCardHtml).join('') + videos.map(renderVideoCardHtml).join('');
        } else {
            const allItems = [
                ...folders.map(f => ({ ...f, _isFolder: true })),
                ...videos.map(v => ({ ...v, _isFolder: false }))
            ];
            allItems.sort((a, b) => compareMediaItems(a, b, a._isFolder, b._isFolder, currentSortKey, currentSortOrder));
            html = allItems.map(item => item._isFolder ? renderFolderCardHtml(item) : renderVideoCardHtml(item)).join('');
        }

        videosGrid.innerHTML = html;
        setWindowScrollY(desiredScrollY);
    }

    // 1. Если данные есть в кэше — мгновенно рендерим
    const cached = folderDataCache.get(cacheKey);
    if (cached) {
        renderData(cached.videos, cached.folders);
        setTimeout(() => {
            if (thisLoadToken === currentLoadVideosToken) {
                isRestoringScroll = false;
            }
        }, 50);
    } else {
        // Если данных ещё нет в кэше — показываем стильный индикатор загрузки
        videosGrid.innerHTML = `
            <div style="grid-column: 1 / -1; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 60px 20px; color: var(--text-secondary);">
                <div class="nav-spinner active" style="width: 32px; height: 32px; border-width: 3px; margin: 0 0 16px 0;"></div>
                <div style="font-size: 14px; font-weight: 500;">Loading...</div>
            </div>
        `;
        emptyState.style.display = 'none';
        videosGrid.style.display = 'grid';
    }

    showNavLoader();

    try {
        const searchParam = currentSearchQuery ? `&search=${encodeURIComponent(currentSearchQuery)}` : '';
        const query = currentFolderId ? `?folder_id=${currentFolderId}&sort_by=${currentSortKey}&order=${currentSortOrder}${searchParam}` : `?sort_by=${currentSortKey}&order=${currentSortOrder}${searchParam}`;
        const parentQuery = currentFolderId ? `?parent_id=${currentFolderId}&sort_by=${currentSortKey}&order=${currentSortOrder}${searchParam}` : `?sort_by=${currentSortKey}&order=${currentSortOrder}${searchParam}`;

        const [resVideos, resFolders] = await Promise.all([
            fetch('/api/videos' + query, { signal }),
            fetch('/api/folders' + parentQuery, { signal })
        ]);

        if (thisLoadToken !== currentLoadVideosToken) {
            hideNavLoader();
            return;
        }

        if (!resVideos.ok || !resFolders.ok) {
            const status = !resVideos.ok ? resVideos.status : resFolders.status;
            let errText = `Server error (${status})`;
            try {
                const errJson = !resVideos.ok ? await resVideos.json() : await resFolders.json();
                if (errJson && errJson.error) errText = errJson.error;
            } catch (e) {}
            
            hideNavLoader();
            isRestoringScroll = false;

            videosGrid.innerHTML = `
                <div class="grid-error-state">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="48" height="48" style="color: var(--danger, #ef4444); margin-bottom: 12px;">
                        <circle cx="12" cy="12" r="10"></circle>
                        <line x1="12" y1="8" x2="12" y2="12"></line>
                        <line x1="12" y1="16" x2="12.01" y2="16"></line>
                    </svg>
                    <div style="font-size: 16px; font-weight: 600; color: var(--text-primary); margin-bottom: 6px;">Failed to load files</div>
                    <div style="font-size: 13px; margin-bottom: 16px;">${escapeHtml(errText)}</div>
                    <button class="grid-error-btn" onclick="loadVideos(${desiredScrollY})">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
                            <path d="M23 4v6h-6M1 20v-6h6"></path>
                            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>
                        </svg>
                        Retry
                    </button>
                </div>
            `;
            emptyState.style.display = 'none';
            videosGrid.style.display = 'grid';
            return;
        }

        let videos = await resVideos.json();
        let folders = await resFolders.json();

        if (thisLoadToken !== currentLoadVideosToken) {
            hideNavLoader();
            return;
        }

        if (!Array.isArray(videos)) videos = [];
        if (!Array.isArray(folders)) folders = [];

        if (typeof currentSearchQuery !== 'undefined' && currentSearchQuery) {
            const queryTokens = currentSearchQuery.trim().split(/\s+/).filter(Boolean);
            if (queryTokens.length > 0) {
                videos = videos.filter(v => v.filename && queryTokens.every(t => v.filename.toLowerCase().includes(t)));
                folders = folders.filter(f => f.name && queryTokens.every(t => f.name.toLowerCase().includes(t)));
            }
        }

        folderDataCache.set(cacheKey, { videos, folders });

        renderData(videos, folders);
        hideNavLoader();
        setTimeout(() => {
            if (thisLoadToken === currentLoadVideosToken) {
                isRestoringScroll = false;
            }
        }, 50);

    } catch (err) {
        if (err && (err.name === 'AbortError' || err.message === 'The user aborted a request.')) {
            return;
        }
        if (thisLoadToken !== currentLoadVideosToken) {
            return;
        }
        console.error('List loading error:', err);
        hideNavLoader();
        isRestoringScroll = false;

        const errMessage = err.message || 'Failed to connect to server';
        videosGrid.innerHTML = `
            <div class="grid-error-state">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="48" height="48" style="color: var(--danger, #ef4444); margin-bottom: 12px;">
                    <circle cx="12" cy="12" r="10"></circle>
                    <line x1="12" y1="8" x2="12" y2="12"></line>
                    <line x1="12" y1="16" x2="12.01" y2="16"></line>
                </svg>
                <div style="font-size: 16px; font-weight: 600; color: var(--text-primary); margin-bottom: 6px;">Connection error</div>
                <div style="font-size: 13px; margin-bottom: 16px;">${escapeHtml(errMessage)}</div>
                <button class="grid-error-btn" onclick="loadVideos(${desiredScrollY})">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
                        <path d="M23 4v6h-6M1 20v-6h6"></path>
                        <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>
                    </svg>
                    Retry
                </button>
            </div>
        `;
        emptyState.style.display = 'none';
        videosGrid.style.display = 'grid';
    }
}

// ============================
// Действия с видео
// ============================
function playVideo(id) {
    saveCurrentFolderScroll();
    try {
        sessionStorage.setItem('last_media_url', window.location.href);
    } catch (e) {}
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
                prompt('Public link:', url);
            }
            if (typeof loadVideos === 'function') loadVideos();
            else {
                // Update button if on player page
                const btn = document.getElementById('shareBtn');
                if (btn) btn.classList.add('shared');
            }
            // Show menu after small delay to allow re-render
            setTimeout(() => {
                const menu = document.getElementById(`share-menu-v-${id}`);
                if (menu) menu.classList.add('show');
            }, 100);
        } else {
            showToast('Public link removed');
            if (typeof loadVideos === 'function') loadVideos();
            else {
                const btn = document.getElementById('shareBtn');
                if (btn) btn.classList.remove('shared');
            }
        }
    } catch (err) {
        showToast('Error', 'error');
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
            if (typeof loadVideos === 'function') loadVideos();
            // Show menu after small delay
            setTimeout(() => {
                const menu = document.getElementById(`share-menu-f-${id}`);
                if (menu) menu.classList.add('show');
            }, 100);
        } else {
            showToast('Public folder link removed');
            if (typeof loadVideos === 'function') loadVideos();
        }
    } catch (err) {
        showToast('Error', 'error');
    }
}

function toggleShareMenu(event, id, isFolder) {
    event.stopPropagation();
    const menuId = `share-menu-${isFolder ? 'f' : 'v'}-${id}`;
    const menu = document.getElementById(menuId);

    // Close other menus
    document.querySelectorAll('.share-menu.show').forEach(m => {
        if (m !== menu) m.classList.remove('show');
    });

    if (menu) {
        menu.classList.toggle('show');
    }
}

async function copyShareLink(id, isFolder) {
    try {
        const endpoint = isFolder ? `/api/folders/${id}` : `/api/videos/${id}`;
        const res = await fetch(endpoint);
        const data = await res.json();

        if (data.share_id) {
            const url = window.location.origin + (isFolder ? '/s/f/' : '/s/') + data.share_id;
            await navigator.clipboard.writeText(url);
            showToast('Link copied to clipboard');
        }
    } catch (err) {
        showToast('Failed to copy', 'error');
    }
    // Hide menu
    document.querySelectorAll('.share-menu').forEach(m => m.classList.remove('show'));
}

async function unshareItem(id, isFolder) {
    if (isFolder) {
        await toggleFolderShare(id);
    } else {
        await toggleShare(id);
    }
    // Hide menu
    document.querySelectorAll('.share-menu').forEach(m => m.classList.remove('show'));
}

// Global click listener to close menus
document.addEventListener('click', (e) => {
    if (!e.target.closest('.share-container')) {
        document.querySelectorAll('.share-menu.show').forEach(m => m.classList.remove('show'));
    }
});

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
// Модальные окна: Хелперы открытия/закрытия с адаптацией под клавиатуру
// ============================
function openModalHelper(modalEl, inputEl) {
    if (!modalEl) return;
    if (window.visualViewport) {
        modalEl.style.height = `${window.visualViewport.height}px`;
        modalEl.style.top = `${window.visualViewport.offsetTop}px`;
    }
    modalEl.style.display = 'flex';
    if (inputEl) {
        setTimeout(() => {
            inputEl.focus();
            if (inputEl.select && typeof inputEl.select === 'function') {
                inputEl.select();
            }
            inputEl.scrollIntoView({ block: 'center', behavior: 'smooth' });
        }, 120);
    }
}

function closeModalHelper(modalEl) {
    if (!modalEl) return;
    modalEl.style.display = 'none';
    modalEl.style.height = '';
    modalEl.style.top = '';
}

function setupMobileModalKeyboardAdjustment() {
    if (window.visualViewport) {
        const adjustModals = () => {
            const openOverlays = document.querySelectorAll('.modal-overlay');
            openOverlays.forEach(overlay => {
                if (overlay.style.display && overlay.style.display !== 'none') {
                    overlay.style.height = `${window.visualViewport.height}px`;
                    overlay.style.top = `${window.visualViewport.offsetTop}px`;
                }
            });
        };

        window.visualViewport.addEventListener('resize', adjustModals);
        window.visualViewport.addEventListener('scroll', adjustModals);
    }

    document.addEventListener('focusin', (e) => {
        if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT')) {
            const modal = e.target.closest('.modal');
            if (modal) {
                setTimeout(() => {
                    e.target.scrollIntoView({ block: 'center', behavior: 'smooth' });
                }, 200);
            }
        }
    });
}

// ============================
// Переименование
// ============================
let renameVideoId = null;

function openRenameModal(id, currentName) {
    renameVideoId = id;
    const modal = document.getElementById('renameModal');
    const input = document.getElementById('renameInput');
    input.value = currentName;
    openModalHelper(modal, input);
}

function closeRenameModal() {
    closeModalHelper(document.getElementById('renameModal'));
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
    if (currentDate && currentDate !== 'null') {
        const d = new Date(currentDate);
        // Форматируем в YYYY-MM-DD для input type="date"
        input.value = d.toISOString().split('T')[0];
    } else {
        input.value = '';
    }
    openModalHelper(modal, input);
}

function closeExpireModal() {
    closeModalHelper(document.getElementById('expireModal'));
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
    const modal = document.getElementById('folderModal');
    document.getElementById('folderModalTitle').textContent = 'Create Folder';
    const input = document.getElementById('folderInput');
    input.value = '';
    openModalHelper(modal, input);
}

function openRenameFolderModal(id, currentName) {
    isFolderModalRename = true;
    renameFolderTargetId = id;
    const modal = document.getElementById('folderModal');
    document.getElementById('folderModalTitle').textContent = 'Rename Folder';
    const input = document.getElementById('folderInput');
    input.value = currentName;
    openModalHelper(modal, input);
}

function closeFolderModal() {
    closeModalHelper(document.getElementById('folderModal'));
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
    try {
        localStorage.removeItem('auth_token');
        sessionStorage.clear();
        await fetch('/api/logout', {
            method: 'POST',
            cache: 'no-store',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' }
        });
    } catch (e) {
        console.error('Logout error:', e);
    }

    try {
        document.cookie = 'auth_token=; Path=/; Expires=Thu, 01 Jan 1970 00:00:01 GMT; Max-Age=0; SameSite=Lax';
        document.cookie = 'auth_token=; Path=/; Expires=Thu, 01 Jan 1970 00:00:01 GMT; Max-Age=0; SameSite=Lax; Secure';
        document.cookie = 'auth_token=; Expires=Thu, 01 Jan 1970 00:00:01 GMT; Max-Age=0;';
    } catch (e) {}

    if (window.location.pathname.startsWith('/s/')) {
        window.location.href = window.location.pathname + '?_t=' + Date.now();
    } else {
        window.location.href = '/secure-admin?_t=' + Date.now();
    }
}

// ============================
// Добавление пользователя (Только для Admin)
// ============================
function openAddUserModal() {
    const modal = document.getElementById('addUserModal');
    if (!modal) {
        window.location.href = '/';
        return;
    }
    const inputUser = document.getElementById('newUsernameInput');
    const inputPass = document.getElementById('newUserPasswordInput');
    inputUser.value = '';
    inputPass.value = '';
    openModalHelper(modal, inputUser);
    loadUsers();
}

async function loadUsers() {
    const userList = document.getElementById('userList');
    if (!userList) return;

    try {
        const res = await fetch('/api/users');
        if (!res.ok) throw new Error('Failed to load users');
        let users = await res.json();
        if (!Array.isArray(users)) users = [];

        if (users.length === 0) {
            userList.innerHTML = '<div style="text-align: center; padding: 20px; color: var(--text-muted); font-size: 14px;">No users found</div>';
            return;
        }

        userList.innerHTML = users.map(user => `
            <div class="user-item">
                <div class="user-info-brief">
                    <span class="user-name-label">${escapeHtml(user.username)}</span>
                    <span class="user-date-label">Created: ${new Date(user.created_at).toLocaleDateString()}</span>
                </div>
                <div class="user-actions">
                    ${user.username !== 'admin' ? `
                        <button class="icon-btn danger" onclick="deleteUser(${user.id}, '${escapeJs(user.username)}')" title="Delete user" style="padding: 4px 8px;">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
                                <polyline points="3 6 5 6 21 6"/>
                                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                            </svg>
                        </button>
                    ` : '<span style="font-size: 11px; color: var(--accent); font-weight: 600; padding: 4px 8px;">System Admin</span>'}
                </div>
            </div>
        `).join('');
    } catch (err) {
        userList.innerHTML = `<div style="text-align: center; padding: 20px; color: var(--danger); font-size: 14px;">Error: ${err.message}</div>`;
    }
}

async function deleteUser(id, username) {
    if (!confirm(`Are you sure you want to delete user "${username}"?`)) return;

    try {
        const res = await fetch(`/api/users/${id}`, { method: 'DELETE' });
        const data = await res.json();

        if (res.ok) {
            showToast(`User "${username}" deleted`);
            loadUsers();
        } else {
            showToast(data.error || 'Error deleting user', 'error');
        }
    } catch (err) {
        showToast('Network error', 'error');
    }
}

function closeAddUserModal() {
    closeModalHelper(document.getElementById('addUserModal'));
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
            document.getElementById('newUsernameInput').value = '';
            document.getElementById('newUserPasswordInput').value = '';
            loadUsers();
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
// Настройки (Site Title, Debug Console)
// ============================
function openSettingsModal() {
    const modal = document.getElementById('settingsModal');
    if (!modal) {
        window.location.href = '/';
        return;
    }
    const input = document.getElementById('siteTitleInput');
    const debugCheckbox = document.getElementById('debugConsoleCheckbox');
    
    // подставим текущее значение
    input.value = document.title === 'Provideo Media Holding' || !document.title.includes(' — ')
        ? document.title
        : document.title.split(' — ')[1] || document.title;

    const logoTexts = document.querySelectorAll('.logo-text');
    if (logoTexts.length > 0) {
        input.value = logoTexts[0].textContent;
    }

    if (debugCheckbox) {
        debugCheckbox.checked = localStorage.getItem('debug_console_enabled') === 'true';
    }

    openModalHelper(modal, input);
}

function closeSettingsModal() {
    closeModalHelper(document.getElementById('settingsModal'));
}

async function saveSettings() {
    const siteTitle = document.getElementById('siteTitleInput').value.trim();
    if (!siteTitle) {
        showToast('Site title cannot be empty', 'error');
        return;
    }

    const debugCheckbox = document.getElementById('debugConsoleCheckbox');
    if (debugCheckbox && window.DebugConsole) {
        window.DebugConsole.setEnabled(debugCheckbox.checked);
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

            // Обновляем ограничение размера файла в подсказке
            if (data.max_file_size_gb || data.max_file_count) {
                const hint = document.getElementById('uploadHint');
                if (hint) {
                    const sizeText = data.max_file_size_gb ? `up to ${data.max_file_size_gb} GB` : 'up to 2 GB';
                    const countText = data.max_file_count ? `Up to ${data.max_file_count} files at once` : 'Up to 50 files at once';
                    hint.textContent = `Video and photo files ${sizeText} • ${countText}`;
                }
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
    const display = document.getElementById('usernameDisplay');
    const userProfileEl = document.getElementById('userProfile');
    const addUserBtn = document.getElementById('addUserBtn');
    const settingsBtn = document.getElementById('settingsBtn');
    const logoutBtn = document.getElementById('logoutBtn');
    const loginBtn = document.getElementById('loginBtn');
    const isSharePage = window.location.pathname.startsWith('/s/');

    try {
        const res = await fetch('/api/me', { cache: 'no-store' });
        if (res.ok) {
            const data = await res.json();
            if (data && data.username && data.authenticated) {
                if (display) display.textContent = data.username;
                if (userProfileEl) userProfileEl.style.display = 'inline-flex';
                if (logoutBtn) logoutBtn.style.display = 'inline-flex';
                if (loginBtn) loginBtn.style.display = 'none';

                // User management and settings buttons are STRICTLY for admin on the main dashboard only
                const isAdmin = !isSharePage && (data.is_admin === true || data.username === 'admin');
                if (isAdmin) {
                    if (addUserBtn) addUserBtn.style.display = 'inline-flex';
                    if (settingsBtn) settingsBtn.style.display = 'inline-flex';
                } else {
                    if (addUserBtn) addUserBtn.style.display = 'none';
                    if (settingsBtn) settingsBtn.style.display = 'none';
                }
                return;
            }
        }
    } catch {
        // ignore
    }

    // Unauthenticated
    if (isSharePage) {
        // On public share pages, completely hide the user profile & login/logout buttons for regular visitors
        if (userProfileEl) userProfileEl.style.display = 'none';
        if (addUserBtn) addUserBtn.style.display = 'none';
        if (settingsBtn) settingsBtn.style.display = 'none';
        if (logoutBtn) logoutBtn.style.display = 'none';
        if (loginBtn) loginBtn.style.display = 'none';
    } else {
        if (display) display.textContent = 'Guest';
        if (userProfileEl) userProfileEl.style.display = 'inline-flex';
        if (addUserBtn) addUserBtn.style.display = 'none';
        if (settingsBtn) settingsBtn.style.display = 'none';
        if (logoutBtn) logoutBtn.style.display = 'none';
        if (loginBtn) loginBtn.style.display = 'inline-flex';
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', loadUserProfile);
} else {
    loadUserProfile();
}

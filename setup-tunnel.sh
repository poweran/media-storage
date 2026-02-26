#!/bin/bash
# =============================================================
# Скрипт настройки Cloudflare Tunnel для Provideo Media Holding (Linux)
# =============================================================
# Использование:
#   chmod +x setup-tunnel.sh
#   ./setup-tunnel.sh
#
# Или с параметрами:
#   ./setup-tunnel.sh --domain video.example.com --port 3000
# =============================================================

set -e

# Цвета
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

log()   { echo -e "${GREEN}[✓]${NC} $1"; }
warn()  { echo -e "${YELLOW}[!]${NC} $1"; }
err()   { echo -e "${RED}[✗]${NC} $1"; }
info()  { echo -e "${CYAN}[→]${NC} $1"; }

# Параметры по умолчанию
TUNNEL_NAME="media-storage"
PORT=3000
DOMAIN=""

# Парсинг аргументов
while [[ $# -gt 0 ]]; do
  case $1 in
    --domain) DOMAIN="$2"; shift 2 ;;
    --port)   PORT="$2"; shift 2 ;;
    --name)   TUNNEL_NAME="$2"; shift 2 ;;
    *) err "Неизвестный параметр: $1"; exit 1 ;;
  esac
done

echo ""
echo -e "${CYAN}╔══════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║   Cloudflare Tunnel — Provideo Media Holding      ║${NC}"
echo -e "${CYAN}╚══════════════════════════════════════════╝${NC}"
echo ""

# =============================================================
# 1. Установка cloudflared
# =============================================================
if command -v cloudflared &> /dev/null; then
    log "cloudflared уже установлен ($(cloudflared --version 2>&1 | head -1))"
else
    info "Устанавливаю cloudflared..."

    ARCH=$(dpkg --print-architecture 2>/dev/null || echo "amd64")

    if command -v dpkg &> /dev/null; then
        # Debian/Ubuntu — скачиваем .deb напрямую с GitHub
        info "Скачиваю .deb пакет для ${ARCH}..."
        curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${ARCH}.deb" \
            -o /tmp/cloudflared.deb
        sudo dpkg -i /tmp/cloudflared.deb
        rm -f /tmp/cloudflared.deb
    elif command -v rpm &> /dev/null; then
        # Fedora/RHEL/CentOS — скачиваем .rpm
        RPM_ARCH=$(uname -m)
        info "Скачиваю .rpm пакет для ${RPM_ARCH}..."
        curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${RPM_ARCH}.rpm" \
            -o /tmp/cloudflared.rpm
        sudo rpm -i /tmp/cloudflared.rpm || sudo dnf install -y /tmp/cloudflared.rpm
        rm -f /tmp/cloudflared.rpm
    else
        # Универсальный способ — бинарник
        info "Скачиваю бинарник для ${ARCH}..."
        curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${ARCH}" \
            -o /tmp/cloudflared
        sudo install /tmp/cloudflared /usr/local/bin/cloudflared
        rm -f /tmp/cloudflared
    fi

    log "cloudflared установлен"
fi

# =============================================================
# 2. Быстрый режим (без домена)
# =============================================================
if [ -z "$DOMAIN" ]; then
    warn "Домен не указан (--domain)"
    echo ""
    echo "  Доступные варианты:"
    echo ""
    echo -e "  ${CYAN}1)${NC} Быстрый туннель (временный URL, без настройки)"
    echo -e "  ${CYAN}2)${NC} Полная настройка с доменом"
    echo ""
    read -rp "  Выберите вариант [1/2]: " CHOICE

    if [ "$CHOICE" = "1" ]; then
        echo ""
        log "Запускаю быстрый туннель на порт ${PORT}..."
        info "Нажмите Ctrl+C для остановки"
        echo ""
        cloudflared tunnel --url "http://localhost:${PORT}"
        exit 0
    fi

    echo ""
    read -rp "  Введите домен (например, video.example.com): " DOMAIN
    if [ -z "$DOMAIN" ]; then
        err "Домен обязателен для полной настройки"
        exit 1
    fi
fi

# =============================================================
# 3. Авторизация в Cloudflare
# =============================================================
if [ ! -f "$HOME/.cloudflared/cert.pem" ]; then
    info "Авторизация в Cloudflare..."
    warn "Откроется браузер — выберите домен и подтвердите"
    echo ""
    cloudflared tunnel login
    log "Авторизация успешна"
else
    log "Авторизация уже выполнена"
fi

# =============================================================
# 4. Создание туннеля
# =============================================================
EXISTING=$(cloudflared tunnel list -o json 2>/dev/null | python3 -c "
import sys, json
tunnels = json.load(sys.stdin)
for t in tunnels:
    if t['name'] == '${TUNNEL_NAME}':
        print(t['id'])
        break
" 2>/dev/null || echo "")

if [ -n "$EXISTING" ]; then
    TUNNEL_ID="$EXISTING"
    log "Туннель '${TUNNEL_NAME}' уже существует (ID: ${TUNNEL_ID})"
else
    info "Создаю туннель '${TUNNEL_NAME}'..."
    TUNNEL_ID=$(cloudflared tunnel create "${TUNNEL_NAME}" 2>&1 | grep -oP '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}')
    log "Туннель создан (ID: ${TUNNEL_ID})"
fi

# =============================================================
# 5. DNS запись
# =============================================================
info "Настраиваю DNS: ${DOMAIN} → туннель..."
cloudflared tunnel route dns "${TUNNEL_NAME}" "${DOMAIN}" 2>/dev/null || \
    warn "DNS запись уже существует или не удалось создать — проверьте в панели Cloudflare"

# =============================================================
# 6. Конфиг
# =============================================================
CONFIG_DIR="$HOME/.cloudflared"
CONFIG_FILE="${CONFIG_DIR}/config.yml"
CRED_FILE=$(find "${CONFIG_DIR}" -name "${TUNNEL_ID}.json" 2>/dev/null | head -1)

if [ -z "$CRED_FILE" ]; then
    CRED_FILE="${CONFIG_DIR}/${TUNNEL_ID}.json"
fi

cat > "${CONFIG_FILE}" << EOF
tunnel: ${TUNNEL_ID}
credentials-file: ${CRED_FILE}

ingress:
  - hostname: ${DOMAIN}
    service: http://localhost:${PORT}
  - service: http_status:404
EOF

log "Конфиг создан: ${CONFIG_FILE}"

# =============================================================
# 7. Systemd сервис
# =============================================================
echo ""
read -rp "Установить как systemd сервис (автозапуск)? [y/N]: " INSTALL_SERVICE

if [[ "$INSTALL_SERVICE" =~ ^[Yy]$ ]]; then
    sudo cloudflared --config "${CONFIG_FILE}" service install
    sudo systemctl enable cloudflared
    sudo systemctl start cloudflared
    log "Сервис установлен и запущен"
    info "Управление: sudo systemctl {start|stop|restart|status} cloudflared"
fi

# =============================================================
# Готово
# =============================================================
echo ""
echo -e "${GREEN}╔══════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║            Настройка завершена!          ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════╝${NC}"
echo ""
echo -e "  Домен:    ${CYAN}https://${DOMAIN}${NC}"
echo -e "  Туннель:  ${CYAN}${TUNNEL_NAME}${NC} (${TUNNEL_ID})"
echo -e "  Порт:     ${CYAN}${PORT}${NC}"
echo -e "  Конфиг:   ${CYAN}${CONFIG_FILE}${NC}"
echo ""
echo "  Запуск вручную:"
echo -e "    ${YELLOW}cloudflared tunnel run ${TUNNEL_NAME}${NC}"
echo ""

if [[ ! "$INSTALL_SERVICE" =~ ^[Yy]$ ]]; then
    read -rp "Запустить туннель сейчас? [Y/n]: " RUN_NOW
    if [[ ! "$RUN_NOW" =~ ^[Nn]$ ]]; then
        info "Запускаю туннель..."
        cloudflared tunnel run "${TUNNEL_NAME}"
    fi
fi

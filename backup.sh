#!/usr/bin/env bash
# SSB 交易所数据库备份工具
# 用法:
#   ./backup.sh         在当前目录创建本地备份
#   ./backup.sh pull    从显式配置的服务器拉取数据库并保存为本地异地备份
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BACKUP_DIR="$SCRIPT_DIR/backups"
DATA_DIR="$SCRIPT_DIR/data"
DB_FILE="$DATA_DIR/ssb.sqlite"
TIMESTAMP="$(date +%Y%m%d_%H%M%S)"
KEEP_DAYS=7

# 远程备份信息只从本地环境变量读取，避免把部署信息写入仓库。
SERVER_HOST="${SSB_SERVER_HOST:-}"
SERVER_DB="${SSB_SERVER_DB:-}"
SSH_KEY_FILE="${SSB_SSH_KEY:-}"
SSH_OPTS=(-o ConnectTimeout=10)

if [[ -n "$SSH_KEY_FILE" && -f "$SSH_KEY_FILE" ]]; then
  SSH_OPTS+=(-i "$SSH_KEY_FILE" -o IdentitiesOnly=yes)
fi

mkdir -p "$BACKUP_DIR"

backup_local() {
  if [[ ! -f "$DB_FILE" ]]; then
    echo "[跳过] 本地无数据库文件: $DB_FILE"
    return 0
  fi
  local target="$BACKUP_DIR/ssb_${TIMESTAMP}.sqlite"
  cp "$DB_FILE" "$target"
  echo "[完成] 本地备份: $target ($(du -h "$target" | cut -f1))"
}

rotate_backups() {
  local count
  count=$(ls -1 "$BACKUP_DIR"/ssb_*.sqlite 2>/dev/null | wc -l | tr -d ' ')
  if [[ $count -le $KEEP_DAYS ]]; then return; fi
  ls -1t "$BACKUP_DIR"/ssb_*.sqlite | tail -n +$((KEEP_DAYS + 1)) | while read -r old; do
    echo "[清理] 删除旧备份: $(basename "$old")"
    rm -f "$old"
  done
}

pull_from_server() {
  if [[ -z "$SERVER_HOST" || -z "$SERVER_DB" ]]; then
    echo "[失败] 请先设置 SSB_SERVER_HOST 和 SSB_SERVER_DB"
    return 1
  fi
  echo "[开始] 从服务器拉取数据库..."
  if ! ssh "${SSH_OPTS[@]}" "$SERVER_HOST" "test -f $SERVER_DB"; then
    echo "[失败] 无法连接服务器或找不到数据库文件"
    return 1
  fi
  local target="$BACKUP_DIR/ssb_remote_${TIMESTAMP}.sqlite"
  scp "${SSH_OPTS[@]}" "$SERVER_HOST:$SERVER_DB" "$target"
  echo "[完成] 远程备份: $target ($(du -h "$target" | cut -f1))"
}

case "${1:-local}" in
  pull|remote) pull_from_server ;;
  *) backup_local ;;
esac

rotate_backups
echo "[完成] 备份目录: $BACKUP_DIR"

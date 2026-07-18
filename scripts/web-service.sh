#!/usr/bin/env bash
#
# 家庭游戏管家 Web 服务管理脚本
#
# 用法：
#   ./scripts/web-service.sh start     # 后台启动
#   ./scripts/web-service.sh stop      # 停止
#   ./scripts/web-service.sh restart   # 重启
#   ./scripts/web-service.sh status    # 查看状态
#   ./scripts/web-service.sh logs      # 跟踪日志（Ctrl+C 退出）
#
# 环境变量（可选，透传给服务）：
#   WEB_PORT   监听端口，默认 8787
#   WEB_HOST   监听地址，默认 0.0.0.0
#
set -euo pipefail

# 定位项目根目录（脚本所在目录的上一级）
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${ROOT_DIR}"

RUN_DIR="${ROOT_DIR}/.run"
PID_FILE="${RUN_DIR}/web.pid"
LOG_FILE="${RUN_DIR}/web.log"
PORT="${WEB_PORT:-8787}"

mkdir -p "${RUN_DIR}"

# 返回占用 Web 端口的监听进程 PID。
listener_pid() {
  command -v lsof >/dev/null 2>&1 || return 1
  lsof -nP -tiTCP:"${PORT}" -sTCP:LISTEN 2>/dev/null | head -n 1
}

# 防止误停其他恰好占用同一端口的服务。
is_our_process() {
  local pid="$1" command cwd
  command="$(ps -p "${pid}" -o command= 2>/dev/null || true)"
  cwd="$(lsof -a -p "${pid}" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -n 1)"
  [[ "${command}" == *"src/web/start-web.ts"* && "${cwd}" == "${ROOT_DIR}" ]]
}

# 优先读取 PID 文件；文件丢失时，从监听端口恢复服务 PID。
running_pid() {
  local pid=""
  if [[ -f "${PID_FILE}" ]]; then
    pid="$(cat "${PID_FILE}" 2>/dev/null || true)"
    if [[ -n "${pid}" ]] && kill -0 "${pid}" 2>/dev/null && is_our_process "${pid}"; then
      echo "${pid}"
      return 0
    fi
    rm -f "${PID_FILE}"
  fi

  pid="$(listener_pid || true)"
  if [[ -n "${pid}" ]] && is_our_process "${pid}"; then
    echo "${pid}" >"${PID_FILE}"
    echo "${pid}"
    return 0
  fi
  return 1
}

start() {
  local pid occupied_pid
  if pid="$(running_pid)"; then
    echo "Web 服务已在运行 (PID ${pid})，端口 ${PORT}。"
    return 0
  fi

  occupied_pid="$(listener_pid || true)"
  if [[ -n "${occupied_pid}" ]]; then
    echo "启动失败：端口 ${PORT} 已被其他进程占用 (PID ${occupied_pid})。" >&2
    return 1
  fi

  echo "正在启动 Web 服务…"
  # 直接启动单一 Node 进程，使 PID 文件准确指向 Web 服务进程。
  nohup node --import tsx src/web/start-web.ts >>"${LOG_FILE}" 2>&1 &
  pid=$!
  echo "${pid}" >"${PID_FILE}"

  sleep 2
  if kill -0 "${pid}" 2>/dev/null && [[ "$(listener_pid || true)" == "${pid}" ]]; then
    echo "启动成功 (PID ${pid})，端口 ${PORT}，日志：${LOG_FILE}"
  else
    echo "启动失败，请查看日志：${LOG_FILE}" >&2
    rm -f "${PID_FILE}"
    return 1
  fi
}

stop() {
  if ! pid="$(running_pid)"; then
    echo "Web 服务未在运行。"
    rm -f "${PID_FILE}"
    return 0
  fi

  echo "正在停止 Web 服务 (PID ${pid})…"
  # PID 直接对应 Node 服务进程，SIGTERM 会触发应用的优雅关闭逻辑。
  kill -TERM "${pid}" 2>/dev/null || true

  # 最多等待 10 秒优雅退出，超时强杀。
  for _ in $(seq 1 10); do
    if ! kill -0 "${pid}" 2>/dev/null; then
      break
    fi
    sleep 1
  done
  if kill -0 "${pid}" 2>/dev/null; then
    echo "优雅退出超时，强制结束。"
    kill -KILL "${pid}" 2>/dev/null || true
  fi

  rm -f "${PID_FILE}"
  echo "已停止。"
}

status() {
  if pid="$(running_pid)"; then
    echo "运行中：PID ${pid}，端口 ${PORT}"
  else
    echo "未运行。"
    return 1
  fi
}

logs() {
  if [[ ! -f "${LOG_FILE}" ]]; then
    echo "暂无日志文件：${LOG_FILE}"
    return 1
  fi
  tail -f "${LOG_FILE}"
}

case "${1:-}" in
  start)   start ;;
  stop)    stop ;;
  restart) stop; sleep 1; start ;;
  status)  status ;;
  logs)    logs ;;
  *)
    echo "用法: $0 {start|stop|restart|status|logs}" >&2
    exit 1
    ;;
esac

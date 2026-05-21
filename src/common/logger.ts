type LogMeta = Record<string, unknown>;

function log(level: string, message: string, meta?: LogMeta): void {
  const payload = {
    level,
    time: new Date().toISOString(),
    message,
    ...(meta && Object.keys(meta).length > 0 ? { meta } : {}),
  };
  console.log(JSON.stringify(payload));
}

export const logger = {
  info(message: string, meta?: LogMeta) {
    log('info', message, meta);
  },
  warn(message: string, meta?: LogMeta) {
    log('warn', message, meta);
  },
  error(message: string, meta?: LogMeta) {
    log('error', message, meta);
  },
};

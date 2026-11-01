export interface Logger {
  debug(obj: unknown, msg: string): void;
  info(obj: unknown, msg: string): void;
  warn(obj: unknown, msg: string): void;
  error(obj: unknown, msg: string): void;
}

const emit = (level: string, obj: unknown, msg: string): void => {
  if (process.env.LOG_LEVEL === "silent") return;
  const extra = obj && typeof obj === "object" ? obj : obj === undefined ? {} : { value: obj };
  process.stderr.write(JSON.stringify({ t: new Date().toISOString(), level, msg, ...extra }) + "\n");
};

/** Logs go to stderr so stdout stays parseable JSON. */
export function createLogger(): Logger {
  return {
    debug: (o, m) => process.env.LOG_LEVEL === "debug" && emit("debug", o, m),
    info: (o, m) => emit("info", o, m),
    warn: (o, m) => emit("warn", o, m),
    error: (o, m) => emit("error", o, m),
  };
}

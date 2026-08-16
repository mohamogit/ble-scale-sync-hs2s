export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
  SILENT = 4,
}

let currentLevel = process.env.DEBUG ? LogLevel.DEBUG : LogLevel.INFO;

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

/**
 * Whether debug output is on. Lets a caller skip work whose only purpose is a
 * debug line (for example extra D-Bus property reads), which the per-message
 * level check inside the logger cannot avoid.
 */
export function isDebugEnabled(): boolean {
  return currentLevel <= LogLevel.DEBUG;
}

export interface Logger {
  debug(msg: string): void;
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export function createLogger(scope: string): Logger {
  const prefix = `[${scope}]`;
  const debugPrefix = `[${scope}:debug]`;
  const timestamp = (): string => {
    // Show local America/Los_Angeles for readability; journalctl already shows local, but app log was UTC causing 7h confusion (03:34Z vs 20:34 PDT)
    try {
      const tz = process.env.TZ || 'America/Los_Angeles';
      const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false });
      const parts = Object.fromEntries(fmt.formatToParts(new Date()).map(p=>[p.type,p.value]));
      return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
    } catch {
      return new Date().toISOString().replace('T', ' ').replace('Z', '');
    }
  };
  const fmt = (pfx: string, msg: string): string => {
    const ts = timestamp();
    const nl = msg.match(/^(\n+)/);
    return nl ? `${nl[1]}${ts} ${pfx} ${msg.slice(nl[1].length)}` : `${ts} ${pfx} ${msg}`;
  };
  return {
    debug: (msg) => {
      if (currentLevel <= LogLevel.DEBUG) console.log(fmt(debugPrefix, msg));
    },
    info: (msg) => {
      if (currentLevel <= LogLevel.INFO) console.log(fmt(prefix, msg));
    },
    warn: (msg) => {
      if (currentLevel <= LogLevel.WARN) console.warn(fmt(prefix, msg));
    },
    error: (msg) => {
      if (currentLevel <= LogLevel.ERROR) console.error(fmt(prefix, msg));
    },
  };
}

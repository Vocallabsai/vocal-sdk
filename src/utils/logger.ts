/**
 * Logger Utility
 * Handles logging throughout the SDK
 */

export type LogLevel = 'info' | 'warning' | 'error' | 'debug';

export class Logger {
  private enableLogs: boolean;
  private prefix: string;
  private logCallback?: (message: string, level: LogLevel) => void;

  constructor(enableLogs: boolean = true, prefix: string = '[SubspaceCallSDK]') {
    this.enableLogs = enableLogs;
    this.prefix = prefix;
  }

  setLogCallback(callback: (message: string, level: LogLevel) => void) {
    this.logCallback = callback;
  }

  setEnabled(enabled: boolean) {
    this.enableLogs = enabled;
  }

  info(message: string, ...args: any[]) {
    this.log('info', message, ...args);
  }

  warning(message: string, ...args: any[]) {
    this.log('warning', message, ...args);
  }

  error(message: string, ...args: any[]) {
    this.log('error', message, ...args);
  }

  debug(message: string, ...args: any[]) {
    this.log('debug', message, ...args);
  }

  private log(level: LogLevel, message: string, ...args: any[]) {
    if (!this.enableLogs && level !== 'error') return;

    const formattedMessage = `${this.prefix} [${level.toUpperCase()}] ${message}`;

    // Console output
    switch (level) {
      case 'error':
        console.error(formattedMessage, ...args);
        break;
      case 'warning':
        console.warn(formattedMessage, ...args);
        break;
      case 'info':
      case 'debug':
      default:
        console.log(formattedMessage, ...args);
        break;
    }

    // Custom callback
    if (this.logCallback) {
      this.logCallback(message, level);
    }
  }
}

export const createLogger = (enableLogs: boolean, prefix?: string) => {
  return new Logger(enableLogs, prefix);
};

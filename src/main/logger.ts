import crypto from 'crypto';
import type { LogEntry } from '../shared/types';

type LogListener = (entry: LogEntry) => void;

const MAX_LOGS = 400;

class AppLogger {
  private entries: LogEntry[] = [];
  private listeners = new Set<LogListener>();

  public add(
    level: LogEntry['level'],
    source: LogEntry['source'],
    message: string
  ): LogEntry {
    const entry: LogEntry = {
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      level,
      source,
      message: message.trim(),
    };
    this.entries.push(entry);
    if (this.entries.length > MAX_LOGS) {
      this.entries = this.entries.slice(-MAX_LOGS);
    }
    for (const listener of this.listeners) {
      try {
        listener(entry);
      } catch {
        // Ignore listener errors when window is closing
      }
    }
    return entry;
  }

  public info(source: LogEntry['source'], message: string): void {
    this.add('info', source, message);
  }

  public success(source: LogEntry['source'], message: string): void {
    this.add('success', source, message);
  }

  public warn(source: LogEntry['source'], message: string): void {
    this.add('warn', source, message);
  }

  public error(source: LogEntry['source'], message: string): void {
    this.add('error', source, message);
  }

  public getAll(): LogEntry[] {
    return [...this.entries];
  }

  public clear(): void {
    this.entries = [];
  }

  public subscribe(listener: LogListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

export const logger = new AppLogger();

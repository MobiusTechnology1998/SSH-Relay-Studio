import { app } from 'electron';
import fs from 'fs';
import path from 'path';
import type { AppSettings, NodeProfile } from '../shared/types';

export function getDefaultSettings(): AppSettings {
  return {
    role: 'unset',
    nodes: [],
    activeNodeId: null,
    autoStart: false,
    autoConnectOnLaunch: false,
    minimizeToTray: true,
    browser: {
      selectedBrowser: 'edge',
      customBrowserPath: '',
      userDataDir: '',
      useHostResolverRules: false,
      disableQuic: true,
      startUrl: 'https://ipinfo.io',
    },
    serverPrefs: {
      targetPort: 53622,
      useAdminAuthorizedKeys: true,
      customAuthorizedKeysPath: '',
    },
  };
}

class SettingsStore {
  private cache: AppSettings | null = null;

  private get filePath(): string {
    return path.join(app.getPath('userData'), 'relay-settings.json');
  }

  public load(): AppSettings {
    if (this.cache) return this.cache;
    const defaults = getDefaultSettings();
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf8');
        const parsed = JSON.parse(raw) as Partial<AppSettings>;
        this.cache = {
          ...defaults,
          ...parsed,
          browser: {
            ...defaults.browser,
            ...(parsed.browser ?? {}),
          },
          serverPrefs: {
            ...defaults.serverPrefs,
            ...(parsed.serverPrefs ?? {}),
          },
          nodes: Array.isArray(parsed.nodes) ? parsed.nodes : [],
        };
        return this.cache;
      }
    } catch {
      // Fallback to defaults if corrupted
    }
    this.cache = defaults;
    return this.cache;
  }

  public save(next: AppSettings): AppSettings {
    this.cache = next;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(next, null, 2), 'utf8');
    } catch (err) {
      console.error('Failed to persist settings:', err);
    }
    return this.cache;
  }

  public update(patch: Partial<AppSettings>): AppSettings {
    const current = this.load();
    const merged: AppSettings = {
      ...current,
      ...patch,
      browser: patch.browser ? { ...current.browser, ...patch.browser } : current.browser,
      serverPrefs: patch.serverPrefs
        ? { ...current.serverPrefs, ...patch.serverPrefs }
        : current.serverPrefs,
    };
    return this.save(merged);
  }

  public getActiveNode(): NodeProfile | null {
    const settings = this.load();
    if (!settings.nodes.length) return null;
    if (settings.activeNodeId) {
      const found = settings.nodes.find((n) => n.id === settings.activeNodeId);
      if (found) return found;
    }
    return settings.nodes[0];
  }
}

export const settingsStore = new SettingsStore();

export interface ParsedSshdConfig {
  port: number;
  pubkeyAuthentication: boolean;
  passwordAuthentication: boolean;
  hasMatchAdminBlock: boolean;
}

export interface SshdConfigUpdate {
  port: number;
  pubkeyAuthentication: boolean;
  passwordAuthentication: boolean;
}

const MATCH_LINE_RE = /^\s*Match\s+/i;

/**
 * Parse key directives from Windows OpenSSH sshd_config.
 * Only inspects global section (lines prior to any `Match` block) for Port,
 * PubkeyAuthentication, and PasswordAuthentication.
 */
export function parseSshdConfig(content: string): ParsedSshdConfig {
  const lines = content.split(/\r?\n/);
  let port = 22;
  let pubkeyAuthentication = true; // OpenSSH default is yes
  let passwordAuthentication = true; // OpenSSH default is yes
  let hasMatchAdminBlock = false;
  let inMatchBlock = false;

  for (const line of lines) {
    if (MATCH_LINE_RE.test(line)) {
      inMatchBlock = true;
      if (/^\s*Match\s+Group\s+administrators\b/i.test(line)) {
        hasMatchAdminBlock = true;
      }
      continue;
    }

    if (inMatchBlock) continue;

    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const portMatch = trimmed.match(/^Port\s+(\d+)\b/i);
    if (portMatch) {
      const parsed = Number.parseInt(portMatch[1], 10);
      if (parsed >= 1 && parsed <= 65535) {
        port = parsed;
      }
      continue;
    }

    const pubkeyMatch = trimmed.match(/^PubkeyAuthentication\s+(yes|no)\b/i);
    if (pubkeyMatch) {
      pubkeyAuthentication = pubkeyMatch[1].toLowerCase() === 'yes';
      continue;
    }

    const passMatch = trimmed.match(/^PasswordAuthentication\s+(yes|no)\b/i);
    if (passMatch) {
      passwordAuthentication = passMatch[1].toLowerCase() === 'yes';
      continue;
    }
  }

  return {
    port,
    pubkeyAuthentication,
    passwordAuthentication,
    hasMatchAdminBlock,
  };
}

/**
 * Safely updates Port, PubkeyAuthentication, and PasswordAuthentication in sshd_config.
 * - Replaces existing active or commented directive lines in the global section (before any `Match` block).
 * - Preserves `Match Group administrators` and all unrelated comments/directives intact.
 * - Inserts missing directives right before the first `Match` block (never inside a `Match` block).
 */
export function updateSshdConfig(content: string, update: SshdConfigUpdate): string {
  if (!Number.isInteger(update.port) || update.port < 1 || update.port > 65535) {
    throw new Error(`无效端口号: ${update.port}，有效范围为 1-65535`);
  }

  const newline = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = content.split(/\r?\n/);

  let firstMatchIdx = lines.findIndex((line) => MATCH_LINE_RE.test(line));
  if (firstMatchIdx === -1) {
    firstMatchIdx = lines.length;
  }

  const globalLines = lines.slice(0, firstMatchIdx);
  const tailLines = lines.slice(firstMatchIdx);

  const directives: Array<{
    key: string;
    activeRe: RegExp;
    commentedRe: RegExp;
    newLine: string;
  }> = [
    {
      key: 'Port',
      activeRe: /^\s*Port\s+\S+/i,
      commentedRe: /^\s*#\s*Port\s+\S+/i,
      newLine: `Port ${update.port}`,
    },
    {
      key: 'PubkeyAuthentication',
      activeRe: /^\s*PubkeyAuthentication\s+\S+/i,
      commentedRe: /^\s*#\s*PubkeyAuthentication\s+\S+/i,
      newLine: `PubkeyAuthentication ${update.pubkeyAuthentication ? 'yes' : 'no'}`,
    },
    {
      key: 'PasswordAuthentication',
      activeRe: /^\s*PasswordAuthentication\s+\S+/i,
      commentedRe: /^\s*#\s*PasswordAuthentication\s+\S+/i,
      newLine: `PasswordAuthentication ${update.passwordAuthentication ? 'yes' : 'no'}`,
    },
  ];

  const missing: string[] = [];

  for (const dir of directives) {
    // 1. Prefer replacing active uncommented line(s)
    const activeIndices: number[] = [];
    for (let i = 0; i < globalLines.length; i++) {
      if (dir.activeRe.test(globalLines[i])) {
        activeIndices.push(i);
      }
    }

    if (activeIndices.length > 0) {
      globalLines[activeIndices[0]] = dir.newLine;
      // Comment out duplicate active directives (e.g., multiple Port lines)
      for (let j = 1; j < activeIndices.length; j++) {
        globalLines[activeIndices[j]] = `# ${globalLines[activeIndices[j]].trim()} # disabled by SSH Relay Studio`;
      }
      continue;
    }

    // 2. Otherwise uncomment & replace the first commented template line (e.g. `#Port 22`)
    const commentedIdx = globalLines.findIndex((l) => dir.commentedRe.test(l));
    if (commentedIdx !== -1) {
      globalLines[commentedIdx] = dir.newLine;
      continue;
    }

    // 3. Otherwise queue for insertion before Match block
    missing.push(dir.newLine);
  }

  if (missing.length > 0) {
    // Trim trailing blank lines of global section before inserting
    while (globalLines.length > 0 && globalLines[globalLines.length - 1].trim() === '') {
      globalLines.pop();
    }
    if (globalLines.length > 0) {
      globalLines.push('');
    }
    globalLines.push('# Added by SSH Relay Studio');
    globalLines.push(...missing);
    if (tailLines.length > 0) {
      globalLines.push('');
    }
  }

  const combined = [...globalLines, ...tailLines].join(newline);
  return combined.endsWith(newline) ? combined : combined + newline;
}

import type { AuthorizedKeyEntry } from './types';

const VALID_KEY_TYPES = new Set([
  'ssh-ed25519',
  'ssh-rsa',
  'ecdsa-sha2-nistp256',
  'ecdsa-sha2-nistp384',
  'ecdsa-sha2-nistp521',
  'sk-ssh-ed25519@openssh.com',
  'sk-ecdsa-sha2-nistp256@openssh.com',
]);

/**
 * Pure JavaScript SHA-256 fingerprint helper using a provided digest function or fallback.
 * Note: In Node.js main process we pass crypto.createHash('sha256').
 */
export type Sha256Base64Fn = (base64KeyData: string) => string;

export function normalizePublicKeyLine(input: string): {
  keyType: string;
  keyData: string;
  comment: string;
  normalized: string;
} | null {
  const cleaned = input.replace(/^\uFEFF/, '').trim();
  if (!cleaned || cleaned.startsWith('#')) {
    return null;
  }

  const parts = cleaned.split(/\s+/);
  if (parts.length < 2) {
    return null;
  }

  // Handle optional authorized_keys options prefix before key type
  let typeIdx = 0;
  while (typeIdx < parts.length && !VALID_KEY_TYPES.has(parts[typeIdx])) {
    typeIdx++;
  }
  if (typeIdx >= parts.length - 1) {
    return null;
  }

  const keyType = parts[typeIdx];
  const keyData = parts[typeIdx + 1];
  const comment = parts.slice(typeIdx + 2).join(' ');

  // Basic base64 sanity check
  if (!/^[A-Za-z0-9+/=]{20,}$/.test(keyData)) {
    return null;
  }

  const normalized = comment ? `${keyType} ${keyData} ${comment}` : `${keyType} ${keyData}`;
  return { keyType, keyData, comment, normalized };
}

export function parseAuthorizedKeys(
  content: string,
  fingerprintFn?: Sha256Base64Fn
): AuthorizedKeyEntry[] {
  const lines = content.replace(/^\uFEFF/, '').split(/\r?\n/);
  const entries: AuthorizedKeyEntry[] = [];

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (!raw || raw.startsWith('#')) continue;
    const parsed = normalizePublicKeyLine(raw);
    if (!parsed) continue;

    const fingerprint = fingerprintFn
      ? fingerprintFn(parsed.keyData)
      : `key:${parsed.keyData.slice(0, 16)}...`;

    entries.push({
      id: `${parsed.keyType}:${parsed.keyData.slice(0, 24)}:${i}`,
      keyType: parsed.keyType,
      keyData: parsed.keyData,
      comment: parsed.comment || '未命名设备',
      fingerprint,
      rawLine: raw,
    });
  }

  return entries;
}

/**
 * Appends a new SSH public key to existing authorized_keys content without overwriting
 * existing keys or creating duplicates. Returns UTF-8 LF text (no BOM).
 */
export function appendAuthorizedKey(
  existingContent: string,
  newPublicKey: string,
  overrideComment?: string
): { content: string; added: boolean; duplicate: boolean } {
  const parsed = normalizePublicKeyLine(newPublicKey);
  if (!parsed) {
    throw new Error('公钥格式无效，请粘贴完整的 ssh-ed25519 或 ssh-rsa 公钥文本');
  }

  const cleanExisting = existingContent.replace(/^\uFEFF/, '');
  const existingLines = cleanExisting
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l, idx, arr) => !(idx === arr.length - 1 && l === ''));

  for (const line of existingLines) {
    const existingParsed = normalizePublicKeyLine(line);
    if (
      existingParsed &&
      existingParsed.keyType === parsed.keyType &&
      existingParsed.keyData === parsed.keyData
    ) {
      const preserved = existingLines.length > 0 ? existingLines.join('\n') + '\n' : '';
      return { content: preserved, added: false, duplicate: true };
    }
  }

  const finalComment = (overrideComment?.trim() || parsed.comment).trim();
  const newLine = finalComment
    ? `${parsed.keyType} ${parsed.keyData} ${finalComment}`
    : `${parsed.keyType} ${parsed.keyData}`;

  const updatedLines = [...existingLines.filter((l) => l.trim().length > 0), newLine];
  return {
    content: updatedLines.join('\n') + '\n',
    added: true,
    duplicate: false,
  };
}

/**
 * Removes a public key matching the given keyData from authorized_keys content.
 */
export function removeAuthorizedKey(existingContent: string, keyDataToRemove: string): string {
  const cleanExisting = existingContent.replace(/^\uFEFF/, '');
  const lines = cleanExisting.split(/\r?\n/);
  const remaining = lines.filter((line) => {
    const trimmed = line.trim();
    if (!trimmed) return false;
    const parsed = normalizePublicKeyLine(trimmed);
    if (!parsed) return true; // Keep comments or unknown lines intact
    return parsed.keyData !== keyDataToRemove;
  });

  return remaining.length > 0 ? remaining.join('\n') + '\n' : '';
}

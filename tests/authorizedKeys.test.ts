import { describe, expect, it } from 'vitest';
import {
  appendAuthorizedKey,
  parseAuthorizedKeys,
  removeAuthorizedKey,
} from '../src/shared/authorizedKeys';

const KEY_1 =
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMockKeyDataOne1234567890ABCDEFGHIJKL deviceA@work';
const KEY_2 =
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMockKeyDataTwo9876543210ZYXWVUTSRQPO deviceA2@home';

describe('authorizedKeys', () => {
  it('appends new key without overwriting existing keys and strips BOM', () => {
    const initialWithBom = `\uFEFF${KEY_1}\r\n`;
    const res = appendAuthorizedKey(initialWithBom, KEY_2);
    expect(res.added).toBe(true);
    expect(res.duplicate).toBe(false);
    expect(res.content.startsWith('\uFEFF')).toBe(false);

    const parsed = parseAuthorizedKeys(res.content);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].comment).toBe('deviceA@work');
    expect(parsed[1].comment).toBe('deviceA2@home');
  });

  it('deduplicates identical public keys', () => {
    const res = appendAuthorizedKey(`${KEY_1}\n`, KEY_1);
    expect(res.added).toBe(false);
    expect(res.duplicate).toBe(true);
    expect(parseAuthorizedKeys(res.content)).toHaveLength(1);
  });

  it('removes a specific key while keeping others intact', () => {
    const combined = `${KEY_1}\n${KEY_2}\n`;
    const parsed = parseAuthorizedKeys(combined);
    const afterRemove = removeAuthorizedKey(combined, parsed[0].keyData);
    const remaining = parseAuthorizedKeys(afterRemove);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].comment).toBe('deviceA2@home');
  });

  it('rejects malformed public keys', () => {
    expect(() => appendAuthorizedKey('', 'not-a-valid-key')).toThrow();
  });
});

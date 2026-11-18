// The API key for a model service on the network. It is typed once in the settings window, kept
// encrypted with the operating system's keychain (Keychain on macOS, DPAPI on Windows, the secret
// service on Linux) and only ever read back inside the main process: no window, log or settings
// view gets it.
import { safeStorage } from 'electron';

/**
 * How well the stored key is protected on this machine.
 * 'keychain': encrypted with a key the operating system guards.
 * 'file':     no keychain to use (some Linux sessions). The key is then only as safe as the
 *             settings file, which is readable by this user alone.
 */
export function protection() {
  try {
    if (!safeStorage.isEncryptionAvailable()) return 'file';
    if (process.platform === 'linux' && safeStorage.getSelectedStorageBackend?.() === 'basic_text') return 'file';
    return 'keychain';
  } catch {
    return 'file';
  }
}

/** The form a key is stored in. */
export function seal(plain) {
  const key = String(plain ?? '').trim();
  if (!key) return '';
  if (protection() === 'keychain') return 'v1:enc:' + safeStorage.encryptString(key).toString('base64');
  return 'v1:raw:' + Buffer.from(key, 'utf8').toString('base64');
}

/** The key back from its stored form, or '' when it cannot be read (another user, a reset keychain). */
export function unseal(stored) {
  const m = /^v1:(enc|raw):(.+)$/s.exec(String(stored ?? ''));
  if (!m) return '';
  try {
    const bytes = Buffer.from(m[2], 'base64');
    return m[1] === 'enc' ? safeStorage.decryptString(bytes) : bytes.toString('utf8');
  } catch {
    return '';
  }
}

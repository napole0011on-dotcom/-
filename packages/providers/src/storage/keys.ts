/**
 * Object keys are POSIX-style relative paths ("brand/<id>/images/x.png").
 * Reject anything that could escape the storage root or behave differently on Windows.
 */
export function assertSafeKey(key: string): string[] {
  const parts = key.split('/');
  const bad =
    key.length === 0 ||
    key.length > 512 ||
    key.startsWith('/') ||
    key.includes('\\') ||
    key.includes('\0') ||
    /^[a-zA-Z]:/.test(key) ||
    parts.some((p) => p === '' || p === '.' || p === '..');
  if (bad) throw new Error(`Invalid storage key: ${JSON.stringify(key)}`);
  return parts;
}

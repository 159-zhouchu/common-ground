// Preserve drafts and authored review criteria. Connection selections can be reselected.
export function readLocal(key: string) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
export function writeLocal(key: string, value: string) {
  if (readLocal(key) === value) return true;
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {}
  try {
    const disposable = [];
    for (let i = 0; i < localStorage.length; i++) {
      const candidate = localStorage.key(i);
      if (candidate && candidate !== key && candidate.startsWith('cg-connections-'))
        disposable.push(candidate);
    }
    for (const candidate of disposable) localStorage.removeItem(candidate);
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}
export function retryKey(key: string, signature: string) {
  try {
    const saved = JSON.parse(sessionStorage.getItem(key) || 'null');
    if (saved?.signature === signature && typeof saved.id === 'string') return saved.id as string;
  } catch {}
  const id = browserUUID();
  try {
    sessionStorage.setItem(key, JSON.stringify({ signature, id }));
  } catch {
    throw new Error('浏览器无法保存请求标识，请允许此站点存储后重试；本次尚未提交。');
  }
  return id;
}
export function clearRetryKey(key: string) {
  try {
    sessionStorage.removeItem(key);
  } catch {}
}
export function browserUUID() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

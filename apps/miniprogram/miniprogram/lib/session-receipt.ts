import { parseReceipt, type SessionReceipt } from './session-receipt-data';
export { createReceipt, type ReceiptMessage, type SessionReceipt } from './session-receipt-data';

const STORAGE_KEY = 'lingli.last-session-receipt.v1';
let latest: SessionReceipt | null = null;
let pending: SessionReceipt | null = null;
const key = () => wx.getStorageSync('bio-account-id') ? `${STORAGE_KEY}:${wx.getStorageSync('bio-account-id')}` : STORAGE_KEY;
export function clearReceipt(): void { latest = null; pending = null; }
export function migrateLegacyOwnerReceipt(userId: string): void {
  if (userId !== 'owner') return;
  try {
    const legacy = parseReceipt(wx.getStorageSync(STORAGE_KEY));
    if (legacy && !wx.getStorageSync(`${STORAGE_KEY}:owner`)) wx.setStorageSync(`${STORAGE_KEY}:owner`, legacy);
  } catch { /* Local cache is optional. */ }
}
export function saveReceipt(receipt: SessionReceipt): void {
  latest = parseReceipt(receipt);
  try { wx.setStorageSync(key(), latest); } catch { /* Available in memory if storage is full. */ }
}

export function getLatestReceipt(): SessionReceipt | null {
  if (latest) return latest;
  try { latest = parseReceipt(wx.getStorageSync(key())); } catch { /* Local cache is optional. */ }
  return latest;
}

export function queueReceipt(receipt: SessionReceipt): void {
  saveReceipt(receipt);
  pending = latest;
}

export function takePendingReceipt(): SessionReceipt | null {
  const value = pending;
  pending = null;
  return value;
}

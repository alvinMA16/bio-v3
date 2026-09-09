import { parseReceipt, type SessionReceipt } from './session-receipt-data';
export { createReceipt, type ReceiptMessage, type SessionReceipt } from './session-receipt-data';

const STORAGE_KEY = 'lingli.last-session-receipt.v1';
let latest: SessionReceipt | null = null;
let pending: SessionReceipt | null = null;
export function saveReceipt(receipt: SessionReceipt): void {
  latest = parseReceipt(receipt);
  try { wx.setStorageSync(STORAGE_KEY, latest); } catch { /* Available in memory if storage is full. */ }
}

export function getLatestReceipt(): SessionReceipt | null {
  if (latest) return latest;
  try { latest = parseReceipt(wx.getStorageSync(STORAGE_KEY)); } catch { /* Local cache is optional. */ }
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

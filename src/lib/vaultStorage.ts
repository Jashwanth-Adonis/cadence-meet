import { decryptBinary, encryptBinary } from './crypto';
import type { LocalVaultEntryMeta } from '../types';

const DB_NAME = 'cadence_encrypted_vault_db';
const DB_VERSION = 1;
const STORE_NAME = 'encrypted_videos';

interface StoredEncryptedBlob {
  meetingId: string;
  iv: ArrayBuffer;
  ciphertext: ArrayBuffer;
  mimeType: string;
  fileSizeBytes: number;
  createdAtMs: number;
}

function openVaultDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'meetingId' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Failed to open local encrypted vault.'));
  });
}

export async function saveEncryptedVideo(
  meetingId: string,
  videoBlob: Blob,
  key: CryptoKey
): Promise<number> {
  const rawBuffer = await videoBlob.arrayBuffer();
  const { iv, ciphertext } = await encryptBinary(key, rawBuffer);
  const record: StoredEncryptedBlob = {
    meetingId,
    iv: iv.buffer as ArrayBuffer,
    ciphertext,
    mimeType: videoBlob.type || 'video/mp4',
    fileSizeBytes: videoBlob.size,
    createdAtMs: Date.now(),
  };

  const db = await openVaultDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('Failed to write encrypted video to local vault.'));
  });
  db.close();
  return videoBlob.size;
}

async function getRawEncryptedRecord(meetingId: string): Promise<StoredEncryptedBlob | null> {
  const db = await openVaultDb();
  const record = await new Promise<StoredEncryptedBlob | null>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(meetingId);
    req.onsuccess = () => resolve((req.result as StoredEncryptedBlob | undefined) ?? null);
    req.onerror = () => reject(req.error ?? new Error('Failed to read from local vault.'));
  });
  db.close();
  return record;
}

export async function loadDecryptedVideoBlob(
  meetingId: string,
  key: CryptoKey
): Promise<Blob | null> {
  const record = await getRawEncryptedRecord(meetingId);
  if (!record) return null;
  const plainBuffer = await decryptBinary(key, new Uint8Array(record.iv), record.ciphertext);
  return new Blob([plainBuffer], { type: record.mimeType || 'video/mp4' });
}

export async function exportEncryptedArchiveBlob(meetingId: string): Promise<Blob | null> {
  const record = await getRawEncryptedRecord(meetingId);
  if (!record) return null;
  const headerJson = JSON.stringify({
    format: 'CADENCE_E2EE_VIDEO_V1',
    cipher: 'AES-256-GCM',
    meetingId: record.meetingId,
    mimeType: record.mimeType,
    ivLength: record.iv.byteLength,
    createdAtMs: record.createdAtMs,
  });
  const headerBytes = new TextEncoder().encode(headerJson);
  const headerLen = new Uint32Array([headerBytes.byteLength]);
  return new Blob([headerLen, headerBytes, record.iv, record.ciphertext], {
    type: 'application/octet-stream',
  });
}

export async function deleteEncryptedVideo(meetingId: string): Promise<void> {
  const db = await openVaultDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(meetingId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('Failed to delete encrypted video.'));
  });
  db.close();
}

export async function listLocalVaultEntries(): Promise<LocalVaultEntryMeta[]> {
  const db = await openVaultDb();
  const entries = await new Promise<LocalVaultEntryMeta[]>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).getAll();
    req.onsuccess = () => {
      const items = (req.result as StoredEncryptedBlob[] | undefined) ?? [];
      resolve(
        items.map((item) => ({
          meetingId: item.meetingId,
          mimeType: item.mimeType,
          fileSizeBytes: item.fileSizeBytes,
          createdAtMs: item.createdAtMs,
        }))
      );
    };
    req.onerror = () => reject(req.error ?? new Error('Failed to list local vault entries.'));
  });
  db.close();
  return entries;
}

export function triggerBlobDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

import { decryptBinary, encryptBinary } from './crypto';
import type { LocalVaultEntryMeta } from '../types';

const DB_NAME = 'cadence_encrypted_vault_db';
const DB_VERSION = 2;
const STORE_NAME = 'encrypted_videos';
const CHECKPOINT_STORE = 'live_checkpoints';

interface StoredEncryptedBlob {
  meetingId: string;
  iv: ArrayBuffer;
  ciphertext: ArrayBuffer;
  mimeType: string;
  fileSizeBytes: number;
  createdAtMs: number;
}

export interface LiveCheckpointMeta {
  id: 'meta';
  title: string;
  meetUrl: string;
  folderId: string;
  notes: string;
  mimeType: string;
  startedAtMs: number;
  updatedAtMs: number;
}

interface LiveCheckpointChunk {
  id: string;
  seq: number;
  iv: ArrayBuffer;
  ciphertext: ArrayBuffer;
}

export async function requestPersistentStorage(): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.storage?.persist) {
      return await navigator.storage.persist();
    }
  } catch {
    // Ignore unsupported browsers
  }
  return false;
}

function openVaultDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'meetingId' });
      }
      if (!db.objectStoreNames.contains(CHECKPOINT_STORE)) {
        db.createObjectStore(CHECKPOINT_STORE, { keyPath: 'id' });
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
  void requestPersistentStorage();
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

export async function initLiveCheckpoint(meta: Omit<LiveCheckpointMeta, 'id' | 'updatedAtMs'>): Promise<void> {
  void requestPersistentStorage();
  const db = await openVaultDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(CHECKPOINT_STORE, 'readwrite');
    const store = tx.objectStore(CHECKPOINT_STORE);
    store.clear();
    store.put({
      ...meta,
      id: 'meta',
      updatedAtMs: Date.now(),
    } satisfies LiveCheckpointMeta);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('Failed to initialize recording cache.'));
  });
  db.close();
}

export async function updateLiveCheckpointMeta(
  updates: Partial<Omit<LiveCheckpointMeta, 'id'>>
): Promise<void> {
  const db = await openVaultDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(CHECKPOINT_STORE, 'readwrite');
    const store = tx.objectStore(CHECKPOINT_STORE);
    const req = store.get('meta');
    req.onsuccess = () => {
      const existing = req.result as LiveCheckpointMeta | undefined;
      if (existing) {
        store.put({ ...existing, ...updates, updatedAtMs: Date.now() });
      }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('Failed to update checkpoint metadata.'));
  });
  db.close();
}

export async function appendLiveCheckpointChunk(
  seq: number,
  chunk: Blob,
  mimeType: string,
  key: CryptoKey
): Promise<void> {
  if (chunk.size === 0) return;
  const buf = await chunk.arrayBuffer();
  const { iv, ciphertext } = await encryptBinary(key, buf);
  const db = await openVaultDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(CHECKPOINT_STORE, 'readwrite');
    const store = tx.objectStore(CHECKPOINT_STORE);
    const metaReq = store.get('meta');
    metaReq.onsuccess = () => {
      const existing = metaReq.result as LiveCheckpointMeta | undefined;
      if (existing) {
        store.put({
          ...existing,
          mimeType: mimeType || existing.mimeType,
          updatedAtMs: Date.now(),
        });
      }
    };
    store.put({
      id: `chunk_${String(seq).padStart(7, '0')}`,
      seq,
      iv: iv.buffer as ArrayBuffer,
      ciphertext,
    } satisfies LiveCheckpointChunk);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('Failed to cache live recording chunk.'));
  });
  db.close();
}

export async function clearLiveCheckpoint(): Promise<void> {
  const db = await openVaultDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(CHECKPOINT_STORE, 'readwrite');
    tx.objectStore(CHECKPOINT_STORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('Failed to clear recording checkpoint.'));
  });
  db.close();
}

export async function recoverLiveCheckpoint(key: CryptoKey): Promise<{
  meta: LiveCheckpointMeta;
  videoBlob: Blob;
  durationSec: number;
} | null> {
  const db = await openVaultDb();
  const allItems = await new Promise<Array<LiveCheckpointMeta | LiveCheckpointChunk>>((resolve, reject) => {
    const tx = db.transaction(CHECKPOINT_STORE, 'readonly');
    const req = tx.objectStore(CHECKPOINT_STORE).getAll();
    req.onsuccess = () => resolve((req.result as Array<LiveCheckpointMeta | LiveCheckpointChunk>) ?? []);
    req.onerror = () => reject(req.error ?? new Error('Failed to read checkpoint cache.'));
  });
  db.close();

  const meta = allItems.find((item): item is LiveCheckpointMeta => item.id === 'meta');
  const chunks = allItems
    .filter((item): item is LiveCheckpointChunk => item.id !== 'meta')
    .sort((a, b) => a.seq - b.seq);

  if (!meta || chunks.length === 0) return null;

  const decryptedBuffers: ArrayBuffer[] = [];
  for (const ch of chunks) {
    try {
      const plain = await decryptBinary(key, new Uint8Array(ch.iv), ch.ciphertext);
      decryptedBuffers.push(plain);
    } catch {
      return null;
    }
  }

  const mimeType = meta.mimeType || 'video/webm';
  const videoBlob = new Blob(decryptedBuffers, { type: mimeType });
  if (videoBlob.size === 0) return null;

  const durationSec = Math.max(1, Math.round((meta.updatedAtMs - meta.startedAtMs) / 1000));
  return { meta, videoBlob, durationSec };
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

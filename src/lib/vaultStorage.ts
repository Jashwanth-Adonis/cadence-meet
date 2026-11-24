import { decryptBinary, encryptBinary } from './crypto';
import type { LocalVaultEntryMeta } from '../types';

const DB_NAME = 'cadence_encrypted_vault_db';
const DB_VERSION = 3;
const STORE_NAME = 'encrypted_videos';
const CHUNKED_META_STORE = 'encrypted_video_meta';
const CHUNKED_DATA_STORE = 'encrypted_video_chunks';
const CHECKPOINT_STORE = 'live_checkpoints';

interface StoredEncryptedBlob {
  meetingId: string;
  iv: ArrayBuffer;
  ciphertext: ArrayBuffer;
  mimeType: string;
  fileSizeBytes: number;
  createdAtMs: number;
}

interface StoredChunkedVideoMeta {
  meetingId: string;
  mimeType: string;
  fileSizeBytes: number;
  chunkCount: number;
  createdAtMs: number;
}

interface StoredEncryptedVideoChunk {
  key: string; // `${meetingId}::${seq}`
  meetingId: string;
  seq: number;
  iv: ArrayBuffer;
  ciphertext: ArrayBuffer;
  plainSizeBytes: number;
}

export interface LiveCheckpointMeta {
  id: 'meta';
  vaultId: string;
  title: string;
  meetUrl: string;
  folderId: string;
  notes: string;
  mimeType: string;
  startedAtMs: number;
  updatedAtMs: number;
  totalBytes: number;
  chunkCount: number;
}

interface LiveCheckpointChunk {
  id: string;
  seq: number;
  iv: ArrayBuffer;
  ciphertext: ArrayBuffer;
  plainSizeBytes: number;
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

export async function getStorageEstimate(): Promise<{
  usageBytes: number;
  quotaBytes: number;
  freeBytes: number;
} | null> {
  try {
    if (typeof navigator !== 'undefined' && navigator.storage?.estimate) {
      const est = await navigator.storage.estimate();
      const usageBytes = est.usage ?? 0;
      const quotaBytes = est.quota ?? 0;
      return {
        usageBytes,
        quotaBytes,
        freeBytes: Math.max(0, quotaBytes - usageBytes),
      };
    }
  } catch {
    // Ignore
  }
  return null;
}

function openVaultDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'meetingId' });
      }
      if (!db.objectStoreNames.contains(CHUNKED_META_STORE)) {
        db.createObjectStore(CHUNKED_META_STORE, { keyPath: 'meetingId' });
      }
      if (!db.objectStoreNames.contains(CHUNKED_DATA_STORE)) {
        const chunkStore = db.createObjectStore(CHUNKED_DATA_STORE, { keyPath: 'key' });
        chunkStore.createIndex('by_meeting', 'meetingId', { unique: false });
      }
      if (!db.objectStoreNames.contains(CHECKPOINT_STORE)) {
        db.createObjectStore(CHECKPOINT_STORE, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Failed to open local encrypted vault.'));
  });
}

const STREAM_CHUNK_SIZE = 2 * 1024 * 1024; // 2 MB per encrypted slice for imported large files

export async function saveEncryptedVideo(
  meetingId: string,
  videoBlob: Blob,
  key: CryptoKey
): Promise<number> {
  void requestPersistentStorage();
  const mimeType = videoBlob.type || 'video/mp4';

  // Stream in 2MB slices so importing even a 1.5GB 3-hour recording never blows JS RAM
  const db = await openVaultDb();
  let seq = 0;
  for (let offset = 0; offset < videoBlob.size; offset += STREAM_CHUNK_SIZE) {
    const slice = videoBlob.slice(offset, Math.min(videoBlob.size, offset + STREAM_CHUNK_SIZE));
    const buf = await slice.arrayBuffer();
    const { iv, ciphertext } = await encryptBinary(key, buf);
    const chunkRec: StoredEncryptedVideoChunk = {
      key: `${meetingId}::${String(seq).padStart(7, '0')}`,
      meetingId,
      seq,
      iv: iv.buffer as ArrayBuffer,
      ciphertext,
      plainSizeBytes: slice.size,
    };
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(CHUNKED_DATA_STORE, 'readwrite');
      tx.objectStore(CHUNKED_DATA_STORE).put(chunkRec);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('Failed to write encrypted video slice.'));
    });
    seq++;
  }

  const metaRec: StoredChunkedVideoMeta = {
    meetingId,
    mimeType,
    fileSizeBytes: videoBlob.size,
    chunkCount: seq,
    createdAtMs: Date.now(),
  };
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(CHUNKED_META_STORE, 'readwrite');
    tx.objectStore(CHUNKED_META_STORE).put(metaRec);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('Failed to save video metadata.'));
  });
  db.close();
  return videoBlob.size;
}

async function getChunkedVideoMeta(meetingId: string): Promise<StoredChunkedVideoMeta | null> {
  const db = await openVaultDb();
  const rec = await new Promise<StoredChunkedVideoMeta | null>((resolve, reject) => {
    const tx = db.transaction(CHUNKED_META_STORE, 'readonly');
    const req = tx.objectStore(CHUNKED_META_STORE).get(meetingId);
    req.onsuccess = () => resolve((req.result as StoredChunkedVideoMeta | undefined) ?? null);
    req.onerror = () => reject(req.error ?? new Error('Read failed.'));
  });
  db.close();
  return rec;
}

async function getChunkedVideoChunks(meetingId: string): Promise<StoredEncryptedVideoChunk[]> {
  const db = await openVaultDb();
  const chunks = await new Promise<StoredEncryptedVideoChunk[]>((resolve, reject) => {
    const tx = db.transaction(CHUNKED_DATA_STORE, 'readonly');
    const idx = tx.objectStore(CHUNKED_DATA_STORE).index('by_meeting');
    const req = idx.getAll(IDBKeyRange.only(meetingId));
    req.onsuccess = () => resolve((req.result as StoredEncryptedVideoChunk[] | undefined) ?? []);
    req.onerror = () => reject(req.error ?? new Error('Failed to read video chunks.'));
  });
  db.close();
  return chunks.sort((a, b) => a.seq - b.seq);
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
  const chunkMeta = await getChunkedVideoMeta(meetingId);
  if (chunkMeta) {
    const chunks = await getChunkedVideoChunks(meetingId);
    if (chunks.length === 0) return null;
    const parts: BlobPart[] = [];
    for (const ch of chunks) {
      const plain = await decryptBinary(key, new Uint8Array(ch.iv), ch.ciphertext);
      parts.push(new Blob([plain]));
    }
    return new Blob(parts, { type: chunkMeta.mimeType || 'video/mp4' });
  }

  const record = await getRawEncryptedRecord(meetingId);
  if (!record) return null;
  const plainBuffer = await decryptBinary(key, new Uint8Array(record.iv), record.ciphertext);
  return new Blob([plainBuffer], { type: record.mimeType || 'video/mp4' });
}

export async function streamDownloadDecryptedVideo(
  meetingId: string,
  key: CryptoKey,
  filename: string,
  fallbackMimeType: string
): Promise<boolean> {
  const winAny = window as unknown as {
    showSaveFilePicker?: (opts?: {
      suggestedName?: string;
      types?: Array<{ description: string; accept: Record<string, string[]> }>;
    }) => Promise<{
      createWritable: () => Promise<{
        write: (data: BufferSource | Blob) => Promise<void>;
        close: () => Promise<void>;
      }>;
    }>;
  };

  const chunkMeta = await getChunkedVideoMeta(meetingId);
  if (chunkMeta && typeof winAny.showSaveFilePicker === 'function') {
    try {
      const ext = (chunkMeta.mimeType || fallbackMimeType).includes('mp4') ? '.mp4' : '.webm';
      const handle = await winAny.showSaveFilePicker({
        suggestedName: filename,
        types: [
          {
            description: 'Recorded Meeting Video',
            accept: { [ext === '.mp4' ? 'video/mp4' : 'video/webm']: [ext] },
          },
        ],
      });
      const writable = await handle.createWritable();
      const chunks = await getChunkedVideoChunks(meetingId);
      for (const ch of chunks) {
        const plain = await decryptBinary(key, new Uint8Array(ch.iv), ch.ciphertext);
        await writable.write(plain);
      }
      await writable.close();
      return true;
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        return false;
      }
      // Fall through to standard Blob download if file picker fails
    }
  }

  const blob = await loadDecryptedVideoBlob(meetingId, key);
  if (!blob) return false;
  triggerBlobDownload(blob, filename);
  return true;
}

export async function exportEncryptedArchiveBlob(meetingId: string): Promise<Blob | null> {
  const chunkMeta = await getChunkedVideoMeta(meetingId);
  if (chunkMeta) {
    const chunks = await getChunkedVideoChunks(meetingId);
    const headerJson = JSON.stringify({
      format: 'CADENCE_E2EE_CHUNKED_VIDEO_V2',
      cipher: 'AES-256-GCM',
      meetingId: chunkMeta.meetingId,
      mimeType: chunkMeta.mimeType,
      chunkSizes: chunks.map((c) => ({ ivLen: c.iv.byteLength, ctLen: c.ciphertext.byteLength })),
      createdAtMs: chunkMeta.createdAtMs,
    });
    const headerBytes = new TextEncoder().encode(headerJson);
    const headerLen = new Uint32Array([headerBytes.byteLength]);
    const parts: BlobPart[] = [headerLen, headerBytes];
    for (const c of chunks) {
      parts.push(c.iv, c.ciphertext);
    }
    return new Blob(parts, { type: 'application/octet-stream' });
  }

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
    const tx = db.transaction([STORE_NAME, CHUNKED_META_STORE], 'readwrite');
    tx.objectStore(STORE_NAME).delete(meetingId);
    tx.objectStore(CHUNKED_META_STORE).delete(meetingId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('Failed to delete encrypted video.'));
  });
  const chunks = await new Promise<StoredEncryptedVideoChunk[]>((resolve, reject) => {
    const tx = db.transaction(CHUNKED_DATA_STORE, 'readonly');
    const req = tx.objectStore(CHUNKED_DATA_STORE).index('by_meeting').getAll(IDBKeyRange.only(meetingId));
    req.onsuccess = () => resolve((req.result as StoredEncryptedVideoChunk[] | undefined) ?? []);
    req.onerror = () => reject(req.error ?? new Error('Failed to query chunks.'));
  });
  if (chunks.length > 0) {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(CHUNKED_DATA_STORE, 'readwrite');
      const store = tx.objectStore(CHUNKED_DATA_STORE);
      for (const ch of chunks) store.delete(ch.key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('Failed to delete video chunks.'));
    });
  }
  db.close();
}

export async function listLocalVaultEntries(): Promise<LocalVaultEntryMeta[]> {
  const db = await openVaultDb();
  const [legacyEntries, chunkedEntries] = await Promise.all([
    new Promise<LocalVaultEntryMeta[]>((resolve, reject) => {
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
      req.onerror = () => reject(req.error ?? new Error('Failed to list legacy vault entries.'));
    }),
    new Promise<LocalVaultEntryMeta[]>((resolve, reject) => {
      const tx = db.transaction(CHUNKED_META_STORE, 'readonly');
      const req = tx.objectStore(CHUNKED_META_STORE).getAll();
      req.onsuccess = () => {
        const items = (req.result as StoredChunkedVideoMeta[] | undefined) ?? [];
        resolve(
          items.map((item) => ({
            meetingId: item.meetingId,
            mimeType: item.mimeType,
            fileSizeBytes: item.fileSizeBytes,
            createdAtMs: item.createdAtMs,
          }))
        );
      };
      req.onerror = () => reject(req.error ?? new Error('Failed to list chunked vault entries.'));
    }),
  ]);
  db.close();
  const map = new Map<string, LocalVaultEntryMeta>();
  legacyEntries.forEach((e) => map.set(e.meetingId, e));
  chunkedEntries.forEach((e) => map.set(e.meetingId, e));
  return Array.from(map.values());
}

export async function initLiveCheckpoint(
  meta: Omit<LiveCheckpointMeta, 'id' | 'updatedAtMs' | 'totalBytes' | 'chunkCount'>
): Promise<void> {
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
      totalBytes: 0,
      chunkCount: 0,
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
): Promise<number> {
  if (chunk.size === 0) return 0;
  const buf = await chunk.arrayBuffer();
  const { iv, ciphertext } = await encryptBinary(key, buf);
  const db = await openVaultDb();
  let newTotal = 0;
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(CHECKPOINT_STORE, 'readwrite');
    const store = tx.objectStore(CHECKPOINT_STORE);
    const metaReq = store.get('meta');
    metaReq.onsuccess = () => {
      const existing = metaReq.result as LiveCheckpointMeta | undefined;
      if (existing) {
        newTotal = existing.totalBytes + chunk.size;
        store.put({
          ...existing,
          mimeType: mimeType || existing.mimeType,
          updatedAtMs: Date.now(),
          totalBytes: newTotal,
          chunkCount: existing.chunkCount + 1,
        });
      }
    };
    store.put({
      id: `chunk_${String(seq).padStart(7, '0')}`,
      seq,
      iv: iv.buffer as ArrayBuffer,
      ciphertext,
      plainSizeBytes: chunk.size,
    } satisfies LiveCheckpointChunk);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('Failed to cache live recording chunk.'));
  });
  db.close();
  return newTotal;
}

/**
 * Zero-RAM promotion: moves already-encrypted live chunks straight into permanent chunked storage!
 * This prevents allocating multi-GB buffers when finishing a 2-3 hour meeting.
 */
export async function finalizeCheckpointToMeetingVideo(
  meetingId: string
): Promise<{ fileSizeBytes: number; mimeType: string }> {
  const db = await openVaultDb();
  const allItems = await new Promise<Array<LiveCheckpointMeta | LiveCheckpointChunk>>(
    (resolve, reject) => {
      const tx = db.transaction(CHECKPOINT_STORE, 'readonly');
      const req = tx.objectStore(CHECKPOINT_STORE).getAll();
      req.onsuccess = () =>
        resolve((req.result as Array<LiveCheckpointMeta | LiveCheckpointChunk>) ?? []);
      req.onerror = () => reject(req.error ?? new Error('Failed to read live checkpoint chunks.'));
    }
  );

  const meta = allItems.find((item): item is LiveCheckpointMeta => item.id === 'meta');
  const chunks = allItems
    .filter((item): item is LiveCheckpointChunk => item.id !== 'meta')
    .sort((a, b) => a.seq - b.seq);

  let totalBytes = 0;
  // Write in small transaction batches so even 2,160 chunks (3 hours @ 5s) complete smoothly
  const BATCH = 100;
  for (let i = 0; i < chunks.length; i += BATCH) {
    const slice = chunks.slice(i, i + BATCH);
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(CHUNKED_DATA_STORE, 'readwrite');
      const store = tx.objectStore(CHUNKED_DATA_STORE);
      slice.forEach((ch, offsetIdx) => {
        const seq = i + offsetIdx;
        totalBytes += ch.plainSizeBytes || 0;
        store.put({
          key: `${meetingId}::${String(seq).padStart(7, '0')}`,
          meetingId,
          seq,
          iv: ch.iv,
          ciphertext: ch.ciphertext,
          plainSizeBytes: ch.plainSizeBytes || 0,
        } satisfies StoredEncryptedVideoChunk);
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('Failed to commit video chunks.'));
    });
  }

  const mimeType = meta?.mimeType || 'video/webm';
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([CHUNKED_META_STORE, CHECKPOINT_STORE], 'readwrite');
    tx.objectStore(CHUNKED_META_STORE).put({
      meetingId,
      mimeType,
      fileSizeBytes: totalBytes,
      chunkCount: chunks.length,
      createdAtMs: Date.now(),
    } satisfies StoredChunkedVideoMeta);
    tx.objectStore(CHECKPOINT_STORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('Failed to finalize video store.'));
  });
  db.close();
  return { fileSizeBytes: totalBytes, mimeType };
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

export async function recoverLiveCheckpoint(
  vaultId: string,
  key: CryptoKey
): Promise<{
  meta: LiveCheckpointMeta;
  durationSec: number;
  fileSizeBytes: number;
  mimeType: string;
} | null> {
  const db = await openVaultDb();
  const allItems = await new Promise<Array<LiveCheckpointMeta | LiveCheckpointChunk>>(
    (resolve, reject) => {
      const tx = db.transaction(CHECKPOINT_STORE, 'readonly');
      const req = tx.objectStore(CHECKPOINT_STORE).getAll();
      req.onsuccess = () =>
        resolve((req.result as Array<LiveCheckpointMeta | LiveCheckpointChunk>) ?? []);
      req.onerror = () => reject(req.error ?? new Error('Failed to read checkpoint cache.'));
    }
  );
  db.close();

  const meta = allItems.find((item): item is LiveCheckpointMeta => item.id === 'meta');
  const chunks = allItems
    .filter((item): item is LiveCheckpointChunk => item.id !== 'meta')
    .sort((a, b) => a.seq - b.seq);

  if (!meta || chunks.length === 0) return null;
  if (meta.vaultId && meta.vaultId !== vaultId) return null;

  // Verify the first chunk decrypts with this key before promoting
  try {
    await decryptBinary(key, new Uint8Array(chunks[0].iv), chunks[0].ciphertext);
  } catch {
    return null;
  }

  const durationSec = Math.max(1, Math.round((meta.updatedAtMs - meta.startedAtMs) / 1000));
  const totalBytes = chunks.reduce((acc, c) => acc + (c.plainSizeBytes || 0), 0);
  return {
    meta,
    durationSec,
    fileSizeBytes: totalBytes,
    mimeType: meta.mimeType || 'video/webm',
  };
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

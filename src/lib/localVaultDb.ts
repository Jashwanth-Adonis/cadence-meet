import {
  createVaultVerifier,
  decryptJson,
  deriveMasterKey,
  deriveVaultId,
  encryptJson,
  generateSalt,
  verifyVaultPassphrase,
} from './crypto';
import { generateDocId } from './formatters';
import {
  deleteEncryptedVideo,
  requestPersistentStorage,
} from './vaultStorage';
import type {
  DecryptedMeetingPayload,
  DecryptedTaskPayload,
  MeetingFolder,
  MeetingRecord,
  ProjectTask,
  TaskPriority,
  TaskStatus,
  UserVaultProfile,
} from '../types';

const DB_NAME = 'cadence_local_workspace_db';
const DB_VERSION = 2;

interface LocalEncryptedMeetingDoc {
  id: string;
  ownerId?: string;
  folderId: string;
  starred: boolean;
  archived: boolean;
  status: 'processing' | 'completed' | 'archived';
  durationSec: number;
  fileSizeBytes: number;
  hasLocalVideo: boolean;
  videoMimeType: string;
  speakerCount: number;
  actionItemCount: number;
  tags: string[];
  encryptedPayload: string;
  payloadIv: string;
  recordedAtMs: number;
}

interface LocalEncryptedTaskDoc {
  id: string;
  ownerId?: string;
  meetingId: string;
  folderId: string;
  status: TaskStatus;
  priority: TaskPriority;
  dueDate: string;
  timestampSec: number;
  encryptedTaskData: string;
  payloadIv: string;
  createdAtMs: number;
}

type StoreListener = () => void;
const listeners = {
  folders: new Set<StoreListener>(),
  meetings: new Set<StoreListener>(),
  tasks: new Set<StoreListener>(),
};

function notify(channel: keyof typeof listeners) {
  listeners[channel].forEach((fn) => fn());
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('profile')) {
        db.createObjectStore('profile', { keyPath: 'uid' });
      }
      if (!db.objectStoreNames.contains('folders')) {
        db.createObjectStore('folders', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('meetings')) {
        db.createObjectStore('meetings', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('tasks')) {
        db.createObjectStore('tasks', { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('Failed to open local workspace database.'));
  });
}

async function getAll<T>(storeName: string): Promise<T[]> {
  const db = await openDb();
  const res = await new Promise<T[]>((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).getAll();
    req.onsuccess = () => resolve((req.result as T[]) ?? []);
    req.onerror = () => reject(req.error ?? new Error('Read failed.'));
  });
  db.close();
  return res;
}

async function getOne<T>(storeName: string, key: string): Promise<T | null> {
  const db = await openDb();
  const res = await new Promise<T | null>((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).get(key);
    req.onsuccess = () => resolve((req.result as T | undefined) ?? null);
    req.onerror = () => reject(req.error ?? new Error('Read failed.'));
  });
  db.close();
  return res;
}

async function putOne<T>(storeName: string, value: T): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).put(value);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('Write failed.'));
  });
  db.close();
}

async function deleteOne(storeName: string, key: string): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('Delete failed.'));
  });
  db.close();
}

export const LOCAL_UID = 'local_device';

function matchesVault(ownerId: string | undefined, activeVaultId: string): boolean {
  const effective = ownerId || LOCAL_UID;
  return effective === activeVaultId;
}

export async function listLocalProfiles(): Promise<UserVaultProfile[]> {
  return getAll<UserVaultProfile>('profile');
}

export async function fetchLocalProfile(uid: string = LOCAL_UID): Promise<UserVaultProfile | null> {
  return getOne<UserVaultProfile>('profile', uid);
}

export async function saveLocalProfile(profile: UserVaultProfile): Promise<void> {
  void requestPersistentStorage();
  await putOne('profile', profile);
}

/**
 * Passphrase-only unlock: checks whether a vault already exists for this passphrase
 * (either derived vaultId or legacy local_device vault) and verifies it.
 */
export async function unlockOrLookupVaultByPassphrase(passphrase: string): Promise<
  | { status: 'unlocked'; key: CryptoKey; profile: UserVaultProfile }
  | { status: 'needs_create'; derivedVaultId: string }
> {
  const derivedId = await deriveVaultId(passphrase);
  const exactProfile = await fetchLocalProfile(derivedId);
  if (exactProfile) {
    const key = await deriveMasterKey(passphrase, exactProfile.vaultSalt);
    const ok = await verifyVaultPassphrase(key, exactProfile.vaultVerifier);
    if (ok) {
      return { status: 'unlocked', key, profile: exactProfile };
    }
  }

  // Backward compatibility: check legacy 'local_device' or any stored profile matching passphrase
  const allProfiles = await listLocalProfiles();
  for (const prof of allProfiles) {
    const key = await deriveMasterKey(passphrase, prof.vaultSalt);
    const ok = await verifyVaultPassphrase(key, prof.vaultVerifier);
    if (ok) {
      return { status: 'unlocked', key, profile: prof };
    }
  }

  return { status: 'needs_create', derivedVaultId: derivedId };
}

export async function createVaultForPassphrase(passphrase: string): Promise<{
  key: CryptoKey;
  profile: UserVaultProfile;
}> {
  const vaultId = await deriveVaultId(passphrase);
  const salt = generateSalt();
  const key = await deriveMasterKey(passphrase, salt);
  const verifier = await createVaultVerifier(key);

  const profile: UserVaultProfile = {
    uid: vaultId,
    email: 'passphrase@local',
    displayName: 'Passphrase Vault',
    vaultSalt: salt,
    vaultVerifier: verifier,
    vaultEnabled: true,
  };
  await saveLocalProfile(profile);
  await Promise.all([
    createLocalFolder(vaultId, 'Work Meetings', 'Team syncs and project reviews', '#2563EB'),
    createLocalFolder(vaultId, 'Client Calls', 'External meetings and demos', '#0F766E'),
    createLocalFolder(vaultId, 'Archive', 'Completed recordings', '#64748B'),
  ]);
  return { key, profile };
}

export async function resetLocalVault(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error ?? new Error('Failed to reset local vault.'));
    req.onblocked = () => resolve();
  });
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase('cadence_encrypted_vault_db');
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });
}

export async function createLocalFolder(
  ownerId: string,
  name: string,
  description: string,
  colorHex: string
): Promise<string> {
  const id = generateDocId('fld');
  const folder: MeetingFolder = {
    id,
    ownerId,
    name: name.trim().slice(0, 80),
    description: description.trim().slice(0, 240),
    colorHex,
  };
  await putOne('folders', folder);
  notify('folders');
  return id;
}

export async function deleteLocalFolder(folderId: string): Promise<void> {
  await deleteOne('folders', folderId);
  notify('folders');
}

export function subscribeLocalFolders(
  vaultId: string,
  onData: (folders: MeetingFolder[]) => void
): () => void {
  const load = () => {
    void getAll<MeetingFolder>('folders').then((items) => {
      const scoped = items.filter((f) => matchesVault(f.ownerId, vaultId));
      onData(scoped.sort((a, b) => a.name.localeCompare(b.name)));
    });
  };
  listeners.folders.add(load);
  load();
  return () => {
    listeners.folders.delete(load);
  };
}

export function subscribeLocalMeetings(
  vaultId: string,
  masterKey: CryptoKey,
  onData: (meetings: MeetingRecord[]) => void
): () => void {
  const load = () => {
    void getAll<LocalEncryptedMeetingDoc>('meetings').then(async (docs) => {
      const scoped = docs
        .filter((d) => matchesVault(d.ownerId, vaultId))
        .sort((a, b) => b.recordedAtMs - a.recordedAtMs);
      const out: MeetingRecord[] = [];
      for (const d of scoped) {
        let payload: DecryptedMeetingPayload;
        try {
          payload = await decryptJson<DecryptedMeetingPayload>(
            masterKey,
            d.payloadIv,
            d.encryptedPayload
          );
        } catch {
          continue;
        }
        out.push({
          id: d.id,
          ownerId: d.ownerId || vaultId,
          folderId: d.folderId,
          starred: d.starred,
          archived: d.archived,
          status: d.status,
          durationSec: d.durationSec,
          fileSizeBytes: d.fileSizeBytes,
          hasLocalVideo: d.hasLocalVideo,
          videoMimeType: d.videoMimeType,
          speakerCount: d.speakerCount,
          actionItemCount: d.actionItemCount,
          tags: d.tags,
          recordedAtMs: d.recordedAtMs,
          payload,
        });
      }
      onData(out);
    });
  };
  listeners.meetings.add(load);
  load();
  return () => {
    listeners.meetings.delete(load);
  };
}

export function subscribeLocalTasks(
  vaultId: string,
  masterKey: CryptoKey,
  onData: (tasks: ProjectTask[]) => void
): () => void {
  const load = () => {
    void getAll<LocalEncryptedTaskDoc>('tasks').then(async (docs) => {
      const scoped = docs
        .filter((d) => matchesVault(d.ownerId, vaultId))
        .sort((a, b) => b.createdAtMs - a.createdAtMs);
      const out: ProjectTask[] = [];
      for (const d of scoped) {
        let payload: DecryptedTaskPayload;
        try {
          payload = await decryptJson<DecryptedTaskPayload>(
            masterKey,
            d.payloadIv,
            d.encryptedTaskData
          );
        } catch {
          continue;
        }
        out.push({
          id: d.id,
          ownerId: d.ownerId || vaultId,
          meetingId: d.meetingId,
          folderId: d.folderId,
          status: d.status,
          priority: d.priority,
          dueDate: d.dueDate,
          timestampSec: d.timestampSec,
          payload,
          createdAtMs: d.createdAtMs,
        });
      }
      onData(out);
    });
  };
  listeners.tasks.add(load);
  load();
  return () => {
    listeners.tasks.delete(load);
  };
}

export async function saveLocalMeeting(params: {
  uid: string;
  meetingId: string;
  masterKey: CryptoKey;
  folderId: string;
  durationSec: number;
  fileSizeBytes: number;
  hasLocalVideo: boolean;
  videoMimeType: string;
  tags: string[];
  payload: DecryptedMeetingPayload;
}): Promise<void> {
  void requestPersistentStorage();
  const encrypted = await encryptJson(params.masterKey, params.payload);
  const doc: LocalEncryptedMeetingDoc = {
    id: params.meetingId,
    ownerId: params.uid,
    folderId: params.folderId || '',
    starred: false,
    archived: false,
    status: 'completed',
    durationSec: Math.max(0, Math.round(params.durationSec)),
    fileSizeBytes: Math.max(0, params.fileSizeBytes),
    hasLocalVideo: params.hasLocalVideo,
    videoMimeType: params.videoMimeType,
    speakerCount: 1,
    actionItemCount: 0,
    tags: params.tags,
    encryptedPayload: encrypted.ciphertext,
    payloadIv: encrypted.iv,
    recordedAtMs: Date.now(),
  };
  await putOne('meetings', doc);
  notify('meetings');
}

export async function updateLocalMeetingPayload(
  meetingId: string,
  masterKey: CryptoKey,
  payload: DecryptedMeetingPayload
): Promise<void> {
  const existing = await getOne<LocalEncryptedMeetingDoc>('meetings', meetingId);
  if (!existing) return;
  const encrypted = await encryptJson(masterKey, payload);
  await putOne('meetings', {
    ...existing,
    encryptedPayload: encrypted.ciphertext,
    payloadIv: encrypted.iv,
  });
  notify('meetings');
}

export async function updateLocalMeetingMeta(
  meetingId: string,
  updates: { folderId?: string; starred?: boolean; tags?: string[] }
): Promise<void> {
  const existing = await getOne<LocalEncryptedMeetingDoc>('meetings', meetingId);
  if (!existing) return;
  await putOne('meetings', {
    ...existing,
    folderId: updates.folderId !== undefined ? updates.folderId : existing.folderId,
    starred: updates.starred !== undefined ? updates.starred : existing.starred,
    tags: updates.tags !== undefined ? updates.tags : existing.tags,
  });
  notify('meetings');
}

export async function setLocalMeetingArchived(meetingId: string, archived: boolean): Promise<void> {
  const existing = await getOne<LocalEncryptedMeetingDoc>('meetings', meetingId);
  if (!existing) return;
  await putOne('meetings', {
    ...existing,
    archived,
    status: archived ? 'archived' : 'completed',
  });
  notify('meetings');
}

export async function deleteLocalMeetingAndVideo(meetingId: string): Promise<void> {
  await deleteOne('meetings', meetingId);
  await deleteEncryptedVideo(meetingId).catch(() => {});
  notify('meetings');
}

export async function createLocalTask(params: {
  uid: string;
  masterKey: CryptoKey;
  meetingId?: string;
  folderId?: string;
  status: TaskStatus;
  priority: TaskPriority;
  dueDate: string;
  timestampSec?: number;
  payload: DecryptedTaskPayload;
}): Promise<void> {
  const encrypted = await encryptJson(params.masterKey, params.payload);
  const doc: LocalEncryptedTaskDoc = {
    id: generateDocId('tsk'),
    ownerId: params.uid,
    meetingId: params.meetingId ?? '',
    folderId: params.folderId ?? '',
    status: params.status,
    priority: params.priority,
    dueDate: params.dueDate,
    timestampSec: Math.max(0, Math.round(params.timestampSec ?? 0)),
    encryptedTaskData: encrypted.ciphertext,
    payloadIv: encrypted.iv,
    createdAtMs: Date.now(),
  };
  await putOne('tasks', doc);
  notify('tasks');
}

export async function updateLocalTaskStatus(taskId: string, status: TaskStatus): Promise<void> {
  const existing = await getOne<LocalEncryptedTaskDoc>('tasks', taskId);
  if (!existing) return;
  await putOne('tasks', { ...existing, status });
  notify('tasks');
}

export async function deleteLocalTask(taskId: string): Promise<void> {
  await deleteOne('tasks', taskId);
  notify('tasks');
}

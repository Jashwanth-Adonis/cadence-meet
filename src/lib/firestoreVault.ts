import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch,
} from 'firebase/firestore';
import { db, handleFirestoreError, OperationType } from '../firebase';
import { decryptJson, encryptJson } from './crypto';
import { generateDocId } from './formatters';
import { deleteEncryptedVideo } from './vaultStorage';
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

export async function fetchUserVaultProfile(uid: string): Promise<UserVaultProfile | null> {
  const path = `users/${uid}`;
  try {
    const snap = await getDoc(doc(db, 'users', uid));
    if (!snap.exists()) return null;
    const d = snap.data();
    return {
      uid: String(d.uid),
      email: String(d.email ?? ''),
      displayName: String(d.displayName ?? ''),
      vaultSalt: String(d.vaultSalt),
      vaultVerifier: String(d.vaultVerifier),
      vaultEnabled: Boolean(d.vaultEnabled),
    };
  } catch (err) {
    handleFirestoreError(err, OperationType.GET, path);
  }
}

export async function createUserVaultProfile(profile: UserVaultProfile): Promise<void> {
  const path = `users/${profile.uid}`;
  try {
    await setDoc(doc(db, 'users', profile.uid), {
      uid: profile.uid,
      email: profile.email.slice(0, 254),
      displayName: profile.displayName.slice(0, 120),
      vaultSalt: profile.vaultSalt,
      vaultVerifier: profile.vaultVerifier,
      vaultEnabled: profile.vaultEnabled,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, path);
  }
}

export async function createFolder(
  uid: string,
  name: string,
  description: string,
  colorHex: string
): Promise<string> {
  const folderId = generateDocId('fld');
  const path = `users/${uid}/folders/${folderId}`;
  try {
    await setDoc(doc(db, 'users', uid, 'folders', folderId), {
      ownerId: uid,
      name: name.trim().slice(0, 80),
      description: description.trim().slice(0, 240),
      colorHex,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    return folderId;
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, path);
  }
}

export async function deleteFolder(uid: string, folderId: string): Promise<void> {
  const path = `users/${uid}/folders/${folderId}`;
  try {
    await deleteDoc(doc(db, 'users', uid, 'folders', folderId));
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, path);
  }
}

export function subscribeFolders(
  uid: string,
  onData: (folders: MeetingFolder[]) => void
): () => void {
  const path = `users/${uid}/folders`;
  const q = query(
    collection(db, 'users', uid, 'folders'),
    where('ownerId', '==', uid),
    orderBy('name', 'asc')
  );
  return onSnapshot(
    q,
    (snap) => {
      const items: MeetingFolder[] = snap.docs.map((d) => {
        const data = d.data();
        return {
          id: d.id,
          ownerId: String(data.ownerId),
          name: String(data.name ?? 'Untitled'),
          description: String(data.description ?? ''),
          colorHex: String(data.colorHex ?? '#2563EB'),
        };
      });
      onData(items);
    },
    (err) => handleFirestoreError(err, OperationType.LIST, path)
  );
}

export function subscribeMeetings(
  uid: string,
  masterKey: CryptoKey,
  onData: (meetings: MeetingRecord[]) => void
): () => void {
  const path = `users/${uid}/meetings`;
  const q = query(
    collection(db, 'users', uid, 'meetings'),
    where('ownerId', '==', uid),
    orderBy('recordedAtMs', 'desc')
  );

  return onSnapshot(
    q,
    (snap) => {
      void (async () => {
        const results: MeetingRecord[] = [];
        for (const docSnap of snap.docs) {
          const data = docSnap.data();
          let payload: DecryptedMeetingPayload;
          try {
            const raw = await decryptJson<Partial<DecryptedMeetingPayload>>(
              masterKey,
              String(data.payloadIv),
              String(data.encryptedPayload)
            );
            payload = {
              title: raw.title ?? 'Recorded Meeting',
              meetUrl: raw.meetUrl ?? '',
              notes: raw.notes ?? raw.executiveSummary ?? '',
              bookmarks: Array.isArray(raw.bookmarks) ? raw.bookmarks : [],
            };
          } catch {
            payload = {
              title: 'Encrypted Meeting (Key Mismatch)',
              meetUrl: '',
              notes: 'Unable to decrypt payload with current vault key.',
              bookmarks: [],
            };
          }
          results.push({
            id: docSnap.id,
            ownerId: String(data.ownerId),
            folderId: String(data.folderId ?? ''),
            starred: Boolean(data.starred),
            archived: Boolean(data.archived),
            status: (data.status as MeetingRecord['status']) ?? 'completed',
            durationSec: Number(data.durationSec ?? 0),
            fileSizeBytes: Number(data.fileSizeBytes ?? 0),
            hasLocalVideo: Boolean(data.hasLocalVideo),
            videoMimeType: String(data.videoMimeType ?? 'video/mp4'),
            speakerCount: Number(data.speakerCount ?? 1),
            actionItemCount: Number(data.actionItemCount ?? 0),
            tags: Array.isArray(data.tags) ? data.tags.map(String) : [],
            recordedAtMs: Number(data.recordedAtMs ?? 0),
            payload,
          });
        }
        onData(results);
      })();
    },
    (err) => handleFirestoreError(err, OperationType.LIST, path)
  );
}

export function subscribeTasks(
  uid: string,
  masterKey: CryptoKey,
  onData: (tasks: ProjectTask[]) => void
): () => void {
  const path = `users/${uid}/tasks`;
  const q = query(
    collection(db, 'users', uid, 'tasks'),
    where('ownerId', '==', uid),
    orderBy('createdAt', 'desc')
  );

  return onSnapshot(
    q,
    (snap) => {
      void (async () => {
        const items: ProjectTask[] = [];
        for (const docSnap of snap.docs) {
          const data = docSnap.data();
          let payload: DecryptedTaskPayload;
          try {
            payload = await decryptJson<DecryptedTaskPayload>(
              masterKey,
              String(data.payloadIv),
              String(data.encryptedTaskData)
            );
          } catch {
            payload = {
              title: 'Encrypted Task',
              description: '',
              assignee: 'Unassigned',
              category: 'General',
              meetingTitle: '',
              timestampLabel: '00:00',
            };
          }
          const ts = data.createdAt as { toMillis?: () => number } | undefined;
          items.push({
            id: docSnap.id,
            ownerId: String(data.ownerId),
            meetingId: String(data.meetingId ?? ''),
            folderId: String(data.folderId ?? ''),
            status: (data.status as TaskStatus) ?? 'backlog',
            priority: (data.priority as TaskPriority) ?? 'medium',
            dueDate: String(data.dueDate ?? ''),
            timestampSec: Number(data.timestampSec ?? 0),
            payload,
            createdAtMs: ts?.toMillis ? ts.toMillis() : Date.now(),
          });
        }
        onData(items);
      })();
    },
    (err) => handleFirestoreError(err, OperationType.LIST, path)
  );
}

export async function saveEncryptedMeeting(params: {
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
  const {
    uid,
    meetingId,
    masterKey,
    folderId,
    durationSec,
    fileSizeBytes,
    hasLocalVideo,
    videoMimeType,
    tags,
    payload,
  } = params;
  const path = `users/${uid}/meetings/${meetingId}`;

  try {
    const encryptedMeeting = await encryptJson(masterKey, payload);
    const batch = writeBatch(db);
    const meetingRef = doc(db, 'users', uid, 'meetings', meetingId);

    batch.set(meetingRef, {
      ownerId: uid,
      folderId: folderId || '',
      starred: false,
      archived: false,
      status: 'completed',
      durationSec: Math.max(0, Math.min(86400, Math.round(durationSec))),
      fileSizeBytes: Math.max(0, fileSizeBytes),
      hasLocalVideo,
      videoMimeType: videoMimeType.slice(0, 64),
      speakerCount: 1,
      actionItemCount: 0,
      tags: tags.slice(0, 10).map((t) => t.slice(0, 40)),
      encryptedPayload: encryptedMeeting.ciphertext,
      payloadIv: encryptedMeeting.iv,
      recordedAtMs: Date.now(),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });

    await batch.commit();
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, path);
  }
}

export async function updateMeetingPayload(
  uid: string,
  meetingId: string,
  masterKey: CryptoKey,
  payload: DecryptedMeetingPayload,
  current: MeetingRecord
): Promise<void> {
  const path = `users/${uid}/meetings/${meetingId}`;
  try {
    const encrypted = await encryptJson(masterKey, payload);
    await updateDoc(doc(db, 'users', uid, 'meetings', meetingId), {
      encryptedPayload: encrypted.ciphertext,
      payloadIv: encrypted.iv,
      actionItemCount: current.actionItemCount,
      speakerCount: current.speakerCount,
      status: current.status,
      updatedAt: serverTimestamp(),
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, path);
  }
}

export async function updateMeetingMeta(
  uid: string,
  meetingId: string,
  updates: { folderId?: string; starred?: boolean; tags?: string[] },
  current: MeetingRecord
): Promise<void> {
  const path = `users/${uid}/meetings/${meetingId}`;
  try {
    await updateDoc(doc(db, 'users', uid, 'meetings', meetingId), {
      folderId: updates.folderId !== undefined ? updates.folderId : current.folderId,
      starred: updates.starred !== undefined ? updates.starred : current.starred,
      tags: (updates.tags !== undefined ? updates.tags : current.tags).slice(0, 10),
      updatedAt: serverTimestamp(),
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, path);
  }
}

export async function setMeetingArchived(
  uid: string,
  meetingId: string,
  archived: boolean
): Promise<void> {
  const path = `users/${uid}/meetings/${meetingId}`;
  try {
    await updateDoc(doc(db, 'users', uid, 'meetings', meetingId), {
      archived,
      status: archived ? 'archived' : 'completed',
      updatedAt: serverTimestamp(),
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, path);
  }
}

export async function deleteMeetingAndLocalVideo(uid: string, meetingId: string): Promise<void> {
  const path = `users/${uid}/meetings/${meetingId}`;
  try {
    await deleteDoc(doc(db, 'users', uid, 'meetings', meetingId));
    await deleteEncryptedVideo(meetingId).catch(() => {});
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, path);
  }
}

export async function createManualTask(params: {
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
  const taskId = generateDocId('tsk');
  const path = `users/${params.uid}/tasks/${taskId}`;
  try {
    const encrypted = await encryptJson(params.masterKey, params.payload);
    await setDoc(doc(db, 'users', params.uid, 'tasks', taskId), {
      ownerId: params.uid,
      meetingId: params.meetingId ?? '',
      folderId: params.folderId ?? '',
      status: params.status,
      priority: params.priority,
      dueDate: params.dueDate.slice(0, 32),
      timestampSec: Math.max(0, Math.round(params.timestampSec ?? 0)),
      encryptedTaskData: encrypted.ciphertext,
      payloadIv: encrypted.iv,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, path);
  }
}

export async function updateTaskStatus(
  uid: string,
  taskId: string,
  status: TaskStatus
): Promise<void> {
  const path = `users/${uid}/tasks/${taskId}`;
  try {
    await updateDoc(doc(db, 'users', uid, 'tasks', taskId), {
      status,
      updatedAt: serverTimestamp(),
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, path);
  }
}

export async function deleteTask(uid: string, taskId: string): Promise<void> {
  const path = `users/${uid}/tasks/${taskId}`;
  try {
    await deleteDoc(doc(db, 'users', uid, 'tasks', taskId));
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, path);
  }
}

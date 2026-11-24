import * as local from './localVaultDb';
import type {
  DecryptedMeetingPayload,
  DecryptedTaskPayload,
  MeetingFolder,
  MeetingRecord,
  ProjectTask,
  TaskPriority,
  TaskStatus,
} from '../types';

export { LOCAL_UID } from './localVaultDb';

export async function createFolder(
  uid: string,
  name: string,
  description: string,
  colorHex: string
): Promise<string> {
  return local.createLocalFolder(uid, name, description, colorHex);
}

export async function deleteFolder(_uid: string, folderId: string): Promise<void> {
  return local.deleteLocalFolder(folderId);
}

export function subscribeFolders(
  uid: string,
  onData: (folders: MeetingFolder[]) => void
): () => void {
  return local.subscribeLocalFolders(uid, onData);
}

export function subscribeMeetings(
  uid: string,
  masterKey: CryptoKey,
  onData: (meetings: MeetingRecord[]) => void
): () => void {
  return local.subscribeLocalMeetings(uid, masterKey, onData);
}

export function subscribeTasks(
  uid: string,
  masterKey: CryptoKey,
  onData: (tasks: ProjectTask[]) => void
): () => void {
  return local.subscribeLocalTasks(uid, masterKey, onData);
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
  return local.saveLocalMeeting(params);
}

export async function updateMeetingPayload(
  _uid: string,
  meetingId: string,
  masterKey: CryptoKey,
  payload: DecryptedMeetingPayload,
  _current: MeetingRecord
): Promise<void> {
  return local.updateLocalMeetingPayload(meetingId, masterKey, payload);
}

export async function updateMeetingMeta(
  _uid: string,
  meetingId: string,
  updates: { folderId?: string; starred?: boolean; tags?: string[] },
  _current: MeetingRecord
): Promise<void> {
  return local.updateLocalMeetingMeta(meetingId, updates);
}

export async function setMeetingArchived(
  _uid: string,
  meetingId: string,
  archived: boolean
): Promise<void> {
  return local.setLocalMeetingArchived(meetingId, archived);
}

export async function deleteMeetingAndLocalVideo(
  _uid: string,
  meetingId: string
): Promise<void> {
  return local.deleteLocalMeetingAndVideo(meetingId);
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
  return local.createLocalTask(params);
}

export async function updateTaskStatus(
  _uid: string,
  taskId: string,
  status: TaskStatus
): Promise<void> {
  return local.updateLocalTaskStatus(taskId, status);
}

export async function deleteTask(_uid: string, taskId: string): Promise<void> {
  return local.deleteLocalTask(taskId);
}

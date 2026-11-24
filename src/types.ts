export type TaskStatus = 'backlog' | 'in_progress' | 'in_review' | 'done';
export type TaskPriority = 'low' | 'medium' | 'high' | 'urgent';
export type MeetingStatus = 'processing' | 'completed' | 'archived';
export type SpeakerFramingMode = 'full_stage' | 'smart_focus';
export type RecordingQualityPreset = 'long_meeting' | 'balanced' | 'high';

export interface SessionBookmark {
  id: string;
  timeSec: number;
  note: string;
}

export interface DecryptedMeetingPayload {
  title: string;
  meetUrl: string;
  notes: string;
  bookmarks: SessionBookmark[];
  executiveSummary?: string;
}

export interface MeetingRecord {
  id: string;
  ownerId: string;
  folderId: string;
  starred: boolean;
  archived: boolean;
  status: MeetingStatus;
  durationSec: number;
  fileSizeBytes: number;
  hasLocalVideo: boolean;
  videoMimeType: string;
  speakerCount: number;
  actionItemCount: number;
  tags: string[];
  recordedAtMs: number;
  payload: DecryptedMeetingPayload;
}

export interface DecryptedTaskPayload {
  title: string;
  description: string;
  assignee: string;
  category: string;
  meetingTitle: string;
  timestampLabel: string;
}

export interface ProjectTask {
  id: string;
  ownerId: string;
  meetingId: string;
  folderId: string;
  status: TaskStatus;
  priority: TaskPriority;
  dueDate: string;
  timestampSec: number;
  payload: DecryptedTaskPayload;
  createdAtMs: number;
}

export interface MeetingFolder {
  id: string;
  ownerId: string;
  name: string;
  description: string;
  colorHex: string;
}

export interface UserVaultProfile {
  uid: string;
  email: string;
  displayName: string;
  vaultSalt: string;
  vaultVerifier: string;
  vaultEnabled: boolean;
}

export interface LocalVaultEntryMeta {
  meetingId: string;
  mimeType: string;
  fileSizeBytes: number;
  createdAtMs: number;
}

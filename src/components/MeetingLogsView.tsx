import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Search,
  Star,
  Archive,
  Trash2,
  Download,
  FolderPlus,
  FolderOpen,
  CheckCircle2,
  Circle,
  Lock,
  Play,
  ArrowLeft,
  Shield,
  VideoOff,
  Save,
} from 'lucide-react';
import {
  createFolder,
  deleteFolder,
  deleteMeetingAndLocalVideo,
  setMeetingArchived,
  updateMeetingMeta,
  updateMeetingPayload,
  updateTaskStatus,
} from '../lib/workspaceStore';
import {
  exportEncryptedArchiveBlob,
  loadDecryptedVideoBlob,
  triggerBlobDownload,
} from '../lib/vaultStorage';
import { formatBytes, formatDateTime, formatTimecode } from '../lib/formatters';
import type { MeetingFolder, MeetingRecord, ProjectTask } from '../types';

interface MeetingLogsViewProps {
  uid: string;
  masterKey: CryptoKey;
  meetings: MeetingRecord[];
  folders: MeetingFolder[];
  tasks: ProjectTask[];
  selectedMeetingId: string | null;
  seekRequestSec: number | null;
  onSelectMeeting: (id: string | null) => void;
  onClearSeek: () => void;
  onGoToCapture: () => void;
}

type LogStatusFilter = 'active' | 'starred' | 'archived';

export const MeetingLogsView: React.FC<MeetingLogsViewProps> = ({
  uid,
  masterKey,
  meetings,
  folders,
  tasks,
  selectedMeetingId,
  seekRequestSec,
  onSelectMeeting,
  onClearSeek,
  onGoToCapture,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [folderFilter, setFolderFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<LogStatusFilter>('active');
  const [sortBy, setSortBy] = useState<'newest' | 'longest'>('newest');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [newFolderColor, setNewFolderColor] = useState('#2563EB');

  const [notesDraft, setNotesDraft] = useState('');
  const [savingNotes, setSavingNotes] = useState(false);
  const [notesSavedNotice, setNotesSavedNotice] = useState(false);

  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [videoLoading, setVideoLoading] = useState(false);
  const [videoBlobCache, setVideoBlobCache] = useState<Blob | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  const selectedMeeting = useMemo(
    () => meetings.find((m) => m.id === selectedMeetingId) ?? null,
    [meetings, selectedMeetingId]
  );

  useEffect(() => {
    if (!selectedMeeting) {
      setNotesDraft('');
      setNotesSavedNotice(false);
      return;
    }
    try {
      const cached = sessionStorage.getItem(`cadence_notes_draft_${selectedMeeting.id}`);
      setNotesDraft(cached !== null ? cached : selectedMeeting.payload.notes);
    } catch {
      setNotesDraft(selectedMeeting.payload.notes);
    }
    setNotesSavedNotice(false);
  }, [selectedMeeting?.id, selectedMeeting?.payload.notes]);

  useEffect(() => {
    let active = true;
    let createdUrl: string | null = null;
    setVideoUrl(null);
    setVideoBlobCache(null);

    if (!selectedMeeting || !selectedMeeting.hasLocalVideo) {
      return;
    }

    setVideoLoading(true);
    void (async () => {
      try {
        const blob = await loadDecryptedVideoBlob(selectedMeeting.id, masterKey);
        if (!active) return;
        if (blob) {
          createdUrl = URL.createObjectURL(blob);
          setVideoBlobCache(blob);
          setVideoUrl(createdUrl);
        }
      } finally {
        if (active) setVideoLoading(false);
      }
    })();

    return () => {
      active = false;
      if (createdUrl) URL.revokeObjectURL(createdUrl);
    };
  }, [selectedMeeting?.id, selectedMeeting?.hasLocalVideo, masterKey]);

  useEffect(() => {
    if (seekRequestSec !== null && videoRef.current && videoUrl) {
      videoRef.current.currentTime = seekRequestSec;
      void videoRef.current.play().catch(() => {});
      onClearSeek();
    }
  }, [seekRequestSec, videoUrl, onClearSeek]);

  const folderMap = useMemo(() => {
    const map = new Map<string, MeetingFolder>();
    folders.forEach((f) => map.set(f.id, f));
    return map;
  }, [folders]);

  const filteredMeetings = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const list = meetings.filter((m) => {
      if (statusFilter === 'active' && m.archived) return false;
      if (statusFilter === 'archived' && !m.archived) return false;
      if (statusFilter === 'starred' && (!m.starred || m.archived)) return false;
      if (folderFilter === 'unfiled' && m.folderId !== '') return false;
      if (folderFilter !== 'all' && folderFilter !== 'unfiled' && m.folderId !== folderFilter) {
        return false;
      }
      if (!q) return true;
      return (
        m.payload.title.toLowerCase().includes(q) ||
        m.payload.notes.toLowerCase().includes(q) ||
        m.payload.meetUrl.toLowerCase().includes(q)
      );
    });

    return [...list].sort((a, b) => {
      if (sortBy === 'longest') return b.durationSec - a.durationSec;
      return b.recordedAtMs - a.recordedAtMs;
    });
  }, [meetings, statusFilter, folderFilter, searchQuery, sortBy]);

  const linkedTasks = useMemo(() => {
    if (!selectedMeeting) return [];
    return tasks.filter((t) => t.meetingId === selectedMeeting.id);
  }, [tasks, selectedMeeting]);

  const handleCreateFolder = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newFolderName.trim()) return;
    await createFolder(uid, newFolderName.trim(), '', newFolderColor);
    setNewFolderName('');
    setNewFolderOpen(false);
  };

  const handleToggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleBulkMoveFolder = async (targetFolderId: string) => {
    const targets = meetings.filter((m) => selectedIds.has(m.id));
    await Promise.all(
      targets.map((m) => updateMeetingMeta(uid, m.id, { folderId: targetFolderId }, m))
    );
    setSelectedIds(new Set());
  };

  const handleBulkArchive = async (archived: boolean) => {
    const ids = Array.from(selectedIds);
    await Promise.all(ids.map((id) => setMeetingArchived(uid, id, archived)));
    setSelectedIds(new Set());
  };

  const handleBulkDelete = async () => {
    const ids = Array.from(selectedIds);
    await Promise.all(ids.map((id) => deleteMeetingAndLocalVideo(uid, id)));
    if (selectedMeetingId && selectedIds.has(selectedMeetingId)) {
      onSelectMeeting(null);
    }
    setSelectedIds(new Set());
  };

  const handleDownloadVideo = async (meeting: MeetingRecord) => {
    const blob =
      videoBlobCache && selectedMeeting?.id === meeting.id
        ? videoBlobCache
        : await loadDecryptedVideoBlob(meeting.id, masterKey);
    if (!blob) return;
    const ext = (blob.type || meeting.videoMimeType).includes('mp4') ? 'mp4' : 'webm';
    const slug = meeting.payload.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '');
    triggerBlobDownload(blob, `${slug || 'meeting-recording'}.${ext}`);
  };

  const handleDownloadEncryptedArchive = async (meeting: MeetingRecord) => {
    const blob = await exportEncryptedArchiveBlob(meeting.id);
    if (!blob) return;
    const slug = meeting.payload.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '');
    triggerBlobDownload(blob, `${slug || 'meeting'}.cadence.enc`);
  };

  const handleSaveNotes = async () => {
    if (!selectedMeeting) return;
    setSavingNotes(true);
    setNotesSavedNotice(false);
    try {
      await updateMeetingPayload(
        uid,
        selectedMeeting.id,
        masterKey,
        {
          ...selectedMeeting.payload,
          notes: notesDraft,
        },
        selectedMeeting
      );
      try {
        sessionStorage.removeItem(`cadence_notes_draft_${selectedMeeting.id}`);
      } catch {
        // Ignore
      }
      setNotesSavedNotice(true);
    } finally {
      setSavingNotes(false);
    }
  };

  const jumpToTimestamp = (sec: number) => {
    if (videoRef.current) {
      videoRef.current.currentTime = sec;
      void videoRef.current.play().catch(() => {});
    }
  };

  if (selectedMeeting) {
    const folder = folderMap.get(selectedMeeting.folderId);

    return (
      <div className="space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-start gap-3">
            <button
              type="button"
              onClick={() => onSelectMeeting(null)}
              className="mt-0.5 p-2 bg-white border border-slate-200 rounded-lg text-slate-600 hover:text-slate-900 hover:bg-slate-50 transition-colors shrink-0"
              aria-label="Back to recordings"
            >
              <ArrowLeft className="w-4 h-4" />
            </button>
            <div>
              <h1 className="font-display text-xl sm:text-2xl font-semibold text-slate-900 tracking-tight">
                {selectedMeeting.payload.title}
              </h1>
              <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                <span className="font-mono tabular-nums">
                  {formatDateTime(selectedMeeting.recordedAtMs)}
                </span>
                <span aria-hidden="true">·</span>
                <span className="font-mono tabular-nums">
                  {formatTimecode(selectedMeeting.durationSec)}
                </span>
                <span aria-hidden="true">·</span>
                <span>{folder ? folder.name : 'Unfiled'}</span>
                <span aria-hidden="true">·</span>
                <span className="inline-flex items-center gap-1 text-slate-600">
                  <Lock className="w-3 h-3" />
                  AES-256-GCM
                </span>
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            {selectedMeeting.hasLocalVideo && (
              <button
                type="button"
                onClick={() => void handleDownloadVideo(selectedMeeting)}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 bg-blue-600 text-white text-xs font-medium rounded-lg hover:bg-blue-700 transition-colors whitespace-nowrap shrink-0"
              >
                <Download className="w-3.5 h-3.5" />
                <span>Download Video</span>
              </button>
            )}
            {selectedMeeting.hasLocalVideo && (
              <button
                type="button"
                onClick={() => void handleDownloadEncryptedArchive(selectedMeeting)}
                className="inline-flex items-center gap-1.5 px-3 py-2 bg-white border border-slate-200 text-slate-700 text-xs font-medium rounded-lg hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0"
              >
                <Shield className="w-3.5 h-3.5" />
                <span>Export .enc</span>
              </button>
            )}
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          <div className="lg:col-span-7 space-y-4">
            <div className="bg-[#0B0F17] border border-slate-800 rounded-xl overflow-hidden">
              <div className="aspect-video w-full bg-[#070A10] flex items-center justify-center">
                {videoLoading ? (
                  <div className="text-xs text-slate-300">
                    Decrypting local video recording...
                  </div>
                ) : videoUrl ? (
                  <video
                    ref={videoRef}
                    src={videoUrl}
                    controls
                    playsInline
                    className="w-full h-full object-contain"
                  />
                ) : (
                  <div className="text-center px-6 py-8">
                    <VideoOff className="w-6 h-6 text-slate-500 mx-auto mb-2" />
                    <p className="text-xs text-slate-300 font-medium">
                      Local video file not stored on this browser
                    </p>
                    <p className="text-[11px] text-slate-500 mt-1">
                      Encrypted recordings are saved locally on the device where they were captured.
                    </p>
                  </div>
                )}
              </div>
              <div className="px-4 py-2.5 border-t border-slate-800/80 flex items-center justify-between text-[11px] text-slate-400">
                <span>Recorded Meeting Playback</span>
                <span className="font-mono tabular-nums">
                  {selectedMeeting.fileSizeBytes > 0
                    ? `${selectedMeeting.videoMimeType} · ${formatBytes(selectedMeeting.fileSizeBytes)}`
                    : 'Metadata Only'}
                </span>
              </div>
            </div>

            <div className="bg-white border border-slate-200 rounded-xl p-4 flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <span className="text-xs text-slate-500">Folder:</span>
                <select
                  value={selectedMeeting.folderId}
                  onChange={(e) =>
                    void updateMeetingMeta(
                      uid,
                      selectedMeeting.id,
                      { folderId: e.target.value },
                      selectedMeeting
                    )
                  }
                  className="px-2.5 py-1.5 text-xs bg-white border border-slate-200 rounded-md focus:outline-none focus:border-blue-600"
                >
                  <option value="">Unfiled</option>
                  {folders.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() =>
                    void updateMeetingMeta(
                      uid,
                      selectedMeeting.id,
                      { starred: !selectedMeeting.starred },
                      selectedMeeting
                    )
                  }
                  className={`inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium border rounded-md transition-colors ${
                    selectedMeeting.starred
                      ? 'border-amber-300 bg-amber-50 text-amber-800'
                      : 'border-slate-200 text-slate-600 hover:bg-slate-50'
                  }`}
                >
                  <Star
                    className={`w-3.5 h-3.5 ${
                      selectedMeeting.starred ? 'fill-amber-500 text-amber-500' : ''
                    }`}
                  />
                  <span>{selectedMeeting.starred ? 'Starred' : 'Star'}</span>
                </button>
                <button
                  type="button"
                  onClick={() =>
                    void setMeetingArchived(uid, selectedMeeting.id, !selectedMeeting.archived)
                  }
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium border border-slate-200 text-slate-600 rounded-md hover:bg-slate-50 transition-colors"
                >
                  <Archive className="w-3.5 h-3.5" />
                  <span>{selectedMeeting.archived ? 'Restore' : 'Archive'}</span>
                </button>
              </div>
            </div>
          </div>

          <div className="lg:col-span-5 bg-white border border-slate-200 rounded-xl p-6 space-y-6">
            <div>
              <div className="flex items-center justify-between mb-2">
                <h2 className="text-xs font-semibold text-slate-500 uppercase tracking-wider">
                  Meeting Notes (Encrypted)
                </h2>
                {notesSavedNotice && (
                  <span className="text-[11px] text-emerald-700 font-medium">Saved</span>
                )}
              </div>
              <textarea
                rows={5}
                value={notesDraft}
                onChange={(e) => {
                  const val = e.target.value;
                  setNotesDraft(val);
                  setNotesSavedNotice(false);
                  if (selectedMeeting) {
                    try {
                      sessionStorage.setItem(`cadence_notes_draft_${selectedMeeting.id}`, val);
                    } catch {
                      // Ignore
                    }
                  }
                }}
                placeholder="Write meeting notes here..."
                className="w-full px-3 py-2 text-sm bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:bg-white focus:border-blue-600"
              />
              <div className="mt-2 flex justify-end">
                <button
                  type="button"
                  disabled={savingNotes}
                  onClick={() => void handleSaveNotes()}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-slate-900 text-white text-xs font-medium rounded-lg hover:bg-slate-800 disabled:opacity-50"
                >
                  <Save className="w-3.5 h-3.5" />
                  <span>{savingNotes ? 'Saving...' : 'Save Notes'}</span>
                </button>
              </div>
            </div>

            {selectedMeeting.payload.bookmarks.length > 0 && (
              <div className="pt-4 border-t border-slate-100">
                <h2 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2.5">
                  Timestamp Bookmarks
                </h2>
                <div className="divide-y divide-slate-100">
                  {selectedMeeting.payload.bookmarks.map((bm) => (
                    <div key={bm.id} className="py-2 flex items-center justify-between gap-3 text-xs">
                      <span className="text-slate-700">{bm.note}</span>
                      <button
                        type="button"
                        onClick={() => jumpToTimestamp(bm.timeSec)}
                        className="inline-flex items-center gap-1 font-mono tabular-nums text-blue-600 hover:underline shrink-0"
                      >
                        <Play className="w-2.5 h-2.5 fill-current" />
                        {formatTimecode(bm.timeSec)}
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {linkedTasks.length > 0 && (
              <div className="pt-4 border-t border-slate-100">
                <h2 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2.5">
                  Linked Tasks ({linkedTasks.length})
                </h2>
                <div className="divide-y divide-slate-100">
                  {linkedTasks.map((task) => {
                    const done = task.status === 'done';
                    return (
                      <div key={task.id} className="py-2.5 flex items-start gap-2.5">
                        <button
                          type="button"
                          onClick={() =>
                            void updateTaskStatus(uid, task.id, done ? 'in_progress' : 'done')
                          }
                          className="mt-0.5 text-slate-400 hover:text-blue-600 shrink-0"
                        >
                          {done ? (
                            <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                          ) : (
                            <Circle className="w-4 h-4" />
                          )}
                        </button>
                        <div className="text-xs text-slate-800">{task.payload.title}</div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-semibold text-slate-900 tracking-tight">
            Recorded Meeting Logs
          </h1>
          <p className="text-sm text-slate-600 mt-1">
            Organize encrypted meeting recordings in folders, play them back, and download videos locally.
          </p>
        </div>

        <button
          type="button"
          onClick={() => setNewFolderOpen((v) => !v)}
          className="inline-flex items-center gap-1.5 px-3.5 py-2 bg-white border border-slate-300 text-slate-800 text-xs font-medium rounded-lg hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0 self-start"
        >
          <FolderPlus className="w-3.5 h-3.5" />
          <span>New Folder</span>
        </button>
      </div>

      {newFolderOpen && (
        <form
          onSubmit={handleCreateFolder}
          className="bg-white border border-slate-200 rounded-xl p-4 flex flex-wrap items-end gap-3"
        >
          <div className="flex-1 min-w-[200px]">
            <label className="block text-xs font-medium text-slate-700 mb-1">
              Folder Name
            </label>
            <input
              type="text"
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              placeholder="e.g. Executive Steering Committee"
              className="w-full px-3 py-1.5 text-sm border border-slate-300 rounded-lg focus:outline-none focus:border-blue-600"
              required
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">Color</label>
            <input
              type="color"
              value={newFolderColor}
              onChange={(e) => setNewFolderColor(e.target.value)}
              className="h-9 w-12 p-1 bg-white border border-slate-300 rounded-lg cursor-pointer"
            />
          </div>
          <button
            type="submit"
            className="px-4 py-2 bg-blue-600 text-white text-xs font-medium rounded-lg hover:bg-blue-700 whitespace-nowrap shrink-0"
          >
            Create Folder
          </button>
        </form>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        <aside className="lg:col-span-3 bg-white border border-slate-200 rounded-xl p-3 space-y-1">
          <div className="px-2.5 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
            Folders
          </div>
          <button
            type="button"
            onClick={() => setFolderFilter('all')}
            className={`w-full flex items-center justify-between px-2.5 py-2 text-xs rounded-lg transition-colors ${
              folderFilter === 'all'
                ? 'bg-slate-900 text-white font-medium'
                : 'text-slate-700 hover:bg-slate-100'
            }`}
          >
            <span className="truncate">All Recordings</span>
            <span className="font-mono tabular-nums opacity-75">{meetings.length}</span>
          </button>
          <button
            type="button"
            onClick={() => setFolderFilter('unfiled')}
            className={`w-full flex items-center justify-between px-2.5 py-2 text-xs rounded-lg transition-colors ${
              folderFilter === 'unfiled'
                ? 'bg-slate-900 text-white font-medium'
                : 'text-slate-700 hover:bg-slate-100'
            }`}
          >
            <span className="truncate">Unfiled</span>
            <span className="font-mono tabular-nums opacity-75">
              {meetings.filter((m) => !m.folderId).length}
            </span>
          </button>

          {folders.map((folder) => {
            const count = meetings.filter((m) => m.folderId === folder.id).length;
            const active = folderFilter === folder.id;
            return (
              <div key={folder.id} className="group flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => setFolderFilter(folder.id)}
                  className={`flex-1 min-w-0 flex items-center justify-between px-2.5 py-2 text-xs rounded-lg transition-colors ${
                    active
                      ? 'bg-slate-900 text-white font-medium'
                      : 'text-slate-700 hover:bg-slate-100'
                  }`}
                >
                  <span className="flex items-center gap-2 truncate">
                    <span
                      className="w-2 h-2 rounded-full shrink-0"
                      style={{ backgroundColor: folder.colorHex }}
                    />
                    <span className="truncate">{folder.name}</span>
                  </span>
                  <span className="font-mono tabular-nums opacity-75">{count}</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (folderFilter === folder.id) setFolderFilter('all');
                    void deleteFolder(uid, folder.id);
                  }}
                  className="opacity-0 group-hover:opacity-100 p-1.5 text-slate-400 hover:text-red-600 transition-opacity"
                  aria-label={`Delete ${folder.name}`}
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>
            );
          })}
        </aside>

        <div className="lg:col-span-9 space-y-4">
          <div className="bg-white border border-slate-200 rounded-xl p-3 flex flex-wrap items-center justify-between gap-3">
            <div className="flex-1 min-w-[220px] relative">
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search recordings by title, Meet link, or notes..."
                className="w-full pl-9 pr-3 py-1.5 text-xs bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:bg-white focus:border-blue-600"
              />
            </div>

            <div className="flex items-center gap-2">
              <div className="inline-flex items-center p-0.5 bg-slate-100 rounded-lg">
                {(['active', 'starred', 'archived'] as LogStatusFilter[]).map((tab) => (
                  <button
                    key={tab}
                    type="button"
                    onClick={() => setStatusFilter(tab)}
                    className={`px-2.5 py-1 text-xs font-medium rounded-md capitalize transition-colors whitespace-nowrap shrink-0 ${
                      statusFilter === tab
                        ? 'bg-white text-slate-900 shadow-xs'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    {tab}
                  </button>
                ))}
              </div>

              <select
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value as 'newest' | 'longest')}
                className="px-2.5 py-1.5 text-xs bg-white border border-slate-200 rounded-lg focus:outline-none focus:border-blue-600"
              >
                <option value="newest">Newest First</option>
                <option value="longest">Longest Duration</option>
              </select>
            </div>
          </div>

          {selectedIds.size > 0 && (
            <div className="bg-slate-900 text-white rounded-xl px-4 py-2.5 flex flex-wrap items-center justify-between gap-3 text-xs">
              <span className="font-medium font-mono tabular-nums">
                {selectedIds.size} selected
              </span>
              <div className="flex flex-wrap items-center gap-2">
                <select
                  defaultValue=""
                  onChange={(e) => {
                    if (e.target.value !== '') {
                      void handleBulkMoveFolder(e.target.value === 'unfiled' ? '' : e.target.value);
                    }
                  }}
                  className="px-2.5 py-1 bg-slate-800 border border-slate-700 text-slate-100 rounded-md"
                >
                  <option value="" disabled>
                    Move to folder...
                  </option>
                  <option value="unfiled">Unfiled</option>
                  {folders.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => void handleBulkArchive(statusFilter !== 'archived')}
                  className="px-2.5 py-1 bg-slate-800 border border-slate-700 rounded-md hover:bg-slate-700"
                >
                  {statusFilter === 'archived' ? 'Restore' : 'Archive'}
                </button>
                <button
                  type="button"
                  onClick={() => void handleBulkDelete()}
                  className="px-2.5 py-1 bg-red-600 rounded-md hover:bg-red-700"
                >
                  Delete Permanently
                </button>
              </div>
            </div>
          )}

          <div className="bg-white border border-slate-200 rounded-xl divide-y divide-slate-100 overflow-hidden">
            {filteredMeetings.length > 0 ? (
              filteredMeetings.map((m) => {
                const folder = folderMap.get(m.folderId);
                const checked = selectedIds.has(m.id);
                return (
                  <div
                    key={m.id}
                    className="p-4 hover:bg-slate-50/70 transition-colors flex items-start gap-3.5"
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => handleToggleSelect(m.id)}
                      className="mt-1 rounded border-slate-300 text-blue-600 focus:ring-blue-600"
                      aria-label={`Select ${m.payload.title}`}
                    />

                    <div
                      onClick={() => onSelectMeeting(m.id)}
                      className="flex-1 min-w-0 cursor-pointer"
                    >
                      <div className="flex items-center justify-between gap-4">
                        <h3 className="font-display text-sm font-semibold text-slate-900 truncate">
                          {m.payload.title}
                        </h3>
                        <span className="font-mono tabular-nums text-xs text-slate-500 shrink-0">
                          {formatTimecode(m.durationSec)}
                        </span>
                      </div>

                      {m.payload.notes && (
                        <p className="text-xs text-slate-600 mt-1 line-clamp-2 leading-relaxed">
                          {m.payload.notes}
                        </p>
                      )}

                      <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
                        <span className="font-mono tabular-nums">
                          {formatDateTime(m.recordedAtMs)}
                        </span>
                        <span aria-hidden="true">·</span>
                        <span>{folder ? folder.name : 'Unfiled'}</span>
                        <span aria-hidden="true">·</span>
                        <span>
                          {m.hasLocalVideo
                            ? `${m.videoMimeType} (${formatBytes(m.fileSizeBytes)})`
                            : 'Metadata Only'}
                        </span>
                      </div>
                    </div>

                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        type="button"
                        onClick={() =>
                          void updateMeetingMeta(uid, m.id, { starred: !m.starred }, m)
                        }
                        className="p-1.5 text-slate-400 hover:text-amber-500 rounded-md"
                        aria-label="Toggle star"
                      >
                        <Star
                          className={`w-4 h-4 ${m.starred ? 'fill-amber-400 text-amber-500' : ''}`}
                        />
                      </button>
                      {m.hasLocalVideo && (
                        <button
                          type="button"
                          onClick={() => void handleDownloadVideo(m)}
                          className="p-1.5 text-slate-400 hover:text-blue-600 rounded-md"
                          aria-label="Download Video"
                          title="Download video to device"
                        >
                          <Download className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                  </div>
                );
              })
            ) : (
              <div className="py-14 px-6 text-center">
                <FolderOpen className="w-7 h-7 text-slate-300 mx-auto mb-3" />
                <p className="text-sm font-medium text-slate-800">
                  No meeting recordings yet
                </p>
                <p className="text-xs text-slate-500 mt-1 mb-4">
                  Record a Google Meet session or import a video file to build your encrypted archive.
                </p>
                <button
                  type="button"
                  onClick={onGoToCapture}
                  className="inline-flex items-center gap-1.5 px-4 py-2 bg-blue-600 text-white text-xs font-medium rounded-lg hover:bg-blue-700 transition-colors"
                >
                  Record First Meeting
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

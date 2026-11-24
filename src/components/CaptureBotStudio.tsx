import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Video,
  Mic,
  MicOff,
  Camera,
  Square,
  Play,
  Download,
  ExternalLink,
  BookmarkPlus,
  Upload,
  CheckCircle2,
  AlertCircle,
  Loader2,
  FolderOpen,
  ArrowRight,
  Lock,
  MonitorPlay,
} from 'lucide-react';
import {
  appendLiveCheckpointChunk,
  clearLiveCheckpoint,
  initLiveCheckpoint,
  recoverLiveCheckpoint,
  saveEncryptedVideo,
  triggerBlobDownload,
  updateLiveCheckpointMeta,
} from '../lib/vaultStorage';
import { saveEncryptedMeeting } from '../lib/workspaceStore';
import {
  startActiveSpeakerCapture,
  type ActiveCaptureSession,
  type RecorderTelemetry,
} from '../lib/mp4Recorder';
import { formatBytes, formatTimecode, generateDocId } from '../lib/formatters';
import type {
  DecryptedMeetingPayload,
  MeetingFolder,
  SessionBookmark,
  SpeakerFramingMode,
} from '../types';

interface CaptureBotStudioProps {
  uid: string;
  masterKey: CryptoKey;
  folders: MeetingFolder[];
  onOpenMeeting: (meetingId: string) => void;
}

type StudioTab = 'live_bot' | 'import_media';

function checkDisplayCaptureAllowed(): { allowed: boolean; inIframe: boolean } {
  if (typeof window === 'undefined') return { allowed: false, inIframe: false };
  const inIframe = window.self !== window.top;
  const docAny = document as unknown as {
    permissionsPolicy?: { allowsFeature?: (feature: string) => boolean };
    featurePolicy?: { allowsFeature?: (feature: string) => boolean };
  };
  const policy = docAny.permissionsPolicy || docAny.featurePolicy;
  if (policy && typeof policy.allowsFeature === 'function') {
    try {
      return { allowed: policy.allowsFeature('display-capture'), inIframe };
    } catch {
      return { allowed: !inIframe, inIframe };
    }
  }
  return { allowed: !inIframe, inIframe };
}

const DRAFT_STORAGE_KEY = 'cadence_capture_draft_v1';

interface CaptureDraft {
  meetUrlInput?: string;
  meetingTitle?: string;
  sessionNotes?: string;
  selectedFolderId?: string;
  framingMode?: SpeakerFramingMode;
}

function loadCaptureDraft(): CaptureDraft {
  try {
    const raw = sessionStorage.getItem(DRAFT_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as CaptureDraft) : {};
  } catch {
    return {};
  }
}

export const CaptureBotStudio: React.FC<CaptureBotStudioProps> = ({
  uid,
  masterKey,
  folders,
  onOpenMeeting,
}) => {
  const initialDraft = useMemo(() => loadCaptureDraft(), []);

  const [studioTab, setStudioTab] = useState<StudioTab>('live_bot');
  const [meetUrlInput, setMeetUrlInput] = useState(initialDraft.meetUrlInput ?? '');
  const [validatedUrl, setValidatedUrl] = useState('');
  const [meetingCode, setMeetingCode] = useState('');
  const [meetingTitle, setMeetingTitle] = useState(initialDraft.meetingTitle ?? '');
  const [sessionNotes, setSessionNotes] = useState(initialDraft.sessionNotes ?? '');
  const [selectedFolderId, setSelectedFolderId] = useState<string>(
    initialDraft.selectedFolderId ?? folders[0]?.id ?? ''
  );
  const [framingMode, setFramingMode] = useState<SpeakerFramingMode>(
    initialDraft.framingMode ?? 'smart_focus'
  );
  const [includeMic, setIncludeMic] = useState(true);
  const [includeCamPip, setIncludeCamPip] = useState(false);

  const [isRecording, setIsRecording] = useState(false);
  const [saving, setSaving] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [recoveredNotice, setRecoveredNotice] = useState('');

  const displayCapInfo = useMemo(() => checkDisplayCaptureAllowed(), []);
  const [tabCaptureBlocked, setTabCaptureBlocked] = useState(!displayCapInfo.allowed);

  const [telemetry, setTelemetry] = useState<RecorderTelemetry>({
    elapsedSec: 0,
    remoteLevel: 0,
    localLevel: 0,
    activeSpeaker: 'idle',
    waveformBars: new Array(24).fill(0.1),
    codecLabel: 'H.264 / AAC MP4',
  });

  const [bookmarkInput, setBookmarkInput] = useState('');
  const [bookmarks, setBookmarks] = useState<SessionBookmark[]>([]);
  const [lastCompleted, setLastCompleted] = useState<{
    meetingId: string;
    title: string;
    videoBlob: Blob;
    videoUrl: string;
    videoMimeType: string;
    durationSec: number;
  } | null>(null);

  const [importedFile, setImportedFile] = useState<File | null>(null);

  const captureRef = useRef<ActiveCaptureSession | null>(null);
  const previewContainerRef = useRef<HTMLDivElement | null>(null);
  const elapsedRef = useRef(0);
  const chunkSeqRef = useRef(0);
  const checkpointChainRef = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    try {
      sessionStorage.setItem(
        DRAFT_STORAGE_KEY,
        JSON.stringify({
          meetUrlInput,
          meetingTitle,
          sessionNotes,
          selectedFolderId,
          framingMode,
        } satisfies CaptureDraft)
      );
    } catch {
      // Ignore storage quota issues
    }
  }, [meetUrlInput, meetingTitle, sessionNotes, selectedFolderId, framingMode]);

  useEffect(() => {
    if (!isRecording && !saving) return;
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [isRecording, saving]);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const recovered = await recoverLiveCheckpoint(masterKey);
        if (!active || !recovered) return;
        const meetingId = generateDocId('mtg');
        const savedBytes = await saveEncryptedVideo(meetingId, recovered.videoBlob, masterKey);
        const payload: DecryptedMeetingPayload = {
          title: `${recovered.meta.title} (Recovered)`,
          meetUrl: recovered.meta.meetUrl,
          notes: recovered.meta.notes,
          bookmarks: [],
        };
        await saveEncryptedMeeting({
          uid,
          meetingId,
          masterKey,
          folderId: recovered.meta.folderId,
          durationSec: recovered.durationSec,
          fileSizeBytes: savedBytes,
          hasLocalVideo: true,
          videoMimeType: recovered.videoBlob.type || recovered.meta.mimeType || 'video/webm',
          tags: ['recovered'],
          payload,
        });
        await clearLiveCheckpoint();
        if (!active) return;
        const videoUrl = URL.createObjectURL(recovered.videoBlob);
        setLastCompleted({
          meetingId,
          title: payload.title,
          videoBlob: recovered.videoBlob,
          videoUrl,
          videoMimeType: recovered.videoBlob.type || recovered.meta.mimeType,
          durationSec: recovered.durationSec,
        });
        setRecoveredNotice(
          `Recovered an interrupted recording ("${payload.title}") from your local cache and saved it to Meeting Logs.`
        );
      } catch {
        // Ignore corrupt partial checkpoint
      }
    })();
    return () => {
      active = false;
    };
  }, [masterKey, uid]);

  useEffect(() => {
    if (!selectedFolderId && folders.length > 0) {
      setSelectedFolderId(folders[0].id);
    }
  }, [folders, selectedFolderId]);

  useEffect(() => {
    captureRef.current?.setFramingMode(framingMode);
  }, [framingMode]);

  useEffect(() => {
    return () => {
      if (lastCompleted?.videoUrl) {
        URL.revokeObjectURL(lastCompleted.videoUrl);
      }
    };
  }, [lastCompleted]);

  const validateMeetLink = async (): Promise<string | null> => {
    const rawUrl = meetUrlInput.trim();
    if (!rawUrl) {
      setErrorMsg(
        'Paste a Google Meet link (e.g. https://meet.google.com/abc-defg-hij) to start recording.'
      );
      return null;
    }

    const validateLocally = (): string | null => {
      let candidate = rawUrl;
      if (/^[a-z]{3}-[a-z]{4}-[a-z]{3}$/i.test(candidate)) {
        candidate = `https://meet.google.com/${candidate.toLowerCase()}`;
      } else if (!/^https?:\/\//i.test(candidate)) {
        candidate = `https://${candidate}`;
      }
      try {
        const parsed = new URL(candidate);
        if (parsed.hostname.toLowerCase() !== 'meet.google.com') {
          setErrorMsg('URL must be a valid meet.google.com meeting link (e.g. https://meet.google.com/abc-defg-hij).');
          return null;
        }
        const code = (parsed.pathname.replace(/^\/+|\/+$/g, '').split('/')[0] || '').toLowerCase();
        if (!/^[a-z]{3}-[a-z]{4}-[a-z]{3}$/.test(code)) {
          setErrorMsg('Meeting code should match the Google Meet format xxx-yyyy-zzz.');
          return null;
        }
        const normalized = `https://meet.google.com/${code}`;
        setValidatedUrl(normalized);
        setMeetingCode(code);
        if (!meetingTitle.trim()) {
          setMeetingTitle(`Meet Recording (${code})`);
        }
        return normalized;
      } catch {
        setErrorMsg('Invalid Google Meet URL format.');
        return null;
      }
    };

    try {
      const res = await fetch('/api/meet/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ meetUrl: rawUrl }),
      });
      if (res.status === 404 || res.status === 405) {
        return validateLocally();
      }
      const data = (await res.json()) as {
        valid?: boolean;
        normalizedUrl?: string;
        meetingCode?: string;
        error?: string;
      };
      if (!res.ok || !data.valid || !data.normalizedUrl) {
        setErrorMsg(data.error ?? 'Invalid Google Meet link.');
        return null;
      }
      setValidatedUrl(data.normalizedUrl);
      setMeetingCode(data.meetingCode ?? '');
      if (!meetingTitle.trim()) {
        setMeetingTitle(`Meet Recording (${data.meetingCode})`);
      }
      return data.normalizedUrl;
    } catch {
      return validateLocally();
    }
  };

  const handleValidateOnly = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg('');
    await validateMeetLink();
  };

  const saveRecordedVideo = async (params: {
    videoBlob: Blob;
    durationSec: number;
    videoMimeType: string;
    sessionTitle: string;
    sessionMeetUrl: string;
    sessionBookmarks: SessionBookmark[];
  }) => {
    setSaving(true);
    try {
      const meetingId = generateDocId('mtg');
      let savedBytes = 0;
      const hasLocalVideo = params.videoBlob.size > 0;
      if (hasLocalVideo) {
        savedBytes = await saveEncryptedVideo(meetingId, params.videoBlob, masterKey);
      }

      const payload: DecryptedMeetingPayload = {
        title: params.sessionTitle,
        meetUrl: params.sessionMeetUrl,
        notes: sessionNotes.trim(),
        bookmarks: params.sessionBookmarks,
      };

      await saveEncryptedMeeting({
        uid,
        meetingId,
        masterKey,
        folderId: selectedFolderId,
        durationSec: params.durationSec,
        fileSizeBytes: savedBytes,
        hasLocalVideo,
        videoMimeType: params.videoMimeType,
        tags: [],
        payload,
      });

      const videoUrl = URL.createObjectURL(params.videoBlob);
      setLastCompleted({
        meetingId,
        title: params.sessionTitle,
        videoBlob: params.videoBlob,
        videoUrl,
        videoMimeType: params.videoMimeType,
        durationSec: params.durationSec,
      });
    } finally {
      setSaving(false);
    }
  };

  const handleStartLiveCapture = async (captureSource: 'meet_tab' | 'room_mic_cam') => {
    setErrorMsg('');
    setRecoveredNotice('');
    setLastCompleted(null);

    const normalized = await validateMeetLink();
    if (!normalized) return;

    let displayStream: MediaStream | null = null;
    let micStream: MediaStream | null = null;
    let camStream: MediaStream | null = null;

    try {
      if (captureSource === 'meet_tab') {
        if (tabCaptureBlocked || typeof navigator.mediaDevices?.getDisplayMedia !== 'function') {
          setTabCaptureBlocked(true);
          setErrorMsg(
            'Screen/tab capture is restricted inside an embedded preview frame. Click Open Full-Tab Studio above to record a Google Meet tab, or use Record Room Mic & Camera below.'
          );
          return;
        }

        try {
          displayStream = await navigator.mediaDevices.getDisplayMedia({
            video: {
              frameRate: { ideal: 30, max: 30 },
              width: { ideal: 1920 },
              height: { ideal: 1080 },
            },
            audio: true,
          });
        } catch (dispErr) {
          const msg = dispErr instanceof Error ? dispErr.message : String(dispErr);
          if (
            msg.toLowerCase().includes('permissions policy') ||
            msg.toLowerCase().includes('disallowed')
          ) {
            setTabCaptureBlocked(true);
            setErrorMsg(
              'Tab capture is blocked by the embedded frame permissions policy. Click Open Full-Tab Studio above for Google Meet tab recording, or use Record Room Mic & Camera below.'
            );
            return;
          }
          throw dispErr;
        }
      }

      if (includeMic || captureSource === 'room_mic_cam') {
        try {
          micStream = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
          });
        } catch (micErr) {
          if (captureSource === 'room_mic_cam') {
            throw micErr;
          }
        }
      }

      if (includeCamPip || captureSource === 'room_mic_cam') {
        try {
          camStream = await navigator.mediaDevices.getUserMedia({
            video: { width: 1280, height: 720 },
          });
        } catch {
          // Continue with audio + broadcast canvas if camera is unavailable
        }
      }

      const effectiveTitle = meetingTitle.trim() || `Meet Recording (${meetingCode || 'Session'})`;
      chunkSeqRef.current = 0;
      checkpointChainRef.current = initLiveCheckpoint({
        title: effectiveTitle,
        meetUrl: normalized,
        folderId: selectedFolderId,
        notes: sessionNotes.trim(),
        mimeType: 'video/webm',
        startedAtMs: Date.now(),
      }).catch(() => {});

      setBookmarks([]);
      const session = await startActiveSpeakerCapture({
        displayStream,
        micStream,
        camStream,
        sessionLabel: effectiveTitle,
        framingMode,
        onTelemetry: (t) => {
          elapsedRef.current = t.elapsedSec;
          setTelemetry(t);
        },
        onCheckpointChunk: (chunk, mimeType) => {
          const seq = chunkSeqRef.current++;
          checkpointChainRef.current = checkpointChainRef.current
            .then(() => appendLiveCheckpointChunk(seq, chunk, mimeType, masterKey))
            .catch(() => {});
        },
        onStreamEnded: () => {
          void handleStopAndSave();
        },
      });

      captureRef.current = session;
      if (previewContainerRef.current) {
        previewContainerRef.current.innerHTML = '';
        session.previewCanvas.className = 'w-full h-full object-contain rounded-lg';
        previewContainerRef.current.appendChild(session.previewCanvas);
      }
      setIsRecording(true);
    } catch (err) {
      displayStream?.getTracks().forEach((t) => t.stop());
      micStream?.getTracks().forEach((t) => t.stop());
      camStream?.getTracks().forEach((t) => t.stop());
      setErrorMsg(
        err instanceof Error
          ? err.message
          : 'Unable to access media capture devices. Check browser permissions and try again.'
      );
    }
  };

  const handleStopAndSave = async () => {
    const session = captureRef.current;
    if (!session) return;
    captureRef.current = null;
    setIsRecording(false);
    setErrorMsg('');

    try {
      const output = await session.stop();
      if (previewContainerRef.current) {
        previewContainerRef.current.innerHTML = '';
      }

      await saveRecordedVideo({
        videoBlob: output.videoBlob,
        durationSec: output.durationSec,
        videoMimeType: output.videoMimeType,
        sessionTitle: meetingTitle.trim() || `Meet Recording (${meetingCode || 'Session'})`,
        sessionMeetUrl: validatedUrl || meetUrlInput.trim(),
        sessionBookmarks: bookmarks,
      });
      await checkpointChainRef.current.catch(() => {});
      await clearLiveCheckpoint().catch(() => {});
    } catch (err) {
      setSaving(false);
      setErrorMsg(err instanceof Error ? err.message : 'Failed to save recorded meeting.');
    }
  };

  const handleImportSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!importedFile) {
      setErrorMsg('Select a video or audio recording file first.');
      return;
    }
    setErrorMsg('');
    setLastCompleted(null);

    try {
      const estimatedDuration = await new Promise<number>((resolve) => {
        const media = document.createElement(importedFile.type.startsWith('audio') ? 'audio' : 'video');
        media.preload = 'metadata';
        const url = URL.createObjectURL(importedFile);
        media.onloadedmetadata = () => {
          const d = Number.isFinite(media.duration) ? Math.round(media.duration) : 60;
          URL.revokeObjectURL(url);
          resolve(Math.max(1, d));
        };
        media.onerror = () => {
          URL.revokeObjectURL(url);
          resolve(60);
        };
        media.src = url;
      });

      await saveRecordedVideo({
        videoBlob: importedFile,
        durationSec: estimatedDuration,
        videoMimeType: importedFile.type || 'video/mp4',
        sessionTitle: meetingTitle.trim() || importedFile.name.replace(/\.[^/.]+$/, ''),
        sessionMeetUrl: validatedUrl || meetUrlInput.trim(),
        sessionBookmarks: [],
      });
    } catch (err) {
      setSaving(false);
      setErrorMsg(err instanceof Error ? err.message : 'Failed to store uploaded recording.');
    }
  };

  const handleAddBookmark = (e: React.FormEvent) => {
    e.preventDefault();
    if (!bookmarkInput.trim() || !isRecording) return;
    setBookmarks((prev) => [
      ...prev,
      {
        id: generateDocId('bm'),
        timeSec: Math.round(elapsedRef.current),
        note: bookmarkInput.trim(),
      },
    ]);
    setBookmarkInput('');
  };

  const handleDownloadRecording = () => {
    if (!lastCompleted) return;
    const ext = lastCompleted.videoMimeType.includes('mp4') ? 'mp4' : 'webm';
    const safeName = lastCompleted.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '');
    triggerBlobDownload(lastCompleted.videoBlob, `${safeName || 'meeting-recording'}.${ext}`);
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-semibold text-slate-900 tracking-tight">
            Meeting Video Recorder
          </h1>
          <p className="text-sm text-slate-600 mt-1">
            Enter a Google Meet link, record the full meeting with the active speaker in view, store it encrypted, and download the video file to your device.
          </p>
        </div>
        <div className="inline-flex items-center p-1 bg-slate-100 border border-slate-200 rounded-lg shrink-0 self-start">
          <button
            type="button"
            disabled={isRecording || saving}
            onClick={() => setStudioTab('live_bot')}
            className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
              studioTab === 'live_bot'
                ? 'bg-white text-slate-900 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            Live Recorder
          </button>
          <button
            type="button"
            disabled={isRecording || saving}
            onClick={() => setStudioTab('import_media')}
            className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
              studioTab === 'import_media'
                ? 'bg-white text-slate-900 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            Import Video
          </button>
        </div>
      </div>

      {tabCaptureBlocked && studioTab === 'live_bot' && (
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-4 bg-white border border-slate-200 rounded-xl text-xs text-slate-700">
          <div className="flex items-start gap-2.5">
            <MonitorPlay className="w-4 h-4 text-blue-600 shrink-0 mt-0.5" />
            <div>
              <span className="font-semibold text-slate-900">
                Embedded preview detected:
              </span>{' '}
              To capture a Google Meet browser tab directly, open this recorder in a full browser tab, or record directly here with your mic and camera.
            </div>
          </div>
          <a
            href={typeof window !== 'undefined' ? window.location.href : '/'}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-slate-900 text-white font-medium rounded-lg hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0 self-start sm:self-auto"
          >
            <span>Open Full-Tab Studio</span>
            <ExternalLink className="w-3.5 h-3.5" />
          </a>
        </div>
      )}

      {recoveredNotice && (
        <div className="flex items-start gap-2.5 p-3.5 bg-emerald-50 border border-emerald-200 rounded-lg text-sm text-emerald-900">
          <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
          <span>{recoveredNotice}</span>
        </div>
      )}

      {errorMsg && (
        <div className="flex items-start gap-2.5 p-3.5 bg-red-50 border border-red-200 rounded-lg text-sm text-red-800">
          <AlertCircle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
          <span>{errorMsg}</span>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Left: Controls */}
        <div className="lg:col-span-5 bg-white border border-slate-200 rounded-xl p-6 space-y-5">
          {studioTab === 'live_bot' ? (
            <>
              <form onSubmit={handleValidateOnly} className="space-y-4">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1.5">
                    Google Meet Link (No Calendar Required)
                  </label>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={meetUrlInput}
                      onChange={(e) => {
                        setMeetUrlInput(e.target.value);
                        setValidatedUrl('');
                      }}
                      disabled={isRecording || saving}
                      placeholder="https://meet.google.com/abc-defg-hij"
                      className="flex-1 min-w-0 px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600/20 focus:border-blue-600 disabled:bg-slate-50"
                    />
                    <button
                      type="submit"
                      disabled={isRecording || saving}
                      className="px-3.5 py-2 text-xs font-medium text-slate-700 bg-slate-100 border border-slate-200 rounded-lg hover:bg-slate-200/70 transition-colors whitespace-nowrap shrink-0"
                    >
                      Verify Link
                    </button>
                  </div>
                  {validatedUrl && (
                    <div className="mt-2 flex items-center justify-between text-xs text-emerald-700">
                      <span>Verified session · {meetingCode}</span>
                      <a
                        href={validatedUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-blue-600 hover:underline font-medium"
                      >
                        Open Meet Tab
                        <ExternalLink className="w-3 h-3" />
                      </a>
                    </div>
                  )}
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1.5">
                    Recording Title (Optional)
                  </label>
                  <input
                    type="text"
                    value={meetingTitle}
                    onChange={(e) => setMeetingTitle(e.target.value)}
                    disabled={isRecording || saving}
                    placeholder="e.g. Weekly Team Sync"
                    className="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600/20 focus:border-blue-600 disabled:bg-slate-50"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1.5">
                    Save to Folder
                  </label>
                  <div className="relative">
                    <FolderOpen className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                    <select
                      value={selectedFolderId}
                      onChange={(e) => setSelectedFolderId(e.target.value)}
                      disabled={isRecording || saving}
                      className="w-full pl-9 pr-3 py-2 text-sm bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600/20 focus:border-blue-600"
                    >
                      <option value="">Unfiled Recordings</option>
                      {folders.map((f) => (
                        <option key={f.id} value={f.id}>
                          {f.name}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1.5">
                    Session Notes (Optional)
                  </label>
                  <textarea
                    rows={2}
                    value={sessionNotes}
                    onChange={(e) => {
                      const val = e.target.value;
                      setSessionNotes(val);
                      if (isRecording) {
                        void updateLiveCheckpointMeta({ notes: val }).catch(() => {});
                      }
                    }}
                    disabled={saving}
                    placeholder="Add personal notes for this meeting..."
                    className="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600/20 focus:border-blue-600"
                  />
                </div>
              </form>

              <div className="pt-4 border-t border-slate-100 space-y-3">
                <span className="block text-xs font-medium text-slate-700">
                  Active-Speaker Framing
                </span>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setFramingMode('smart_focus')}
                    className={`p-2.5 text-left border rounded-lg transition-colors ${
                      framingMode === 'smart_focus'
                        ? 'border-blue-600 bg-blue-50/50 text-slate-900'
                        : 'border-slate-200 hover:border-slate-300 text-slate-700'
                    }`}
                  >
                    <div className="text-xs font-semibold">Smart Focus</div>
                    <div className="text-[11px] text-slate-500 mt-0.5">
                      Tracks active talker cleanly
                    </div>
                  </button>
                  <button
                    type="button"
                    onClick={() => setFramingMode('full_stage')}
                    className={`p-2.5 text-left border rounded-lg transition-colors ${
                      framingMode === 'full_stage'
                        ? 'border-blue-600 bg-blue-50/50 text-slate-900'
                        : 'border-slate-200 hover:border-slate-300 text-slate-700'
                    }`}
                  >
                    <div className="text-xs font-semibold">Full Speaker Stage</div>
                    <div className="text-[11px] text-slate-500 mt-0.5">
                      Complete uncropped Meet view
                    </div>
                  </button>
                </div>

                <div className="flex items-center gap-3 pt-1">
                  <button
                    type="button"
                    disabled={isRecording || saving}
                    onClick={() => setIncludeMic((v) => !v)}
                    className={`flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium border rounded-lg transition-colors ${
                      includeMic
                        ? 'border-slate-900 bg-slate-900 text-white'
                        : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                    }`}
                  >
                    {includeMic ? <Mic className="w-3.5 h-3.5" /> : <MicOff className="w-3.5 h-3.5" />}
                    <span>{includeMic ? 'Mic Mixed' : 'Tab Audio Only'}</span>
                  </button>
                  <button
                    type="button"
                    disabled={isRecording || saving}
                    onClick={() => setIncludeCamPip((v) => !v)}
                    className={`flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium border rounded-lg transition-colors ${
                      includeCamPip
                        ? 'border-blue-600 bg-blue-600 text-white'
                        : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                    }`}
                  >
                    <Camera className="w-3.5 h-3.5" />
                    <span>{includeCamPip ? 'Camera On' : 'Camera Off'}</span>
                  </button>
                </div>
              </div>

              <div className="pt-4 border-t border-slate-100 space-y-2.5">
                {!isRecording ? (
                  <>
                    {!tabCaptureBlocked && (
                      <button
                        type="button"
                        disabled={saving}
                        onClick={() => void handleStartLiveCapture('meet_tab')}
                        className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
                      >
                        <Play className="w-4 h-4 fill-current" />
                        <span>Record Google Meet Tab</span>
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={saving}
                      onClick={() => void handleStartLiveCapture('room_mic_cam')}
                      className={`w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-medium rounded-lg disabled:opacity-50 transition-colors ${
                        tabCaptureBlocked
                          ? 'bg-blue-600 text-white hover:bg-blue-700'
                          : 'bg-slate-100 text-slate-800 hover:bg-slate-200/70'
                      }`}
                    >
                      <Mic className="w-4 h-4" />
                      <span>Record Room Mic & Camera</span>
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={() => void handleStopAndSave()}
                    className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 bg-red-600 text-white text-sm font-medium rounded-lg hover:bg-red-700 transition-colors"
                  >
                    <Square className="w-4 h-4 fill-current" />
                    <span>Stop & Save Recording</span>
                  </button>
                )}
              </div>
            </>
          ) : (
            <form onSubmit={handleImportSave} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1.5">
                  Select Video or Audio Recording
                </label>
                <label className="flex flex-col items-center justify-center border border-dashed border-slate-300 rounded-lg p-6 text-center cursor-pointer hover:border-blue-500 hover:bg-slate-50/60 transition-colors">
                  <Upload className="w-5 h-5 text-slate-400 mb-2" />
                  <span className="text-sm font-medium text-slate-800">
                    {importedFile ? importedFile.name : 'Choose MP4, WebM, MOV, WAV, or MP3'}
                  </span>
                  <span className="text-xs text-slate-500 mt-1">
                    {importedFile
                      ? `${formatBytes(importedFile.size)} · Ready to encrypt and store`
                      : 'Stored encrypted locally with AES-256-GCM'}
                  </span>
                  <input
                    type="file"
                    accept="video/*,audio/*"
                    className="hidden"
                    onChange={(e) => setImportedFile(e.target.files?.[0] ?? null)}
                    disabled={saving}
                  />
                </label>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1.5">
                  Recording Title
                </label>
                <input
                  type="text"
                  value={meetingTitle}
                  onChange={(e) => setMeetingTitle(e.target.value)}
                  disabled={saving}
                  placeholder="e.g. Client Call Recording"
                  className="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600/20 focus:border-blue-600"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1.5">
                  Target Folder
                </label>
                <select
                  value={selectedFolderId}
                  onChange={(e) => setSelectedFolderId(e.target.value)}
                  disabled={saving}
                  className="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600/20 focus:border-blue-600"
                >
                  <option value="">Unfiled Recordings</option>
                  {folders.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                    </option>
                  ))}
                </select>
              </div>

              <button
                type="submit"
                disabled={!importedFile || saving}
                className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
              >
                <Lock className="w-4 h-4" />
                <span>Encrypt & Save Recording</span>
              </button>
            </form>
          )}
        </div>

        {/* Right: Dark Broadcast Viewport & Completed Video Preview */}
        <div className="lg:col-span-7 space-y-4">
          <div className="bg-[#0B0F17] border border-slate-800 rounded-xl overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800/80 text-xs text-slate-300">
              <div className="flex items-center gap-2.5">
                {isRecording ? (
                  <span className="inline-flex items-center gap-1.5 text-red-400 font-medium">
                    <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
                    REC
                  </span>
                ) : (
                  <Video className="w-3.5 h-3.5 text-slate-400" />
                )}
                <span className="font-medium text-slate-200">
                  Active-Speaker Recording Viewport
                </span>
                <span className="text-slate-500">·</span>
                <span className="text-slate-400 font-mono text-[11px]">
                  {telemetry.codecLabel}
                </span>
              </div>
              <div className="font-mono tabular-nums text-slate-200 font-medium">
                {formatTimecode(telemetry.elapsedSec)}
              </div>
            </div>

            <div className="aspect-video w-full bg-[#070A10] relative flex items-center justify-center">
              <div
                ref={previewContainerRef}
                className={`w-full h-full ${isRecording ? 'block' : 'hidden'}`}
              />
              {!isRecording && !saving && lastCompleted?.videoUrl && (
                <video
                  src={lastCompleted.videoUrl}
                  controls
                  playsInline
                  className="w-full h-full object-contain"
                />
              )}
              {!isRecording && !saving && !lastCompleted && (
                <div className="text-center px-6 max-w-md">
                  <div className="w-11 h-11 rounded-lg bg-slate-800/80 border border-slate-700/80 flex items-center justify-center mx-auto mb-3 text-slate-300">
                    <Video className="w-5 h-5" />
                  </div>
                  <p className="text-sm font-medium text-slate-200">
                    Ready to record full meeting video
                  </p>
                  <p className="text-xs text-slate-400 mt-1.5 leading-relaxed">
                    Captures the active speaker completely in frame and saves the complete video encrypted locally for immediate playback and download.
                  </p>
                </div>
              )}

              {saving && (
                <div className="text-center px-6 max-w-md">
                  <Loader2 className="w-7 h-7 text-blue-400 animate-spin mx-auto mb-3" />
                  <p className="text-sm font-medium text-slate-100">
                    Encrypting & saving recorded video...
                  </p>
                </div>
              )}
            </div>

            <div className="px-4 py-3 border-t border-slate-800/80 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <div className="flex items-end gap-0.5 h-5">
                  {telemetry.waveformBars.map((bar, idx) => (
                    <span
                      key={idx}
                      style={{ height: `${Math.round(bar * 100)}%` }}
                      className={`w-1 rounded-xs transition-all duration-75 ${
                        isRecording
                          ? telemetry.activeSpeaker === 'local'
                            ? 'bg-emerald-400'
                            : 'bg-blue-400'
                          : 'bg-slate-700'
                      }`}
                    />
                  ))}
                </div>
                <span className="text-xs text-slate-300">
                  {!isRecording
                    ? 'Audio monitor standby'
                    : telemetry.activeSpeaker === 'remote'
                    ? 'Active voice: Remote Meet Speaker'
                    : telemetry.activeSpeaker === 'local'
                    ? 'Active voice: Your Microphone'
                    : 'Recording active'}
                </span>
              </div>

              {isRecording && (
                <form onSubmit={handleAddBookmark} className="flex items-center gap-2">
                  <input
                    type="text"
                    value={bookmarkInput}
                    onChange={(e) => setBookmarkInput(e.target.value)}
                    placeholder="Add timestamp note..."
                    className="px-2.5 py-1 text-xs bg-slate-900 border border-slate-700 text-slate-100 rounded-md focus:outline-none focus:border-blue-500"
                  />
                  <button
                    type="submit"
                    className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium bg-slate-800 text-slate-200 border border-slate-700 rounded-md hover:bg-slate-700 whitespace-nowrap shrink-0"
                  >
                    <BookmarkPlus className="w-3.5 h-3.5" />
                    Mark
                  </button>
                </form>
              )}
            </div>
          </div>

          {bookmarks.length > 0 && (
            <div className="bg-white border border-slate-200 rounded-xl p-4">
              <div className="text-xs font-semibold text-slate-700 mb-2">
                Session Bookmarks ({bookmarks.length})
              </div>
              <div className="divide-y divide-slate-100">
                {bookmarks.map((bm) => (
                  <div key={bm.id} className="py-1.5 flex items-center gap-3 text-xs">
                    <span className="font-mono tabular-nums text-blue-600 font-medium">
                      {formatTimecode(bm.timeSec)}
                    </span>
                    <span className="text-slate-700">{bm.note}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {lastCompleted && !saving && (
            <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="flex items-center gap-2 text-emerald-700 text-xs font-semibold mb-1">
                    <CheckCircle2 className="w-4 h-4" />
                    <span>Recording Saved & Encrypted</span>
                  </div>
                  <h2 className="font-display text-lg font-semibold text-slate-900">
                    {lastCompleted.title}
                  </h2>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                    <span className="font-mono tabular-nums">
                      {formatTimecode(lastCompleted.durationSec)}
                    </span>
                    <span aria-hidden="true">·</span>
                    <span className="font-mono tabular-nums">
                      {formatBytes(lastCompleted.videoBlob.size)}
                    </span>
                    <span aria-hidden="true">·</span>
                    <span>{lastCompleted.videoMimeType}</span>
                  </div>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-3 pt-1">
                {lastCompleted.videoBlob.size > 0 && (
                  <button
                    type="button"
                    onClick={handleDownloadRecording}
                    className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 text-white text-xs font-medium rounded-lg hover:bg-blue-700 transition-colors whitespace-nowrap shrink-0"
                  >
                    <Download className="w-3.5 h-3.5" />
                    <span>Download Recorded Video</span>
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => onOpenMeeting(lastCompleted.meetingId)}
                  className="inline-flex items-center gap-1.5 px-4 py-2 bg-white border border-slate-300 text-slate-800 text-xs font-medium rounded-lg hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0"
                >
                  <span>Open in Meeting Logs</span>
                  <ArrowRight className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

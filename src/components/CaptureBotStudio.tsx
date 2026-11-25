import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  HardDrive,
  Smartphone,
  Sparkles,
  Volume2,
} from 'lucide-react';
import {
  appendLiveCheckpointChunk,
  clearLiveCheckpoint,
  finalizeCheckpointToMeetingVideo,
  getStorageEstimate,
  initLiveCheckpoint,
  loadDecryptedVideoBlob,
  recoverLiveCheckpoint,
  saveEncryptedVideo,
  streamDownloadDecryptedVideo,
  updateLiveCheckpointMeta,
} from '../lib/vaultStorage';
import { saveEncryptedMeeting } from '../lib/workspaceStore';
import {
  MAX_RECORDING_SECONDS,
  QUALITY_PRESETS,
  startActiveSpeakerCapture,
  type ActiveCaptureSession,
  type RecorderTelemetry,
} from '../lib/mp4Recorder';
import {
  addNativeCaptureListener,
  deleteNativeFile,
  getNativeCaptureStatus,
  isNativeAndroid,
  openNativeAppSettings,
  readNativeFileAsBlob,
  requestNativePermissions,
  setNativeMicEnabled,
  setNativeNoiseCancelEnabled,
  startNativeCapture,
  stopNativeCapture,
} from '../lib/nativeCapture';
import { formatBytes, formatTimecode, generateDocId } from '../lib/formatters';
import { AndroidApkDownloadButton } from './PWAControls';
import type {
  DecryptedMeetingPayload,
  MeetingFolder,
  RecordingQualityPreset,
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

function checkEnvironmentCapabilities(): {
  inIframe: boolean;
  isMobile: boolean;
  nativeAndroid: boolean;
  displayCaptureAllowed: boolean;
  supportsDirectDiskSave: boolean;
} {
  if (typeof window === 'undefined') {
    return {
      inIframe: false,
      isMobile: false,
      nativeAndroid: false,
      displayCaptureAllowed: false,
      supportsDirectDiskSave: false,
    };
  }
  const nativeAndroid = isNativeAndroid();
  const inIframe = !nativeAndroid && window.self !== window.top;
  const ua = navigator.userAgent.toLowerCase();
  const isMobile = nativeAndroid || /android|iphone|ipad|ipod|mobile/.test(ua);
  const hasDisplayMedia = typeof navigator.mediaDevices?.getDisplayMedia === 'function';

  let policyAllowed = !inIframe;
  const docAny = document as unknown as {
    permissionsPolicy?: { allowsFeature?: (feature: string) => boolean };
    featurePolicy?: { allowsFeature?: (feature: string) => boolean };
  };
  const policy = docAny.permissionsPolicy || docAny.featurePolicy;
  if (policy && typeof policy.allowsFeature === 'function') {
    try {
      policyAllowed = policy.allowsFeature('display-capture');
    } catch {
      policyAllowed = !inIframe;
    }
  }

  const supportsDirectDiskSave =
    !nativeAndroid &&
    !inIframe &&
    !isMobile &&
    typeof (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker === 'function';

  return {
    inIframe,
    isMobile,
    nativeAndroid,
    displayCaptureAllowed: nativeAndroid || (hasDisplayMedia && policyAllowed),
    supportsDirectDiskSave,
  };
}

const DRAFT_STORAGE_KEY = 'cadence_capture_draft_v2';

interface CaptureDraft {
  meetUrlInput?: string;
  meetingTitle?: string;
  sessionNotes?: string;
  selectedFolderId?: string;
  framingMode?: SpeakerFramingMode;
  qualityPreset?: RecordingQualityPreset;
}

function loadCaptureDraft(): CaptureDraft {
  try {
    const raw = sessionStorage.getItem(DRAFT_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as CaptureDraft) : {};
  } catch {
    return {};
  }
}

interface FileWritable {
  write: (data: BufferSource | Blob) => Promise<void>;
  close: () => Promise<void>;
}

export const CaptureBotStudio: React.FC<CaptureBotStudioProps> = ({
  uid,
  masterKey,
  folders,
  onOpenMeeting,
}) => {
  const initialDraft = useMemo(() => loadCaptureDraft(), []);
  const envCaps = useMemo(() => checkEnvironmentCapabilities(), []);

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
    initialDraft.framingMode ?? 'full_stage'
  );
  const [qualityPreset, setQualityPreset] = useState<RecordingQualityPreset>(
    initialDraft.qualityPreset ?? 'long_meeting'
  );
  const [directToDiskMode, setDirectToDiskMode] = useState(false);

  // Default: record meeting/device audio cleanly, keep user's mic OFF until toggled on
  const [includeMic, setIncludeMic] = useState(false);
  const [noiseCancel, setNoiseCancel] = useState(true);
  const [includeCamPip, setIncludeCamPip] = useState(false);

  const [isRecording, setIsRecording] = useState(false);
  const [isNativeRecording, setIsNativeRecording] = useState(false);
  const [saving, setSaving] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [audioWarning, setAudioWarning] = useState('');
  const [recoveredNotice, setRecoveredNotice] = useState('');
  const [freeBytes, setFreeBytes] = useState<number | null>(null);

  const [tabCaptureBlocked, setTabCaptureBlocked] = useState(!envCaps.displayCaptureAllowed);

  const [telemetry, setTelemetry] = useState<RecorderTelemetry>({
    elapsedSec: 0,
    remoteLevel: 0,
    localLevel: 0,
    activeSpeaker: 'idle',
    waveformBars: new Array(24).fill(0.1),
    codecLabel: envCaps.nativeAndroid ? 'Android MP4' : 'MP4 / WebM',
    recordedBytes: 0,
    micEnabled: false,
    noiseCancelEnabled: true,
  });

  const [bookmarkInput, setBookmarkInput] = useState('');
  const [bookmarks, setBookmarks] = useState<SessionBookmark[]>([]);
  const [lastCompleted, setLastCompleted] = useState<{
    meetingId: string;
    title: string;
    videoUrl: string | null;
    videoMimeType: string;
    durationSec: number;
    fileSizeBytes: number;
    savedDirectlyToDisk: boolean;
  } | null>(null);

  const [importedFile, setImportedFile] = useState<File | null>(null);

  const captureRef = useRef<ActiveCaptureSession | null>(null);
  const previewContainerRef = useRef<HTMLDivElement | null>(null);
  const elapsedRef = useRef(0);
  const chunkSeqRef = useRef(0);
  const checkpointChainRef = useRef<Promise<void>>(Promise.resolve());
  const diskWritableRef = useRef<FileWritable | null>(null);
  const ingestingNativeRef = useRef(false);

  useEffect(() => {
    void getStorageEstimate().then((est) => {
      if (est) setFreeBytes(est.freeBytes);
    });
  }, [lastCompleted]);

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
          qualityPreset,
        } satisfies CaptureDraft)
      );
    } catch {
      // Ignore
    }
  }, [meetUrlInput, meetingTitle, sessionNotes, selectedFolderId, framingMode, qualityPreset]);

  useEffect(() => {
    if (!isRecording && !saving) return;
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [isRecording, saving]);

  const ingestNativeCompletedFile = useCallback(
    async (filePath: string, mimeType: string, durationSec: number) => {
      if (!filePath || ingestingNativeRef.current) return;
      ingestingNativeRef.current = true;
      setSaving(true);
      setIsRecording(false);
      setIsNativeRecording(false);
      setErrorMsg('');

      try {
        const blob = await readNativeFileAsBlob(filePath, mimeType || 'video/mp4');
        if (!blob) {
          throw new Error('Recorded file was empty or unavailable.');
        }

        const meetingId = generateDocId('mtg');
        const effectiveTitle = meetingTitle.trim() || `Meet Recording (${meetingCode || 'Android'})`;
        const savedBytes = await saveEncryptedVideo(meetingId, blob, masterKey);
        const payload: DecryptedMeetingPayload = {
          title: effectiveTitle,
          meetUrl: validatedUrl || meetUrlInput.trim(),
          notes: sessionNotes.trim(),
          bookmarks,
        };

        await saveEncryptedMeeting({
          uid,
          meetingId,
          masterKey,
          folderId: selectedFolderId,
          durationSec: Math.max(1, durationSec),
          fileSizeBytes: savedBytes,
          hasLocalVideo: true,
          videoMimeType: mimeType || 'video/mp4',
          tags: ['android-native'],
          payload,
        });

        await deleteNativeFile(filePath).catch(() => {});

        let previewUrl: string | null = null;
        if (savedBytes > 0 && savedBytes <= 400 * 1024 * 1024) {
          previewUrl = URL.createObjectURL(blob);
        }

        setLastCompleted({
          meetingId,
          title: effectiveTitle,
          videoUrl: previewUrl,
          videoMimeType: mimeType || 'video/mp4',
          durationSec: Math.max(1, durationSec),
          fileSizeBytes: savedBytes,
          savedDirectlyToDisk: false,
        });
      } catch (err) {
        setErrorMsg(err instanceof Error ? err.message : 'Failed to encrypt native Android recording.');
      } finally {
        setSaving(false);
        ingestingNativeRef.current = false;
      }
    },
    [bookmarks, masterKey, meetingCode, meetingTitle, meetUrlInput, selectedFolderId, sessionNotes, uid, validatedUrl]
  );

  // Sync with Android native foreground service if active or stopped from notification bar
  useEffect(() => {
    if (!envCaps.nativeAndroid) return;
    let active = true;

    const syncNativeStatus = async () => {
      try {
        const status = await getNativeCaptureStatus();
        if (!active) return;
        if (status.isRecording) {
          setIsRecording(true);
          setIsNativeRecording(true);
          setIncludeMic(status.micEnabled);
          setNoiseCancel(status.noiseCancelEnabled);
          elapsedRef.current = status.elapsedSec;

          const rLvl = status.remoteLevel ?? 0;
          const lLvl = status.localLevel ?? 0;
          const activeSpeaker: 'remote' | 'local' | 'idle' =
            rLvl > 0.015 && rLvl >= lLvl * 0.85
              ? 'remote'
              : lLvl > 0.015
              ? 'local'
              : 'idle';
          const peakLevel = Math.max(rLvl, lLvl);

          if (status.lastAudioError && !status.micEnabled) {
            setAudioWarning(status.lastAudioError);
          } else if (status.elapsedSec >= 6 && !status.remoteAudioDetected && !status.micEnabled) {
            setAudioWarning(
              'No internal Meet audio detected yet — some Android Meet versions block internal AudioPlaybackCapture. Put Meet on Speakerphone and tap "My Voice Mic: ON", or open Meet in Chrome.'
            );
          } else if (status.remoteAudioDetected || status.micEnabled) {
            setAudioWarning('');
          }

          setTelemetry((prev) => ({
            ...prev,
            elapsedSec: status.elapsedSec,
            remoteLevel: rLvl,
            localLevel: lLvl,
            activeSpeaker,
            recordedBytes: status.recordedBytes,
            codecLabel: 'Native H.264 MP4',
            micEnabled: status.micEnabled,
            noiseCancelEnabled: status.noiseCancelEnabled,
            waveformBars: prev.waveformBars.map((_, idx) => {
              if (peakLevel < 0.008) return 0.1;
              const shape = 0.55 + 0.45 * Math.sin(status.elapsedSec * 4.2 + idx * 0.7);
              return Math.max(0.12, Math.min(1, peakLevel * 2.2 * shape));
            }),
          }));
        } else if (status.lastCompletedPath && !ingestingNativeRef.current) {
          void ingestNativeCompletedFile(
            status.lastCompletedPath,
            status.lastCompletedMime || 'video/mp4',
            status.lastCompletedDurationSec || 1
          );
        }
      } catch {
        // Ignore transient status poll errors
      }
    };

    void syncNativeStatus();
    const interval = window.setInterval(() => {
      void syncNativeStatus();
    }, 650);

    let stopHandle: { remove: () => Promise<void> } | null = null;
    let errHandle: { remove: () => Promise<void> } | null = null;

    void addNativeCaptureListener('captureStopped', (data) => {
      const path = typeof data.filePath === 'string' ? data.filePath : '';
      const mime = typeof data.mimeType === 'string' ? data.mimeType : 'video/mp4';
      const dur = typeof data.durationSec === 'number' ? data.durationSec : 1;
      if (path) {
        void ingestNativeCompletedFile(path, mime, dur);
      }
    }).then((h) => {
      stopHandle = h;
    });

    void addNativeCaptureListener('captureError', (data) => {
      const msg = typeof data.message === 'string' ? data.message : 'Native Android capture failed.';
      setIsRecording(false);
      setIsNativeRecording(false);
      setErrorMsg(msg);
    }).then((h) => {
      errHandle = h;
    });

    return () => {
      active = false;
      window.clearInterval(interval);
      void stopHandle?.remove().catch(() => {});
      void errHandle?.remove().catch(() => {});
    };
  }, [envCaps.nativeAndroid, ingestNativeCompletedFile]);

  // Recover interrupted browser recording from IndexedDB live chunks on reload
  useEffect(() => {
    if (envCaps.nativeAndroid) return;
    let active = true;
    void (async () => {
      try {
        const recovered = await recoverLiveCheckpoint(uid, masterKey);
        if (!active || !recovered) return;
        const meetingId = generateDocId('mtg');
        const finalized = await finalizeCheckpointToMeetingVideo(meetingId);
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
          fileSizeBytes: finalized.fileSizeBytes,
          hasLocalVideo: true,
          videoMimeType: finalized.mimeType,
          tags: ['recovered'],
          payload,
        });
        const blob = await loadDecryptedVideoBlob(meetingId, masterKey);
        if (!active) return;
        const videoUrl = blob ? URL.createObjectURL(blob) : null;
        setLastCompleted({
          meetingId,
          title: payload.title,
          videoUrl,
          videoMimeType: finalized.mimeType,
          durationSec: recovered.durationSec,
          fileSizeBytes: finalized.fileSizeBytes,
          savedDirectlyToDisk: false,
        });
        setRecoveredNotice(
          `Recovered interrupted recording "${payload.title}" (${formatBytes(finalized.fileSizeBytes)}) into Meeting Logs.`
        );
      } catch {
        // Ignore non-matching checkpoint
      }
    })();
    return () => {
      active = false;
    };
  }, [envCaps.nativeAndroid, masterKey, uid]);

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

  const handleToggleMic = async () => {
    const next = !includeMic;
    if (isRecording && isNativeRecording) {
      try {
        const updated = await setNativeMicEnabled(next);
        setIncludeMic(updated);
      } catch {
        setErrorMsg('Unable to toggle native microphone.');
      }
      return;
    }

    if (isRecording && captureRef.current) {
      const result = await captureRef.current.setMicEnabled(next);
      setIncludeMic(result);
      if (next && !result) {
        setErrorMsg('Microphone permission denied. Check browser mic permissions to record your voice.');
      }
    } else {
      setIncludeMic(next);
    }
  };

  const handleToggleNoiseCancel = async () => {
    const next = !noiseCancel;
    setNoiseCancel(next);
    if (isRecording && isNativeRecording) {
      await setNativeNoiseCancelEnabled(next).catch(() => {});
      return;
    }
    if (isRecording && captureRef.current) {
      captureRef.current.setNoiseCancelEnabled(next);
    }
  };

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
          setErrorMsg(
            'URL must be a valid meet.google.com meeting link (e.g. https://meet.google.com/abc-defg-hij).'
          );
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

  const handleStartLiveCapture = async (captureSource: 'meet_tab' | 'room_mic_cam') => {
    setErrorMsg('');
    setAudioWarning('');
    setRecoveredNotice('');
    setLastCompleted(null);

    const normalized = await validateMeetLink();
    if (!normalized) return;

    const effectiveTitle = meetingTitle.trim() || `Meet Recording (${meetingCode || 'Session'})`;

    // Native Capacitor Android Foreground Service capture path
    if (envCaps.nativeAndroid && captureSource === 'meet_tab') {
      try {
        const perms = await requestNativePermissions();
        if (!perms.audio) {
          setErrorMsg('Android Microphone / Audio permission is required to record meeting audio. Enable Microphone in Android App Settings.');
          return;
        }
        setBookmarks([]);
        await startNativeCapture({
          title: effectiveTitle,
          qualityPreset,
          micEnabled: includeMic,
          noiseCancelEnabled: noiseCancel,
        });
        setIsRecording(true);
        setIsNativeRecording(true);
      } catch (err) {
        setErrorMsg(err instanceof Error ? err.message : 'Native Android screen capture canceled.');
      }
      return;
    }

    if (envCaps.nativeAndroid && captureSource === 'room_mic_cam') {
      const perms = await requestNativePermissions();
      if (!perms.audio) {
        setErrorMsg('Android Microphone permission is required to record Room Mic & Camera. Enable Microphone in Android App Settings.');
        return;
      }
    }

    let writable: FileWritable | null = null;
    if (directToDiskMode && envCaps.supportsDirectDiskSave) {
      try {
        const winAny = window as unknown as {
          showSaveFilePicker: (opts?: {
            suggestedName?: string;
            types?: Array<{ description: string; accept: Record<string, string[]> }>;
          }) => Promise<{ createWritable: () => Promise<FileWritable> }>;
        };
        const safeSlug = effectiveTitle
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/(^-|-$)/g, '');
        const handle = await winAny.showSaveFilePicker({
          suggestedName: `${safeSlug || 'meeting-recording'}.webm`,
          types: [
            {
              description: 'Meeting Video',
              accept: { 'video/webm': ['.webm'], 'video/mp4': ['.mp4'] },
            },
          ],
        });
        writable = await handle.createWritable();
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          return;
        }
        setErrorMsg('Could not open a save file on disk. Try Encrypted Browser Vault mode instead.');
        return;
      }
    }
    diskWritableRef.current = writable;

    let displayStream: MediaStream | null = null;
    let micStream: MediaStream | null = null;
    let camStream: MediaStream | null = null;

    try {
      if (captureSource === 'meet_tab') {
        if (tabCaptureBlocked || typeof navigator.mediaDevices?.getDisplayMedia !== 'function') {
          setTabCaptureBlocked(true);
          await writable?.close().catch(() => {});
          diskWritableRef.current = null;
          setErrorMsg(
            envCaps.inIframe
              ? 'Tab capture is blocked inside embedded preview. Open Full-Tab Studio above to record a Google Meet tab.'
              : 'Screen capture is unavailable in this mobile browser. Install the Cadence Android APK or import a screen recording below.'
          );
          return;
        }

        try {
          displayStream = await navigator.mediaDevices.getDisplayMedia({
            video: {
              frameRate: { ideal: QUALITY_PRESETS[qualityPreset].fps, max: 30 },
              width: { ideal: QUALITY_PRESETS[qualityPreset].width },
              height: { ideal: QUALITY_PRESETS[qualityPreset].height },
            },
            audio: {
              echoCancellation: false,
              noiseSuppression: false,
              autoGainControl: false,
            },
          });
        } catch (dispErr) {
          const msg = dispErr instanceof Error ? dispErr.message : String(dispErr);
          if (
            msg.toLowerCase().includes('permissions policy') ||
            msg.toLowerCase().includes('disallowed')
          ) {
            setTabCaptureBlocked(true);
            await writable?.close().catch(() => {});
            diskWritableRef.current = null;
            setErrorMsg(
              'Tab capture is restricted inside the embedded preview. Click Open Full-Tab Studio above to record Google Meet.'
            );
            return;
          }
          throw dispErr;
        }

        if (displayStream.getAudioTracks().length === 0) {
          setAudioWarning(
            'Screen video captured without meeting audio. Re-share and check "Share tab/system audio" if you want other speakers recorded.'
          );
        }
      }

      const startWithMic = includeMic || captureSource === 'room_mic_cam';
      if (captureSource === 'room_mic_cam') {
        setIncludeMic(true);
      }

      if (startWithMic) {
        try {
          micStream = await navigator.mediaDevices.getUserMedia({
            audio: {
              echoCancellation: true,
              noiseSuppression: noiseCancel,
              autoGainControl: true,
              channelCount: 1,
            },
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
            video: {
              width: QUALITY_PRESETS[qualityPreset].width,
              height: QUALITY_PRESETS[qualityPreset].height,
            },
          });
        } catch {
          // Continue with audio + visualizer if camera is unavailable
        }
      }

      chunkSeqRef.current = 0;
      if (!writable) {
        checkpointChainRef.current = initLiveCheckpoint({
          vaultId: uid,
          title: effectiveTitle,
          meetUrl: normalized,
          folderId: selectedFolderId,
          notes: sessionNotes.trim(),
          mimeType: 'video/webm',
          startedAtMs: Date.now(),
        }).catch(() => {});
      } else {
        checkpointChainRef.current = Promise.resolve();
      }

      setBookmarks([]);
      const session = await startActiveSpeakerCapture({
        displayStream,
        micStream,
        camStream,
        micEnabled: startWithMic,
        noiseCancelEnabled: noiseCancel,
        sessionLabel: effectiveTitle,
        framingMode,
        qualityPreset,
        onTelemetry: (t) => {
          elapsedRef.current = t.elapsedSec;
          setTelemetry(t);
        },
        onChunk: (chunk, mimeType) => {
          if (writable) {
            checkpointChainRef.current = checkpointChainRef.current
              .then(() => writable!.write(chunk))
              .catch(() => {});
            return;
          }
          const seq = chunkSeqRef.current++;
          checkpointChainRef.current = checkpointChainRef.current
            .then(async () => {
              await appendLiveCheckpointChunk(seq, chunk, mimeType, masterKey);
            })
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
      setIsNativeRecording(false);
    } catch (err) {
      await writable?.close().catch(() => {});
      diskWritableRef.current = null;
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
    if (isNativeRecording) {
      setSaving(true);
      try {
        const res = await stopNativeCapture();
        if (res.filePath) {
          await ingestNativeCompletedFile(res.filePath, res.mimeType || 'video/mp4', res.durationSec);
        } else {
          setIsRecording(false);
          setIsNativeRecording(false);
          setSaving(false);
        }
      } catch (err) {
        setIsRecording(false);
        setIsNativeRecording(false);
        setSaving(false);
        setErrorMsg(err instanceof Error ? err.message : 'Failed to stop native capture.');
      }
      return;
    }

    const session = captureRef.current;
    if (!session) return;
    captureRef.current = null;
    setIsRecording(false);
    setSaving(true);
    setErrorMsg('');
    setAudioWarning('');

    const writable = diskWritableRef.current;
    diskWritableRef.current = null;

    try {
      const output = await session.stop();
      if (previewContainerRef.current) {
        previewContainerRef.current.innerHTML = '';
      }

      await checkpointChainRef.current;

      const meetingId = generateDocId('mtg');
      const effectiveTitle = meetingTitle.trim() || `Meet Recording (${meetingCode || 'Session'})`;
      const payload: DecryptedMeetingPayload = {
        title: effectiveTitle,
        meetUrl: validatedUrl || meetUrlInput.trim(),
        notes: sessionNotes.trim(),
        bookmarks,
      };

      if (writable) {
        await writable.close();
        await saveEncryptedMeeting({
          uid,
          meetingId,
          masterKey,
          folderId: selectedFolderId,
          durationSec: output.durationSec,
          fileSizeBytes: output.recordedBytes,
          hasLocalVideo: false,
          videoMimeType: output.videoMimeType,
          tags: ['saved-to-disk'],
          payload,
        });
        setLastCompleted({
          meetingId,
          title: effectiveTitle,
          videoUrl: null,
          videoMimeType: output.videoMimeType,
          durationSec: output.durationSec,
          fileSizeBytes: output.recordedBytes,
          savedDirectlyToDisk: true,
        });
      } else {
        const finalized = await finalizeCheckpointToMeetingVideo(meetingId);
        await saveEncryptedMeeting({
          uid,
          meetingId,
          masterKey,
          folderId: selectedFolderId,
          durationSec: output.durationSec,
          fileSizeBytes: finalized.fileSizeBytes,
          hasLocalVideo: finalized.fileSizeBytes > 0,
          videoMimeType: finalized.mimeType,
          tags: [],
          payload,
        });

        let previewUrl: string | null = null;
        if (finalized.fileSizeBytes > 0 && finalized.fileSizeBytes <= 400 * 1024 * 1024) {
          const blob = await loadDecryptedVideoBlob(meetingId, masterKey);
          if (blob) previewUrl = URL.createObjectURL(blob);
        }

        setLastCompleted({
          meetingId,
          title: effectiveTitle,
          videoUrl: previewUrl,
          videoMimeType: finalized.mimeType,
          durationSec: output.durationSec,
          fileSizeBytes: finalized.fileSizeBytes,
          savedDirectlyToDisk: false,
        });
      }
    } catch (err) {
      await clearLiveCheckpoint().catch(() => {});
      setErrorMsg(err instanceof Error ? err.message : 'Failed to save recorded meeting.');
    } finally {
      setSaving(false);
    }
  };

  const handleImportSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!importedFile) {
      setErrorMsg('Select a video or audio recording file first.');
      return;
    }
    setErrorMsg('');
    setRecoveredNotice('');
    setLastCompleted(null);
    setSaving(true);

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

      const meetingId = generateDocId('mtg');
      const savedBytes = await saveEncryptedVideo(meetingId, importedFile, masterKey);
      const effectiveTitle = meetingTitle.trim() || importedFile.name.replace(/\.[^/.]+$/, '');
      const payload: DecryptedMeetingPayload = {
        title: effectiveTitle,
        meetUrl: validatedUrl || meetUrlInput.trim(),
        notes: sessionNotes.trim(),
        bookmarks: [],
      };

      await saveEncryptedMeeting({
        uid,
        meetingId,
        masterKey,
        folderId: selectedFolderId,
        durationSec: estimatedDuration,
        fileSizeBytes: savedBytes,
        hasLocalVideo: true,
        videoMimeType: importedFile.type || 'video/mp4',
        tags: ['imported'],
        payload,
      });

      let previewUrl: string | null = null;
      if (importedFile.size <= 400 * 1024 * 1024) {
        previewUrl = URL.createObjectURL(importedFile);
      }

      setLastCompleted({
        meetingId,
        title: effectiveTitle,
        videoUrl: previewUrl,
        videoMimeType: importedFile.type || 'video/mp4',
        durationSec: estimatedDuration,
        fileSizeBytes: savedBytes,
        savedDirectlyToDisk: false,
      });
      setImportedFile(null);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to store uploaded recording.');
    } finally {
      setSaving(false);
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

  const handleDownloadRecording = async () => {
    if (!lastCompleted || lastCompleted.savedDirectlyToDisk) return;
    const ext = lastCompleted.videoMimeType.includes('mp4') ? 'mp4' : 'webm';
    const safeName = lastCompleted.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '');
    await streamDownloadDecryptedVideo(
      lastCompleted.meetingId,
      masterKey,
      `${safeName || 'meeting-recording'}.${ext}`,
      lastCompleted.videoMimeType
    );
  };

  const activePresetSpec = QUALITY_PRESETS[qualityPreset];

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-semibold text-slate-100 tracking-tight">
            Meeting Video Studio
          </h1>
          <p className="text-sm text-slate-400 mt-1">
            Captures Google Meet audio clearly by default, filters fan &amp; background noise, and stores encrypted 2–3 hour sessions locally.
          </p>
        </div>
        <div className="inline-flex items-center p-1 bg-[#091022] border border-[#162342] rounded-xl shrink-0 self-start">
          <button
            type="button"
            disabled={isRecording || saving}
            onClick={() => setStudioTab('live_bot')}
            className={`px-3.5 py-2 text-xs font-medium rounded-lg transition-colors whitespace-nowrap shrink-0 min-h-[36px] ${
              studioTab === 'live_bot'
                ? 'bg-blue-600 text-white'
                : 'text-slate-400 hover:text-slate-100'
            }`}
          >
            Live Recorder
          </button>
          <button
            type="button"
            disabled={isRecording || saving}
            onClick={() => setStudioTab('import_media')}
            className={`px-3.5 py-2 text-xs font-medium rounded-lg transition-colors whitespace-nowrap shrink-0 min-h-[36px] ${
              studioTab === 'import_media'
                ? 'bg-blue-600 text-white'
                : 'text-slate-400 hover:text-slate-100'
            }`}
          >
            Import Video
          </button>
        </div>
      </div>

      {envCaps.inIframe && tabCaptureBlocked && studioTab === 'live_bot' && (
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-4 bg-[#091022] border border-[#162342] rounded-2xl text-xs text-slate-300">
          <div className="flex items-start gap-2.5">
            <MonitorPlay className="w-4 h-4 text-blue-400 shrink-0 mt-0.5" />
            <div>
              <span className="font-semibold text-slate-100">Embedded preview detected:</span>{' '}
              Open Full-Tab Studio to capture a Google Meet browser tab, or record directly here with your mic and camera.
            </div>
          </div>
          <a
            href={typeof window !== 'undefined' ? window.location.href : '/'}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 px-3.5 py-2 bg-blue-600 text-white font-medium rounded-xl hover:bg-blue-500 transition-colors whitespace-nowrap shrink-0 self-start sm:self-auto min-h-[40px]"
          >
            <span>Open Full-Tab Studio</span>
            <ExternalLink className="w-3.5 h-3.5" />
          </a>
        </div>
      )}

      {envCaps.nativeAndroid && studioTab === 'live_bot' && (
        <div className="flex items-start gap-3 p-4 bg-[#091022] border border-emerald-800/50 rounded-2xl text-xs text-slate-300 leading-relaxed">
          <Smartphone className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
          <div>
            <span className="font-semibold text-slate-100">Native Android Foreground Mode Active:</span>{' '}
            Tap <strong className="text-slate-100">Record Screen / Meet</strong> to pick Google Meet in Android&rsquo;s native display selector. A background foreground notification keeps recording alive when you switch into the Google Meet app.
          </div>
        </div>
      )}

      {envCaps.isMobile && !envCaps.nativeAndroid && studioTab === 'live_bot' && (
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-4 bg-[#091022] border border-[#162342] rounded-2xl text-xs text-slate-300 leading-relaxed">
          <div className="flex items-start gap-2.5">
            <Smartphone className="w-4 h-4 text-blue-400 shrink-0 mt-0.5" />
            <div>
              <span className="font-semibold text-slate-100">Recording Google Meet on Mobile:</span>{' '}
              Mobile browsers suspend web tabs when you switch into the Google Meet app. Use the native <strong className="text-slate-100">Cadence Android APK</strong> for background MediaProjection recording, or tap{' '}
              <button
                type="button"
                onClick={() => setStudioTab('import_media')}
                className="text-blue-400 font-semibold hover:underline"
              >
                Import Video
              </button>{' '}
              for phone screen recordings.
            </div>
          </div>
          <AndroidApkDownloadButton />
        </div>
      )}

      {recoveredNotice && (
        <div className="flex items-start gap-2.5 p-3.5 bg-emerald-950/60 border border-emerald-800/70 rounded-xl text-sm text-emerald-200">
          <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
          <span>{recoveredNotice}</span>
        </div>
      )}

      {audioWarning && (
        <div className="flex items-start gap-2.5 p-3.5 bg-amber-950/60 border border-amber-800/70 rounded-xl text-xs text-amber-200">
          <AlertCircle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
          <span>{audioWarning}</span>
        </div>
      )}

      {errorMsg && (
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 p-3.5 bg-red-950/60 border border-red-800/70 rounded-xl text-sm text-red-200">
          <div className="flex items-start gap-2.5">
            <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
            <span>{errorMsg}</span>
          </div>
          {envCaps.nativeAndroid && errorMsg.toLowerCase().includes('permission') && (
            <button
              type="button"
              onClick={() => void openNativeAppSettings()}
              className="px-3 py-1.5 bg-red-600 text-white text-xs font-medium rounded-lg hover:bg-red-500 whitespace-nowrap shrink-0 self-start sm:self-auto"
            >
              Open App Permissions
            </button>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Left: Controls */}
        <div className="lg:col-span-5 bg-[#091022] border border-[#162342] rounded-2xl p-5 sm:p-6 space-y-5">
          {studioTab === 'live_bot' ? (
            <>
              <form onSubmit={handleValidateOnly} className="space-y-4">
                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1.5">
                    Google Meet Link
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
                      className="flex-1 min-w-0 px-3 py-2 text-sm bg-[#04060B] text-slate-100 placeholder:text-slate-500 border border-[#1E2E52] rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500 disabled:opacity-60 min-h-[44px]"
                    />
                    <button
                      type="submit"
                      disabled={isRecording || saving}
                      className="px-3.5 py-2 text-xs font-medium text-slate-200 bg-[#0F1B35] border border-[#1E2E52] rounded-xl hover:bg-[#16264A] transition-colors whitespace-nowrap shrink-0 min-h-[44px]"
                    >
                      Verify
                    </button>
                  </div>
                  {validatedUrl && (
                    <div className="mt-2 flex items-center justify-between text-xs text-emerald-400">
                      <span>Verified · {meetingCode}</span>
                      <a
                        href={validatedUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-blue-400 hover:underline font-medium"
                      >
                        Open Meet
                        <ExternalLink className="w-3 h-3" />
                      </a>
                    </div>
                  )}
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-slate-300 mb-1.5">
                      Title (Optional)
                    </label>
                    <input
                      type="text"
                      value={meetingTitle}
                      onChange={(e) => setMeetingTitle(e.target.value)}
                      disabled={isRecording || saving}
                      placeholder="Weekly Sync"
                      className="w-full px-3 py-2 text-sm bg-[#04060B] text-slate-100 placeholder:text-slate-500 border border-[#1E2E52] rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500 disabled:opacity-60 min-h-[42px]"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-300 mb-1.5">
                      Folder
                    </label>
                    <div className="relative">
                      <FolderOpen className="w-4 h-4 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
                      <select
                        value={selectedFolderId}
                        onChange={(e) => setSelectedFolderId(e.target.value)}
                        disabled={isRecording || saving}
                        className="w-full pl-9 pr-3 py-2 text-sm bg-[#04060B] text-slate-100 border border-[#1E2E52] rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500 min-h-[42px]"
                      >
                        <option value="">Unfiled</option>
                        {folders.map((f) => (
                          <option key={f.id} value={f.id}>
                            {f.name}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1.5">
                    Session Notes (Optional)
                  </label>
                  <textarea
                    rows={2}
                    value={sessionNotes}
                    onChange={(e) => {
                      const val = e.target.value;
                      setSessionNotes(val);
                      if (isRecording && !isNativeRecording) {
                        void updateLiveCheckpointMeta({ notes: val }).catch(() => {});
                      }
                    }}
                    disabled={saving}
                    placeholder="Notes saved encrypted with your recording..."
                    className="w-full px-3 py-2 text-sm bg-[#04060B] text-slate-100 placeholder:text-slate-500 border border-[#1E2E52] rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500"
                  />
                </div>
              </form>

              {/* Audio Routing & Noise Cancellation */}
              <div className="pt-4 border-t border-[#162342] space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-slate-300">
                    Audio &amp; Noise Cancellation
                  </span>
                  <span className="inline-flex items-center gap-1 text-[11px] text-emerald-400 font-medium">
                    <Volume2 className="w-3 h-3" />
                    Meeting Audio Always On
                  </span>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => void handleToggleMic()}
                    className={`inline-flex items-center justify-center gap-1.5 px-3 py-2.5 text-xs font-medium border rounded-xl transition-colors min-h-[44px] ${
                      includeMic
                        ? 'border-emerald-500/60 bg-emerald-500/15 text-emerald-200'
                        : 'border-[#1E2E52] bg-[#04060B] text-slate-300 hover:border-slate-600'
                    }`}
                  >
                    {includeMic ? <Mic className="w-3.5 h-3.5 text-emerald-400" /> : <MicOff className="w-3.5 h-3.5 text-slate-400" />}
                    <span>{includeMic ? 'My Voice Mic: ON' : 'My Voice Mic: OFF'}</span>
                  </button>

                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => void handleToggleNoiseCancel()}
                    className={`inline-flex items-center justify-center gap-1.5 px-3 py-2.5 text-xs font-medium border rounded-xl transition-colors min-h-[44px] ${
                      noiseCancel
                        ? 'border-blue-500/60 bg-blue-500/15 text-blue-200'
                        : 'border-[#1E2E52] bg-[#04060B] text-slate-400 hover:border-slate-600'
                    }`}
                  >
                    <Sparkles className={`w-3.5 h-3.5 ${noiseCancel ? 'text-blue-400' : 'text-slate-500'}`} />
                    <span>{noiseCancel ? 'Noise Cancel: ON' : 'Noise Cancel: OFF'}</span>
                  </button>
                </div>

                <p className="text-[11px] text-slate-400 leading-relaxed">
                  Others&rsquo; voices play normally and are recorded by default. Toggle <strong className="text-slate-200">My Voice Mic</strong> live whenever you speak—fan hum and distant sounds are gated out automatically.
                </p>
              </div>

              <div className="pt-4 border-t border-[#162342] space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-slate-300">
                    Video Quality &amp; Storage
                  </span>
                  {freeBytes !== null && (
                    <span className="text-[11px] font-mono tabular-nums text-slate-400">
                      {formatBytes(freeBytes)} free
                    </span>
                  )}
                </div>

                <div className="grid grid-cols-3 gap-2">
                  {(Object.keys(QUALITY_PRESETS) as RecordingQualityPreset[]).map((presetKey) => {
                    const spec = QUALITY_PRESETS[presetKey];
                    const active = qualityPreset === presetKey;
                    return (
                      <button
                        key={presetKey}
                        type="button"
                        disabled={isRecording || saving}
                        onClick={() => setQualityPreset(presetKey)}
                        className={`p-2 text-left border rounded-xl transition-colors ${
                          active
                            ? 'border-blue-500 bg-blue-500/15 text-slate-100'
                            : 'border-[#162342] bg-[#04060B] hover:border-[#1E2E52] text-slate-300'
                        }`}
                      >
                        <div className="text-[11px] font-semibold leading-tight">
                          {presetKey === 'long_meeting'
                            ? '2–3 Hr Saver'
                            : presetKey === 'balanced'
                            ? 'Standard HD'
                            : 'High Detail'}
                        </div>
                        <div className="text-[10px] font-mono tabular-nums text-slate-400 mt-0.5">
                          ~{spec.estMbPerHour} MB/hr
                        </div>
                      </button>
                    );
                  })}
                </div>
                <p className="text-[11px] text-slate-400">
                  {activePresetSpec.label} · {activePresetSpec.shortDesc} (3 hr cap)
                </p>

                {!envCaps.nativeAndroid && (
                  <>
                    <div className="grid grid-cols-2 gap-2 pt-1">
                      <button
                        type="button"
                        disabled={isRecording || saving}
                        onClick={() => setFramingMode('full_stage')}
                        className={`p-2.5 text-left border rounded-xl transition-colors ${
                          framingMode === 'full_stage'
                            ? 'border-blue-500 bg-blue-500/15 text-slate-100'
                            : 'border-[#162342] bg-[#04060B] hover:border-[#1E2E52] text-slate-300'
                        }`}
                      >
                        <div className="text-xs font-semibold">Full Stage</div>
                        <div className="text-[11px] text-slate-400 mt-0.5">
                          Lowest CPU for 3 hrs
                        </div>
                      </button>
                      <button
                        type="button"
                        disabled={isRecording || saving}
                        onClick={() => setFramingMode('smart_focus')}
                        className={`p-2.5 text-left border rounded-xl transition-colors ${
                          framingMode === 'smart_focus'
                            ? 'border-blue-500 bg-blue-500/15 text-slate-100'
                            : 'border-[#162342] bg-[#04060B] hover:border-[#1E2E52] text-slate-300'
                        }`}
                      >
                        <div className="text-xs font-semibold">Smart Focus</div>
                        <div className="text-[11px] text-slate-400 mt-0.5">
                          Tracks active talker
                        </div>
                      </button>
                    </div>

                    <button
                      type="button"
                      disabled={isRecording || saving}
                      onClick={() => setIncludeCamPip((v) => !v)}
                      className={`w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium border rounded-xl transition-colors min-h-[40px] ${
                        includeCamPip
                          ? 'border-blue-500 bg-blue-500/15 text-blue-200'
                          : 'border-[#162342] bg-[#04060B] text-slate-400 hover:border-[#1E2E52]'
                      }`}
                    >
                      <Camera className="w-3.5 h-3.5" />
                      <span>{includeCamPip ? 'Self-Cam Overlay: ON' : 'Self-Cam Overlay: OFF'}</span>
                    </button>
                  </>
                )}

                {envCaps.supportsDirectDiskSave && (
                  <label className="flex items-start gap-2.5 p-3 bg-[#04060B] border border-[#162342] rounded-xl cursor-pointer">
                    <input
                      type="checkbox"
                      checked={directToDiskMode}
                      disabled={isRecording || saving}
                      onChange={(e) => setDirectToDiskMode(e.target.checked)}
                      className="mt-0.5 rounded border-[#1E2E52] bg-slate-900 text-blue-500 focus:ring-blue-500"
                    />
                    <div className="text-xs">
                      <span className="font-semibold text-slate-200 inline-flex items-center gap-1">
                        <HardDrive className="w-3 h-3 text-blue-400" />
                        Stream directly to hard drive (0 MB browser storage)
                      </span>
                      <p className="text-[11px] text-slate-400 mt-0.5">
                        Recommended for 2–3 hour calls. Writes chunks straight to a local video file.
                      </p>
                    </div>
                  </label>
                )}
              </div>

              <div className="pt-4 border-t border-[#162342] space-y-2.5">
                {!isRecording ? (
                  <>
                    {!tabCaptureBlocked && (
                      <button
                        type="button"
                        disabled={saving}
                        onClick={() => void handleStartLiveCapture('meet_tab')}
                        className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 bg-blue-600 text-white text-sm font-medium rounded-xl hover:bg-blue-500 disabled:opacity-50 transition-colors min-h-[46px]"
                      >
                        <Play className="w-4 h-4 fill-current" />
                        <span>
                          {envCaps.nativeAndroid
                            ? 'Record Screen / Meet (Native)'
                            : envCaps.isMobile
                            ? 'Record Screen / Meet'
                            : 'Record Google Meet Tab'}
                        </span>
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={saving}
                      onClick={() => void handleStartLiveCapture('room_mic_cam')}
                      className={`w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-medium rounded-xl disabled:opacity-50 transition-colors min-h-[46px] ${
                        tabCaptureBlocked
                          ? 'bg-blue-600 text-white hover:bg-blue-500'
                          : 'bg-[#0F1B35] border border-[#1E2E52] text-slate-200 hover:bg-[#16264A]'
                      }`}
                    >
                      <Mic className="w-4 h-4" />
                      <span>Record Room Mic &amp; Camera</span>
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={() => void handleStopAndSave()}
                    className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 bg-red-600 text-white text-sm font-medium rounded-xl hover:bg-red-500 transition-colors min-h-[48px]"
                  >
                    <Square className="w-4 h-4 fill-current" />
                    <span>Stop &amp; Save Recording</span>
                  </button>
                )}
              </div>
            </>
          ) : (
            <form onSubmit={handleImportSave} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1.5">
                  Select Meeting or Phone Screen Recording
                </label>
                <label className="flex flex-col items-center justify-center border border-dashed border-[#1E2E52] bg-[#04060B] rounded-xl p-6 text-center cursor-pointer hover:border-blue-500 transition-colors min-h-[120px]">
                  <Upload className="w-5 h-5 text-slate-400 mb-2" />
                  <span className="text-sm font-medium text-slate-200">
                    {importedFile ? importedFile.name : 'Choose MP4, WebM, MOV, or Audio'}
                  </span>
                  <span className="text-xs text-slate-400 mt-1">
                    {importedFile
                      ? `${formatBytes(importedFile.size)} · Ready to encrypt in slices`
                      : 'Streamed & encrypted locally with AES-256-GCM'}
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
                <label className="block text-xs font-medium text-slate-300 mb-1.5">
                  Recording Title
                </label>
                <input
                  type="text"
                  value={meetingTitle}
                  onChange={(e) => setMeetingTitle(e.target.value)}
                  disabled={saving}
                  placeholder="e.g. Client Call Recording"
                  className="w-full px-3 py-2 text-sm bg-[#04060B] text-slate-100 placeholder:text-slate-500 border border-[#1E2E52] rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500 min-h-[44px]"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1.5">
                  Target Folder
                </label>
                <select
                  value={selectedFolderId}
                  onChange={(e) => setSelectedFolderId(e.target.value)}
                  disabled={saving}
                  className="w-full px-3 py-2 text-sm bg-[#04060B] text-slate-100 border border-[#1E2E52] rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500 min-h-[44px]"
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
                className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 bg-blue-600 text-white text-sm font-medium rounded-xl hover:bg-blue-500 disabled:opacity-50 transition-colors min-h-[46px]"
              >
                <Lock className="w-4 h-4" />
                <span>Encrypt &amp; Save to Vault</span>
              </button>
            </form>
          )}
        </div>

        {/* Right: Dark Broadcast Viewport & Completed Video Preview */}
        <div className="lg:col-span-7 space-y-4">
          <div className="bg-[#060B18] border border-[#162342] rounded-2xl overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 border-b border-[#162342]/80 text-xs text-slate-300">
              <div className="flex items-center gap-2.5 min-w-0">
                {isRecording ? (
                  <span className="inline-flex items-center gap-1.5 text-red-400 font-medium shrink-0">
                    <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
                    REC
                  </span>
                ) : (
                  <Video className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                )}
                <span className="font-medium text-slate-200 truncate">
                  {isNativeRecording ? 'Android Foreground Capture' : 'Active-Speaker Viewport'}
                </span>
                <span className="text-slate-600 hidden sm:inline">·</span>
                <span className="text-slate-400 font-mono text-[11px] hidden sm:inline">
                  {telemetry.codecLabel}
                </span>
              </div>
              <div className="flex items-center gap-3 font-mono tabular-nums text-slate-200 font-medium shrink-0">
                {isRecording && (
                  <span className="text-slate-400 text-[11px]">
                    {formatBytes(telemetry.recordedBytes)}
                  </span>
                )}
                <span>
                  {formatTimecode(telemetry.elapsedSec)}
                  {isRecording ? ` / ${formatTimecode(MAX_RECORDING_SECONDS)}` : ''}
                </span>
              </div>
            </div>

            <div className="aspect-video w-full bg-[#03050A] relative flex items-center justify-center">
              <div
                ref={previewContainerRef}
                className={`w-full h-full ${isRecording && !isNativeRecording ? 'block' : 'hidden'}`}
              />
              {isRecording && isNativeRecording && (
                <div className="text-center px-6 max-w-md">
                  <div className="w-12 h-12 rounded-full bg-red-500/20 border border-red-500/40 flex items-center justify-center mx-auto mb-3">
                    <span className="w-3.5 h-3.5 rounded-full bg-red-500 animate-pulse" />
                  </div>
                  <p className="text-sm font-medium text-slate-100">
                    Recording in Android Background Service
                  </p>
                  <p className="text-xs text-slate-400 mt-1.5 leading-relaxed">
                    You can switch straight to the Google Meet app now. Use your notification shade or return here to stop &amp; encrypt the video.
                  </p>
                </div>
              )}
              {!isRecording && !saving && lastCompleted?.videoUrl && (
                <video
                  src={lastCompleted.videoUrl}
                  controls
                  playsInline
                  className="w-full h-full object-contain"
                />
              )}
              {!isRecording && !saving && lastCompleted && !lastCompleted.videoUrl && (
                <div className="text-center px-6 max-w-md">
                  <CheckCircle2 className="w-8 h-8 text-emerald-400 mx-auto mb-3" />
                  <p className="text-sm font-medium text-slate-100">
                    {lastCompleted.savedDirectlyToDisk
                      ? 'Saved directly to your hard drive'
                      : 'Large recording safely cached & encrypted'}
                  </p>
                  <p className="text-xs text-slate-400 mt-1.5 leading-relaxed">
                    {lastCompleted.savedDirectlyToDisk
                      ? 'Your file was streamed directly to disk with zero browser storage used.'
                      : 'Use the Download button below to stream the decrypted video directly to disk.'}
                  </p>
                </div>
              )}
              {!isRecording && !saving && !lastCompleted && (
                <div className="text-center px-6 max-w-md">
                  <div className="w-11 h-11 rounded-xl bg-[#0F1B35]/80 border border-[#1E2E52]/80 flex items-center justify-center mx-auto mb-3 text-slate-300">
                    <Video className="w-5 h-5" />
                  </div>
                  <p className="text-sm font-medium text-slate-200">
                    Ready for noise-filtered meeting capture
                  </p>
                  <p className="text-xs text-slate-400 mt-1.5 leading-relaxed">
                    Records Meet participants cleanly while you listen, with adaptive mic noise-cancellation and 5-second encrypted checkpoints for 2–3 hour sessions.
                  </p>
                </div>
              )}

              {saving && (
                <div className="text-center px-6 max-w-md">
                  <Loader2 className="w-7 h-7 text-blue-400 animate-spin mx-auto mb-3" />
                  <p className="text-sm font-medium text-slate-100">
                    Finalizing encrypted recording...
                  </p>
                </div>
              )}
            </div>

            <div className="px-4 py-3 border-t border-[#162342]/80 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
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
                    : isNativeRecording
                    ? includeMic
                      ? 'Native Foreground · Meeting + Noise-Cancelled Mic'
                      : 'Native Foreground · Recording Meeting Audio'
                    : telemetry.activeSpeaker === 'remote'
                    ? 'Remote Meet audio active'
                    : telemetry.activeSpeaker === 'local'
                    ? 'Your voice active (Noise Cancelled)'
                    : includeMic
                    ? 'Listening · Mic gated cleanly'
                    : 'Listening to Meeting Audio'}
                </span>
              </div>

              {isRecording && (
                <form onSubmit={handleAddBookmark} className="flex items-center gap-2">
                  <input
                    type="text"
                    value={bookmarkInput}
                    onChange={(e) => setBookmarkInput(e.target.value)}
                    placeholder="Timestamp note..."
                    className="px-2.5 py-1.5 text-xs bg-slate-900 border border-[#1E2E52] text-slate-100 placeholder:text-slate-500 rounded-lg focus:outline-none focus:border-blue-500 min-h-[34px]"
                  />
                  <button
                    type="submit"
                    className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium bg-[#0F1B35] text-slate-200 border border-[#1E2E52] rounded-lg hover:bg-[#16264A] whitespace-nowrap shrink-0 min-h-[34px]"
                  >
                    <BookmarkPlus className="w-3.5 h-3.5" />
                    Mark
                  </button>
                </form>
              )}
            </div>
          </div>

          {bookmarks.length > 0 && (
            <div className="bg-[#091022] border border-[#162342] rounded-2xl p-4">
              <div className="text-xs font-semibold text-slate-300 mb-2">
                Session Bookmarks ({bookmarks.length})
              </div>
              <div className="divide-y divide-slate-800/80">
                {bookmarks.map((bm) => (
                  <div key={bm.id} className="py-1.5 flex items-center gap-3 text-xs">
                    <span className="font-mono tabular-nums text-blue-400 font-medium">
                      {formatTimecode(bm.timeSec)}
                    </span>
                    <span className="text-slate-200">{bm.note}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {lastCompleted && !saving && (
            <div className="bg-[#091022] border border-[#162342] rounded-2xl p-6 space-y-4">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="flex items-center gap-2 text-emerald-400 text-xs font-semibold mb-1">
                    <CheckCircle2 className="w-4 h-4" />
                    <span>
                      {lastCompleted.savedDirectlyToDisk
                        ? 'Saved Directly to Disk'
                        : 'Saved & Encrypted in Local Vault'}
                    </span>
                  </div>
                  <h2 className="font-display text-lg font-semibold text-slate-100">
                    {lastCompleted.title}
                  </h2>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-400">
                    <span className="font-mono tabular-nums">
                      {formatTimecode(lastCompleted.durationSec)}
                    </span>
                    <span aria-hidden="true">·</span>
                    <span className="font-mono tabular-nums">
                      {formatBytes(lastCompleted.fileSizeBytes)}
                    </span>
                    <span aria-hidden="true">·</span>
                    <span>{lastCompleted.videoMimeType}</span>
                  </div>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-3 pt-1">
                {!lastCompleted.savedDirectlyToDisk && lastCompleted.fileSizeBytes > 0 && (
                  <button
                    type="button"
                    onClick={() => void handleDownloadRecording()}
                    className="inline-flex items-center gap-2 px-4 py-2.5 bg-blue-600 text-white text-xs font-medium rounded-xl hover:bg-blue-500 transition-colors whitespace-nowrap shrink-0 min-h-[42px]"
                  >
                    <Download className="w-3.5 h-3.5" />
                    <span>Download Recorded Video</span>
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => onOpenMeeting(lastCompleted.meetingId)}
                  className="inline-flex items-center gap-1.5 px-4 py-2.5 bg-[#0F1B35] border border-[#1E2E52] text-slate-100 text-xs font-medium rounded-xl hover:bg-[#16264A] transition-colors whitespace-nowrap shrink-0 min-h-[42px]"
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

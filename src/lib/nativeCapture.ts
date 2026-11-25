import { Capacitor, registerPlugin } from '@capacitor/core';
import type { RecordingQualityPreset } from '../types';

export interface NativeCaptureStatus {
  isRecording: boolean;
  elapsedSec: number;
  recordedBytes: number;
  micEnabled: boolean;
  noiseCancelEnabled: boolean;
  remoteLevel: number;
  localLevel: number;
  remoteAudioDetected: boolean;
  playbackCaptureReady: boolean;
  lastAudioError: string;
  lastCompletedPath: string;
  lastCompletedMime: string;
  lastCompletedSizeBytes: number;
  lastCompletedDurationSec: number;
}

export interface NativeCaptureResult {
  filePath: string;
  mimeType: string;
  fileSizeBytes: number;
  durationSec: number;
}

interface MeetingRecorderPluginInterface {
  requestCapturePermissions: () => Promise<{
    audio: boolean;
    camera: boolean;
    notifications: boolean;
  }>;
  startNativeMeetingCapture: (options: {
    title: string;
    qualityPreset: RecordingQualityPreset;
    micEnabled: boolean;
    noiseCancelEnabled: boolean;
  }) => Promise<{ started: boolean; outputPath: string }>;
  stopNativeMeetingCapture: () => Promise<NativeCaptureResult>;
  setMicEnabled: (options: { enabled: boolean }) => Promise<{ micEnabled: boolean }>;
  setNoiseCancelEnabled: (options: { enabled: boolean }) => Promise<{ noiseCancelEnabled: boolean }>;
  getCaptureStatus: () => Promise<NativeCaptureStatus>;
  openAppSettings: () => Promise<void>;
  deleteNativeFile: (options: { filePath: string }) => Promise<void>;
  addListener: (
    eventName: 'captureStopped' | 'captureError',
    listenerFunc: (data: Record<string, unknown>) => void
  ) => Promise<{ remove: () => Promise<void> }>;
}

const MeetingRecorder = registerPlugin<MeetingRecorderPluginInterface>('MeetingRecorder');

export function isNativeAndroid(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
}

export async function requestNativePermissions() {
  return MeetingRecorder.requestCapturePermissions();
}

export async function startNativeCapture(options: {
  title: string;
  qualityPreset: RecordingQualityPreset;
  micEnabled: boolean;
  noiseCancelEnabled: boolean;
}) {
  return MeetingRecorder.startNativeMeetingCapture(options);
}

export async function stopNativeCapture(): Promise<NativeCaptureResult> {
  return MeetingRecorder.stopNativeMeetingCapture();
}

export async function setNativeMicEnabled(enabled: boolean): Promise<boolean> {
  const res = await MeetingRecorder.setMicEnabled({ enabled });
  return res.micEnabled;
}

export async function setNativeNoiseCancelEnabled(enabled: boolean): Promise<boolean> {
  const res = await MeetingRecorder.setNoiseCancelEnabled({ enabled });
  return res.noiseCancelEnabled;
}

export async function getNativeCaptureStatus(): Promise<NativeCaptureStatus> {
  return MeetingRecorder.getCaptureStatus();
}

export async function openNativeAppSettings(): Promise<void> {
  await MeetingRecorder.openAppSettings();
}

export async function deleteNativeFile(filePath: string): Promise<void> {
  if (!filePath) return;
  await MeetingRecorder.deleteNativeFile({ filePath });
}

export async function readNativeFileAsBlob(filePath: string, mimeType = 'video/mp4'): Promise<Blob | null> {
  if (!filePath) return null;
  const webUrl = Capacitor.convertFileSrc(filePath);
  const res = await fetch(webUrl);
  if (!res.ok) return null;
  const rawBlob = await res.blob();
  if (rawBlob.size === 0) return null;
  return new Blob([rawBlob], { type: mimeType });
}

export function addNativeCaptureListener(
  eventName: 'captureStopped' | 'captureError',
  handler: (data: Record<string, unknown>) => void
) {
  return MeetingRecorder.addListener(eventName, handler);
}

import type { RecordingQualityPreset, SpeakerFramingMode } from '../types';

export interface RecorderTelemetry {
  elapsedSec: number;
  remoteLevel: number;
  localLevel: number;
  activeSpeaker: 'remote' | 'local' | 'idle';
  waveformBars: number[];
  codecLabel: string;
  recordedBytes: number;
  micEnabled: boolean;
  noiseCancelEnabled: boolean;
}

export interface RecordedSessionOutput {
  durationSec: number;
  videoMimeType: string;
  recordedBytes: number;
}

export interface ActiveCaptureSession {
  previewCanvas: HTMLCanvasElement;
  stop: () => Promise<RecordedSessionOutput>;
  setFramingMode: (mode: SpeakerFramingMode) => void;
  setMicEnabled: (enabled: boolean) => Promise<boolean>;
  setNoiseCancelEnabled: (enabled: boolean) => void;
}

export interface QualityPresetSpec {
  id: RecordingQualityPreset;
  label: string;
  shortDesc: string;
  width: number;
  height: number;
  fps: number;
  videoBitsPerSecond: number;
  audioBitsPerSecond: number;
  estMbPerHour: number;
}

export const QUALITY_PRESETS: Record<RecordingQualityPreset, QualityPresetSpec> = {
  long_meeting: {
    id: 'long_meeting',
    label: '2–3 Hr Saver (480p)',
    shortDesc: '~240 MB/hr · Ideal for long calls',
    width: 854,
    height: 480,
    fps: 15,
    videoBitsPerSecond: 450_000,
    audioBitsPerSecond: 96_000,
    estMbPerHour: 240,
  },
  balanced: {
    id: 'balanced',
    label: 'Standard HD (720p)',
    shortDesc: '~500 MB/hr · Balanced clarity',
    width: 1280,
    height: 720,
    fps: 24,
    videoBitsPerSecond: 1_000_000,
    audioBitsPerSecond: 96_000,
    estMbPerHour: 500,
  },
  high: {
    id: 'high',
    label: 'High Detail (720p30)',
    shortDesc: '~960 MB/hr · Sharpest screenshare',
    width: 1280,
    height: 720,
    fps: 30,
    videoBitsPerSecond: 2_000_000,
    audioBitsPerSecond: 128_000,
    estMbPerHour: 960,
  },
};

export const MAX_RECORDING_SECONDS = 3 * 60 * 60; // 3 hours max safety cap

interface StartCaptureOptions {
  displayStream?: MediaStream | null;
  micStream?: MediaStream | null;
  camStream?: MediaStream | null;
  micEnabled?: boolean;
  noiseCancelEnabled?: boolean;
  sessionLabel?: string;
  framingMode: SpeakerFramingMode;
  qualityPreset: RecordingQualityPreset;
  onTelemetry: (telemetry: RecorderTelemetry) => void;
  onChunk: (chunk: Blob, mimeType: string) => Promise<void> | void;
  onStreamEnded?: () => void;
}

function createWorkerTimer(intervalMs: number, onTick: () => void): () => void {
  try {
    const code = `let id = setInterval(() => postMessage(0), ${Math.max(16, Math.round(intervalMs))}); self.onmessage = () => { clearInterval(id); };`;
    const blob = new Blob([code], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    const worker = new Worker(url);
    worker.onmessage = () => onTick();
    return () => {
      worker.postMessage(1);
      worker.terminate();
      URL.revokeObjectURL(url);
    };
  } catch {
    const id = window.setInterval(onTick, intervalMs);
    return () => window.clearInterval(id);
  }
}

export async function startActiveSpeakerCapture(
  options: StartCaptureOptions
): Promise<ActiveCaptureSession> {
  const {
    displayStream,
    camStream,
    sessionLabel,
    qualityPreset,
    onTelemetry,
    onChunk,
    onStreamEnded,
  } = options;
  let currentFramingMode: SpeakerFramingMode = options.framingMode;
  let currentMicEnabled = Boolean(options.micEnabled ?? Boolean(options.micStream));
  let currentNoiseCancel = options.noiseCancelEnabled ?? true;
  let activeMicStream: MediaStream | null = options.micStream ?? null;

  const spec = QUALITY_PRESETS[qualityPreset] ?? QUALITY_PRESETS.long_meeting;
  const { width, height, fps } = spec;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { alpha: false })!;

  const analysisCanvas = document.createElement('canvas');
  analysisCanvas.width = 96;
  analysisCanvas.height = 54;
  const analysisCtx = analysisCanvas.getContext('2d', { willReadFrequently: true })!;
  let prevFrameData: Uint8ClampedArray | null = null;
  let focusTargetX = 0.5;
  let focusTargetY = 0.5;
  let smoothFocusX = 0.5;
  let smoothFocusY = 0.5;
  let smoothZoom = 1.0;

  let displayVideo: HTMLVideoElement | null = null;
  if (displayStream && displayStream.getVideoTracks().length > 0) {
    displayVideo = document.createElement('video');
    displayVideo.srcObject = displayStream;
    displayVideo.muted = true;
    displayVideo.playsInline = true;
    await displayVideo.play().catch(() => {});
  }

  let camVideo: HTMLVideoElement | null = null;
  if (camStream && camStream.getVideoTracks().length > 0) {
    camVideo = document.createElement('video');
    camVideo.srcObject = camStream;
    camVideo.muted = true;
    camVideo.playsInline = true;
    await camVideo.play().catch(() => {});
  }

  const audioCtx = new AudioContext({ sampleRate: 48000 });
  if (audioCtx.state === 'suspended') {
    await audioCtx.resume();
  }
  const mixedDest = audioCtx.createMediaStreamDestination();

  // Gentle safety limiter prevents digital clipping when remote & local speak together
  // without pumping or ducking remote meeting audio
  const masterLimiter = audioCtx.createDynamicsCompressor();
  masterLimiter.threshold.value = -2;
  masterLimiter.knee.value = 6;
  masterLimiter.ratio.value = 4;
  masterLimiter.attack.value = 0.002;
  masterLimiter.release.value = 0.12;
  masterLimiter.connect(mixedDest);

  // True zero-signal silent keepalive keeps MediaStream audio active when toggling mic live
  const silentKeepalive = audioCtx.createConstantSource();
  silentKeepalive.offset.value = 0;
  const silentGain = audioCtx.createGain();
  silentGain.gain.value = 0;
  silentKeepalive.connect(silentGain);
  silentGain.connect(masterLimiter);
  silentKeepalive.start();

  // Remote meeting audio: passed cleanly & un-gated so every participant is heard naturally
  let remoteAnalyser: AnalyserNode | null = null;
  if (displayStream && displayStream.getAudioTracks().length > 0) {
    const remoteSource = audioCtx.createMediaStreamSource(
      new MediaStream(displayStream.getAudioTracks())
    );
    const remoteUnityGain = audioCtx.createGain();
    remoteUnityGain.gain.value = 1.0;
    remoteAnalyser = audioCtx.createAnalyser();
    remoteAnalyser.fftSize = 256;
    remoteSource.connect(remoteUnityGain);
    remoteUnityGain.connect(remoteAnalyser);
    remoteUnityGain.connect(masterLimiter);
  }

  // Local Microphone Studio Vocal Chain:
  // Relies on browser AEC + neural NoiseSuppression, plus gentle sub-rumble cut & soft expander
  // (never mutes to 0 so voice consonants & soft words are NEVER chopped off)
  let localRawAnalyser: AnalyserNode | null = null;
  let localOutAnalyser: AnalyserNode | null = null;
  let micHighPass: BiquadFilterNode | null = null;
  let micLowPass: BiquadFilterNode | null = null;
  let micSoftExpanderGain: GainNode | null = null;
  let micMuteGain: GainNode | null = null;
  let adaptiveNoiseFloor = 0.004;
  let holdUntilMs = 0;

  const attachMicPipeline = (stream: MediaStream) => {
    if (localOutAnalyser || stream.getAudioTracks().length === 0) return;

    const localSource = audioCtx.createMediaStreamSource(
      new MediaStream(stream.getAudioTracks())
    );

    localRawAnalyser = audioCtx.createAnalyser();
    localRawAnalyser.fftSize = 256;

    // Cut low ceiling-fan / AC rumble (< 80Hz) while preserving full vocal body
    micHighPass = audioCtx.createBiquadFilter();
    micHighPass.type = 'highpass';
    micHighPass.frequency.value = currentNoiseCancel ? 80 : 20;
    micHighPass.Q.value = 0.7;

    // Trim upper hiss (> 10.5kHz) without dulling speech clarity
    micLowPass = audioCtx.createBiquadFilter();
    micLowPass.type = 'lowpass';
    micLowPass.frequency.value = currentNoiseCancel ? 10500 : 18000;
    micLowPass.Q.value = 0.7;

    // Gentle vocal leveling
    const micCompressor = audioCtx.createDynamicsCompressor();
    micCompressor.threshold.value = -22;
    micCompressor.knee.value = 16;
    micCompressor.ratio.value = 2.6;
    micCompressor.attack.value = 0.004;
    micCompressor.release.value = 0.16;

    // Transparent soft expander (attenuates quiet background hum to 0.30, NEVER cuts to 0)
    micSoftExpanderGain = audioCtx.createGain();
    micSoftExpanderGain.gain.value = 1.0;

    // Smooth click-free mute/unmute toggle
    micMuteGain = audioCtx.createGain();
    micMuteGain.gain.value = currentMicEnabled ? 1.0 : 0.0;

    localOutAnalyser = audioCtx.createAnalyser();
    localOutAnalyser.fftSize = 256;

    localSource.connect(micHighPass);
    micHighPass.connect(micLowPass);
    micLowPass.connect(localRawAnalyser);
    micLowPass.connect(micCompressor);
    micCompressor.connect(micSoftExpanderGain);
    micSoftExpanderGain.connect(micMuteGain);
    micMuteGain.connect(localOutAnalyser);
    micMuteGain.connect(masterLimiter);
  };

  if (activeMicStream && activeMicStream.getAudioTracks().length > 0) {
    attachMicPipeline(activeMicStream);
  }

  const combinedAnalyser = audioCtx.createAnalyser();
  combinedAnalyser.fftSize = 64;
  const combinedSrc = audioCtx.createMediaStreamSource(mixedDest.stream);
  combinedSrc.connect(combinedAnalyser);

  const computeRms = (analyser: AnalyserNode | null): number => {
    if (!analyser) return 0;
    const buf = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) {
      const norm = (buf[i] - 128) / 128;
      sum += norm * norm;
    }
    return Math.sqrt(sum / buf.length);
  };

  const getWaveformBars = (): number[] => {
    const buf = new Uint8Array(combinedAnalyser.frequencyBinCount);
    combinedAnalyser.getByteFrequencyData(buf);
    const bars: number[] = [];
    const step = Math.max(1, Math.floor(buf.length / 24));
    for (let i = 0; i < 24; i++) {
      const val = buf[Math.min(buf.length - 1, i * step)] / 255;
      bars.push(Math.max(0.08, Math.min(1, val)));
    }
    return bars;
  };

  let wakeLock: { release: () => Promise<void> } | null = null;
  const requestWakeLock = async () => {
    try {
      const navAny = navigator as unknown as {
        wakeLock?: { request: (type: 'screen') => Promise<{ release: () => Promise<void> }> };
      };
      if (navAny.wakeLock && !wakeLock) {
        wakeLock = await navAny.wakeLock.request('screen');
      }
    } catch {
      wakeLock = null;
    }
  };
  await requestWakeLock();

  const mediaSession =
    typeof navigator !== 'undefined' && 'mediaSession' in navigator
      ? navigator.mediaSession
      : null;
  if (mediaSession) {
    try {
      mediaSession.metadata = new MediaMetadata({
        title: sessionLabel || 'Cadence Meet Recording',
        artist: 'Cadence Meet',
        album: 'Encrypted Local Capture',
      });
      mediaSession.playbackState = 'playing';
    } catch {
      // Ignore
    }
  }

  const useDirectDisplayTrack =
    Boolean(displayStream && displayStream.getVideoTracks().length > 0) &&
    currentFramingMode === 'full_stage' &&
    !camVideo;

  const canvasStream = canvas.captureStream(fps);
  const recordTracks: MediaStreamTrack[] = useDirectDisplayTrack
    ? [displayStream!.getVideoTracks()[0]]
    : [...canvasStream.getVideoTracks()];

  recordTracks.push(...mixedDest.stream.getAudioTracks());

  const mergedStream = new MediaStream(recordTracks);
  const candidateMimes = [
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
    'video/mp4;codecs=avc1,mp4a.40.2',
    'video/mp4',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ];
  const chosenMime = candidateMimes.find((m) => MediaRecorder.isTypeSupported(m)) || '';
  const codecLabel = chosenMime.includes('mp4')
    ? `MP4 · ${spec.height}p`
    : `WebM · ${spec.height}p`;

  const recorderOptions: MediaRecorderOptions = {
    videoBitsPerSecond: spec.videoBitsPerSecond,
    audioBitsPerSecond: spec.audioBitsPerSecond,
  };
  if (chosenMime) recorderOptions.mimeType = chosenMime;

  const recorder = new MediaRecorder(mergedStream, recorderOptions);
  const effectiveMime = recorder.mimeType || chosenMime || 'video/webm';

  let recordedBytes = 0;
  let chunkChain: Promise<void> = Promise.resolve();

  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) {
      recordedBytes += e.data.size;
      const chunk = e.data;
      chunkChain = chunkChain.then(() => Promise.resolve(onChunk(chunk, effectiveMime))).catch(() => {});
    }
  };

  recorder.start(5000);

  let stopped = false;
  const startTimeMs = performance.now();
  let frameIndex = 0;
  let lastTelemetryMs = 0;
  let autoStopTriggered = false;

  const handleVisibilityOrHide = () => {
    if (stopped) return;
    if (document.visibilityState === 'hidden') {
      if (recorder.state === 'recording') {
        try {
          recorder.requestData();
        } catch {
          // Ignore
        }
      }
    } else {
      if (audioCtx.state === 'suspended') {
        void audioCtx.resume().catch(() => {});
      }
      void requestWakeLock();
    }
  };
  document.addEventListener('visibilitychange', handleVisibilityOrHide);
  window.addEventListener('pagehide', handleVisibilityOrHide);

  const updateMotionFocus = (sourceVideo: HTMLVideoElement) => {
    if (sourceVideo.readyState < 2 || sourceVideo.videoWidth === 0) return;
    analysisCtx.drawImage(sourceVideo, 0, 0, 96, 54);
    const frame = analysisCtx.getImageData(0, 0, 96, 54).data;
    if (prevFrameData) {
      let weightSum = 0;
      let weightedX = 0;
      let weightedY = 0;
      for (let y = 0; y < 54; y += 2) {
        for (let x = 0; x < 96; x += 2) {
          const idx = (y * 96 + x) * 4;
          const diff =
            Math.abs(frame[idx] - prevFrameData[idx]) +
            Math.abs(frame[idx + 1] - prevFrameData[idx + 1]) +
            Math.abs(frame[idx + 2] - prevFrameData[idx + 2]);
          if (diff > 32) {
            weightSum += diff;
            weightedX += (x / 96) * diff;
            weightedY += (y / 54) * diff;
          }
        }
      }
      if (weightSum > 800) {
        focusTargetX = Math.max(0.25, Math.min(0.75, weightedX / weightSum));
        focusTargetY = Math.max(0.25, Math.min(0.75, weightedY / weightSum));
      }
    }
    prevFrameData = new Uint8ClampedArray(frame);
  };

  const updateSoftExpander = () => {
    if (!micSoftExpanderGain || !localRawAnalyser) return;
    const nowCtx = audioCtx.currentTime;
    if (!currentNoiseCancel || !currentMicEnabled) {
      micSoftExpanderGain.gain.setTargetAtTime(1.0, nowCtx, 0.03);
      return;
    }

    const rms = computeRms(localRawAnalyser);
    const nowMs = performance.now();

    if (rms < adaptiveNoiseFloor * 1.8) {
      adaptiveNoiseFloor = adaptiveNoiseFloor * 0.96 + rms * 0.04;
      adaptiveNoiseFloor = Math.max(0.003, Math.min(0.032, adaptiveNoiseFloor));
    }

    const speechThreshold = Math.max(0.01, adaptiveNoiseFloor * 1.65 + 0.004);
    if (rms >= speechThreshold) {
      holdUntilMs = nowMs + 450;
      micSoftExpanderGain.gain.setTargetAtTime(1.0, nowCtx, 0.01);
    } else if (nowMs < holdUntilMs) {
      micSoftExpanderGain.gain.setTargetAtTime(1.0, nowCtx, 0.02);
    } else {
      // Gently reduce idle background hum to -10dB (0.30) rather than muting to 0
      micSoftExpanderGain.gain.setTargetAtTime(0.3, nowCtx, 0.16);
    }
  };

  const renderFrame = () => {
    if (stopped) return;

    updateSoftExpander();

    const remoteLevel = computeRms(remoteAnalyser);
    const localLevel = currentMicEnabled ? computeRms(localOutAnalyser) : 0;
    const activeSpeaker: 'remote' | 'local' | 'idle' =
      remoteLevel > 0.018 && remoteLevel >= localLevel * 0.9
        ? 'remote'
        : localLevel > 0.018
        ? 'local'
        : 'idle';

    const elapsedSec = (performance.now() - startTimeMs) / 1000;
    if (elapsedSec >= MAX_RECORDING_SECONDS && !autoStopTriggered) {
      autoStopTriggered = true;
      onStreamEnded?.();
      return;
    }

    const bars = getWaveformBars();

    ctx.fillStyle = '#04060B';
    ctx.fillRect(0, 0, width, height);

    const primaryVideo =
      displayVideo && displayVideo.readyState >= 2 && displayVideo.videoWidth > 0
        ? displayVideo
        : !displayVideo && camVideo && camVideo.readyState >= 2 && camVideo.videoWidth > 0
        ? camVideo
        : null;

    if (primaryVideo) {
      const vw = primaryVideo.videoWidth;
      const vh = primaryVideo.videoHeight;

      if (currentFramingMode === 'smart_focus') {
        if (frameIndex % 4 === 0) updateMotionFocus(primaryVideo);
        const targetZoom = activeSpeaker !== 'idle' ? 1.14 : 1.04;
        smoothZoom += (targetZoom - smoothZoom) * 0.08;
        smoothFocusX += (focusTargetX - smoothFocusX) * 0.06;
        smoothFocusY += (focusTargetY - smoothFocusY) * 0.06;

        const cropW = vw / smoothZoom;
        const cropH = vh / smoothZoom;
        const sx = Math.max(0, Math.min(vw - cropW, smoothFocusX * vw - cropW / 2));
        const sy = Math.max(0, Math.min(vh - cropH, smoothFocusY * vh - cropH / 2));

        const scale = Math.min(width / cropW, height / cropH);
        const dw = cropW * scale;
        const dh = cropH * scale;
        const dx = (width - dw) / 2;
        const dy = (height - dh) / 2;
        ctx.drawImage(primaryVideo, sx, sy, cropW, cropH, dx, dy, dw, dh);
      } else {
        const scale = Math.min(width / vw, height / vh);
        const dw = vw * scale;
        const dh = vh * scale;
        const dx = (width - dw) / 2;
        const dy = (height - dh) / 2;
        ctx.drawImage(primaryVideo, 0, 0, vw, vh, dx, dy, dw, dh);
      }

      if (activeSpeaker !== 'idle') {
        ctx.strokeStyle = activeSpeaker === 'local' ? '#22C55E' : '#2563EB';
        ctx.lineWidth = 4;
        ctx.strokeRect(2, 2, width - 4, height - 4);
      }
    } else {
      ctx.fillStyle = '#091022';
      ctx.fillRect(48, 48, width - 96, height - 96);
      ctx.strokeStyle = activeSpeaker !== 'idle' ? '#2563EB' : '#162342';
      ctx.lineWidth = 2;
      ctx.strokeRect(48, 48, width - 96, height - 96);

      ctx.fillStyle = '#F8FAFC';
      ctx.font = '600 24px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(sessionLabel || 'Cadence Meet Recording', width / 2, height * 0.36);

      ctx.fillStyle = '#94A3B8';
      ctx.font = '400 15px sans-serif';
      ctx.fillText(
        activeSpeaker !== 'idle' ? 'Voice Activity Detected — Recording' : 'Listening for audio...',
        width / 2,
        height * 0.44
      );

      const barWidth = Math.max(8, Math.round(width / 80));
      const gap = 6;
      const totalBarW = bars.length * (barWidth + gap) - gap;
      const startX = (width - totalBarW) / 2;
      const baseY = height * 0.74;
      for (let i = 0; i < bars.length; i++) {
        const barH = Math.max(10, Math.round(bars[i] * (height * 0.2)));
        ctx.fillStyle = activeSpeaker !== 'idle' ? '#3B82F6' : '#1E293B';
        ctx.fillRect(startX + i * (barWidth + gap), baseY - barH, barWidth, barH);
      }
    }

    if (displayVideo && camVideo && camVideo.readyState >= 2 && camVideo.videoWidth > 0) {
      const pipW = Math.round(width * 0.2);
      const pipH = Math.round(pipW * (9 / 16));
      const pipX = width - pipW - 20;
      const pipY = height - pipH - 20;
      ctx.save();
      ctx.beginPath();
      ctx.roundRect(pipX, pipY, pipW, pipH, 8);
      ctx.clip();
      ctx.drawImage(camVideo, pipX, pipY, pipW, pipH);
      ctx.restore();
      ctx.strokeStyle = activeSpeaker === 'local' ? '#22C55E' : 'rgba(59,130,246,0.45)';
      ctx.lineWidth = activeSpeaker === 'local' ? 3 : 1.5;
      ctx.beginPath();
      ctx.roundRect(pipX, pipY, pipW, pipH, 8);
      ctx.stroke();
    }

    frameIndex++;
    const now = performance.now();
    if (now - lastTelemetryMs >= 120) {
      lastTelemetryMs = now;
      onTelemetry({
        elapsedSec,
        remoteLevel,
        localLevel,
        activeSpeaker,
        waveformBars: bars,
        codecLabel,
        recordedBytes,
        micEnabled: currentMicEnabled,
        noiseCancelEnabled: currentNoiseCancel,
      });
    }
  };

  const stopTimer = createWorkerTimer(Math.round(1000 / fps), renderFrame);

  displayStream?.getVideoTracks().forEach((track) => {
    track.addEventListener('ended', () => {
      if (!stopped && onStreamEnded) {
        onStreamEnded();
      }
    });
  });

  const setMicEnabled = async (enabled: boolean): Promise<boolean> => {
    if (stopped) return currentMicEnabled;
    if (audioCtx.state === 'suspended') {
      await audioCtx.resume().catch(() => {});
    }
    if (enabled && !activeMicStream) {
      try {
        activeMicStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: currentNoiseCancel,
            autoGainControl: true,
            channelCount: 1,
          },
        });
        attachMicPipeline(activeMicStream);
      } catch {
        currentMicEnabled = false;
        return false;
      }
    }
    currentMicEnabled = enabled;
    if (micMuteGain) {
      micMuteGain.gain.setTargetAtTime(enabled ? 1.0 : 0.0, audioCtx.currentTime, 0.02);
    }
    if (activeMicStream) {
      activeMicStream.getAudioTracks().forEach((t) => {
        t.enabled = enabled;
        if (typeof t.applyConstraints === 'function') {
          void t
            .applyConstraints({
              echoCancellation: true,
              noiseSuppression: currentNoiseCancel,
              autoGainControl: true,
            })
            .catch(() => {});
        }
      });
    }
    return currentMicEnabled;
  };

  const setNoiseCancelEnabled = (enabled: boolean) => {
    currentNoiseCancel = enabled;
    const now = audioCtx.currentTime;
    if (micHighPass) {
      micHighPass.frequency.setTargetAtTime(enabled ? 80 : 20, now, 0.03);
    }
    if (micLowPass) {
      micLowPass.frequency.setTargetAtTime(enabled ? 10500 : 18000, now, 0.03);
    }
    if (micSoftExpanderGain && !enabled) {
      micSoftExpanderGain.gain.setTargetAtTime(1.0, now, 0.03);
    }
    if (activeMicStream) {
      activeMicStream.getAudioTracks().forEach((t) => {
        if (typeof t.applyConstraints === 'function') {
          void t
            .applyConstraints({
              echoCancellation: true,
              noiseSuppression: enabled,
              autoGainControl: true,
            })
            .catch(() => {});
        }
      });
    }
  };

  const stop = async (): Promise<RecordedSessionOutput> => {
    if (stopped) {
      throw new Error('Capture session already stopped.');
    }
    stopped = true;
    stopTimer();
    document.removeEventListener('visibilitychange', handleVisibilityOrHide);
    window.removeEventListener('pagehide', handleVisibilityOrHide);

    const durationSec = Math.max(1, Math.round((performance.now() - startTimeMs) / 1000));

    if (recorder.state !== 'inactive') {
      await new Promise<void>((resolve) => {
        recorder.onstop = () => resolve();
        recorder.stop();
      });
    }
    await chunkChain;

    try {
      silentKeepalive.stop();
    } catch {
      // Ignore
    }
    displayStream?.getTracks().forEach((t) => t.stop());
    activeMicStream?.getTracks().forEach((t) => t.stop());
    camStream?.getTracks().forEach((t) => t.stop());
    await audioCtx.close().catch(() => {});
    if (wakeLock) {
      await wakeLock.release().catch(() => {});
      wakeLock = null;
    }
    if (mediaSession) {
      try {
        mediaSession.playbackState = 'none';
      } catch {
        // Ignore
      }
    }

    return {
      durationSec,
      videoMimeType: effectiveMime,
      recordedBytes,
    };
  };

  return {
    previewCanvas: canvas,
    stop,
    setFramingMode: (mode: SpeakerFramingMode) => {
      currentFramingMode = mode;
    },
    setMicEnabled,
    setNoiseCancelEnabled,
  };
}

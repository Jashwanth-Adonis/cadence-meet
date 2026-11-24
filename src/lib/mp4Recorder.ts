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
    shortDesc: '~220 MB/hr · Ideal for long calls',
    width: 854,
    height: 480,
    fps: 15,
    videoBitsPerSecond: 450_000,
    audioBitsPerSecond: 48_000,
    estMbPerHour: 220,
  },
  balanced: {
    id: 'balanced',
    label: 'Standard HD (720p)',
    shortDesc: '~480 MB/hr · Balanced clarity',
    width: 1280,
    height: 720,
    fps: 24,
    videoBitsPerSecond: 1_000_000,
    audioBitsPerSecond: 64_000,
    estMbPerHour: 480,
  },
  high: {
    id: 'high',
    label: 'High Detail (720p30)',
    shortDesc: '~940 MB/hr · Sharpest screenshare',
    width: 1280,
    height: 720,
    fps: 30,
    videoBitsPerSecond: 2_000_000,
    audioBitsPerSecond: 96_000,
    estMbPerHour: 940,
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

  // Master compressor keeps mixed remote + local voice smooth and prevents clipping
  const mixCompressor = audioCtx.createDynamicsCompressor();
  mixCompressor.threshold.value = -16;
  mixCompressor.knee.value = 20;
  mixCompressor.ratio.value = 3;
  mixCompressor.attack.value = 0.004;
  mixCompressor.release.value = 0.16;
  mixCompressor.connect(mixedDest);

  // Subtle silent oscillator keeps MediaStream audio track active even when mic is toggled mid-call
  const keepaliveOsc = audioCtx.createOscillator();
  const keepaliveGain = audioCtx.createGain();
  keepaliveOsc.frequency.value = 440;
  keepaliveGain.gain.value = 0.00001;
  keepaliveOsc.connect(keepaliveGain);
  keepaliveGain.connect(mixCompressor);
  keepaliveOsc.start();

  let remoteAnalyser: AnalyserNode | null = null;
  if (displayStream && displayStream.getAudioTracks().length > 0) {
    const remoteSource = audioCtx.createMediaStreamSource(
      new MediaStream(displayStream.getAudioTracks())
    );
    remoteAnalyser = audioCtx.createAnalyser();
    remoteAnalyser.fftSize = 256;
    remoteSource.connect(remoteAnalyser);
    remoteSource.connect(mixCompressor);
  }

  // Microphone DSP Noise-Cancellation Pipeline (can be attached initially or live mid-recording)
  let localRawAnalyser: AnalyserNode | null = null;
  let localOutAnalyser: AnalyserNode | null = null;
  let micHighPass: BiquadFilterNode | null = null;
  let micLowPass: BiquadFilterNode | null = null;
  let micRoomNotch: BiquadFilterNode | null = null;
  let micNoiseGateGain: GainNode | null = null;
  let micMuteGain: GainNode | null = null;
  let adaptiveNoiseFloor = 0.01;
  let gateOpenRatio = 0;

  const attachMicPipeline = (stream: MediaStream) => {
    if (localOutAnalyser || stream.getAudioTracks().length === 0) return;

    const localSource = audioCtx.createMediaStreamSource(
      new MediaStream(stream.getAudioTracks())
    );

    // Pre-gate speech-band analyser for accurate voice activity detection
    localRawAnalyser = audioCtx.createAnalyser();
    localRawAnalyser.fftSize = 256;

    // 1. High-pass filter cuts ceiling fan / AC rumble / desk thumps below 110Hz
    micHighPass = audioCtx.createBiquadFilter();
    micHighPass.type = 'highpass';
    micHighPass.frequency.value = currentNoiseCancel ? 110 : 20;
    micHighPass.Q.value = 0.8;

    // 2. Gentle low-cut reduces boxy 280Hz room echo
    micRoomNotch = audioCtx.createBiquadFilter();
    micRoomNotch.type = 'peaking';
    micRoomNotch.frequency.value = 280;
    micRoomNotch.Q.value = 1.1;
    micRoomNotch.gain.value = currentNoiseCancel ? -2.8 : 0;

    // 3. Low-pass filter trims distant hiss & fan air turbulence above 7.2kHz
    micLowPass = audioCtx.createBiquadFilter();
    micLowPass.type = 'lowpass';
    micLowPass.frequency.value = currentNoiseCancel ? 7200 : 18000;
    micLowPass.Q.value = 0.7;

    // 4. Voice dynamics leveling
    const micCompressor = audioCtx.createDynamicsCompressor();
    micCompressor.threshold.value = -24;
    micCompressor.knee.value = 18;
    micCompressor.ratio.value = 3.5;
    micCompressor.attack.value = 0.005;
    micCompressor.release.value = 0.15;

    // 5. Adaptive smooth noise gate (suppresses steady fan/ambient noise between words)
    micNoiseGateGain = audioCtx.createGain();
    micNoiseGateGain.gain.value = currentNoiseCancel ? 0 : 1;

    // 6. Smooth live mute/unmute toggle gain (no clicks or pops)
    micMuteGain = audioCtx.createGain();
    micMuteGain.gain.value = currentMicEnabled ? 1 : 0;

    localOutAnalyser = audioCtx.createAnalyser();
    localOutAnalyser.fftSize = 256;

    localSource.connect(micHighPass);
    micHighPass.connect(micRoomNotch);
    micRoomNotch.connect(micLowPass);
    micLowPass.connect(localRawAnalyser);
    micLowPass.connect(micCompressor);
    micCompressor.connect(micNoiseGateGain);
    micNoiseGateGain.connect(micMuteGain);
    micMuteGain.connect(localOutAnalyser);
    micMuteGain.connect(mixCompressor);
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

  // Measures energy specifically in the human voice frequency band (200Hz - 3800Hz)
  const computeSpeechEnergy = (analyser: AnalyserNode | null): number => {
    if (!analyser) return 0;
    const freq = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(freq);
    const binHz = audioCtx.sampleRate / analyser.fftSize;
    const startBin = Math.max(1, Math.floor(200 / binHz));
    const endBin = Math.min(freq.length - 1, Math.ceil(3800 / binHz));
    let sum = 0;
    let count = 0;
    for (let i = startBin; i <= endBin; i++) {
      sum += freq[i] / 255;
      count++;
    }
    return count > 0 ? sum / count : 0;
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

  // Acquire screen WakeLock so laptops/phones stay awake during long calls
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

  // Register MediaSession metadata so mobile PWA recording stays prioritized during app switches
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
      // Ignore unsupported MediaSession environments
    }
  }

  // Zero-copy direct track mode when full_stage + displayStream + no camera PiP
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

  // Emit encrypted chunks every 5s and drop from JS heap to sustain 2-3 hours cleanly
  recorder.start(5000);

  let stopped = false;
  const startTimeMs = performance.now();
  let frameIndex = 0;
  let lastTelemetryMs = 0;
  let autoStopTriggered = false;

  // Flush buffered audio/video immediately if user switches apps or backgrounds browser on mobile
  const handleVisibilityOrHide = () => {
    if (stopped) return;
    if (document.visibilityState === 'hidden') {
      if (recorder.state === 'recording') {
        try {
          recorder.requestData();
        } catch {
          // Ignore if state transitioned
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

  const updateNoiseGate = () => {
    if (!micNoiseGateGain || !localRawAnalyser) return;
    const now = audioCtx.currentTime;
    if (!currentNoiseCancel) {
      gateOpenRatio = 1;
      micNoiseGateGain.gain.setTargetAtTime(1, now, 0.03);
      return;
    }

    const speechEnergy = computeSpeechEnergy(localRawAnalyser);
    // Track ambient baseline slowly when speech isn't surging
    if (speechEnergy < adaptiveNoiseFloor * 2.1) {
      adaptiveNoiseFloor = adaptiveNoiseFloor * 0.96 + speechEnergy * 0.04;
      adaptiveNoiseFloor = Math.max(0.008, Math.min(0.14, adaptiveNoiseFloor));
    }

    const threshold = Math.max(0.045, adaptiveNoiseFloor * 1.9 + 0.018);
    if (speechEnergy > threshold) {
      gateOpenRatio = 1;
      micNoiseGateGain.gain.setTargetAtTime(1, now, 0.02);
    } else {
      gateOpenRatio = Math.max(0, gateOpenRatio * 0.85);
      if (gateOpenRatio < 0.08) {
        micNoiseGateGain.gain.setTargetAtTime(0, now, 0.14);
      }
    }
  };

  const renderFrame = () => {
    if (stopped) return;

    updateNoiseGate();

    const remoteLevel = computeRms(remoteAnalyser);
    const localLevel = currentMicEnabled ? computeRms(localOutAnalyser) : 0;
    const activeSpeaker: 'remote' | 'local' | 'idle' =
      remoteLevel > 0.022 && remoteLevel >= localLevel * 0.9
        ? 'remote'
        : localLevel > 0.022
        ? 'local'
        : 'idle';

    const elapsedSec = (performance.now() - startTimeMs) / 1000;
    if (elapsedSec >= MAX_RECORDING_SECONDS && !autoStopTriggered) {
      autoStopTriggered = true;
      onStreamEnded?.();
      return;
    }

    const bars = getWaveformBars();

    ctx.fillStyle = '#0B0F17';
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
        ctx.strokeStyle = activeSpeaker === 'local' ? '#22C55E' : '#3B82F6';
        ctx.lineWidth = 4;
        ctx.strokeRect(2, 2, width - 4, height - 4);
      }
    } else {
      ctx.fillStyle = '#0F172A';
      ctx.fillRect(48, 48, width - 96, height - 96);
      ctx.strokeStyle = activeSpeaker !== 'idle' ? '#3B82F6' : '#1E293B';
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
        ctx.fillStyle = activeSpeaker !== 'idle' ? '#3B82F6' : '#334155';
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
      ctx.strokeStyle = activeSpeaker === 'local' ? '#22C55E' : 'rgba(255,255,255,0.28)';
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

  // Unthrottled Web Worker timer prevents browser from dropping background tab FPS
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
    if (enabled && !activeMicStream) {
      try {
        activeMicStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
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
      micMuteGain.gain.setTargetAtTime(enabled ? 1 : 0, audioCtx.currentTime, 0.025);
    }
    if (activeMicStream) {
      activeMicStream.getAudioTracks().forEach((t) => {
        t.enabled = enabled;
      });
    }
    return currentMicEnabled;
  };

  const setNoiseCancelEnabled = (enabled: boolean) => {
    currentNoiseCancel = enabled;
    const now = audioCtx.currentTime;
    if (micHighPass) {
      micHighPass.frequency.setTargetAtTime(enabled ? 110 : 20, now, 0.03);
    }
    if (micRoomNotch) {
      micRoomNotch.gain.setTargetAtTime(enabled ? -2.8 : 0, now, 0.03);
    }
    if (micLowPass) {
      micLowPass.frequency.setTargetAtTime(enabled ? 7200 : 18000, now, 0.03);
    }
    if (micNoiseGateGain && !enabled) {
      micNoiseGateGain.gain.setTargetAtTime(1, now, 0.03);
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
      keepaliveOsc.stop();
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

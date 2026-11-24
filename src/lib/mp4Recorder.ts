import { Muxer, ArrayBufferTarget } from 'mp4-muxer';
import type { SpeakerFramingMode } from '../types';

export interface RecorderTelemetry {
  elapsedSec: number;
  remoteLevel: number;
  localLevel: number;
  activeSpeaker: 'remote' | 'local' | 'idle';
  waveformBars: number[];
  codecLabel: string;
}

export interface RecordedSessionOutput {
  videoBlob: Blob;
  durationSec: number;
  videoMimeType: string;
}

export interface ActiveCaptureSession {
  previewCanvas: HTMLCanvasElement;
  stop: () => Promise<RecordedSessionOutput>;
  setFramingMode: (mode: SpeakerFramingMode) => void;
}

interface StartCaptureOptions {
  displayStream?: MediaStream | null;
  micStream?: MediaStream | null;
  camStream?: MediaStream | null;
  sessionLabel?: string;
  framingMode: SpeakerFramingMode;
  onTelemetry: (telemetry: RecorderTelemetry) => void;
  onStreamEnded?: () => void;
  onCheckpointChunk?: (chunk: Blob, mimeType: string) => void;
}

export async function startActiveSpeakerCapture(
  options: StartCaptureOptions
): Promise<ActiveCaptureSession> {
  const {
    displayStream,
    micStream,
    camStream,
    sessionLabel,
    onTelemetry,
    onStreamEnded,
    onCheckpointChunk,
  } = options;
  let currentFramingMode: SpeakerFramingMode = options.framingMode;

  const width = 1280;
  const height = 720;
  const fps = 30;

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

  let remoteAnalyser: AnalyserNode | null = null;
  let localAnalyser: AnalyserNode | null = null;
  let hasAnyAudioTrack = false;

  if (displayStream && displayStream.getAudioTracks().length > 0) {
    hasAnyAudioTrack = true;
    const remoteSource = audioCtx.createMediaStreamSource(
      new MediaStream(displayStream.getAudioTracks())
    );
    remoteAnalyser = audioCtx.createAnalyser();
    remoteAnalyser.fftSize = 256;
    remoteSource.connect(remoteAnalyser);
    remoteSource.connect(mixedDest);
  }

  if (micStream && micStream.getAudioTracks().length > 0) {
    hasAnyAudioTrack = true;
    const localSource = audioCtx.createMediaStreamSource(
      new MediaStream(micStream.getAudioTracks())
    );
    localAnalyser = audioCtx.createAnalyser();
    localAnalyser.fftSize = 256;
    localSource.connect(localAnalyser);
    localSource.connect(mixedDest);
  }

  const combinedAnalyser = audioCtx.createAnalyser();
  combinedAnalyser.fftSize = 64;
  if (hasAnyAudioTrack) {
    const combinedSrc = audioCtx.createMediaStreamSource(mixedDest.stream);
    combinedSrc.connect(combinedAnalyser);
  }

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

  let useWebCodecs = false;
  let videoEncoder: VideoEncoder | null = null;
  let audioEncoder: AudioEncoder | null = null;
  let muxer: Muxer<ArrayBufferTarget> | null = null;
  let audioReader: ReadableStreamDefaultReader<AudioData> | null = null;
  let fallbackRecorder: MediaRecorder | null = null;
  const fallbackChunks: Blob[] = [];
  let fallbackMime = 'video/webm';
  let codecLabel = 'H.264 / AAC MP4';

  const canUseWebCodecs =
    typeof VideoEncoder !== 'undefined' &&
    typeof VideoFrame !== 'undefined' &&
    (!hasAnyAudioTrack ||
      (typeof AudioEncoder !== 'undefined' &&
        typeof (window as unknown as { MediaStreamTrackProcessor?: unknown }).MediaStreamTrackProcessor !==
          'undefined'));

  if (canUseWebCodecs) {
    try {
      const vSupport = await VideoEncoder.isConfigSupported({
        codec: 'avc1.42001f',
        width,
        height,
        bitrate: 2_500_000,
        framerate: fps,
      });
      let audioSupported = true;
      if (hasAnyAudioTrack) {
        const aSupport = await AudioEncoder.isConfigSupported({
          codec: 'mp4a.40.2',
          sampleRate: 48000,
          numberOfChannels: 2,
          bitrate: 128_000,
        });
        audioSupported = Boolean(aSupport.supported);
      }
      if (vSupport.supported && audioSupported) {
        useWebCodecs = true;
      }
    } catch {
      useWebCodecs = false;
    }
  }

  if (useWebCodecs) {
    muxer = new Muxer({
      target: new ArrayBufferTarget(),
      video: {
        codec: 'avc',
        width,
        height,
        frameRate: fps,
      },
      audio: hasAnyAudioTrack
        ? {
            codec: 'aac',
            numberOfChannels: 2,
            sampleRate: 48000,
          }
        : undefined,
      fastStart: 'in-memory',
      firstTimestampBehavior: 'offset',
    });

    videoEncoder = new VideoEncoder({
      output: (chunk, meta) => muxer?.addVideoChunk(chunk, meta),
      error: (err) => console.error('VideoEncoder error:', err),
    });

    videoEncoder.configure({
      codec: 'avc1.42001f',
      width,
      height,
      bitrate: 2_500_000,
      framerate: fps,
    });

    if (hasAnyAudioTrack) {
      audioEncoder = new AudioEncoder({
        output: (chunk, meta) => muxer?.addAudioChunk(chunk, meta),
        error: (err) => console.error('AudioEncoder error:', err),
      });
      audioEncoder.configure({
        codec: 'mp4a.40.2',
        sampleRate: 48000,
        numberOfChannels: 2,
        bitrate: 128_000,
      });

      const track = mixedDest.stream.getAudioTracks()[0];
      const ProcessorCtor = (
        window as unknown as {
          MediaStreamTrackProcessor: new (init: { track: MediaStreamTrack }) => {
            readable: ReadableStream<AudioData>;
          };
        }
      ).MediaStreamTrackProcessor;
      const processor = new ProcessorCtor({ track });
      audioReader = processor.readable.getReader();

      void (async () => {
        try {
          while (audioReader) {
            const { done, value } = await audioReader.read();
            if (done) break;
            if (audioEncoder && audioEncoder.state === 'configured') {
              audioEncoder.encode(value);
            }
            value.close();
          }
        } catch {
          // Closed on stop
        }
      })();
    }
  } else {
    const canvasStream = canvas.captureStream(fps);
    const tracks = [...canvasStream.getVideoTracks()];
    if (hasAnyAudioTrack) {
      tracks.push(...mixedDest.stream.getAudioTracks());
    }
    const mergedStream = new MediaStream(tracks);
    const candidateMimes = [
      'video/mp4;codecs=avc1,mp4a.40.2',
      'video/mp4',
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm',
    ];
    fallbackMime = candidateMimes.find((m) => MediaRecorder.isTypeSupported(m)) || '';
    codecLabel = fallbackMime.includes('mp4') ? 'MP4 Stream' : 'WebM Video';
    fallbackRecorder = fallbackMime
      ? new MediaRecorder(mergedStream, { mimeType: fallbackMime, videoBitsPerSecond: 2_500_000 })
      : new MediaRecorder(mergedStream);
    fallbackRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) {
        fallbackChunks.push(e.data);
        onCheckpointChunk?.(e.data, fallbackRecorder?.mimeType || fallbackMime || 'video/webm');
      }
    };
    fallbackRecorder.start(2500);
  }

  let backupRecorder: MediaRecorder | null = null;
  if (useWebCodecs && onCheckpointChunk && typeof MediaRecorder !== 'undefined') {
    try {
      const backupCanvasStream = canvas.captureStream(15);
      const backupTracks = [...backupCanvasStream.getVideoTracks()];
      if (hasAnyAudioTrack) {
        backupTracks.push(...mixedDest.stream.getAudioTracks());
      }
      const backupStream = new MediaStream(backupTracks);
      const backupMimes = [
        'video/webm;codecs=vp8,opus',
        'video/webm',
        'video/mp4',
      ];
      const backupMime = backupMimes.find((m) => MediaRecorder.isTypeSupported(m)) || '';
      backupRecorder = backupMime
        ? new MediaRecorder(backupStream, { mimeType: backupMime, videoBitsPerSecond: 900_000 })
        : new MediaRecorder(backupStream);
      backupRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          onCheckpointChunk(e.data, backupRecorder?.mimeType || backupMime || 'video/webm');
        }
      };
      backupRecorder.start(3000);
    } catch {
      backupRecorder = null;
    }
  }

  let stopped = false;
  const startTimeMs = performance.now();
  let frameIndex = 0;
  let lastTelemetryMs = 0;
  let lastTimestampUs = -1;

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

  const renderFrame = () => {
    if (stopped) return;

    const remoteLevel = computeRms(remoteAnalyser);
    const localLevel = computeRms(localAnalyser);
    const activeSpeaker: 'remote' | 'local' | 'idle' =
      remoteLevel > 0.022 && remoteLevel >= localLevel * 0.9
        ? 'remote'
        : localLevel > 0.022
        ? 'local'
        : 'idle';

    const elapsedSec = (performance.now() - startTimeMs) / 1000;
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
      ctx.fillRect(80, 80, width - 160, height - 160);
      ctx.strokeStyle = activeSpeaker !== 'idle' ? '#3B82F6' : '#1E293B';
      ctx.lineWidth = 2;
      ctx.strokeRect(80, 80, width - 160, height - 160);

      ctx.fillStyle = '#F8FAFC';
      ctx.font = '600 30px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(sessionLabel || 'Cadence Meet Recording', width / 2, 240);

      ctx.fillStyle = '#94A3B8';
      ctx.font = '400 18px sans-serif';
      ctx.fillText(
        activeSpeaker !== 'idle' ? 'Voice Activity Detected — Recording' : 'Listening...',
        width / 2,
        282
      );

      const barWidth = 14;
      const gap = 8;
      const totalBarW = bars.length * (barWidth + gap) - gap;
      const startX = (width - totalBarW) / 2;
      const baseY = 470;
      for (let i = 0; i < bars.length; i++) {
        const barH = Math.max(12, Math.round(bars[i] * 140));
        ctx.fillStyle = activeSpeaker !== 'idle' ? '#3B82F6' : '#334155';
        ctx.fillRect(startX + i * (barWidth + gap), baseY - barH, barWidth, barH);
      }
    }

    if (displayVideo && camVideo && camVideo.readyState >= 2 && camVideo.videoWidth > 0) {
      const pipW = 240;
      const pipH = 135;
      const pipX = width - pipW - 24;
      const pipY = height - pipH - 24;
      ctx.save();
      ctx.beginPath();
      ctx.roundRect(pipX, pipY, pipW, pipH, 10);
      ctx.clip();
      ctx.drawImage(camVideo, pipX, pipY, pipW, pipH);
      ctx.restore();
      ctx.strokeStyle = activeSpeaker === 'local' ? '#22C55E' : 'rgba(255,255,255,0.25)';
      ctx.lineWidth = activeSpeaker === 'local' ? 3 : 1.5;
      ctx.beginPath();
      ctx.roundRect(pipX, pipY, pipW, pipH, 10);
      ctx.stroke();
    }

    if (useWebCodecs && videoEncoder && videoEncoder.state === 'configured') {
      if (videoEncoder.encodeQueueSize < 8) {
        const rawUs = Math.round(elapsedSec * 1_000_000);
        const timestampUs = Math.max(lastTimestampUs + 1, rawUs);
        lastTimestampUs = timestampUs;
        const frame = new VideoFrame(canvas, { timestamp: timestampUs });
        videoEncoder.encode(frame, { keyFrame: frameIndex % (fps * 2) === 0 });
        frame.close();
      }
    }

    frameIndex++;
    const now = performance.now();
    if (now - lastTelemetryMs >= 75) {
      lastTelemetryMs = now;
      onTelemetry({
        elapsedSec,
        remoteLevel,
        localLevel,
        activeSpeaker,
        waveformBars: bars,
        codecLabel,
      });
    }
  };

  const intervalId = window.setInterval(renderFrame, Math.round(1000 / fps));

  displayStream?.getVideoTracks().forEach((track) => {
    track.addEventListener('ended', () => {
      if (!stopped && onStreamEnded) {
        onStreamEnded();
      }
    });
  });

  const stop = async (): Promise<RecordedSessionOutput> => {
    if (stopped) {
      throw new Error('Capture session already stopped.');
    }
    stopped = true;
    window.clearInterval(intervalId);

    const durationSec = Math.max(1, Math.round((performance.now() - startTimeMs) / 1000));

    let videoBlob: Blob;
    let videoMimeType = 'video/mp4';

    if (useWebCodecs && muxer && videoEncoder) {
      if (audioReader) {
        await audioReader.cancel().catch(() => {});
        audioReader = null;
      }
      if (videoEncoder.state === 'configured') {
        await videoEncoder.flush();
        videoEncoder.close();
      }
      if (audioEncoder && audioEncoder.state === 'configured') {
        await audioEncoder.flush();
        audioEncoder.close();
      }
      muxer.finalize();
      videoBlob = new Blob([muxer.target.buffer], { type: 'video/mp4' });
    } else if (fallbackRecorder) {
      if (fallbackRecorder.state !== 'inactive') {
        await new Promise<void>((resolve) => {
          fallbackRecorder!.onstop = () => resolve();
          fallbackRecorder!.stop();
        });
      }
      videoMimeType = fallbackRecorder.mimeType || fallbackMime || 'video/webm';
      videoBlob = new Blob(fallbackChunks, { type: videoMimeType });
    } else {
      videoBlob = new Blob([], { type: 'video/mp4' });
    }

    if (backupRecorder && backupRecorder.state !== 'inactive') {
      try {
        backupRecorder.stop();
      } catch {
        // Ignore
      }
    }

    displayStream?.getTracks().forEach((t) => t.stop());
    micStream?.getTracks().forEach((t) => t.stop());
    camStream?.getTracks().forEach((t) => t.stop());
    await audioCtx.close().catch(() => {});

    return {
      videoBlob,
      durationSec,
      videoMimeType,
    };
  };

  return {
    previewCanvas: canvas,
    stop,
    setFramingMode: (mode: SpeakerFramingMode) => {
      currentFramingMode = mode;
    },
  };
}

package app.cadencemeet.recorder;

import android.app.Activity;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.graphics.Rect;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.media.AudioAttributes;
import android.media.AudioFormat;
import android.media.AudioPlaybackCaptureConfiguration;
import android.media.AudioRecord;
import android.media.MediaCodec;
import android.media.MediaCodecInfo;
import android.media.MediaFormat;
import android.media.MediaMuxer;
import android.media.MediaRecorder;
import android.media.audiofx.AcousticEchoCanceler;
import android.media.audiofx.NoiseSuppressor;
import android.media.projection.MediaProjection;
import android.media.projection.MediaProjectionManager;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import android.util.DisplayMetrics;
import android.view.Surface;
import android.view.WindowManager;
import android.view.WindowMetrics;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;

import java.io.File;
import java.nio.ByteBuffer;
import java.util.concurrent.CountDownLatch;

public class MeetingCaptureService extends Service {
    public static final String ACTION_START = "app.cadencemeet.recorder.ACTION_START";
    public static final String ACTION_STOP = "app.cadencemeet.recorder.ACTION_STOP";

    public static final String EXTRA_RESULT_CODE = "resultCode";
    public static final String EXTRA_RESULT_DATA = "resultData";
    public static final String EXTRA_OUTPUT_PATH = "outputPath";
    public static final String EXTRA_TITLE = "title";
    public static final String EXTRA_WIDTH = "width";
    public static final String EXTRA_HEIGHT = "height";
    public static final String EXTRA_FPS = "fps";
    public static final String EXTRA_VIDEO_BITRATE = "videoBitrate";
    public static final String EXTRA_MIC_ENABLED = "micEnabled";
    public static final String EXTRA_NOISE_CANCEL = "noiseCancel";

    private static final String CHANNEL_ID = "cadence_capture_channel";
    private static final int NOTIFICATION_ID = 4102;
    private static final int SAMPLE_RATE = 48000;
    private static final int FRAME_SAMPLES = 1024;

    public interface CaptureListener {
        void onStopped(String filePath, long fileSizeBytes, int durationSec);
        void onError(String message);
    }

    private static volatile boolean recordingActive = false;
    private static volatile boolean micEnabled = false;
    private static volatile boolean noiseCancelEnabled = true;
    private static volatile long startTimeMs = 0L;
    private static volatile float currentRemoteLevel = 0f;
    private static volatile float currentLocalLevel = 0f;
    private static volatile boolean remoteAudioDetected = false;
    private static volatile String activeOutputPath = "";
    private static volatile String lastCompletedPath = "";
    private static volatile long lastCompletedSizeBytes = 0L;
    private static volatile int lastCompletedDurationSec = 0;
    private static volatile CaptureListener listener = null;
    private static volatile MeetingCaptureService instance = null;

    private PowerManager.WakeLock wakeLock;
    private MediaProjection mediaProjection;
    private VirtualDisplay virtualDisplay;

    private MediaCodec videoCodec;
    private MediaCodec audioCodec;
    private MediaMuxer mediaMuxer;
    private Surface inputSurface;
    private Thread videoDrainThread;
    private Thread audioMixerThread;
    private Thread playbackReaderThread;
    private Thread micReaderThread;
    private final Object muxerLock = new Object();
    private volatile int videoTrackIndex = -1;
    private volatile int audioTrackIndex = -1;
    private volatile boolean muxerStarted = false;
    private volatile boolean stopRequested = false;

    private MediaRecorder legacyRecorder;

    /**
     * Thread-safe circular PCM buffer so playback and mic readers never block each other.
     */
    private static final class PcmRingBuffer {
        private final short[] buffer;
        private int readPos = 0;
        private int writePos = 0;
        private int count = 0;

        PcmRingBuffer(int capacitySamples) {
            this.buffer = new short[capacitySamples];
        }

        synchronized void write(short[] data, int len) {
            for (int i = 0; i < len; i++) {
                if (count == buffer.length) {
                    // Drop oldest sample smoothly if consumer fell behind
                    readPos = (readPos + 1) % buffer.length;
                    count--;
                }
                buffer[writePos] = data[i];
                writePos = (writePos + 1) % buffer.length;
                count++;
            }
        }

        synchronized int read(short[] out, int len) {
            int toRead = Math.min(len, count);
            for (int i = 0; i < toRead; i++) {
                out[i] = buffer[readPos];
                readPos = (readPos + 1) % buffer.length;
            }
            count -= toRead;
            for (int i = toRead; i < len; i++) {
                out[i] = 0;
            }
            return toRead;
        }

        synchronized void clear() {
            readPos = 0;
            writePos = 0;
            count = 0;
        }
    }

    public static void setListener(@Nullable CaptureListener captureListener) {
        listener = captureListener;
    }

    public static boolean isRecording() {
        return recordingActive;
    }

    public static boolean isMicEnabled() {
        return micEnabled;
    }

    public static boolean isNoiseCancelEnabled() {
        return noiseCancelEnabled;
    }

    public static void setMicEnabled(boolean enabled) {
        micEnabled = enabled;
    }

    public static void setNoiseCancelEnabled(boolean enabled) {
        noiseCancelEnabled = enabled;
    }

    public static float getRemoteLevel() {
        return currentRemoteLevel;
    }

    public static float getLocalLevel() {
        return currentLocalLevel;
    }

    public static boolean isRemoteAudioDetected() {
        return remoteAudioDetected;
    }

    public static int getElapsedSec() {
        if (!recordingActive || startTimeMs <= 0L) return 0;
        return (int) Math.max(0L, (System.currentTimeMillis() - startTimeMs) / 1000L);
    }

    public static long getCurrentRecordedBytes() {
        if (activeOutputPath == null || activeOutputPath.isEmpty()) return 0L;
        File f = new File(activeOutputPath);
        return f.exists() ? f.length() : 0L;
    }

    public static String getLastCompletedPath() {
        return lastCompletedPath;
    }

    public static long getLastCompletedSizeBytes() {
        return lastCompletedSizeBytes;
    }

    public static int getLastCompletedDurationSec() {
        return lastCompletedDurationSec;
    }

    public static void clearLastCompleted() {
        lastCompletedPath = "";
        lastCompletedSizeBytes = 0L;
        lastCompletedDurationSec = 0;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;
        createNotificationChannel();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null) {
            return START_NOT_STICKY;
        }
        String action = intent.getAction();
        if (ACTION_STOP.equals(action)) {
            stopCaptureAndSelf();
            return START_NOT_STICKY;
        }

        if (ACTION_START.equals(action) && !recordingActive) {
            int resultCode = intent.getIntExtra(EXTRA_RESULT_CODE, Activity.RESULT_CANCELED);
            Intent resultData = Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                    ? intent.getParcelableExtra(EXTRA_RESULT_DATA, Intent.class)
                    : intent.getParcelableExtra(EXTRA_RESULT_DATA);
            String outputPath = intent.getStringExtra(EXTRA_OUTPUT_PATH);
            String title = intent.getStringExtra(EXTRA_TITLE);
            int width = intent.getIntExtra(EXTRA_WIDTH, 854);
            int height = intent.getIntExtra(EXTRA_HEIGHT, 480);
            int fps = intent.getIntExtra(EXTRA_FPS, 15);
            int videoBitrate = intent.getIntExtra(EXTRA_VIDEO_BITRATE, 700_000);
            micEnabled = intent.getBooleanExtra(EXTRA_MIC_ENABLED, false);
            noiseCancelEnabled = intent.getBooleanExtra(EXTRA_NOISE_CANCEL, true);

            if (resultData == null || outputPath == null) {
                if (listener != null) listener.onError("Missing screen capture permission grant.");
                stopSelf();
                return START_NOT_STICKY;
            }

            Notification notification = buildNotification(title != null ? title : "Cadence Meet Recording");
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                int fgsType = ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION;
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                    fgsType |= ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE;
                }
                startForeground(NOTIFICATION_ID, notification, fgsType);
            } else {
                startForeground(NOTIFICATION_ID, notification);
            }

            acquireWakeLock();
            beginCapture(resultCode, resultData, outputPath, width, height, fps, videoBitrate);
        }

        return START_NOT_STICKY;
    }

    private void acquireWakeLock() {
        try {
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            if (pm != null) {
                wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "cadence:MeetingCaptureWakeLock");
                wakeLock.acquire(4L * 60L * 60L * 1000L);
            }
        } catch (Exception ignored) {
        }
    }

    private void beginCapture(
            int resultCode,
            Intent resultData,
            String outputPath,
            int targetWidth,
            int targetHeight,
            int fps,
            int videoBitrate
    ) {
        try {
            MediaProjectionManager mpm = (MediaProjectionManager) getSystemService(Context.MEDIA_PROJECTION_SERVICE);
            mediaProjection = mpm.getMediaProjection(resultCode, resultData);
            if (mediaProjection == null) {
                throw new IllegalStateException("MediaProjection returned null.");
            }

            File outFile = new File(outputPath);
            if (outFile.getParentFile() != null) {
                //noinspection ResultOfMethodCallIgnored
                outFile.getParentFile().mkdirs();
            }

            activeOutputPath = outputPath;
            clearLastCompleted();
            currentRemoteLevel = 0f;
            currentLocalLevel = 0f;
            remoteAudioDetected = false;
            startTimeMs = System.currentTimeMillis();
            stopRequested = false;
            recordingActive = true;

            int screenW = 1080;
            int screenH = 1920;
            int densityDpi = DisplayMetrics.DENSITY_HIGH;
            WindowManager wm = (WindowManager) getSystemService(Context.WINDOW_SERVICE);
            if (wm != null) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                    WindowMetrics windowMetrics = wm.getMaximumWindowMetrics();
                    Rect bounds = windowMetrics.getBounds();
                    screenW = bounds.width();
                    screenH = bounds.height();
                    densityDpi = getResources().getConfiguration().densityDpi;
                } else {
                    DisplayMetrics metrics = new DisplayMetrics();
                    //noinspection deprecation
                    wm.getDefaultDisplay().getRealMetrics(metrics);
                    screenW = metrics.widthPixels;
                    screenH = metrics.heightPixels;
                    densityDpi = metrics.densityDpi > 0 ? metrics.densityDpi : DisplayMetrics.DENSITY_HIGH;
                }
            }

            int width = (targetWidth / 2) * 2;
            int height = (targetHeight / 2) * 2;
            if (screenH > screenW && width > height) {
                int tmp = width;
                width = height;
                height = tmp;
            }

            mediaProjection.registerCallback(new MediaProjection.Callback() {
                @Override
                public void onStop() {
                    if (recordingActive && !stopRequested) {
                        stopCaptureAndSelf();
                    }
                }
            }, null);

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startApi29PlaybackAndMicMuxer(width, height, fps, videoBitrate, densityDpi, outputPath);
            } else {
                startLegacyMediaRecorder(width, height, fps, videoBitrate, densityDpi, outputPath);
            }
        } catch (Exception ex) {
            recordingActive = false;
            if (listener != null) listener.onError("Failed to start native capture: " + ex.getMessage());
            cleanupResources();
            stopSelf();
        }
    }

    private void startLegacyMediaRecorder(
            int width,
            int height,
            int fps,
            int videoBitrate,
            int densityDpi,
            String outputPath
    ) throws Exception {
        legacyRecorder = new MediaRecorder();
        legacyRecorder.setAudioSource(MediaRecorder.AudioSource.MIC);
        legacyRecorder.setVideoSource(MediaRecorder.VideoSource.SURFACE);
        legacyRecorder.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4);
        legacyRecorder.setOutputFile(outputPath);
        legacyRecorder.setVideoSize(width, height);
        legacyRecorder.setVideoEncoder(MediaRecorder.VideoEncoder.H264);
        legacyRecorder.setAudioEncoder(MediaRecorder.AudioEncoder.AAC);
        legacyRecorder.setAudioEncodingBitRate(96_000);
        legacyRecorder.setAudioSamplingRate(SAMPLE_RATE);
        legacyRecorder.setVideoEncodingBitRate(videoBitrate);
        legacyRecorder.setVideoFrameRate(fps);
        legacyRecorder.prepare();

        virtualDisplay = mediaProjection.createVirtualDisplay(
                "CadenceMeetCapture",
                width,
                height,
                densityDpi,
                DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
                legacyRecorder.getSurface(),
                null,
                null
        );
        legacyRecorder.start();
    }

    private void startApi29PlaybackAndMicMuxer(
            int width,
            int height,
            int fps,
            int videoBitrate,
            int densityDpi,
            String outputPath
    ) throws Exception {
        videoTrackIndex = -1;
        audioTrackIndex = -1;
        muxerStarted = false;

        mediaMuxer = new MediaMuxer(outputPath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4);

        MediaFormat videoFormat = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, width, height);
        videoFormat.setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface);
        videoFormat.setInteger(MediaFormat.KEY_BIT_RATE, videoBitrate);
        videoFormat.setInteger(MediaFormat.KEY_FRAME_RATE, fps);
        videoFormat.setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 2);

        videoCodec = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_VIDEO_AVC);
        videoCodec.configure(videoFormat, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE);
        inputSurface = videoCodec.createInputSurface();
        videoCodec.start();

        virtualDisplay = mediaProjection.createVirtualDisplay(
                "CadenceMeetCapture",
                width,
                height,
                densityDpi,
                DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
                inputSurface,
                null,
                null
        );

        MediaFormat audioFormat = MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_AAC, SAMPLE_RATE, 1);
        audioFormat.setInteger(MediaFormat.KEY_AAC_PROFILE, MediaCodecInfo.CodecProfileLevel.AACObjectLC);
        audioFormat.setInteger(MediaFormat.KEY_BIT_RATE, 96_000);
        audioFormat.setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, 16384);

        audioCodec = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_AUDIO_AAC);
        audioCodec.configure(audioFormat, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE);
        audioCodec.start();

        final long anchorNs = System.nanoTime();
        final PcmRingBuffer remoteRing = new PcmRingBuffer(SAMPLE_RATE / 2); // 500ms ring
        final PcmRingBuffer micRing = new PcmRingBuffer(SAMPLE_RATE / 2);

        playbackReaderThread = new Thread(() -> runPlaybackReader(remoteRing), "CadencePlaybackReader");
        micReaderThread = new Thread(() -> runMicReader(micRing), "CadenceMicReader");
        videoDrainThread = new Thread(() -> drainVideoEncoder(anchorNs), "CadenceVideoDrain");
        audioMixerThread = new Thread(() -> mixAndEncodeAudio(anchorNs, remoteRing, micRing), "CadenceAudioMixer");

        playbackReaderThread.start();
        micReaderThread.start();
        videoDrainThread.start();
        audioMixerThread.start();
    }

    private void runPlaybackReader(PcmRingBuffer remoteRing) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return;

        int minBuf = AudioRecord.getMinBufferSize(
                SAMPLE_RATE,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT
        );
        int bufferBytes = Math.max(minBuf, FRAME_SAMPLES * 6);
        AudioRecord playbackRecord = null;

        try {
            AudioPlaybackCaptureConfiguration config = new AudioPlaybackCaptureConfiguration.Builder(mediaProjection)
                    .addMatchingUsage(AudioAttributes.USAGE_MEDIA)
                    .addMatchingUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                    .addMatchingUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION_SIGNALLING)
                    .addMatchingUsage(AudioAttributes.USAGE_ASSISTANCE_NAVIGATION_GUIDANCE)
                    .addMatchingUsage(AudioAttributes.USAGE_GAME)
                    .addMatchingUsage(AudioAttributes.USAGE_UNKNOWN)
                    .build();

            AudioFormat pcmFormat = new AudioFormat.Builder()
                    .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                    .setSampleRate(SAMPLE_RATE)
                    .setChannelMask(AudioFormat.CHANNEL_IN_MONO)
                    .build();

            playbackRecord = new AudioRecord.Builder()
                    .setAudioFormat(pcmFormat)
                    .setBufferSizeInBytes(bufferBytes)
                    .setAudioPlaybackCaptureConfig(config)
                    .build();

            if (playbackRecord.getState() != AudioRecord.STATE_INITIALIZED) {
                playbackRecord.release();
                return;
            }
            playbackRecord.startRecording();
        } catch (Exception ignored) {
            if (playbackRecord != null) {
                try { playbackRecord.release(); } catch (Exception ignored2) {}
            }
            return;
        }

        short[] buf = new short[FRAME_SAMPLES];
        while (!stopRequested) {
            int n = playbackRecord.read(buf, 0, FRAME_SAMPLES);
            if (n > 0) {
                remoteRing.write(buf, n);
            } else if (n < 0) {
                break;
            }
        }

        try { playbackRecord.stop(); } catch (Exception ignored) {}
        playbackRecord.release();
    }

    private void runMicReader(PcmRingBuffer micRing) {
        int minBuf = AudioRecord.getMinBufferSize(
                SAMPLE_RATE,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT
        );
        int bufferBytes = Math.max(minBuf, FRAME_SAMPLES * 6);

        AudioRecord micRecord = null;
        NoiseSuppressor noiseSuppressor = null;
        AcousticEchoCanceler echoCanceler = null;
        short[] buf = new short[FRAME_SAMPLES];

        while (!stopRequested) {
            if (!micEnabled) {
                // Lazily wait without holding the hardware mic while muted,
                // preventing audio routing conflicts with the Google Meet app
                if (micRecord != null) {
                    if (noiseSuppressor != null) { try { noiseSuppressor.release(); } catch (Exception ignored) {} noiseSuppressor = null; }
                    if (echoCanceler != null) { try { echoCanceler.release(); } catch (Exception ignored) {} echoCanceler = null; }
                    try { micRecord.stop(); } catch (Exception ignored) {}
                    micRecord.release();
                    micRecord = null;
                    micRing.clear();
                    currentLocalLevel = 0f;
                }
                try {
                    Thread.sleep(40);
                } catch (InterruptedException e) {
                    break;
                }
                continue;
            }

            if (micRecord == null) {
                try {
                    // Use VOICE_RECOGNITION so Android preserves media speaker routing & clean speech
                    micRecord = new AudioRecord(
                            MediaRecorder.AudioSource.VOICE_RECOGNITION,
                            SAMPLE_RATE,
                            AudioFormat.CHANNEL_IN_MONO,
                            AudioFormat.ENCODING_PCM_16BIT,
                            bufferBytes
                    );
                    if (micRecord.getState() != AudioRecord.STATE_INITIALIZED) {
                        micRecord.release();
                        micRecord = new AudioRecord(
                                MediaRecorder.AudioSource.MIC,
                                SAMPLE_RATE,
                                AudioFormat.CHANNEL_IN_MONO,
                                AudioFormat.ENCODING_PCM_16BIT,
                                bufferBytes
                        );
                    }
                    if (micRecord.getState() != AudioRecord.STATE_INITIALIZED) {
                        micRecord.release();
                        micRecord = null;
                        Thread.sleep(200);
                        continue;
                    }
                    int sessionId = micRecord.getAudioSessionId();
                    if (NoiseSuppressor.isAvailable()) {
                        noiseSuppressor = NoiseSuppressor.create(sessionId);
                        if (noiseSuppressor != null) noiseSuppressor.setEnabled(noiseCancelEnabled);
                    }
                    if (AcousticEchoCanceler.isAvailable()) {
                        echoCanceler = AcousticEchoCanceler.create(sessionId);
                        if (echoCanceler != null) echoCanceler.setEnabled(true);
                    }
                    micRecord.startRecording();
                } catch (Exception ignored) {
                    if (micRecord != null) {
                        try { micRecord.release(); } catch (Exception ignored2) {}
                        micRecord = null;
                    }
                    try { Thread.sleep(200); } catch (InterruptedException e) { break; }
                    continue;
                }
            }

            if (noiseSuppressor != null) {
                try {
                    noiseSuppressor.setEnabled(noiseCancelEnabled);
                } catch (Exception ignored) {
                }
            }

            int n = micRecord.read(buf, 0, FRAME_SAMPLES);
            if (n > 0) {
                micRing.write(buf, n);
            }
        }

        if (noiseSuppressor != null) { try { noiseSuppressor.release(); } catch (Exception ignored) {} }
        if (echoCanceler != null) { try { echoCanceler.release(); } catch (Exception ignored) {} }
        if (micRecord != null) {
            try { micRecord.stop(); } catch (Exception ignored) {}
            micRecord.release();
        }
    }

    private void drainVideoEncoder(long anchorNs) {
        MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
        while (true) {
            int outIndex;
            try {
                outIndex = videoCodec.dequeueOutputBuffer(info, 25_000);
            } catch (Exception e) {
                break;
            }
            if (outIndex == MediaCodec.INFO_TRY_AGAIN_LATER) {
                if (stopRequested) break;
            } else if (outIndex == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                synchronized (muxerLock) {
                    if (videoTrackIndex == -1) {
                        videoTrackIndex = mediaMuxer.addTrack(videoCodec.getOutputFormat());
                        maybeStartMuxerLocked();
                    }
                }
            } else if (outIndex >= 0) {
                ByteBuffer buf = videoCodec.getOutputBuffer(outIndex);
                if (buf != null && (info.flags & MediaCodec.BUFFER_FLAG_CODEC_CONFIG) == 0 && info.size > 0) {
                    if (waitForMuxerStart()) {
                        buf.position(info.offset);
                        buf.limit(info.offset + info.size);
                        info.presentationTimeUs = Math.max(0L, (System.nanoTime() - anchorNs) / 1000L);
                        synchronized (muxerLock) {
                            if (muxerStarted) {
                                mediaMuxer.writeSampleData(videoTrackIndex, buf, info);
                            }
                        }
                    }
                }
                videoCodec.releaseOutputBuffer(outIndex, false);
                if ((info.flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) {
                    break;
                }
            }
        }
    }

    private void mixAndEncodeAudio(long anchorNs, PcmRingBuffer remoteRing, PcmRingBuffer micRing) {
        short[] remotePcm = new short[FRAME_SAMPLES];
        short[] micPcm = new short[FRAME_SAMPLES];
        byte[] mixedBytes = new byte[FRAME_SAMPLES * 2];
        MediaCodec.BufferInfo outInfo = new MediaCodec.BufferInfo();

        long encodedSamples = 0L;
        final long frameDurationNs = (FRAME_SAMPLES * 1_000_000_000L) / SAMPLE_RATE;

        // First-order 85Hz high-pass filter state to cut fan/AC rumble without affecting voice
        double hpPrevIn = 0.0;
        double hpPrevOut = 0.0;
        final double hpAlpha = 0.9889;

        // Transparent soft-expander state (attenuates idle hum to 0.30, NEVER cuts voice to 0)
        double noiseFloor = 90.0;
        double expanderGain = 1.0;
        long holdUntilNs = 0L;

        while (!stopRequested) {
            long targetFrameNs = anchorNs + ((encodedSamples / FRAME_SAMPLES) + 1L) * frameDurationNs;
            long nowNs = System.nanoTime();
            long sleepNs = targetFrameNs - nowNs;
            if (sleepNs > 1_000_000L) {
                try {
                    Thread.sleep(sleepNs / 1_000_000L, (int) (sleepNs % 1_000_000L));
                } catch (InterruptedException e) {
                    break;
                }
            }

            int remoteCount = remoteRing.read(remotePcm, FRAME_SAMPLES);
            int micCount = micEnabled ? micRing.read(micPcm, FRAME_SAMPLES) : 0;

            double remoteSumSq = 0.0;
            for (int i = 0; i < FRAME_SAMPLES; i++) {
                double r = remotePcm[i];
                remoteSumSq += r * r;
            }
            double remoteRms = Math.sqrt(remoteSumSq / FRAME_SAMPLES);
            currentRemoteLevel = (float) Math.min(1.0, remoteRms / 8000.0);
            if (remoteCount > 0 && remoteRms > 18.0) {
                remoteAudioDetected = true;
            }

            double localRmsOut = 0.0;
            if (micEnabled && micCount > 0) {
                double micSumSq = 0.0;
                for (int i = 0; i < FRAME_SAMPLES; i++) {
                    double x = micPcm[i];
                    if (noiseCancelEnabled) {
                        double y = hpAlpha * (hpPrevOut + x - hpPrevIn);
                        hpPrevIn = x;
                        hpPrevOut = y;
                        micPcm[i] = (short) Math.max(-32768.0, Math.min(32767.0, y));
                        micSumSq += y * y;
                    } else {
                        micSumSq += x * x;
                    }
                }
                double micRms = Math.sqrt(micSumSq / FRAME_SAMPLES);

                if (noiseCancelEnabled) {
                    if (micRms < noiseFloor * 1.8) {
                        noiseFloor = noiseFloor * 0.95 + micRms * 0.05;
                        noiseFloor = Math.max(45.0, Math.min(450.0, noiseFloor));
                    }
                    double speechThreshold = Math.max(110.0, noiseFloor * 1.65 + 40.0);
                    if (micRms >= speechThreshold) {
                        holdUntilNs = System.nanoTime() + 450_000_000L;
                        expanderGain = Math.min(1.0, expanderGain + 0.35);
                    } else if (System.nanoTime() < holdUntilNs) {
                        expanderGain = 1.0;
                    } else {
                        expanderGain = Math.max(0.30, expanderGain - 0.05);
                    }
                } else {
                    expanderGain = 1.0;
                }
                localRmsOut = micRms * expanderGain;
            }
            currentLocalLevel = (float) Math.min(1.0, localRmsOut / 8000.0);

            for (int i = 0; i < FRAME_SAMPLES; i++) {
                int r = remotePcm[i];
                int m = (micEnabled && micCount > 0) ? (int) Math.round(micPcm[i] * expanderGain) : 0;
                int mixed = r + m;
                if (mixed > 32767) mixed = 32767;
                if (mixed < -32768) mixed = -32768;
                mixedBytes[i * 2] = (byte) (mixed & 0xff);
                mixedBytes[i * 2 + 1] = (byte) ((mixed >> 8) & 0xff);
            }

            try {
                int inIdx = audioCodec.dequeueInputBuffer(20_000);
                if (inIdx >= 0) {
                    ByteBuffer inBuf = audioCodec.getInputBuffer(inIdx);
                    if (inBuf != null) {
                        inBuf.clear();
                        int writeLen = Math.min(inBuf.remaining(), FRAME_SAMPLES * 2);
                        inBuf.put(mixedBytes, 0, writeLen);
                        long ptsUs = (encodedSamples * 1_000_000L) / SAMPLE_RATE;
                        encodedSamples += (writeLen / 2);
                        audioCodec.queueInputBuffer(inIdx, 0, writeLen, ptsUs, 0);
                    }
                }
                drainAudioEncoder(outInfo, false);
            } catch (Exception e) {
                break;
            }
        }

        try {
            int inIdx = audioCodec.dequeueInputBuffer(25_000);
            if (inIdx >= 0) {
                long ptsUs = (encodedSamples * 1_000_000L) / SAMPLE_RATE;
                audioCodec.queueInputBuffer(inIdx, 0, 0, ptsUs, MediaCodec.BUFFER_FLAG_END_OF_STREAM);
            }
            drainAudioEncoder(outInfo, true);
        } catch (Exception ignored) {
        }
    }

    private void drainAudioEncoder(MediaCodec.BufferInfo info, boolean waitForEos) {
        while (true) {
            int outIndex = audioCodec.dequeueOutputBuffer(info, waitForEos ? 15_000 : 0);
            if (outIndex == MediaCodec.INFO_TRY_AGAIN_LATER) {
                if (!waitForEos) break;
            } else if (outIndex == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                synchronized (muxerLock) {
                    if (audioTrackIndex == -1) {
                        audioTrackIndex = mediaMuxer.addTrack(audioCodec.getOutputFormat());
                        maybeStartMuxerLocked();
                    }
                }
            } else if (outIndex >= 0) {
                ByteBuffer buf = audioCodec.getOutputBuffer(outIndex);
                if (buf != null && (info.flags & MediaCodec.BUFFER_FLAG_CODEC_CONFIG) == 0 && info.size > 0) {
                    if (waitForMuxerStart()) {
                        buf.position(info.offset);
                        buf.limit(info.offset + info.size);
                        synchronized (muxerLock) {
                            if (muxerStarted) {
                                mediaMuxer.writeSampleData(audioTrackIndex, buf, info);
                            }
                        }
                    }
                }
                audioCodec.releaseOutputBuffer(outIndex, false);
                if ((info.flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) {
                    break;
                }
            }
        }
    }

    private void maybeStartMuxerLocked() {
        if (!muxerStarted && videoTrackIndex != -1 && audioTrackIndex != -1) {
            mediaMuxer.start();
            muxerStarted = true;
            muxerLock.notifyAll();
        }
    }

    private boolean waitForMuxerStart() {
        synchronized (muxerLock) {
            if (muxerStarted) return true;
            long deadline = System.currentTimeMillis() + 4000L;
            while (!muxerStarted && !stopRequested) {
                long rem = deadline - System.currentTimeMillis();
                if (rem <= 0L) break;
                try {
                    muxerLock.wait(rem);
                } catch (InterruptedException ignored) {
                    break;
                }
            }
            return muxerStarted;
        }
    }

    public static void requestStopFromPlugin(@Nullable CountDownLatch latch) {
        MeetingCaptureService svc = instance;
        if (svc == null) {
            if (latch != null) latch.countDown();
            return;
        }
        new Thread(() -> {
            svc.stopCaptureAndSelf();
            if (latch != null) latch.countDown();
        }, "CadenceStopThread").start();
    }

    private synchronized void stopCaptureAndSelf() {
        if (stopRequested) return;
        stopRequested = true;
        int durationSec = Math.max(1, getElapsedSec());
        String savedPath = activeOutputPath;

        if (legacyRecorder != null) {
            try { legacyRecorder.stop(); } catch (Exception ignored) {}
            try { legacyRecorder.reset(); } catch (Exception ignored) {}
            try { legacyRecorder.release(); } catch (Exception ignored) {}
            legacyRecorder = null;
        } else {
            if (videoCodec != null) {
                try { videoCodec.signalEndOfInputStream(); } catch (Exception ignored) {}
            }
            if (videoDrainThread != null) {
                try { videoDrainThread.join(2500); } catch (InterruptedException ignored) {}
            }
            if (audioMixerThread != null) {
                try { audioMixerThread.join(2500); } catch (InterruptedException ignored) {}
            }
            if (playbackReaderThread != null) {
                try { playbackReaderThread.join(1200); } catch (InterruptedException ignored) {}
            }
            if (micReaderThread != null) {
                try { micReaderThread.join(1200); } catch (InterruptedException ignored) {}
            }
        }

        cleanupResources();
        recordingActive = false;

        File outFile = new File(savedPath);
        long sizeBytes = outFile.exists() ? outFile.length() : 0L;
        lastCompletedPath = savedPath;
        lastCompletedSizeBytes = sizeBytes;
        lastCompletedDurationSec = durationSec;

        if (listener != null) {
            listener.onStopped(savedPath, sizeBytes, durationSec);
        }

        stopForeground(STOP_FOREGROUND_REMOVE);
        stopSelf();
    }

    private void cleanupResources() {
        if (virtualDisplay != null) {
            try { virtualDisplay.release(); } catch (Exception ignored) {}
            virtualDisplay = null;
        }
        if (mediaProjection != null) {
            try { mediaProjection.stop(); } catch (Exception ignored) {}
            mediaProjection = null;
        }
        if (videoCodec != null) {
            try { videoCodec.stop(); } catch (Exception ignored) {}
            try { videoCodec.release(); } catch (Exception ignored) {}
            videoCodec = null;
        }
        if (audioCodec != null) {
            try { audioCodec.stop(); } catch (Exception ignored) {}
            try { audioCodec.release(); } catch (Exception ignored) {}
            audioCodec = null;
        }
        if (inputSurface != null) {
            try { inputSurface.release(); } catch (Exception ignored) {}
            inputSurface = null;
        }
        synchronized (muxerLock) {
            if (mediaMuxer != null) {
                if (muxerStarted) {
                    try { mediaMuxer.stop(); } catch (Exception ignored) {}
                }
                try { mediaMuxer.release(); } catch (Exception ignored) {}
                mediaMuxer = null;
                muxerStarted = false;
            }
        }
        if (wakeLock != null && wakeLock.isHeld()) {
            try { wakeLock.release(); } catch (Exception ignored) {}
            wakeLock = null;
        }
    }

    private Notification buildNotification(String title) {
        Intent openIntent = new Intent(this, MainActivity.class);
        openIntent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent openPending = PendingIntent.getActivity(
                this,
                0,
                openIntent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        Intent stopIntent = new Intent(this, MeetingCaptureService.class);
        stopIntent.setAction(ACTION_STOP);
        PendingIntent stopPending = PendingIntent.getService(
                this,
                1,
                stopIntent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        return new NotificationCompat.Builder(this, CHANNEL_ID)
                .setContentTitle(title)
                .setContentText("Recording meeting screen & audio in background")
                .setSmallIcon(R.mipmap.ic_launcher)
                .setOngoing(true)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setContentIntent(openPending)
                .addAction(android.R.drawable.ic_media_pause, "Stop & Save", stopPending)
                .build();
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID,
                    "Cadence Meet Recorder",
                    NotificationManager.IMPORTANCE_LOW
            );
            channel.setDescription("Keeps screen & Google Meet recording alive in the background");
            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager != null) {
                manager.createNotificationChannel(channel);
            }
        }
    }

    @Override
    public void onDestroy() {
        instance = null;
        super.onDestroy();
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}

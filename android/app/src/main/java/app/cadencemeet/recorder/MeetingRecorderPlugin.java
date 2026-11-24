package app.cadencemeet.recorder;

import android.Manifest;
import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.media.projection.MediaProjectionManager;
import android.os.Build;

import androidx.activity.result.ActivityResult;
import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.File;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

@CapacitorPlugin(
        name = "MeetingRecorder",
        permissions = {
                @Permission(alias = "audio", strings = { Manifest.permission.RECORD_AUDIO }),
                @Permission(alias = "camera", strings = { Manifest.permission.CAMERA }),
                @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS })
        }
)
public class MeetingRecorderPlugin extends Plugin {
    private String pendingTitle = "Cadence Meet Recording";
    private int pendingWidth = 854;
    private int pendingHeight = 480;
    private int pendingFps = 15;
    private int pendingVideoBitrate = 700_000;
    private boolean pendingMicEnabled = false;
    private boolean pendingNoiseCancel = true;

    @PluginMethod
    public void requestCapturePermissions(PluginCall call) {
        boolean audioGranted = getPermissionState("audio") == PermissionState.GRANTED;
        boolean notifGranted = Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU
                || getPermissionState("notifications") == PermissionState.GRANTED;

        if (audioGranted && notifGranted) {
            JSObject ret = new JSObject();
            ret.put("audio", true);
            ret.put("camera", getPermissionState("camera") == PermissionState.GRANTED);
            ret.put("notifications", true);
            call.resolve(ret);
            return;
        }

        requestAllPermissions(call, "permissionsCallback");
    }

    @PermissionCallback
    private void permissionsCallback(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("audio", getPermissionState("audio") == PermissionState.GRANTED);
        ret.put("camera", getPermissionState("camera") == PermissionState.GRANTED);
        ret.put("notifications", Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU
                || getPermissionState("notifications") == PermissionState.GRANTED);
        call.resolve(ret);
    }

    @PluginMethod
    public void startNativeMeetingCapture(PluginCall call) {
        if (MeetingCaptureService.isRecording()) {
            call.reject("A native recording session is already active.");
            return;
        }
        if (getPermissionState("audio") != PermissionState.GRANTED) {
            requestPermissionForAlias("audio", call, "audioBeforeStartCallback");
            return;
        }
        launchScreenSelector(call);
    }

    @PermissionCallback
    private void audioBeforeStartCallback(PluginCall call) {
        if (getPermissionState("audio") != PermissionState.GRANTED) {
            call.reject("Microphone/Audio permission is required for Android meeting capture.");
            return;
        }
        launchScreenSelector(call);
    }

    private void launchScreenSelector(PluginCall call) {
        pendingTitle = call.getString("title", "Cadence Meet Recording");
        String qualityPreset = call.getString("qualityPreset", "long_meeting");
        pendingMicEnabled = Boolean.TRUE.equals(call.getBoolean("micEnabled", false));
        pendingNoiseCancel = Boolean.TRUE.equals(call.getBoolean("noiseCancelEnabled", true));

        if ("high".equals(qualityPreset)) {
            pendingWidth = 1280;
            pendingHeight = 720;
            pendingFps = 30;
            pendingVideoBitrate = 2_000_000;
        } else if ("balanced".equals(qualityPreset)) {
            pendingWidth = 1280;
            pendingHeight = 720;
            pendingFps = 24;
            pendingVideoBitrate = 1_000_000;
        } else {
            pendingWidth = 854;
            pendingHeight = 480;
            pendingFps = 15;
            pendingVideoBitrate = 600_000;
        }

        MediaProjectionManager mpm = (MediaProjectionManager) getContext().getSystemService(Context.MEDIA_PROJECTION_SERVICE);
        if (mpm == null) {
            call.reject("MediaProjection screen capture is unavailable on this device.");
            return;
        }
        Intent captureIntent = mpm.createScreenCaptureIntent();
        startActivityForResult(call, captureIntent, "handleScreenCaptureResult");
    }

    @ActivityCallback
    private void handleScreenCaptureResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null) {
            call.reject("Screen capture permission was canceled.");
            return;
        }

        File outDir = new File(getContext().getFilesDir(), "recordings");
        String fileName = "cadence_" + System.currentTimeMillis() + ".mp4";
        File outFile = new File(outDir, fileName);

        MeetingCaptureService.setListener(new MeetingCaptureService.CaptureListener() {
            @Override
            public void onStopped(String filePath, long fileSizeBytes, int durationSec) {
                JSObject payload = new JSObject();
                payload.put("filePath", filePath);
                payload.put("mimeType", "video/mp4");
                payload.put("fileSizeBytes", fileSizeBytes);
                payload.put("durationSec", durationSec);
                notifyListeners("captureStopped", payload);
            }

            @Override
            public void onError(String message) {
                JSObject payload = new JSObject();
                payload.put("message", message);
                notifyListeners("captureError", payload);
            }
        });

        Intent svcIntent = new Intent(getContext(), MeetingCaptureService.class);
        svcIntent.setAction(MeetingCaptureService.ACTION_START);
        svcIntent.putExtra(MeetingCaptureService.EXTRA_RESULT_CODE, result.getResultCode());
        svcIntent.putExtra(MeetingCaptureService.EXTRA_RESULT_DATA, result.getData());
        svcIntent.putExtra(MeetingCaptureService.EXTRA_OUTPUT_PATH, outFile.getAbsolutePath());
        svcIntent.putExtra(MeetingCaptureService.EXTRA_TITLE, pendingTitle);
        svcIntent.putExtra(MeetingCaptureService.EXTRA_WIDTH, pendingWidth);
        svcIntent.putExtra(MeetingCaptureService.EXTRA_HEIGHT, pendingHeight);
        svcIntent.putExtra(MeetingCaptureService.EXTRA_FPS, pendingFps);
        svcIntent.putExtra(MeetingCaptureService.EXTRA_VIDEO_BITRATE, pendingVideoBitrate);
        svcIntent.putExtra(MeetingCaptureService.EXTRA_MIC_ENABLED, pendingMicEnabled);
        svcIntent.putExtra(MeetingCaptureService.EXTRA_NOISE_CANCEL, pendingNoiseCancel);

        ContextCompat.startForegroundService(getContext(), svcIntent);

        JSObject ret = new JSObject();
        ret.put("started", true);
        ret.put("outputPath", outFile.getAbsolutePath());
        call.resolve(ret);
    }

    @PluginMethod
    public void setMicEnabled(PluginCall call) {
        boolean enabled = Boolean.TRUE.equals(call.getBoolean("enabled", false));
        MeetingCaptureService.setMicEnabled(enabled);
        JSObject ret = new JSObject();
        ret.put("micEnabled", enabled);
        call.resolve(ret);
    }

    @PluginMethod
    public void setNoiseCancelEnabled(PluginCall call) {
        boolean enabled = Boolean.TRUE.equals(call.getBoolean("enabled", true));
        MeetingCaptureService.setNoiseCancelEnabled(enabled);
        JSObject ret = new JSObject();
        ret.put("noiseCancelEnabled", enabled);
        call.resolve(ret);
    }

    @PluginMethod
    public void getCaptureStatus(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("isRecording", MeetingCaptureService.isRecording());
        ret.put("elapsedSec", MeetingCaptureService.getElapsedSec());
        ret.put("recordedBytes", MeetingCaptureService.getCurrentRecordedBytes());
        ret.put("micEnabled", MeetingCaptureService.isMicEnabled());
        ret.put("noiseCancelEnabled", MeetingCaptureService.isNoiseCancelEnabled());
        ret.put("lastCompletedPath", MeetingCaptureService.getLastCompletedPath());
        ret.put("lastCompletedMime", "video/mp4");
        ret.put("lastCompletedSizeBytes", MeetingCaptureService.getLastCompletedSizeBytes());
        ret.put("lastCompletedDurationSec", MeetingCaptureService.getLastCompletedDurationSec());
        call.resolve(ret);
    }

    @PluginMethod
    public void stopNativeMeetingCapture(PluginCall call) {
        if (!MeetingCaptureService.isRecording()) {
            String path = MeetingCaptureService.getLastCompletedPath();
            JSObject ret = new JSObject();
            ret.put("filePath", path);
            ret.put("mimeType", "video/mp4");
            ret.put("fileSizeBytes", MeetingCaptureService.getLastCompletedSizeBytes());
            ret.put("durationSec", MeetingCaptureService.getLastCompletedDurationSec());
            MeetingCaptureService.clearLastCompleted();
            call.resolve(ret);
            return;
        }

        new Thread(() -> {
            CountDownLatch latch = new CountDownLatch(1);
            MeetingCaptureService.requestStopFromPlugin(latch);
            try {
                latch.await(6, TimeUnit.SECONDS);
            } catch (InterruptedException ignored) {
            }
            JSObject ret = new JSObject();
            ret.put("filePath", MeetingCaptureService.getLastCompletedPath());
            ret.put("mimeType", "video/mp4");
            ret.put("fileSizeBytes", MeetingCaptureService.getLastCompletedSizeBytes());
            ret.put("durationSec", MeetingCaptureService.getLastCompletedDurationSec());
            MeetingCaptureService.clearLastCompleted();
            call.resolve(ret);
        }, "CadencePluginStopWait").start();
    }

    @PluginMethod
    public void deleteNativeFile(PluginCall call) {
        String filePath = call.getString("filePath", "");
        if (filePath != null && !filePath.isEmpty()) {
            File f = new File(filePath);
            if (f.exists()) {
                //noinspection ResultOfMethodCallIgnored
                f.delete();
            }
        }
        MeetingCaptureService.clearLastCompleted();
        call.resolve();
    }
}

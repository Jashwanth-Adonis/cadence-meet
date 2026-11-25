import React, { useEffect, useState } from 'react';
import { Download, Share, Smartphone, Terminal, WifiOff, X } from 'lucide-react';
import { usePWAInstall } from '../hooks/usePWAInstall';
import { useOnlineStatus } from '../hooks/useOnlineStatus';
import { checkAndroidApkAvailability, type ApkAvailability } from '../lib/apkRelease';
import { isNativeAndroid } from '../lib/nativeCapture';

export const AndroidApkDownloadButton: React.FC<{ compact?: boolean }> = ({ compact = false }) => {
  const [apk, setApk] = useState<ApkAvailability>({ available: false, url: null, source: 'none' });
  const [showBuildModal, setShowBuildModal] = useState(false);

  const runningInApk = isNativeAndroid();

  useEffect(() => {
    if (runningInApk) return;
    let active = true;
    void checkAndroidApkAvailability().then((res) => {
      if (active) setApk(res);
    });
    return () => {
      active = false;
    };
  }, [runningInApk]);

  if (runningInApk) return null;

  if (apk.available && apk.url) {
    return (
      <a
        href={apk.url}
        download="cadence-meet.apk"
        className={`inline-flex items-center gap-1.5 font-medium rounded-lg border border-emerald-500/40 bg-emerald-500/15 text-emerald-200 hover:bg-emerald-500/25 transition-colors whitespace-nowrap shrink-0 ${
          compact ? 'px-2.5 py-1.5 text-xs min-h-[36px]' : 'px-3.5 py-2 text-xs min-h-[40px]'
        }`}
      >
        <Smartphone className="w-3.5 h-3.5 text-emerald-400" />
        <span>Download APK</span>
      </a>
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setShowBuildModal(true)}
        className={`inline-flex items-center gap-1.5 font-medium rounded-lg border border-[#1E2E52] bg-[#0F1B35]/80 text-slate-200 hover:bg-[#16264A] transition-colors whitespace-nowrap shrink-0 ${
          compact ? 'px-2.5 py-1.5 text-xs min-h-[36px]' : 'px-3.5 py-2 text-xs min-h-[40px]'
        }`}
      >
        <Smartphone className="w-3.5 h-3.5 text-blue-400" />
        <span>Android APK</span>
      </button>

      {showBuildModal && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/75 backdrop-blur-xs p-4">
          <div className="w-full max-w-md rounded-2xl bg-[#091022] border border-[#162342] p-6 space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Smartphone className="w-4 h-4 text-blue-400" />
                <h3 className="font-display text-base font-semibold text-slate-100">
                  Cadence Meet Android APK
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setShowBuildModal(false)}
                className="p-1.5 text-slate-400 hover:text-slate-200 rounded-lg"
                aria-label="Close"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <p className="text-xs text-slate-300 leading-relaxed">
              The native Capacitor Android project (with <strong className="text-slate-100">Foreground Service</strong>, <strong className="text-slate-100">MediaProjection</strong> screen picker, and <strong className="text-slate-100">AudioPlaybackCapture</strong> for Google Meet) is ready in <span className="font-mono text-slate-200">/android</span>.
            </p>

            <div className="p-3 bg-[#04060B] border border-[#162342] rounded-xl space-y-2 text-xs">
              <div className="flex items-center gap-1.5 text-slate-200 font-medium">
                <Terminal className="w-3.5 h-3.5 text-blue-400" />
                <span>Compile &amp; Enable Direct APK Download</span>
              </div>
              <p className="text-slate-400 leading-relaxed">
                Run this once with Android SDK / Java 21 (or trigger the included GitHub Actions workflow) to generate and host <span className="font-mono text-slate-300">public/downloads/cadence-meet.apk</span>:
              </p>
              <pre className="p-2.5 bg-black/60 border border-[#162342] rounded-lg font-mono text-[11px] text-emerald-300 overflow-x-auto">
                npm run android:apk
              </pre>
              <p className="text-[11px] text-slate-400">
                Or set <span className="font-mono text-slate-300">VITE_ANDROID_APK_URL</span> to your GitHub Release <span className="font-mono">.apk</span> URL and this button turns into a 1-tap APK download.
              </p>
            </div>

            <button
              type="button"
              onClick={() => setShowBuildModal(false)}
              className="w-full py-2.5 rounded-xl bg-blue-600 text-white text-xs font-medium hover:bg-blue-500"
            >
              Close
            </button>
          </div>
        </div>
      )}
    </>
  );
};

export const PWAInstallButton: React.FC<{ compact?: boolean }> = ({ compact = false }) => {
  const { isInstallable, isInstalled, isIOS, install } = usePWAInstall();
  const [showIOSGuide, setShowIOSGuide] = useState(false);

  if (isInstalled || isNativeAndroid()) return null;

  if (isInstallable) {
    return (
      <button
        type="button"
        onClick={() => void install()}
        className={`inline-flex items-center gap-1.5 font-medium rounded-lg border border-[#1E2E52] bg-[#0F1B35]/80 text-slate-200 hover:bg-[#16264A] transition-colors whitespace-nowrap shrink-0 ${
          compact ? 'px-2.5 py-1.5 text-xs min-h-[36px]' : 'px-3 py-1.5 text-xs min-h-[36px]'
        }`}
      >
        <Download className="w-3.5 h-3.5 text-blue-400" />
        <span>Install App</span>
      </button>
    );
  }

  if (isIOS) {
    return (
      <>
        <button
          type="button"
          onClick={() => setShowIOSGuide(true)}
          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-lg border border-[#1E2E52] bg-[#0F1B35]/80 text-slate-200 hover:bg-[#16264A] transition-colors whitespace-nowrap shrink-0 min-h-[36px]"
        >
          <Share className="w-3.5 h-3.5 text-blue-400" />
          <span>Install</span>
        </button>

        {showIOSGuide && (
          <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/70 backdrop-blur-xs p-4">
            <div className="w-full max-w-sm rounded-2xl bg-[#091022] border border-[#162342] p-6 space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="font-display text-base font-semibold text-slate-100">
                  Install Cadence Meet
                </h3>
                <button
                  type="button"
                  onClick={() => setShowIOSGuide(false)}
                  className="p-1.5 text-slate-400 hover:text-slate-200 rounded-lg"
                  aria-label="Close"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
              <p className="text-sm text-slate-400 leading-relaxed">
                1. Tap the <strong className="text-slate-200">Share</strong> button in Safari&rsquo;s toolbar.
                <br />
                2. Scroll down and tap <strong className="text-slate-200">Add to Home Screen</strong>.
              </p>
              <button
                type="button"
                onClick={() => setShowIOSGuide(false)}
                className="w-full py-2.5 rounded-xl bg-blue-600 text-white text-xs font-medium hover:bg-blue-500"
              >
                Got it
              </button>
            </div>
          </div>
        )}
      </>
    );
  }

  return null;
};

export const OfflineIndicator: React.FC = () => {
  const isOnline = useOnlineStatus();
  if (isOnline) return null;

  return (
    <div className="fixed bottom-20 lg:bottom-4 left-4 z-50 flex items-center gap-2 rounded-lg bg-[#091022] text-slate-100 px-3 py-2 text-xs font-medium shadow-md border border-[#1E2E52]">
      <WifiOff className="w-3.5 h-3.5 text-amber-400 shrink-0" />
      <span>Offline mode — Local encrypted vault active</span>
    </div>
  );
};

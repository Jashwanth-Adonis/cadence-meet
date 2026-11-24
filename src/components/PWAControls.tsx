import React, { useState } from 'react';
import { Download, Share, WifiOff, X } from 'lucide-react';
import { usePWAInstall } from '../hooks/usePWAInstall';
import { useOnlineStatus } from '../hooks/useOnlineStatus';

export const PWAInstallButton: React.FC<{ compact?: boolean }> = ({ compact = false }) => {
  const { isInstallable, isInstalled, isIOS, install } = usePWAInstall();
  const [showIOSGuide, setShowIOSGuide] = useState(false);

  if (isInstalled) return null;

  if (isInstallable) {
    return (
      <button
        type="button"
        onClick={() => void install()}
        className={`inline-flex items-center gap-1.5 font-medium rounded-lg border border-slate-700 bg-slate-800/80 text-slate-200 hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0 ${
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
          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-lg border border-slate-700 bg-slate-800/80 text-slate-200 hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0 min-h-[36px]"
        >
          <Share className="w-3.5 h-3.5 text-blue-400" />
          <span>Install</span>
        </button>

        {showIOSGuide && (
          <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/70 backdrop-blur-xs p-4">
            <div className="w-full max-w-sm rounded-2xl bg-[#0F1623] border border-slate-800 p-6 space-y-4">
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
    <div className="fixed bottom-20 lg:bottom-4 left-4 z-50 flex items-center gap-2 rounded-lg bg-[#0F1623] text-slate-100 px-3 py-2 text-xs font-medium shadow-md border border-slate-700">
      <WifiOff className="w-3.5 h-3.5 text-amber-400 shrink-0" />
      <span>Offline mode — Local encrypted vault active</span>
    </div>
  );
};

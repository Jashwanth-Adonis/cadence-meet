export interface ApkAvailability {
  available: boolean;
  url: string | null;
  source: 'env' | 'local' | 'none';
}

const LOCAL_APK_PATH = '/downloads/cadence-meet.apk';

export async function checkAndroidApkAvailability(): Promise<ApkAvailability> {
  const envUrl =
    typeof import.meta !== 'undefined' &&
    import.meta.env &&
    typeof import.meta.env.VITE_ANDROID_APK_URL === 'string'
      ? import.meta.env.VITE_ANDROID_APK_URL.trim()
      : '';

  if (envUrl) {
    return {
      available: true,
      url: envUrl,
      source: 'env',
    };
  }

  try {
    const res = await fetch(LOCAL_APK_PATH, { method: 'HEAD', cache: 'no-store' });
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    // Static SPA hosts often serve index.html with 200 OK for missing paths; reject HTML responses
    if (res.ok && !ct.includes('text/html')) {
      return {
        available: true,
        url: LOCAL_APK_PATH,
        source: 'local',
      };
    }
  } catch {
    // Ignore network failures offline
  }

  return {
    available: false,
    url: null,
    source: 'none',
  };
}

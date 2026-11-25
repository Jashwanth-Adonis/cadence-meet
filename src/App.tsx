import { useEffect, useState } from 'react';
import {
  Video,
  FolderArchive,
  KanbanSquare,
  ShieldCheck,
  Lock,
  Plus,
} from 'lucide-react';
import {
  exportSessionKey,
  importSessionKey,
  verifyVaultPassphrase,
} from './lib/crypto';
import { fetchLocalProfile, LOCAL_UID } from './lib/localVaultDb';
import { requestPersistentStorage } from './lib/vaultStorage';
import {
  subscribeFolders,
  subscribeMeetings,
  subscribeTasks,
} from './lib/workspaceStore';
import { ErrorBoundary } from './components/ErrorBoundary';
import { VaultGate } from './components/VaultGate';
import { CaptureBotStudio } from './components/CaptureBotStudio';
import { MeetingLogsView } from './components/MeetingLogsView';
import { ProjectDashboardView } from './components/ProjectDashboardView';
import { VaultSecurityView } from './components/VaultSecurityView';
import { AndroidApkDownloadButton, OfflineIndicator, PWAInstallButton } from './components/PWAControls';
import type {
  MeetingFolder,
  MeetingRecord,
  ProjectTask,
  UserVaultProfile,
} from './types';

type ActiveRoute = 'capture' | 'logs' | 'board' | 'vault';

const SESSION_KEY_STORAGE = 'cadence_session_vault_jwk';
const SESSION_UID_STORAGE = 'cadence_session_vault_uid';
const SESSION_ROUTE_STORAGE = 'cadence_active_route';
const SESSION_MEETING_STORAGE = 'cadence_selected_meeting_id';

function readInitialRoute(): ActiveRoute {
  try {
    const saved = sessionStorage.getItem(SESSION_ROUTE_STORAGE);
    if (saved === 'capture' || saved === 'logs' || saved === 'board' || saved === 'vault') {
      return saved;
    }
  } catch {
    // Ignore
  }
  return 'capture';
}

function readInitialMeetingId(): string | null {
  try {
    return sessionStorage.getItem(SESSION_MEETING_STORAGE) || null;
  } catch {
    return null;
  }
}

function WorkspaceApp() {
  const [profile, setProfile] = useState<UserVaultProfile | null>(null);
  const [restoring, setRestoring] = useState(true);
  const [masterKey, setMasterKey] = useState<CryptoKey | null>(null);

  const [activeRoute, setActiveRoute] = useState<ActiveRoute>(() => readInitialRoute());

  const [folders, setFolders] = useState<MeetingFolder[]>([]);
  const [meetings, setMeetings] = useState<MeetingRecord[]>([]);
  const [tasks, setTasks] = useState<ProjectTask[]>([]);

  const [selectedMeetingId, setSelectedMeetingId] = useState<string | null>(() =>
    readInitialMeetingId()
  );
  const [seekRequestSec, setSeekRequestSec] = useState<number | null>(null);

  useEffect(() => {
    void requestPersistentStorage();
    void (async () => {
      try {
        const cachedJwk = sessionStorage.getItem(SESSION_KEY_STORAGE);
        const cachedUid = sessionStorage.getItem(SESSION_UID_STORAGE) || LOCAL_UID;
        if (cachedJwk) {
          const loadedProfile = await fetchLocalProfile(cachedUid);
          if (loadedProfile) {
            const restoredKey = await importSessionKey(cachedJwk);
            const valid = await verifyVaultPassphrase(restoredKey, loadedProfile.vaultVerifier);
            if (valid) {
              setProfile(loadedProfile);
              setMasterKey(restoredKey);
            } else {
              sessionStorage.removeItem(SESSION_KEY_STORAGE);
              sessionStorage.removeItem(SESSION_UID_STORAGE);
            }
          }
        }
      } catch {
        sessionStorage.removeItem(SESSION_KEY_STORAGE);
        sessionStorage.removeItem(SESSION_UID_STORAGE);
      } finally {
        setRestoring(false);
      }
    })();
  }, []);

  useEffect(() => {
    try {
      sessionStorage.setItem(SESSION_ROUTE_STORAGE, activeRoute);
    } catch {
      // Ignore
    }
  }, [activeRoute]);

  useEffect(() => {
    try {
      if (selectedMeetingId) {
        sessionStorage.setItem(SESSION_MEETING_STORAGE, selectedMeetingId);
      } else {
        sessionStorage.removeItem(SESSION_MEETING_STORAGE);
      }
    } catch {
      // Ignore
    }
  }, [selectedMeetingId]);

  const activeVaultId = profile?.uid ?? LOCAL_UID;

  useEffect(() => {
    if (!masterKey || !profile) return;
    const unsubFolders = subscribeFolders(profile.uid, setFolders);
    const unsubMeetings = subscribeMeetings(profile.uid, masterKey, setMeetings);
    const unsubTasks = subscribeTasks(profile.uid, masterKey, setTasks);
    return () => {
      unsubFolders();
      unsubMeetings();
      unsubTasks();
    };
  }, [masterKey, profile]);

  const handleOpenMeeting = (meetingId: string) => {
    setSelectedMeetingId(meetingId);
    setActiveRoute('logs');
  };

  const handleJumpToMeetingTimestamp = (meetingId: string, sec: number) => {
    setSelectedMeetingId(meetingId);
    setSeekRequestSec(sec);
    setActiveRoute('logs');
  };

  const handleLockVault = () => {
    try {
      sessionStorage.removeItem(SESSION_KEY_STORAGE);
      sessionStorage.removeItem(SESSION_UID_STORAGE);
    } catch {
      // Ignore
    }
    setMasterKey(null);
    setProfile(null);
    setFolders([]);
    setMeetings([]);
    setTasks([]);
  };

  if (restoring) {
    return (
      <div className="min-h-screen bg-[#04060B] flex items-center justify-center text-sm text-slate-400">
        Restoring encrypted workspace...
      </div>
    );
  }

  if (!masterKey || !profile) {
    return (
      <>
        <VaultGate
          onUnlocked={(key, unlockedProfile) => {
            setProfile(unlockedProfile);
            setMasterKey(key);
            void exportSessionKey(key)
              .then((jwk) => {
                sessionStorage.setItem(SESSION_KEY_STORAGE, jwk);
                sessionStorage.setItem(SESSION_UID_STORAGE, unlockedProfile.uid);
              })
              .catch(() => {});
          }}
          onVaultReset={() => {
            try {
              sessionStorage.removeItem(SESSION_KEY_STORAGE);
              sessionStorage.removeItem(SESSION_UID_STORAGE);
              sessionStorage.removeItem(SESSION_MEETING_STORAGE);
            } catch {
              // Ignore
            }
            setProfile(null);
            setMasterKey(null);
            setFolders([]);
            setMeetings([]);
            setTasks([]);
          }}
        />
        <OfflineIndicator />
      </>
    );
  }

  const openTaskCount = tasks.filter((t) => t.status !== 'done').length;
  const activeMeeting = selectedMeetingId
    ? meetings.find((m) => m.id === selectedMeetingId)
    : null;

  const breadcrumbLabel =
    activeRoute === 'capture'
      ? 'Recorder'
      : activeRoute === 'logs'
      ? activeMeeting
        ? `Meeting Logs / ${activeMeeting.payload.title}`
        : 'Meeting Logs'
      : activeRoute === 'board'
      ? 'Project Board'
      : 'Vault & Storage';

  const navItems: Array<{
    id: ActiveRoute;
    label: string;
    mobileLabel: string;
    icon: typeof Video;
    count?: number;
  }> = [
    { id: 'capture', label: 'Recorder', mobileLabel: 'Record', icon: Video },
    { id: 'logs', label: 'Meeting Logs', mobileLabel: 'Logs', icon: FolderArchive, count: meetings.length },
    { id: 'board', label: 'Project Board', mobileLabel: 'Tasks', icon: KanbanSquare, count: openTaskCount },
    { id: 'vault', label: 'Vault & Storage', mobileLabel: 'Vault', icon: ShieldCheck },
  ];

  return (
    <div className="min-h-screen bg-[#04060B] text-slate-100 flex">
      {/* Desktop Sidebar */}
      <aside className="hidden lg:flex lg:flex-col w-60 bg-[#060B16] border-r border-[#162342]/90 shrink-0 sticky top-0 h-screen">
        <div className="h-14 px-5 flex items-center gap-2.5 border-b border-[#162342]/90">
          <img src="/icon.svg" alt="" className="w-6 h-6 rounded-md shrink-0" />
          <span className="font-display text-base font-bold tracking-tight text-slate-100 whitespace-nowrap shrink-0">
            Cadence Meet
          </span>
        </div>

        <nav className="flex-1 p-3 space-y-1">
          {navItems.map((item) => {
            const Icon = item.icon;
            const active = activeRoute === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => {
                  setActiveRoute(item.id);
                  if (item.id !== 'logs') setSelectedMeetingId(null);
                }}
                className={`w-full flex items-center justify-between px-3 py-2 text-xs font-medium rounded-lg transition-colors whitespace-nowrap shrink-0 ${
                  active
                    ? 'bg-blue-600 text-white'
                    : 'text-slate-400 hover:text-slate-100 hover:bg-[#0F1B35]/70'
                }`}
              >
                <span className="flex items-center gap-2.5">
                  <Icon className="w-4 h-4 shrink-0" />
                  <span>{item.label}</span>
                </span>
                {item.count !== undefined && (
                  <span
                    className={`font-mono tabular-nums text-[11px] ${
                      active ? 'text-blue-100' : 'text-slate-500'
                    }`}
                  >
                    {item.count}
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        <div className="p-3 border-t border-[#162342]/90 space-y-2.5">
          <div className="px-2 py-1">
            <div className="text-xs font-medium text-slate-200 truncate">Local Passphrase Vault</div>
            <div className="text-[11px] font-mono text-slate-500 truncate">
              {profile.uid.slice(0, 14)}
            </div>
          </div>
          <button
            type="button"
            onClick={handleLockVault}
            className="w-full inline-flex items-center justify-center gap-1.5 px-2.5 py-2 text-xs font-medium text-slate-200 bg-[#0F1B35]/80 border border-[#1E2E52]/80 rounded-lg hover:bg-[#0F1B35] transition-colors whitespace-nowrap shrink-0"
          >
            <Lock className="w-3.5 h-3.5" />
            <span>Lock Vault</span>
          </button>
        </div>
      </aside>

      {/* Main Content Shell */}
      <div className="flex-1 min-w-0 flex flex-col">
        <header className="h-14 bg-[#060B16]/95 backdrop-blur-md border-b border-[#162342]/90 px-4 sm:px-8 flex items-center justify-between gap-4 sticky top-0 z-30">
          <div className="flex items-center gap-2.5 min-w-0">
            <img src="/icon.svg" alt="" className="w-6 h-6 rounded-md lg:hidden shrink-0" />
            <span className="font-display text-sm font-bold text-slate-100 lg:hidden whitespace-nowrap shrink-0">
              Cadence Meet
            </span>
            <div className="hidden lg:block text-sm text-slate-500 truncate">
              <span>Vault</span>
              <span className="mx-2 text-slate-700">/</span>
              <span className="font-medium text-slate-100">{breadcrumbLabel}</span>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <AndroidApkDownloadButton compact />
            <PWAInstallButton compact />
            <button
              type="button"
              onClick={handleLockVault}
              className="lg:hidden inline-flex items-center justify-center p-2 text-slate-300 hover:text-white bg-[#0F1B35] border border-[#1E2E52] rounded-lg min-h-[36px] min-w-[36px]"
              aria-label="Lock Vault"
            >
              <Lock className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={() => {
                setActiveRoute('capture');
                setSelectedMeetingId(null);
              }}
              className="hidden sm:inline-flex items-center gap-1.5 px-3.5 py-1.5 bg-blue-600 text-white text-xs font-medium rounded-lg hover:bg-blue-500 transition-colors whitespace-nowrap shrink-0 min-h-[36px]"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>New Recording</span>
            </button>
          </div>
        </header>

        <main className="flex-1 p-4 sm:p-8 pb-24 lg:pb-8 max-w-[1280px] w-full mx-auto">
          {activeRoute === 'capture' && (
            <CaptureBotStudio
              uid={activeVaultId}
              masterKey={masterKey}
              folders={folders}
              onOpenMeeting={handleOpenMeeting}
            />
          )}

          {activeRoute === 'logs' && (
            <MeetingLogsView
              uid={activeVaultId}
              masterKey={masterKey}
              meetings={meetings}
              folders={folders}
              tasks={tasks}
              selectedMeetingId={selectedMeetingId}
              seekRequestSec={seekRequestSec}
              onSelectMeeting={setSelectedMeetingId}
              onClearSeek={() => setSeekRequestSec(null)}
              onGoToCapture={() => setActiveRoute('capture')}
            />
          )}

          {activeRoute === 'board' && (
            <ProjectDashboardView
              uid={activeVaultId}
              masterKey={masterKey}
              tasks={tasks}
              meetings={meetings}
              folders={folders}
              onJumpToMeetingTimestamp={handleJumpToMeetingTimestamp}
            />
          )}

          {activeRoute === 'vault' && (
            <VaultSecurityView
              vaultId={activeVaultId}
              masterKey={masterKey}
              meetings={meetings}
              onLockVault={handleLockVault}
            />
          )}
        </main>
      </div>

      {/* Mobile Native Bottom Tab Bar */}
      <nav
        aria-label="Mobile navigation"
        className="fixed bottom-0 left-0 right-0 z-40 lg:hidden bg-[#060B16]/95 backdrop-blur-md border-t border-[#162342] pb-[env(safe-area-inset-bottom)]"
      >
        <div className="grid grid-cols-4 h-16">
          {navItems.map((item) => {
            const Icon = item.icon;
            const active = activeRoute === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => {
                  setActiveRoute(item.id);
                  if (item.id !== 'logs') setSelectedMeetingId(null);
                }}
                className={`flex flex-col items-center justify-center gap-0.5 min-h-[44px] transition-colors ${
                  active ? 'text-blue-400' : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <div className="relative">
                  <Icon className="w-5 h-5" />
                  {item.count !== undefined && item.count > 0 && (
                    <span className="absolute -top-1 -right-2.5 text-[9px] font-mono font-semibold text-slate-300">
                      {item.count}
                    </span>
                  )}
                </div>
                <span className="text-[11px] font-medium tracking-tight">{item.mobileLabel}</span>
              </button>
            );
          })}
        </div>
      </nav>

      <OfflineIndicator />
    </div>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <WorkspaceApp />
    </ErrorBoundary>
  );
}

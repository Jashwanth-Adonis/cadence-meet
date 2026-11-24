import { useEffect, useState } from 'react';
import {
  Video,
  FolderArchive,
  KanbanSquare,
  ShieldCheck,
  Lock,
  Menu,
  X,
  Plus,
} from 'lucide-react';
import {
  exportSessionKey,
  importSessionKey,
  verifyVaultPassphrase,
} from './lib/crypto';
import { fetchLocalProfile } from './lib/localVaultDb';
import { requestPersistentStorage } from './lib/vaultStorage';
import {
  LOCAL_UID,
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
import type {
  MeetingFolder,
  MeetingRecord,
  ProjectTask,
  UserVaultProfile,
} from './types';

type ActiveRoute = 'capture' | 'logs' | 'board' | 'vault';

const SESSION_KEY_STORAGE = 'cadence_session_vault_jwk';
const SESSION_ROUTE_STORAGE = 'cadence_active_route';
const SESSION_MEETING_STORAGE = 'cadence_selected_meeting_id';

function readInitialRoute(): ActiveRoute {
  try {
    const saved = sessionStorage.getItem(SESSION_ROUTE_STORAGE);
    if (saved === 'capture' || saved === 'logs' || saved === 'board' || saved === 'vault') {
      return saved;
    }
  } catch {
    // Ignore storage errors
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
  const [profileLoading, setProfileLoading] = useState(true);
  const [masterKey, setMasterKey] = useState<CryptoKey | null>(null);

  const [activeRoute, setActiveRoute] = useState<ActiveRoute>(() => readInitialRoute());
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const [folders, setFolders] = useState<MeetingFolder[]>([]);
  const [meetings, setMeetings] = useState<MeetingRecord[]>([]);
  const [tasks, setTasks] = useState<ProjectTask[]>([]);

  const [selectedMeetingId, setSelectedMeetingId] = useState<string | null>(() =>
    readInitialMeetingId()
  );
  const [seekRequestSec, setSeekRequestSec] = useState<number | null>(null);

  useEffect(() => {
    void requestPersistentStorage();
    setProfileLoading(true);
    void (async () => {
      try {
        const loadedProfile = await fetchLocalProfile();
        setProfile(loadedProfile);
        if (loadedProfile) {
          const cachedJwk = sessionStorage.getItem(SESSION_KEY_STORAGE);
          if (cachedJwk) {
            try {
              const restoredKey = await importSessionKey(cachedJwk);
              const valid = await verifyVaultPassphrase(restoredKey, loadedProfile.vaultVerifier);
              if (valid) {
                setMasterKey(restoredKey);
              } else {
                sessionStorage.removeItem(SESSION_KEY_STORAGE);
              }
            } catch {
              sessionStorage.removeItem(SESSION_KEY_STORAGE);
            }
          }
        }
      } finally {
        setProfileLoading(false);
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

  useEffect(() => {
    if (!masterKey) return;
    const unsubFolders = subscribeFolders(LOCAL_UID, setFolders);
    const unsubMeetings = subscribeMeetings(LOCAL_UID, masterKey, setMeetings);
    const unsubTasks = subscribeTasks(LOCAL_UID, masterKey, setTasks);
    return () => {
      unsubFolders();
      unsubMeetings();
      unsubTasks();
    };
  }, [masterKey]);

  const handleOpenMeeting = (meetingId: string) => {
    setSelectedMeetingId(meetingId);
    setActiveRoute('logs');
    setMobileMenuOpen(false);
  };

  const handleJumpToMeetingTimestamp = (meetingId: string, sec: number) => {
    setSelectedMeetingId(meetingId);
    setSeekRequestSec(sec);
    setActiveRoute('logs');
    setMobileMenuOpen(false);
  };

  const handleLockVault = () => {
    try {
      sessionStorage.removeItem(SESSION_KEY_STORAGE);
    } catch {
      // Ignore
    }
    setMasterKey(null);
    setFolders([]);
    setMeetings([]);
    setTasks([]);
  };

  if (!masterKey) {
    return (
      <VaultGate
        profile={profile}
        profileLoading={profileLoading}
        onUnlocked={(key, unlockedProfile) => {
          setProfile(unlockedProfile);
          setMasterKey(key);
          void exportSessionKey(key)
            .then((jwk) => sessionStorage.setItem(SESSION_KEY_STORAGE, jwk))
            .catch(() => {});
        }}
        onVaultReset={() => {
          try {
            sessionStorage.removeItem(SESSION_KEY_STORAGE);
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
      : 'Vault Security';

  const navItems: Array<{
    id: ActiveRoute;
    label: string;
    icon: typeof Video;
    count?: number;
  }> = [
    { id: 'capture', label: 'Recorder', icon: Video },
    { id: 'logs', label: 'Meeting Logs', icon: FolderArchive, count: meetings.length },
    { id: 'board', label: 'Project Board', icon: KanbanSquare, count: openTaskCount },
    { id: 'vault', label: 'Vault Security', icon: ShieldCheck },
  ];

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 flex">
      {/* Desktop Sidebar */}
      <aside className="hidden lg:flex lg:flex-col w-60 bg-white border-r border-slate-200 shrink-0 sticky top-0 h-screen">
        <div className="h-14 px-5 flex items-center border-b border-slate-200">
          <span className="font-display text-base font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0">
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
                    ? 'bg-slate-900 text-white'
                    : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'
                }`}
              >
                <span className="flex items-center gap-2.5">
                  <Icon className="w-4 h-4 shrink-0" />
                  <span>{item.label}</span>
                </span>
                {item.count !== undefined && (
                  <span
                    className={`font-mono tabular-nums text-[11px] ${
                      active ? 'text-slate-300' : 'text-slate-400'
                    }`}
                  >
                    {item.count}
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        <div className="p-3 border-t border-slate-200 space-y-2">
          <div className="px-2 py-1.5">
            <div className="text-xs font-medium text-slate-900 truncate">Local Device Vault</div>
            <div className="text-[11px] text-slate-500 truncate">Cached &amp; encrypted locally</div>
          </div>
          <button
            type="button"
            onClick={handleLockVault}
            className="w-full inline-flex items-center justify-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-slate-700 bg-slate-100 rounded-md hover:bg-slate-200/70 transition-colors whitespace-nowrap shrink-0"
          >
            <Lock className="w-3.5 h-3.5" />
            <span>Lock Vault</span>
          </button>
        </div>
      </aside>

      {/* Mobile Navigation Drawer */}
      {mobileMenuOpen && (
        <div className="fixed inset-0 z-50 lg:hidden flex">
          <div
            className="fixed inset-0 bg-slate-900/40"
            onClick={() => setMobileMenuOpen(false)}
          />
          <div className="relative w-64 max-w-[80vw] bg-white h-full border-r border-slate-200 flex flex-col z-10">
            <div className="h-14 px-4 flex items-center justify-between border-b border-slate-200">
              <span className="font-display text-base font-bold text-slate-900">
                Cadence Meet
              </span>
              <button
                type="button"
                onClick={() => setMobileMenuOpen(false)}
                className="p-1.5 text-slate-500"
                aria-label="Close navigation"
              >
                <X className="w-4 h-4" />
              </button>
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
                      setMobileMenuOpen(false);
                    }}
                    className={`w-full flex items-center justify-between px-3 py-2.5 text-sm font-medium rounded-lg ${
                      active ? 'bg-slate-900 text-white' : 'text-slate-700 hover:bg-slate-100'
                    }`}
                  >
                    <span className="flex items-center gap-2.5">
                      <Icon className="w-4 h-4" />
                      <span>{item.label}</span>
                    </span>
                    {item.count !== undefined && (
                      <span className="font-mono tabular-nums text-xs opacity-75">
                        {item.count}
                      </span>
                    )}
                  </button>
                );
              })}
            </nav>
            <div className="p-3 border-t border-slate-200">
              <button
                type="button"
                onClick={handleLockVault}
                className="w-full py-2 text-xs font-medium bg-slate-100 text-slate-800 rounded-md inline-flex items-center justify-center gap-1.5"
              >
                <Lock className="w-3.5 h-3.5" />
                <span>Lock Vault</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Main Content Shell */}
      <div className="flex-1 min-w-0 flex flex-col">
        <header className="h-14 bg-white border-b border-slate-200 px-4 sm:px-8 flex items-center justify-between gap-8 sticky top-0 z-30">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => setMobileMenuOpen(true)}
              className="lg:hidden p-1.5 text-slate-600 hover:text-slate-900 rounded-md"
              aria-label="Open menu"
            >
              <Menu className="w-5 h-5" />
            </button>
            <div className="text-xs sm:text-sm text-slate-500 truncate">
              <span>Local Workspace</span>
              <span className="mx-2 text-slate-300">/</span>
              <span className="font-medium text-slate-900">{breadcrumbLabel}</span>
            </div>
          </div>

          <div className="shrink-0">
            <button
              type="button"
              onClick={() => {
                setActiveRoute('capture');
                setSelectedMeetingId(null);
              }}
              className="inline-flex items-center gap-1.5 px-3.5 py-1.5 bg-blue-600 text-white text-xs font-medium rounded-lg hover:bg-blue-700 transition-colors whitespace-nowrap shrink-0"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>New Recording</span>
            </button>
          </div>
        </header>

        <main className="flex-1 p-4 sm:p-8 max-w-[1280px] w-full mx-auto">
          {activeRoute === 'capture' && (
            <CaptureBotStudio
              uid={LOCAL_UID}
              masterKey={masterKey}
              folders={folders}
              onOpenMeeting={handleOpenMeeting}
            />
          )}

          {activeRoute === 'logs' && (
            <MeetingLogsView
              uid={LOCAL_UID}
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
              uid={LOCAL_UID}
              masterKey={masterKey}
              tasks={tasks}
              meetings={meetings}
              folders={folders}
              onJumpToMeetingTimestamp={handleJumpToMeetingTimestamp}
            />
          )}

          {activeRoute === 'vault' && (
            <VaultSecurityView
              userEmail="this local device"
              masterKey={masterKey}
              meetings={meetings}
              onLockVault={handleLockVault}
            />
          )}
        </main>
      </div>
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

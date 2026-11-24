import React, { useEffect, useMemo, useState } from 'react';
import { Download, HardDrive, Lock, ShieldCheck, Trash2 } from 'lucide-react';
import {
  deleteEncryptedVideo,
  exportEncryptedArchiveBlob,
  listLocalVaultEntries,
  loadDecryptedVideoBlob,
  triggerBlobDownload,
} from '../lib/vaultStorage';
import { formatBytes, formatDateTime } from '../lib/formatters';
import type { LocalVaultEntryMeta, MeetingRecord } from '../types';

interface VaultSecurityViewProps {
  userEmail: string;
  masterKey: CryptoKey;
  meetings: MeetingRecord[];
  onLockVault: () => void;
}

export const VaultSecurityView: React.FC<VaultSecurityViewProps> = ({
  userEmail,
  masterKey,
  meetings,
  onLockVault,
}) => {
  const [entries, setEntries] = useState<LocalVaultEntryMeta[]>([]);
  const [loading, setLoading] = useState(true);

  const refreshEntries = async () => {
    setLoading(true);
    try {
      const list = await listLocalVaultEntries();
      setEntries(list.sort((a, b) => b.createdAtMs - a.createdAtMs));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refreshEntries();
  }, []);

  const meetingMap = useMemo(() => {
    const map = new Map<string, MeetingRecord>();
    meetings.forEach((m) => map.set(m.id, m));
    return map;
  }, [meetings]);

  const totalLocalBytes = useMemo(
    () => entries.reduce((sum, e) => sum + e.fileSizeBytes, 0),
    [entries]
  );

  const handleDownloadDecrypted = async (entry: LocalVaultEntryMeta) => {
    const blob = await loadDecryptedVideoBlob(entry.meetingId, masterKey);
    if (!blob) return;
    const meeting = meetingMap.get(entry.meetingId);
    const title = meeting?.payload.title ?? entry.meetingId;
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    const ext = entry.mimeType.includes('mp4') ? 'mp4' : 'webm';
    triggerBlobDownload(blob, `${slug || 'meeting-recording'}.${ext}`);
  };

  const handleExportEncrypted = async (entry: LocalVaultEntryMeta) => {
    const blob = await exportEncryptedArchiveBlob(entry.meetingId);
    if (!blob) return;
    triggerBlobDownload(blob, `${entry.meetingId}.cadence.enc`);
  };

  const handleRemoveLocalCopy = async (meetingId: string) => {
    await deleteEncryptedVideo(meetingId);
    await refreshEntries();
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-semibold text-slate-900 tracking-tight">
            Vault Security & Local Storage
          </h1>
          <p className="text-sm text-slate-600 mt-1">
            Zero-knowledge client-side encryption status and local MP4 device storage management.
          </p>
        </div>

        <button
          type="button"
          onClick={onLockVault}
          className="inline-flex items-center gap-1.5 px-4 py-2 bg-slate-900 text-white text-xs font-medium rounded-lg hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0 self-start"
        >
          <Lock className="w-3.5 h-3.5" />
          <span>Lock Vault Session</span>
        </button>
      </div>

      {/* Cryptographic Parameters Strip */}
      <div className="grid grid-cols-1 md:grid-cols-3 bg-white border border-slate-200 rounded-xl divide-y md:divide-y-0 md:divide-x divide-slate-200">
        <div className="p-5">
          <div className="flex items-center gap-2 text-xs font-medium text-slate-500">
            <ShieldCheck className="w-4 h-4 text-blue-600" />
            <span>Cipher Suite</span>
          </div>
          <div className="mt-1.5 font-mono text-sm font-semibold text-slate-900">
            AES-256-GCM (96-bit random IV)
          </div>
          <p className="mt-1 text-xs text-slate-500">
            Applied to every meeting note, task, and locally stored video recording before persistence.
          </p>
        </div>
        <div className="p-5">
          <div className="flex items-center gap-2 text-xs font-medium text-slate-500">
            <Lock className="w-4 h-4 text-slate-600" />
            <span>Key Derivation</span>
          </div>
          <div className="mt-1.5 font-mono text-sm font-semibold text-slate-900">
            PBKDF2-HMAC-SHA256 · 310k
          </div>
          <p className="mt-1 text-xs text-slate-500">
            Non-extractable Web Crypto key held strictly in memory for {userEmail}.
          </p>
        </div>
        <div className="p-5">
          <div className="flex items-center gap-2 text-xs font-medium text-slate-500">
            <HardDrive className="w-4 h-4 text-slate-600" />
            <span>Local Encrypted Vault</span>
          </div>
          <div className="mt-1.5 font-mono tabular-nums text-sm font-semibold text-slate-900">
            {entries.length} recordings · {formatBytes(totalLocalBytes)}
          </div>
          <p className="mt-1 text-xs text-slate-500">
            Stored encrypted inside this browser&rsquo;s IndexedDB for instant offline MP4 export.
          </p>
        </div>
      </div>

      {/* Local Encrypted MP4 Files Table */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-5 py-3.5 border-b border-slate-200 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-900">
            Encrypted Video Files on This Device
          </h2>
          <span className="text-xs text-slate-500">
            Decrypted on demand only with your passphrase
          </span>
        </div>

        {loading ? (
          <div className="p-8 text-center text-xs text-slate-500">
            Scanning encrypted local storage...
          </div>
        ) : entries.length === 0 ? (
          <div className="p-10 text-center text-xs text-slate-500">
            No encrypted MP4 recordings stored locally on this device yet.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 text-[11px] font-semibold uppercase tracking-wider text-slate-500 bg-slate-50/70">
                  <th className="py-2.5 px-5">Meeting</th>
                  <th className="py-2.5 px-4">Format</th>
                  <th className="py-2.5 px-4">Encrypted Size</th>
                  <th className="py-2.5 px-4">Saved</th>
                  <th className="py-2.5 px-5 text-right">Local Device Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-xs">
                {entries.map((entry) => {
                  const meeting = meetingMap.get(entry.meetingId);
                  return (
                    <tr key={entry.meetingId} className="hover:bg-slate-50/70">
                      <td className="py-3 px-5 font-medium text-slate-900">
                        {meeting?.payload.title ?? entry.meetingId}
                      </td>
                      <td className="py-3 px-4 font-mono text-slate-600">
                        {entry.mimeType}
                      </td>
                      <td className="py-3 px-4 font-mono tabular-nums text-slate-700">
                        {formatBytes(entry.fileSizeBytes)}
                      </td>
                      <td className="py-3 px-4 font-mono tabular-nums text-slate-500">
                        {formatDateTime(entry.createdAtMs)}
                      </td>
                      <td className="py-3 px-5 text-right whitespace-nowrap space-x-2">
                        <button
                          type="button"
                          onClick={() => void handleDownloadDecrypted(entry)}
                          className="inline-flex items-center gap-1 px-2.5 py-1 bg-blue-600 text-white rounded-md hover:bg-blue-700"
                        >
                          <Download className="w-3 h-3" />
                          <span>Save MP4</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleExportEncrypted(entry)}
                          className="inline-flex items-center gap-1 px-2.5 py-1 bg-white border border-slate-200 text-slate-700 rounded-md hover:bg-slate-50"
                        >
                          <span>Backup .enc</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleRemoveLocalCopy(entry.meetingId)}
                          className="inline-flex items-center gap-1 p-1 text-slate-400 hover:text-red-600"
                          aria-label="Delete local encrypted video"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};

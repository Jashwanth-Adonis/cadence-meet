import React, { useEffect, useMemo, useState } from 'react';
import { Download, HardDrive, Lock, ShieldCheck, Trash2 } from 'lucide-react';
import {
  deleteEncryptedVideo,
  exportEncryptedArchiveBlob,
  getStorageEstimate,
  listLocalVaultEntries,
  streamDownloadDecryptedVideo,
  triggerBlobDownload,
} from '../lib/vaultStorage';
import { formatBytes, formatDateTime } from '../lib/formatters';
import type { LocalVaultEntryMeta, MeetingRecord } from '../types';

interface VaultSecurityViewProps {
  vaultId: string;
  masterKey: CryptoKey;
  meetings: MeetingRecord[];
  onLockVault: () => void;
}

export const VaultSecurityView: React.FC<VaultSecurityViewProps> = ({
  vaultId,
  masterKey,
  meetings,
  onLockVault,
}) => {
  const [entries, setEntries] = useState<LocalVaultEntryMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [freeBytes, setFreeBytes] = useState<number | null>(null);

  const refreshEntries = async () => {
    setLoading(true);
    try {
      const [list, est] = await Promise.all([listLocalVaultEntries(), getStorageEstimate()]);
      setEntries(list.sort((a, b) => b.createdAtMs - a.createdAtMs));
      if (est) setFreeBytes(est.freeBytes);
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

  const scopedEntries = useMemo(
    () => entries.filter((e) => meetingMap.has(e.meetingId)),
    [entries, meetingMap]
  );

  const totalLocalBytes = useMemo(
    () => scopedEntries.reduce((sum, e) => sum + e.fileSizeBytes, 0),
    [scopedEntries]
  );

  const handleDownloadDecrypted = async (entry: LocalVaultEntryMeta) => {
    const meeting = meetingMap.get(entry.meetingId);
    const title = meeting?.payload.title ?? entry.meetingId;
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    const ext = entry.mimeType.includes('mp4') ? 'mp4' : 'webm';
    await streamDownloadDecryptedVideo(
      entry.meetingId,
      masterKey,
      `${slug || 'meeting-recording'}.${ext}`,
      entry.mimeType
    );
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
          <h1 className="font-display text-2xl font-semibold text-slate-100 tracking-tight">
            Vault Security &amp; Local Storage
          </h1>
          <p className="text-sm text-slate-400 mt-1">
            Passphrase-locked local browser storage, quota monitor, and encrypted video downloads.
          </p>
        </div>

        <button
          type="button"
          onClick={onLockVault}
          className="inline-flex items-center gap-1.5 px-4 py-2.5 bg-[#0F1B35] border border-[#1E2E52] text-slate-100 text-xs font-medium rounded-xl hover:bg-[#16264A] transition-colors whitespace-nowrap shrink-0 self-start min-h-[42px]"
        >
          <Lock className="w-3.5 h-3.5" />
          <span>Lock Vault Session</span>
        </button>
      </div>

      {/* Cryptographic Parameters Strip */}
      <div className="grid grid-cols-1 md:grid-cols-3 bg-[#091022] border border-[#162342] rounded-2xl divide-y md:divide-y-0 md:divide-x divide-[#162342]">
        <div className="p-5">
          <div className="flex items-center gap-2 text-xs font-medium text-slate-400">
            <ShieldCheck className="w-4 h-4 text-blue-400" />
            <span>Cipher Suite</span>
          </div>
          <div className="mt-1.5 font-mono text-sm font-semibold text-slate-100">
            AES-256-GCM (Chunked)
          </div>
          <p className="mt-1 text-xs text-slate-400">
            Video chunks, notes, and tasks are encrypted incrementally with a unique 96-bit IV per slice.
          </p>
        </div>
        <div className="p-5">
          <div className="flex items-center gap-2 text-xs font-medium text-slate-400">
            <Lock className="w-4 h-4 text-slate-400" />
            <span>Passphrase Keyspace</span>
          </div>
          <div className="mt-1.5 font-mono text-sm font-semibold text-slate-100">
            PBKDF2-SHA256 · 310k
          </div>
          <p className="mt-1 text-xs text-slate-400">
            Key derived locally from your passphrase ({vaultId.slice(0, 14)}). Zero cloud accounts.
          </p>
        </div>
        <div className="p-5">
          <div className="flex items-center gap-2 text-xs font-medium text-slate-400">
            <HardDrive className="w-4 h-4 text-slate-400" />
            <span>Vault Storage</span>
          </div>
          <div className="mt-1.5 font-mono tabular-nums text-sm font-semibold text-slate-100">
            {scopedEntries.length} files · {formatBytes(totalLocalBytes)}
          </div>
          <p className="mt-1 text-xs text-slate-400">
            {freeBytes !== null
              ? `${formatBytes(freeBytes)} available in persistent browser storage.`
              : 'Persisted in encrypted local IndexedDB.'}
          </p>
        </div>
      </div>

      {/* Local Encrypted Video Files Table */}
      <div className="bg-[#091022] border border-[#162342] rounded-2xl overflow-hidden">
        <div className="px-5 py-3.5 border-b border-[#162342] flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-100">
            Encrypted Video Files in This Vault
          </h2>
          <span className="text-xs text-slate-400">
            Stream-decrypted on demand
          </span>
        </div>

        {loading ? (
          <div className="p-8 text-center text-xs text-slate-400">
            Scanning encrypted local storage...
          </div>
        ) : scopedEntries.length === 0 ? (
          <div className="p-10 text-center text-xs text-slate-400">
            No encrypted recordings stored inside browser storage for this passphrase yet.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-[#162342] text-[11px] font-semibold uppercase tracking-wider text-slate-400 bg-[#060B18]">
                  <th className="py-2.5 px-5">Meeting</th>
                  <th className="py-2.5 px-4">Format</th>
                  <th className="py-2.5 px-4">Size</th>
                  <th className="py-2.5 px-4">Saved</th>
                  <th className="py-2.5 px-5 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#162342]/70 text-xs">
                {scopedEntries.map((entry) => {
                  const meeting = meetingMap.get(entry.meetingId);
                  return (
                    <tr key={entry.meetingId} className="hover:bg-[#0F1B35]/40">
                      <td className="py-3 px-5 font-medium text-slate-100">
                        {meeting?.payload.title ?? entry.meetingId}
                      </td>
                      <td className="py-3 px-4 font-mono text-slate-400">
                        {entry.mimeType}
                      </td>
                      <td className="py-3 px-4 font-mono tabular-nums text-slate-300">
                        {formatBytes(entry.fileSizeBytes)}
                      </td>
                      <td className="py-3 px-4 font-mono tabular-nums text-slate-400">
                        {formatDateTime(entry.createdAtMs)}
                      </td>
                      <td className="py-3 px-5 text-right whitespace-nowrap space-x-2">
                        <button
                          type="button"
                          onClick={() => void handleDownloadDecrypted(entry)}
                          className="inline-flex items-center gap-1 px-2.5 py-1.5 bg-blue-600 text-white rounded-lg hover:bg-blue-500"
                        >
                          <Download className="w-3 h-3" />
                          <span>Save Video</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleExportEncrypted(entry)}
                          className="inline-flex items-center gap-1 px-2.5 py-1.5 bg-[#0F1B35] border border-[#1E2E52] text-slate-200 rounded-lg hover:bg-[#16264A]"
                        >
                          <span>Backup .enc</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleRemoveLocalCopy(entry.meetingId)}
                          className="inline-flex items-center gap-1 p-1.5 text-slate-500 hover:text-red-400"
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

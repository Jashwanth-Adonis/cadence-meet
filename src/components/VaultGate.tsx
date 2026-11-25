import React, { useState } from 'react';
import { KeyRound, Lock, ShieldCheck, ArrowRight, RotateCcw } from 'lucide-react';
import {
  createVaultForPassphrase,
  resetLocalVault,
  unlockOrLookupVaultByPassphrase,
} from '../lib/localVaultDb';
import { AndroidApkDownloadButton, PWAInstallButton } from './PWAControls';
import type { UserVaultProfile } from '../types';

interface VaultGateProps {
  onUnlocked: (key: CryptoKey, profile: UserVaultProfile) => void;
  onVaultReset: () => void;
}

export const VaultGate: React.FC<VaultGateProps> = ({ onUnlocked, onVaultReset }) => {
  const [passphrase, setPassphrase] = useState('');
  const [confirmPassphrase, setConfirmPassphrase] = useState('');
  const [needsConfirmCreate, setNeedsConfirmCreate] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (passphrase.length < 6) {
      setError('Enter a passphrase of at least 6 characters.');
      return;
    }

    setBusy(true);
    try {
      if (needsConfirmCreate) {
        if (passphrase !== confirmPassphrase) {
          setError('Passphrases do not match.');
          setBusy(false);
          return;
        }
        const created = await createVaultForPassphrase(passphrase);
        onUnlocked(created.key, created.profile);
        return;
      }

      const lookup = await unlockOrLookupVaultByPassphrase(passphrase);
      if (lookup.status === 'unlocked') {
        onUnlocked(lookup.key, lookup.profile);
        return;
      }

      // First time this passphrase is used on this device — confirm once to create local vault
      setNeedsConfirmCreate(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to unlock vault with this passphrase.');
    } finally {
      setBusy(false);
    }
  };

  const handleResetAll = async () => {
    setBusy(true);
    setError('');
    try {
      await resetLocalVault();
      setPassphrase('');
      setConfirmPassphrase('');
      setNeedsConfirmCreate(false);
      setConfirmReset(false);
      onVaultReset();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reset local storage.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#04060B] text-slate-100 flex flex-col justify-between p-4 sm:p-6">
      <div className="w-full max-w-md mx-auto flex items-center justify-between pt-2">
        <div className="flex items-center gap-2.5">
          <img
            src="/icon.svg"
            alt="Cadence Meet"
            className="w-8 h-8 rounded-lg shrink-0"
          />
          <span className="font-display text-base font-bold tracking-tight text-slate-100">
            Cadence Meet
          </span>
        </div>
        <div className="flex items-center gap-2">
          <AndroidApkDownloadButton compact />
          <PWAInstallButton compact />
        </div>
      </div>

      <div className="w-full max-w-md mx-auto bg-[#091022] border border-[#162342] rounded-2xl p-6 sm:p-8 my-6">
        <div className="mb-6">
          <div className="inline-flex items-center gap-1.5 text-xs font-medium text-blue-400 mb-3">
            <ShieldCheck className="w-3.5 h-3.5" />
            <span>Local Passphrase Vault</span>
          </div>
          <h1 className="font-display text-2xl font-semibold text-slate-100 tracking-tight">
            {needsConfirmCreate ? 'Confirm new passphrase' : 'Enter your passphrase'}
          </h1>
          <p className="mt-2 text-sm text-slate-400 leading-relaxed">
            {needsConfirmCreate
              ? 'No local vault exists for this passphrase yet on this browser. Confirm it below to create one.'
              : 'Completely local and private. Your passphrase unlocks your encrypted meetings and recordings directly on this device.'}
          </p>
        </div>

        {error && (
          <div className="mb-5 p-3 bg-red-950/60 border border-red-800/70 rounded-xl text-xs text-red-200 leading-relaxed">
            {error}
          </div>
        )}

        <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1.5">
              Vault Passphrase
            </label>
            <div className="relative">
              <KeyRound className="w-4 h-4 text-slate-500 absolute left-3.5 top-1/2 -translate-y-1/2" />
              <input
                type="password"
                value={passphrase}
                onChange={(e) => {
                  setPassphrase(e.target.value);
                  if (needsConfirmCreate) {
                    setNeedsConfirmCreate(false);
                    setConfirmPassphrase('');
                  }
                }}
                placeholder="Enter your passphrase"
                className="w-full pl-10 pr-3.5 py-2.5 text-sm bg-[#04060B] text-slate-100 placeholder:text-slate-500 border border-[#1E2E52] rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500 min-h-[44px]"
                required
                minLength={6}
                autoFocus
              />
            </div>
          </div>

          {needsConfirmCreate && (
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5">
                Confirm New Passphrase
              </label>
              <div className="relative">
                <Lock className="w-4 h-4 text-slate-500 absolute left-3.5 top-1/2 -translate-y-1/2" />
                <input
                  type="password"
                  value={confirmPassphrase}
                  onChange={(e) => setConfirmPassphrase(e.target.value)}
                  placeholder="Repeat passphrase"
                  className="w-full pl-10 pr-3.5 py-2.5 text-sm bg-[#04060B] text-slate-100 placeholder:text-slate-500 border border-[#1E2E52] rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500 min-h-[44px]"
                  required
                  minLength={6}
                  autoFocus
                />
              </div>
            </div>
          )}

          <button
            type="submit"
            disabled={busy}
            className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-blue-600 text-white text-sm font-medium rounded-xl hover:bg-blue-500 disabled:opacity-50 transition-colors min-h-[44px]"
          >
            <span>
              {busy
                ? 'Deriving Encryption Key...'
                : needsConfirmCreate
                ? 'Create Passphrase Vault'
                : 'Open Workspace'}
            </span>
            <ArrowRight className="w-4 h-4" />
          </button>
        </form>

        <div className="mt-5 pt-4 border-t border-[#162342] flex flex-wrap items-center justify-between gap-2 text-xs">
          <span className="text-slate-500">Zero accounts · Zero cloud uploads</span>

          {!confirmReset ? (
            <button
              type="button"
              onClick={() => setConfirmReset(true)}
              className="text-slate-400 hover:text-slate-200 py-1"
            >
              Clear browser cache
            </button>
          ) : (
            <div className="w-full mt-2 p-3 bg-[#04060B] border border-[#162342] rounded-xl space-y-2">
              <p className="text-xs text-slate-300">
                Permanently clear all locally stored vaults and recordings on this browser?
              </p>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void handleResetAll()}
                  className="inline-flex items-center gap-1 px-3 py-1.5 bg-red-600 text-white text-xs font-medium rounded-lg hover:bg-red-500"
                >
                  <RotateCcw className="w-3 h-3" />
                  <span>Confirm Clear</span>
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmReset(false)}
                  className="px-3 py-1.5 bg-[#0F1B35] border border-[#1E2E52] text-slate-200 text-xs font-medium rounded-lg hover:bg-[#16264A]"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="w-full max-w-md mx-auto text-center text-xs text-slate-500 pb-2">
        AES-256-GCM encrypted in local browser storage · Works offline
      </div>
    </div>
  );
};

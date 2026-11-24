import React, { useState } from 'react';
import { KeyRound, Lock, ShieldCheck, RotateCcw } from 'lucide-react';
import {
  createVaultVerifier,
  deriveMasterKey,
  generateSalt,
  verifyVaultPassphrase,
} from '../lib/crypto';
import {
  createLocalFolder,
  LOCAL_UID,
  resetLocalVault,
  saveLocalProfile,
} from '../lib/localVaultDb';
import type { UserVaultProfile } from '../types';

interface VaultGateProps {
  profile: UserVaultProfile | null;
  profileLoading: boolean;
  onUnlocked: (key: CryptoKey, profile: UserVaultProfile) => void;
  onVaultReset: () => void;
}

export const VaultGate: React.FC<VaultGateProps> = ({
  profile,
  profileLoading,
  onUnlocked,
  onVaultReset,
}) => {
  const [passphrase, setPassphrase] = useState('');
  const [confirmPassphrase, setConfirmPassphrase] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);

  const handleCreateVault = async (e: React.FormEvent) => {
    e.preventDefault();
    if (passphrase.length < 8) {
      setError('Vault passphrase must be at least 8 characters long.');
      return;
    }
    if (passphrase !== confirmPassphrase) {
      setError('Passphrases do not match.');
      return;
    }

    setError('');
    setBusy(true);
    try {
      const salt = generateSalt();
      const key = await deriveMasterKey(passphrase, salt);
      const verifier = await createVaultVerifier(key);

      const newLocalProfile: UserVaultProfile = {
        uid: LOCAL_UID,
        email: 'local@device',
        displayName: 'Local Device Vault',
        vaultSalt: salt,
        vaultVerifier: verifier,
        vaultEnabled: true,
      };
      await saveLocalProfile(newLocalProfile);
      await Promise.all([
        createLocalFolder('Work Meetings', 'Team syncs and project reviews', '#2563EB'),
        createLocalFolder('Client Calls', 'External meetings and demos', '#0F766E'),
        createLocalFolder('Archive', 'Completed project recordings', '#64748B'),
      ]);
      onUnlocked(key, newLocalProfile);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to initialize local encrypted vault.');
    } finally {
      setBusy(false);
    }
  };

  const handleUnlockVault = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!profile) return;
    if (!passphrase) {
      setError('Enter your vault passphrase to sign in.');
      return;
    }

    setError('');
    setBusy(true);
    try {
      const key = await deriveMasterKey(passphrase, profile.vaultSalt);
      const ok = await verifyVaultPassphrase(key, profile.vaultVerifier);
      if (!ok) {
        setError('Incorrect passphrase. Unable to unlock your local vault.');
        setBusy(false);
        return;
      }
      onUnlocked(key, profile);
    } catch {
      setError('Failed to verify vault passphrase.');
    } finally {
      setBusy(false);
    }
  };

  const handleResetVault = async () => {
    setBusy(true);
    setError('');
    try {
      await resetLocalVault();
      setPassphrase('');
      setConfirmPassphrase('');
      setConfirmReset(false);
      onVaultReset();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reset local vault.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col justify-center items-center p-6">
      <div className="w-full max-w-md bg-white border border-slate-200 rounded-xl p-8">
        <div className="mb-6">
          <div className="flex items-center justify-between mb-4">
            <span className="font-display text-lg font-bold tracking-tight text-slate-900">
              Cadence Meet
            </span>
            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-500">
              <ShieldCheck className="w-3.5 h-3.5 text-blue-600" />
              AES-256-GCM Local Vault
            </span>
          </div>
          <h1 className="font-display text-2xl font-semibold text-slate-900 tracking-tight">
            {profileLoading
              ? 'Loading local vault'
              : profile
              ? 'Sign in with passphrase'
              : 'Create your vault passphrase'}
          </h1>
          <p className="mt-2 text-sm text-slate-600 leading-relaxed">
            {profile
              ? 'Your meeting videos, logs, and tasks are stored encrypted in this browser. Enter your passphrase to unlock.'
              : 'Set a passphrase to encrypt all recorded meetings and logs locally on this device. Everything stays in your browser.'}
          </p>
        </div>

        {error && (
          <div className="mb-5 p-3 bg-red-50 border border-red-200 rounded-lg text-xs text-red-800 leading-relaxed">
            {error}
          </div>
        )}

        {profileLoading ? (
          <div className="py-8 text-center text-sm text-slate-500">
            Checking local browser storage...
          </div>
        ) : !profile ? (
          <form onSubmit={handleCreateVault} className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1.5">
                Passphrase (min. 8 characters)
              </label>
              <div className="relative">
                <KeyRound className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="password"
                  value={passphrase}
                  onChange={(e) => setPassphrase(e.target.value)}
                  placeholder="Create a passphrase"
                  className="w-full pl-9 pr-3 py-2 text-sm bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600/20 focus:border-blue-600"
                  required
                  minLength={8}
                  autoFocus
                />
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1.5">
                Confirm Passphrase
              </label>
              <div className="relative">
                <Lock className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="password"
                  value={confirmPassphrase}
                  onChange={(e) => setConfirmPassphrase(e.target.value)}
                  placeholder="Repeat passphrase"
                  className="w-full pl-9 pr-3 py-2 text-sm bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600/20 focus:border-blue-600"
                  required
                  minLength={8}
                />
              </div>
            </div>
            <button
              type="submit"
              disabled={busy}
              className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
            >
              <span>{busy ? 'Creating Local Vault...' : 'Create & Open Workspace'}</span>
            </button>
          </form>
        ) : (
          <form onSubmit={handleUnlockVault} className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1.5">
                Vault Passphrase
              </label>
              <div className="relative">
                <Lock className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="password"
                  value={passphrase}
                  onChange={(e) => setPassphrase(e.target.value)}
                  placeholder="Enter passphrase to unlock"
                  className="w-full pl-9 pr-3 py-2 text-sm bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600/20 focus:border-blue-600"
                  required
                  autoFocus
                />
              </div>
            </div>
            <button
              type="submit"
              disabled={busy}
              className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
            >
              <span>{busy ? 'Unlocking...' : 'Unlock Workspace'}</span>
            </button>

            <div className="pt-2">
              {!confirmReset ? (
                <button
                  type="button"
                  onClick={() => setConfirmReset(true)}
                  className="text-xs text-slate-500 hover:text-slate-800 transition-colors"
                >
                  Forgot passphrase? Reset local vault
                </button>
              ) : (
                <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg space-y-2.5">
                  <p className="text-xs text-slate-700 leading-relaxed">
                    Resetting clears all encrypted recordings and logs stored in this browser so you can set a new passphrase.
                  </p>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void handleResetVault()}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-red-600 text-white text-xs font-medium rounded-md hover:bg-red-700 disabled:opacity-50"
                    >
                      <RotateCcw className="w-3 h-3" />
                      <span>Confirm Reset</span>
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => setConfirmReset(false)}
                      className="px-3 py-1.5 bg-white border border-slate-300 text-slate-700 text-xs font-medium rounded-md hover:bg-slate-50"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          </form>
        )}

        <div className="mt-6 pt-5 border-t border-slate-100 text-xs text-slate-500 flex items-center justify-between">
          <span>100% Local Browser Storage</span>
          <span>PBKDF2 · AES-256-GCM</span>
        </div>
      </div>
    </div>
  );
};

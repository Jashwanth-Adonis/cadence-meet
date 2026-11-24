import React, { useState } from 'react';
import { signInWithPopup, signOut, type User } from 'firebase/auth';
import { KeyRound, Lock, ShieldCheck, LogOut, ArrowRight } from 'lucide-react';
import { auth, googleProvider } from '../firebase';
import {
  createVaultVerifier,
  deriveMasterKey,
  generateSalt,
  verifyVaultPassphrase,
} from '../lib/crypto';
import { createFolder, createUserVaultProfile } from '../lib/firestoreVault';
import type { UserVaultProfile } from '../types';

interface VaultGateProps {
  user: User | null;
  profile: UserVaultProfile | null;
  profileLoading: boolean;
  onUnlocked: (key: CryptoKey, profile: UserVaultProfile) => void;
}

export const VaultGate: React.FC<VaultGateProps> = ({
  user,
  profile,
  profileLoading,
  onUnlocked,
}) => {
  const [passphrase, setPassphrase] = useState('');
  const [confirmPassphrase, setConfirmPassphrase] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const handleGoogleSignIn = async () => {
    setError('');
    setBusy(true);
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to sign in with Google.');
    } finally {
      setBusy(false);
    }
  };

  const handleCreateVault = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;
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

      const newProfile: UserVaultProfile = {
        uid: user.uid,
        email: user.email ?? '',
        displayName: user.displayName ?? 'Workspace Owner',
        vaultSalt: salt,
        vaultVerifier: verifier,
        vaultEnabled: true,
      };

      await createUserVaultProfile(newProfile);

      // Seed starter folders for clean log organization
      await Promise.all([
        createFolder(user.uid, 'Product & Roadmap', 'Weekly product syncs and feature planning', '#2563EB'),
        createFolder(user.uid, 'Engineering', 'Architecture reviews and sprint standups', '#0F766E'),
        createFolder(user.uid, 'Client & External', 'Stakeholder reviews and partner calls', '#B45309'),
      ]);

      onUnlocked(key, newProfile);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to initialize encrypted vault.');
    } finally {
      setBusy(false);
    }
  };

  const handleUnlockVault = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!profile) return;
    if (!passphrase) {
      setError('Enter your vault passphrase to decrypt your workspace.');
      return;
    }

    setError('');
    setBusy(true);
    try {
      const key = await deriveMasterKey(passphrase, profile.vaultSalt);
      const ok = await verifyVaultPassphrase(key, profile.vaultVerifier);
      if (!ok) {
        setError('Incorrect vault passphrase. Unable to verify decryption key.');
        setBusy(false);
        return;
      }
      onUnlocked(key, profile);
    } catch {
      setError('Failed to derive decryption key.');
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
              AES-256-GCM E2EE
            </span>
          </div>
          <h1 className="font-display text-2xl font-semibold text-slate-900 tracking-tight">
            {!user
              ? 'Sign in to your meeting workspace'
              : profileLoading
              ? 'Checking encryption vault'
              : profile
              ? 'Unlock your encrypted vault'
              : 'Create your encryption passphrase'}
          </h1>
          <p className="mt-2 text-sm text-slate-600 leading-relaxed">
            {!user
              ? 'Record Google Meet sessions, encrypt recordings locally, organize logs in folders, and download video files directly.'
              : profile
              ? 'Your recorded videos, meeting notes, and tasks are encrypted client-side. Enter your passphrase to derive your session key.'
              : 'Set a personal passphrase to derive your local AES-256-GCM encryption key. This passphrase never leaves your browser.'}
          </p>
        </div>

        {error && (
          <div className="mb-5 p-3 bg-red-50 border border-red-200 rounded-lg text-xs text-red-800 leading-relaxed">
            {error}
          </div>
        )}

        {!user ? (
          <button
            type="button"
            onClick={handleGoogleSignIn}
            disabled={busy}
            className="w-full flex items-center justify-center gap-2.5 px-4 py-2.5 bg-slate-900 text-white text-sm font-medium rounded-lg hover:bg-slate-800 disabled:opacity-50 transition-colors"
          >
            <span>{busy ? 'Connecting Google Account...' : 'Continue with Google'}</span>
            <ArrowRight className="w-4 h-4" />
          </button>
        ) : profileLoading ? (
          <div className="py-8 text-center text-sm text-slate-500">
            Loading encrypted vault metadata...
          </div>
        ) : !profile ? (
          <form onSubmit={handleCreateVault} className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1.5">
                Vault Passphrase (min. 8 characters)
              </label>
              <div className="relative">
                <KeyRound className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="password"
                  value={passphrase}
                  onChange={(e) => setPassphrase(e.target.value)}
                  placeholder="Enter a strong passphrase"
                  className="w-full pl-9 pr-3 py-2 text-sm bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600/20 focus:border-blue-600"
                  required
                  minLength={8}
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
              <span>{busy ? 'Deriving 256-bit Key...' : 'Initialize Encrypted Workspace'}</span>
            </button>
          </form>
        ) : (
          <form onSubmit={handleUnlockVault} className="space-y-4">
            <div className="text-xs text-slate-500 flex items-center justify-between border-b border-slate-100 pb-3">
              <span className="truncate">{user.email}</span>
              <button
                type="button"
                onClick={() => signOut(auth)}
                className="inline-flex items-center gap-1 text-slate-600 hover:text-slate-900 font-medium whitespace-nowrap shrink-0"
              >
                <LogOut className="w-3.5 h-3.5" />
                Switch account
              </button>
            </div>
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
                />
              </div>
            </div>
            <button
              type="submit"
              disabled={busy}
              className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
            >
              <span>{busy ? 'Verifying Key...' : 'Unlock Workspace'}</span>
            </button>
          </form>
        )}

        <div className="mt-6 pt-5 border-t border-slate-100 text-xs text-slate-500 flex items-center justify-between">
          <span>PBKDF2-SHA256 · 310k rounds</span>
          <span>Zero-knowledge local keys</span>
        </div>
      </div>
    </div>
  );
};

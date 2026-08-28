import React, { useState, useEffect } from 'react';
import { supabase } from '@beaver/agent-core/transport/supabaseClient';
import { isServiceUnavailableError, SERVICE_UNAVAILABLE_MESSAGE } from '@beaver/agent-core/transport/otp';

/**
 * Fully‑featured password‑reset page that mimics the look & feel of `LoginPage`.
 *
 * ➡️  Two states are supported in a single file:
 *   1. "Request" ‑ user enters e‑mail to receive a reset link.
 *   2. "Update"  ‑ user has clicked the link from the e‑mail and now sets a new password.
 *
 *   Supabase automatically authenticates the user on the *recovery* link
 *   (because we pass `redirectTo` pointing back to this page).  Once the
 *   session exists we can simply call `updateUser({ password })`.
 */

const ResetPasswordPage: React.FC = () => {
  // Detect whether we landed here from a recovery e‑mail.
  const query = new URLSearchParams(Zotero.getMainWindow().location.search);
  const isRecoveryFlow = query.get('type') === 'recovery';

  // Shared UI state
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Request‑link state
  const [email, setEmail] = useState('');

  // Update‑password state
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  /*
   * When we arrive with `type=recovery`, Supabase has already exchanged the
   * token in the URL for a valid session **if** the project settings use the
   * recommended "Code exchange" flow (default).  We do not need to call
   * `onAuthStateChange` here, but if your project uses OTP you could listen
   * for `PASSWORD_RECOVERY` events.
   */

  // ──────────────────────────────── Handlers ────────────────────────────────
  const handleSendResetLink = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    setSuccessMsg(null);

    if (!email) {
      setErrorMsg('Please enter a valid e‑mail address.');
      return;
    }

    setSubmitting(true);
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${Zotero.getMainWindow().location.origin}/reset-password`, // ensure this route is allowed in Auth → Redirect URLs
    });

    if (error) {
      setErrorMsg(isServiceUnavailableError(error) ? SERVICE_UNAVAILABLE_MESSAGE : error.message);
    } else {
      setSuccessMsg('Check your inbox! Click the link in the e‑mail to continue.');
    }
    setSubmitting(false);
  };

  const handleUpdatePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    setSuccessMsg(null);

    if (password.length < 8) {
      setErrorMsg('Password must be at least 8 characters long.');
      return;
    }
    if (password !== confirmPassword) {
      setErrorMsg("Passwords don't match.");
      return;
    }

    setSubmitting(true);
    const { error } = await supabase.auth.updateUser({ password });

    if (error) {
      setErrorMsg(isServiceUnavailableError(error) ? SERVICE_UNAVAILABLE_MESSAGE : error.message);
    } else {
      setSuccessMsg('Password updated ✔️  You can now sign in with the new password.');
      // Optionally, redirect the user after a delay
      // setTimeout(() => window.location.replace('/login'), 2500);
    }
    setSubmitting(false);
  };

  // ──────────────────────────────── Render ─────────────────────────────────
  return (
    <div
      id="beaver-reset"
      className="display-flex flex-col flex-1 min-h-0 overflow-y-auto scrollbar min-w-0 p-4"
    >
      <div style={{ height: '5vh' }}></div>
      <div className="display-flex flex-col justify-center max-w-md mx-auto w-full">
        {/* Header */}
        <div className="display-flex flex-col items-start mb-4">
          <h1 className="text-2xl font-semibold">Reset your password 🔑</h1>
          <p className="text-base font-color-secondary -mt-2">
            {isRecoveryFlow
              ? 'Enter a new password below.'
              : 'Forgot your password? No problem — we’ll send you a reset link.'}
          </p>
        </div>

        {/* Card */}
        <div className="w-90 rounded-lg border-quinary p-4 bg-raised">
          {isRecoveryFlow ? (
            <form onSubmit={handleUpdatePassword} className="display-flex flex-col gap-3">
              <label className="font-sm" htmlFor="password">
                New password
              </label>
              <input
                id="password"
                type="password"
                className="input-primary"
                placeholder="********"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
              <label className="font-sm" htmlFor="confirmPassword">
                Confirm password
              </label>
              <input
                id="confirmPassword"
                type="password"
                className="input-primary"
                placeholder="********"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                required
              />
              <button
                type="submit"
                className="button-primary mt-2"
                disabled={submitting}
              >
                {submitting ? 'Updating…' : 'Update password'}
              </button>
            </form>
          ) : (
            <form onSubmit={handleSendResetLink} className="display-flex flex-col gap-3">
              <label className="font-sm" htmlFor="email">
                Email
              </label>
              <input
                id="email"
                type="email"
                className="input-primary"
                placeholder="jane@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
              <button
                type="submit"
                className="button-primary mt-2"
                disabled={submitting}
              >
                {submitting ? 'Sending…' : 'Send reset link'}
              </button>
            </form>
          )}
        </div>

        {/* Auxiliary links */}
        <div className="display-flex flex-col gap-2 mt-4 text-sm">
          <button
            type="button"
            className="font-color-secondary hover:font-color-primary transition bg-transparent border-0 p-0 text-left"
            style={{ textDecoration: 'none' }}
            onClick={() => {
              if (isRecoveryFlow) {
                Zotero.getMainWindow().location.replace('/login');
              } else {
                Zotero.getMainWindow().history.back();
              }
            }}
          >
            ← Back to sign‑in
          </button>
        </div>

        {/* Feedback messages */}
        {errorMsg && <p className="text-sm font-color-red text-center mt-2">{errorMsg}</p>}
        {successMsg && <p className="text-sm font-color-green text-center mt-2">{successMsg}</p>}
      </div>
    </div>
  );
};

export default ResetPasswordPage;

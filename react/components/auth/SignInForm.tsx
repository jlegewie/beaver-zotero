import React, { useState, useEffect, useCallback } from 'react'
import { supabase } from '../../../src/services/supabaseClient'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { isProfileLoadedAtom, isProfileInvalidAtom } from '../../atoms/profile'
import {
  authMethodAtom,
  loginStepAtom,
  loginEmailAtom,
  loginPasswordAtom,
  loginErrorAtom,
  loginLoadingAtom,
  otpResendCountdownAtom,
  isWaitingForProfileAtom,
  resetLoginFormAtom,
  setAuthMethodAtom,
} from '../../atoms/auth'
import { OTPVerification } from './OTPVerification'
import { sendOTP, verifyOTP, getOTPErrorMessage } from './otp'
import { getPref } from '../../../src/utils/prefs'

interface SignInFormProps {
  setErrorMsg: (errorMsg: string | null) => void;
  emailInputRef?: React.RefObject<HTMLInputElement>;
}

export default function SignInForm({ setErrorMsg, emailInputRef }: SignInFormProps) {
  // Shared atoms for login form state
  const [email, setEmail] = useAtom(loginEmailAtom)
  const [password, setPassword] = useAtom(loginPasswordAtom)
  const [isLoading, setIsLoading] = useAtom(loginLoadingAtom)
  const [error, setError] = useAtom(loginErrorAtom)
  const [authMethod] = useAtom(authMethodAtom)
  const setAuthMethod = useSetAtom(setAuthMethodAtom)
  const [step, setStep] = useAtom(loginStepAtom)
  const [resendCountdown, setResendCountdown] = useAtom(otpResendCountdownAtom)
  const [isWaitingForProfile, setIsWaitingForProfile] = useAtom(isWaitingForProfileAtom)
  const resetLoginForm = useSetAtom(resetLoginFormAtom)
  
  // Store the associated email at mount time for error messages
  const [associatedEmail] = useState<string | undefined>(() => getPref("userEmail"))
  const isProfileLoaded = useAtomValue(isProfileLoadedAtom)
  const isProfileInvalid = useAtomValue(isProfileInvalidAtom)

  const PROFILE_LOAD_TIMEOUT = 10000; // 10 second timeout

  // Reset stale login form state on mount.
  useEffect(() => {
    if (!isWaitingForProfile && (isLoading || step === 'otp')) {
      resetLoginForm();
      setIsLoading(false);
    }
  }, []); // mount only - intentionally ignoring deps to detect stale state

  // Handle initial focus and email prefill
  useEffect(() => {
    if (associatedEmail) {
      setEmail(associatedEmail);
    } else {
      emailInputRef?.current?.focus();
    }
  }, [emailInputRef, associatedEmail]);

  // Add timeout for profile loading
  useEffect(() => {
    if (isWaitingForProfile) {
      const timeout = setTimeout(() => {
        if (!isProfileLoaded) {
          setError('Failed to load profile data. Try again later.');
          setErrorMsg('Failed to load profile data. Try again later.');
          supabase.auth.signOut();
          setIsWaitingForProfile(false);
          setIsLoading(false);
        }
      }, PROFILE_LOAD_TIMEOUT);

      return () => clearTimeout(timeout);
    }
  }, [isWaitingForProfile, isProfileLoaded, setErrorMsg]);

  // Handle successful profile loading
  useEffect(() => {
    if (isWaitingForProfile && isProfileLoaded) {
      setIsWaitingForProfile(false);
      setIsLoading(false);
    }
  }, [isWaitingForProfile, isProfileLoaded]);

  // Handle profile invalid state (Zotero instance mismatch)
  useEffect(() => {
    if (isProfileInvalid) {
      const errorMessage = 'This Zotero instance is not linked to your account. Please try signing in from the correct Zotero instance.';
      setError(errorMessage);
      setErrorMsg(errorMessage);
      setIsWaitingForProfile(false);
      setIsLoading(false);
      // Return to email page if on OTP page
      if (step === 'otp') {
        setAuthMethod('initial');
        setStep('method-selection');
      }
    }
  }, [isProfileInvalid, setErrorMsg, step]);

  // Countdown timer for resend OTP
  useEffect(() => {
    if (resendCountdown > 0) {
      const timer = setTimeout(() => setResendCountdown(resendCountdown - 1), 1000)
      return () => clearTimeout(timer)
    }
  }, [resendCountdown])

  // Handle email code sign-in
  const handleSendEmailCode = useCallback(async () => {
    if (!email) {
      setError('Please enter your email address')
      return
    }

    // Check if Zotero instance is already associated with another account
    const storedUserEmail = getPref("userEmail");
    if (storedUserEmail && storedUserEmail.toLowerCase() !== email.toLowerCase()) {
      const errorMessage = `This Zotero instance is already associated with another Beaver account. Please sign in with the correct account (${storedUserEmail}).`;
      setError(errorMessage);
      setErrorMsg(errorMessage);
      return;
    }
    
    setIsLoading(true)
    setError(null)
    
    try {
      await sendOTP(email, { shouldCreateUser: false })
      setAuthMethod('code')
      setStep('otp')
      setResendCountdown(60)
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Failed to send verification code')
    } finally {
      setIsLoading(false)
    }
  }, [email, setErrorMsg])

  // Handle OTP verification
  const handleVerifyOTP = useCallback(async (otpCode: string) => {
    // Check if Zotero instance is already associated with another account
    const storedUserEmail = getPref("userEmail");
    if (storedUserEmail && storedUserEmail.toLowerCase() !== email.toLowerCase()) {
      const errorMessage = `This Zotero instance is already associated with another Beaver account. Please sign in with the correct account (${storedUserEmail}).`;
      setError(errorMessage);
      setErrorMsg(errorMessage);
      // Return to email page
      setAuthMethod('initial');
      setStep('method-selection');
      return; // Early return - error is already handled locally
    }

    setIsLoading(true)
    setError(null)
    setErrorMsg(null)
    
    try {
      await verifyOTP(email, otpCode, 'email')
      // Wait for useProfileSync to fetch the profile
      setIsWaitingForProfile(true);
      // isLoading will be set to false when profile loads or timeout occurs
    } catch (error) {
      const errorMessage = error instanceof Error ? getOTPErrorMessage(error) : 'Verification failed'
      setError(errorMessage)
      setErrorMsg(errorMessage)
      setIsLoading(false)
      throw error // Re-throw to let OTPVerification component handle UI feedback
    }
  }, [email, setErrorMsg])

  // Handle resend OTP
  const handleResendOTP = useCallback(async () => {
    if (resendCountdown > 0) return
    await handleSendEmailCode()
  }, [handleSendEmailCode, resendCountdown])

  // Handle password sign-in
  const handlePasswordSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setIsLoading(true)
    setError(null)
    setErrorMsg(null)

    // Check if Zotero instance is already associated with another account
    const storedUserEmail = getPref("userEmail");
    if (storedUserEmail && storedUserEmail.toLowerCase() !== email.toLowerCase()) {
      const errorMessage = `This Zotero instance is already associated with another Beaver account. Please sign in with the correct account (${storedUserEmail}).`;
      setError(errorMessage);
      setErrorMsg(errorMessage);
      setIsLoading(false)
      return;
    }
    
    try {
      const { data, error } = await supabase.auth.signInWithPassword({
        email,
        password,
      })
      
      if (error) throw error
      
      if (data.user) {
        // Wait for useProfileSync to fetch the profile
        setIsWaitingForProfile(true);
        // isLoading will be set to false when profile loads or timeout occurs
      }
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'An error occurred during login'
      setError(errorMessage)
      setErrorMsg(errorMessage)
      setIsLoading(false)
    }
  }

  // Handle forgot password - redirect to webapp
  const handleForgotPassword = () => {
    const baseUrl = process.env.WEBAPP_BASE_URL?.replace(/\/$/, '') || ''
    const params = new URLSearchParams({
      'forgot-password': 'true'
    })
    
    if (email) {
      params.set('email', email)
    }
    
    Zotero.launchURL(`${baseUrl}/login?${params.toString()}`)
  }

  // Reset to initial state
  const resetToInitial = () => {
    resetLoginForm()
  }

  // Show loading while waiting for profile
  if (isWaitingForProfile) {
    return (
      <div className="text-center webapp-space-y-3">
        <div className="webapp-spinner webapp-mx-auto"></div>
        <p className="text-sm font-color-secondary">Setting up your account...</p>
      </div>
    )
  }

  // Render OTP verification
  if (step === 'otp' && authMethod === 'code') {
    return (
      <OTPVerification
        email={email}
        onVerify={handleVerifyOTP}
        onResend={handleResendOTP}
        onChangeEmail={resetToInitial}
        error={error}
        isLoading={isLoading}
        resendCountdown={resendCountdown}
        title="Check your email"
        description={`We sent a 6-digit code to ${email}`}
      />
    )
  }

  // If we are in OTP step but not in code method, reset to initial
  if (step === 'otp' && authMethod !== 'code') {
    resetToInitial();
    return null;
  }

  // Render main login form
  return (
    <div className="webapp-space-y-6">
      {/* Initial login form with email and method selection */}
      {(authMethod === 'initial' || (authMethod === 'code' && step === 'method-selection')) && (
        <form onSubmit={(e) => {
          e.preventDefault()
          handleSendEmailCode()
        }} className="webapp-space-y-6">
          <div>
            <label htmlFor="email" className="block text-sm font-medium font-color-primary mb-2">
              Email address
            </label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value)
                setError(null)
                setErrorMsg(null)
              }}
              required
              className="webapp-input"
              placeholder="Enter your email"
              ref={emailInputRef}
            />
            {error && (
              <p className='text-xs font-color-red mt-2'>
                {error == 'Signups not allowed for otp'
                  ? <span>Invalid email address. Signup <span className="text-link-red cursor-pointer" onClick={() => Zotero.launchURL(process.env.WEBAPP_BASE_URL + '/join')}>here</span>.</span>
                  : error.includes('not linked to your account')
                  ? <span>This Zotero instance is not linked to your Beaver account. <span className="text-link-red cursor-pointer" onClick={() => Zotero.launchURL(process.env.WEBAPP_BASE_URL + '/docs/multiple-devices#this-zotero-instance-is-not-linked-to-your-account')}>Learn more</span>.</span>
                  : error.includes('already associated with another Beaver account')
                  ? <span>This Zotero instance is already associated with {associatedEmail ? <strong>{associatedEmail}</strong> : 'another account'}. <span className="text-link-red cursor-pointer" onClick={() => Zotero.launchURL(process.env.WEBAPP_BASE_URL + '/docs/multiple-devices#this-zotero-instance-is-already-associated-with-another-beaver-account')}>Learn more</span>.</span>
                  : error}
              </p>
            )}
          </div>

          <div className="webapp-space-y-3 display-flex flex-col items-center">
            <button
              type="submit"
              disabled={!email || isLoading}
              className="webapp-btn webapp-btn-primary"
            >
              {isLoading && <div className="webapp-spinner"></div>}
              {isLoading ? 'Sending...' : 'Send code to email'}
            </button>
            <div className="text-center webapp-space-y-3">
                <button
                    type="button"
                    onClick={() => {
                      setAuthMethod('password')
                      setError(null)
                      setErrorMsg(null)
                    }}
                    disabled={isLoading}
                    className="text-link-muted text-sm"
                >
                    Use password
                </button>
              </div>
          </div>
        </form>
      )}

      {/* Password authentication */}
      {authMethod === 'password' && (
        <div className="webapp-space-y-5">
          <div>
            <label htmlFor="email-password" className="block text-sm font-medium font-color-primary mb-2">
              Email address
            </label>
            <input
              id="email-password"
              type="email"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value)
                setError(null)
                setErrorMsg(null)
              }}
              required
              className="webapp-input"
              placeholder="Enter your email"
            />
            {error && (
              <p className='text-xs font-color-red mt-2'>
                {error.includes('not linked to your account')
                  ? <span>This Zotero instance is not linked to your account. <span className="text-link-red cursor-pointer" onClick={() => Zotero.launchURL(process.env.WEBAPP_BASE_URL + '/docs/multiple-devices#this-zotero-instance-is-not-linked-to-your-account')}>Learn more</span>.</span>
                  : error.includes('already associated with another Beaver account')
                  ? <span>This Zotero instance is already associated with {associatedEmail ? <strong>{associatedEmail}</strong> : 'another account'}. <span className="text-link-red cursor-pointer" onClick={() => Zotero.launchURL(process.env.WEBAPP_BASE_URL + '/docs/multiple-devices#this-zotero-instance-is-already-associated-with-another-beaver-account')}>Learn more</span>.</span>
                  : error}
              </p>
            )}
          </div>

          <form onSubmit={handlePasswordSubmit} className="webapp-space-y-6">
            <div>
              <label htmlFor="password" className="block text-sm font-medium font-color-primary mb-2">
                Password
              </label>
              <input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                className="webapp-input"
                placeholder="Enter your password"
                autoFocus
              />
            </div>
            
            <button
              type="submit"
              onClick={() => setAuthMethod('password')}
              disabled={isLoading}
              className="webapp-btn webapp-btn-primary"
            >
              {isLoading && <div className="webapp-spinner"></div>}
              {isLoading ? 'Signing in...' : 'Sign in'}
            </button>
            
            <div className="text-center webapp-space-y-3">
              <button
                type="button"
                onClick={resetToInitial}
                disabled={isLoading}
                className="text-link-muted text-sm"
              >
                Sign in with email code
              </button>
              <div>
                <button
                  type="button"
                  onClick={handleForgotPassword}
                  disabled={isLoading}
                  className="text-link-muted text-sm"
                >
                  Forgot password?
                </button>
              </div>
            </div>
          </form>
        </div>
      )}

      {/* Additional links */}
      {!isWaitingForProfile && (
        <div className="mt-8 text-center">
            <p className="font-color-secondary">
                Don&apos;t have an account?{' '}
                <span
                    onClick={() => Zotero.launchURL(process.env.WEBAPP_BASE_URL + '/join')}
                    className="text-link font-medium"
                >
                    Get started
                </span>
            </p>
        </div>
      )}
    </div>
  )
}
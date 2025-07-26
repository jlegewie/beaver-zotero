import React, { useState, useEffect, useCallback } from 'react'
import { supabase } from '../../../src/services/supabaseClient'
import { useAtomValue } from 'jotai'
import { isProfileLoadedAtom, isProfileInvalidAtom } from '../../atoms/profile'
import { OTPVerification } from './OTPVerification'
import { sendOTP, verifyOTP, getOTPErrorMessage } from './otp'
import Button from '../ui/Button'
import { getPref, setPref } from '../../../src/utils/prefs'

type AuthMethod = 'initial' | 'code' | 'password'
type LoginStep = 'method-selection' | 'otp' | 'forgot-password'

interface SignInFormProps {
  setErrorMsg: (errorMsg: string | null) => void;
  emailInputRef?: React.RefObject<HTMLInputElement>;
}

export default function SignInForm({ setErrorMsg, emailInputRef }: SignInFormProps) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [authMethod, setAuthMethod] = useState<AuthMethod>('initial')
  const [step, setStep] = useState<LoginStep>('method-selection')
  const [resendCountdown, setResendCountdown] = useState(0)
  const [isWaitingForProfile, setIsWaitingForProfile] = useState(false)
  const isProfileLoaded = useAtomValue(isProfileLoadedAtom)
  const isProfileInvalid = useAtomValue(isProfileInvalidAtom)

  const PROFILE_LOAD_TIMEOUT = 10000; // 10 second timeout

  // Handle initial focus and email prefill
  useEffect(() => {
    const storedUserEmail = getPref("userEmail");
    if (storedUserEmail) {
      setEmail(storedUserEmail);
    } else {
      emailInputRef?.current?.focus();
    }
  }, [emailInputRef]);

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
    }
  }, [isProfileInvalid, setErrorMsg]);

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
  }, [email])

  // Handle OTP verification
  const handleVerifyOTP = useCallback(async (otpCode: string) => {
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
    Zotero.launchURL(process.env.WEBAPP_BASE_URL + '/forgot-password')
  }

  // Reset to initial state
  const resetToInitial = () => {
    setAuthMethod('initial')
    setStep('method-selection')
    setError(null)
    setPassword('')
  }

  // Show loading while waiting for profile
  if (isWaitingForProfile) {
    return (
      <div className="display-flex flex-col items-center gap-2 p-4">
        <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-primary"></div>
        <p className="text-sm font-color-secondary">Setting up your account...</p>
      </div>
    )
  }

  // Forgot password just redirects to webapp - no form needed in plugin

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

  // Render main login form
  return (
    <div className="display-flex flex-col gap-5 w-full my-2">
      {/* Initial login form with email and method selection */}
      {authMethod === 'initial' && (
        <>
          <div className="display-flex flex-col gap-2">
            <div className="display-flex flex-row items-center justify-between">
              <label htmlFor="email" className="text-sm font-medium">
                Email address
              </label>
              {error && (
                <span className='text-xs font-color-red'>
                  {error == 'Signups not allowed for otp'
                    ? <span>Invalid email address</span>
                    : error}
                </span>
              )}
            </div>
            
            
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
              className="border-quinary rounded-md -ml-05 p-2 bg-quaternary focus:border-tertiary transition outline-none"
              placeholder="your.email@example.com"
              ref={emailInputRef}
            />
          </div>

          <div className="display-flex flex-col gap-2">
            <Button
              onClick={handleSendEmailCode}
              variant="solid"
              className="ml-05"
              loading={isLoading}
              disabled={email === "" || isLoading}
            >
              {isLoading ? 'Sending...' : 'Send code to email'}
            </Button>
            
            <Button
              onClick={() => setAuthMethod('password')}
              variant="outline"
              className="ml-05"
              disabled={isLoading}
            >
              Use password
            </Button>
          </div>
        </>
      )}

      {/* Password authentication */}
      {authMethod === 'password' && (
        <form onSubmit={handlePasswordSubmit} className="display-flex flex-col gap-5">
          <div className="display-flex flex-col gap-2">
            <label htmlFor="email-password" className="text-sm font-medium">Email address</label>
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
              className="border-quinary rounded-md -ml-05 p-2 bg-quaternary focus:border-tertiary transition outline-none"
              placeholder="your.email@example.com"
            />
          </div>
          
          <div className="display-flex flex-col gap-2">
            <div className="display-flex flex-row gap-2 flex-1">
              <label htmlFor="password" className="text-sm font-medium">Password</label>
              <div className="flex-1" />
              <div className="text-sm font-color-tertiary">
                <span
                  onClick={handleForgotPassword}
                  className="font-color-tertiary hover:font-color-primary transition cursor-pointer"
                  style={{textDecoration: 'none'}}
                  onMouseEnter={(e) => e.currentTarget.style.textDecoration = 'underline'}
                  onMouseLeave={(e) => e.currentTarget.style.textDecoration = 'none'}
                >
                  Forgot password?
                </span>
              </div>
            </div>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              className="border-quinary rounded-md -ml-05 p-2 bg-quaternary transition outline-none"
              placeholder="••••••••"
              autoFocus
            />
          </div>
          
          <div className="display-flex flex-col gap-2">
            <Button
              type="submit"
              onClick={() => setPref("authMethod", "password")}
              variant="solid"
              className="ml-05"
              loading={isLoading}
              disabled={email === "" || password === "" || isLoading}
            >
              {isLoading ? 'Signing in...' : 'Sign in'}
            </Button>
            
            <Button
              type="button"
              onClick={resetToInitial}
              variant="outline"
              className="ml-05"
              disabled={isLoading}
            >
              Sign in with email code
            </Button>
          </div>
        </form>
      )}
    </div>
  )
}
/**
 * Email one-time-code sign-in, against Supabase auth.
 *
 * Shared rather than per-client because none of it is about a host: it is the
 * Supabase auth contract plus the reading every client has to give the errors
 * that contract returns. Two clients spelling `shouldCreateUser` differently
 * would mean two different answers to "may an unknown email sign in here", and
 * an outage that one client explains and the other reports as "Unexpected token
 * <" is the same outage twice.
 */

import { supabase } from './supabaseClient'
import { EmailOtpType } from '@supabase/supabase-js'

export interface OTPSendOptions {
  shouldCreateUser?: boolean
  data?: Record<string, string>
}

export interface OTPVerifyResult {
  success: boolean
  error?: string
}

/**
 * Send OTP to email address
 */
export const sendOTP = async (email: string, options: OTPSendOptions = {}): Promise<void> => {
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: {
      shouldCreateUser: options.shouldCreateUser || false,
      data: options.data || {}
    }
  })
  
  if (error) throw error
}

/**
 * Verify OTP code
 */
export const verifyOTP = async (email: string, token: string, type: EmailOtpType = 'email'): Promise<void> => {
  const { error } = await supabase.auth.verifyOtp({
    email,
    token,
    type
  })
  
  if (error) throw error
}

/**
 * Validate OTP code format
 */
export const validateOTPCode = (code: string): boolean => {
  return code.length === 6 && /^\d{6}$/.test(code)
}

/**
 * Check if an error indicates a service outage (e.g. Supabase returning HTML instead of JSON)
 */
export const isServiceUnavailableError = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false
  const msg = error.message.toLowerCase()
  return (
    msg.includes('json.parse') ||
    msg.includes('unexpected character') ||
    msg.includes('unexpected token') ||
    msg.includes('failed to fetch') ||
    msg.includes('networkerror') ||
    msg.includes('fetch failed') ||
    msg.includes('load failed')
  )
}

export const SERVICE_UNAVAILABLE_MESSAGE =
    'Beaver is temporarily unable to connect. Please try again in a moment. ' +
    'If the issue persists, check beaverapp.ai for status updates.'
/**
 * Get user-friendly error message for OTP errors
 */
export const getOTPErrorMessage = (error: Error): string => {
  if (isServiceUnavailableError(error)) {
    return SERVICE_UNAVAILABLE_MESSAGE
  }

  const message = error.message.toLowerCase()

  if (message.includes('invalid')) {
    return 'Invalid code'
  } else if (message.includes('expired')) {
    return 'Code expired. Please request a new one.'
  } else if (message.includes('too many')) {
    return 'Too many attempts. Please try again later.'
  } else {
    return 'Verification failed'
  }
}

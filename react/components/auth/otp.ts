import { supabase } from '../../../src/services/supabaseClient'
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
 * Get user-friendly error message for OTP errors
 */
export const getOTPErrorMessage = (error: Error): string => {
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

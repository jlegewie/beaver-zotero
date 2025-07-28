import React, { useState, useEffect, useRef, useCallback } from 'react'
import { validateOTPCode } from './otp'
import { createOTPInputHandlers } from './otp-ui'
import { setPref } from '../../../src/utils/prefs'

export interface OTPVerificationProps {
  /** The email address to display */
  email: string
  /** Callback when verification should happen */
  onVerify: (code: string) => Promise<void>
  /** Callback when resend should happen */
  onResend: () => Promise<void>
  /** Optional callback to change email */
  onChangeEmail?: () => void
  /** Error message to display */
  error?: string | null
  /** Loading state */
  isLoading?: boolean
  /** Whether to auto-submit when 6 digits are entered (default: true) */
  autoSubmit?: boolean
  /** Countdown for resend button */
  resendCountdown?: number
  /** Custom title (default: "Check your email") */
  title?: string
  /** Custom description */
  description?: string
}

export function OTPVerification({
  email,
  onVerify,
  onResend,
  onChangeEmail,
  error,
  isLoading = false,
  autoSubmit = true,
  resendCountdown = 0,
  title = "Check your email",
  description
}: OTPVerificationProps) {
  const [otpCode, setOtpCode] = useState('')
  const otpInputRefs = useRef<(HTMLInputElement | null)[]>([])
  const isVerifying = useRef(false)
  
  // Create OTP input handlers
  const { handleOTPChange, handleOTPKeyDown, handleOTPPaste, clearOTP, focusFirstInput } = createOTPInputHandlers(
    otpCode,
    setOtpCode,
    otpInputRefs
  )
  
  // Focus first input on mount
  useEffect(() => {
    focusFirstInput()
    isVerifying.current = false
  }, [])
  
  const handleVerify = useCallback(async () => {
    if (!validateOTPCode(otpCode) || isLoading) return
    
    try {
      isVerifying.current = true
      await onVerify(otpCode)
      setPref("authMethod", "otp")
    } catch (error) {
      console.log('handleVerify error', error)
      // On any error during verification, clear the input
      clearOTP()
    } finally {
      // This needs to be in a finally block to correctly handle multiple submissions
      isVerifying.current = false
    }
  }, [otpCode, onVerify, isLoading, clearOTP])

  // Auto-submit when OTP is complete
  useEffect(() => {
    if (autoSubmit && validateOTPCode(otpCode) && !isVerifying.current && !isLoading) {
      isVerifying.current = true
      handleVerify()
    }
  }, [otpCode, handleVerify, autoSubmit, isLoading])

  const defaultDescription = `We sent a 6-digit code to ${email}`

  return (
    <div className="webapp-max-w-md">
      <h1 className="webapp-text-2xl webapp-font-bold mb-4 font-color-primary">
        {title}
      </h1>
      <p className="font-color-secondary mb-8">
        {description || defaultDescription}
      </p>
      
      <div className="webapp-space-y-6">
        <div>
          <div className="display-flex justify-between items-center mb-3">
            <label className="text-sm font-medium font-color-primary">
              Verification code
            </label>
          </div>
          <div className="display-flex gap-2">
            {[0, 1, 2, 3, 4, 5].map((index) => (
              <input
                key={index}
                ref={(el) => { otpInputRefs.current[index] = el }}
                type="text"
                maxLength={1}
                value={otpCode[index] || ''}
                onChange={(e) => handleOTPChange(index, e.target.value)}
                onKeyDown={(e) => handleOTPKeyDown(index, e)}
                onPaste={(e) => handleOTPPaste(index, e)}
                disabled={isLoading}
                className="webapp-otp-input"
              />
            ))}
          </div>
          <p className="font-color-red text-sm mt-1">{error || '\u00A0'}</p>
        </div>
        
        <button
          onClick={handleVerify}
          disabled={!validateOTPCode(otpCode) || isLoading}
          className="webapp-btn webapp-btn-primary"
        >
          {isLoading && <div className="webapp-spinner"></div>}
          {isLoading ? 'Verifying...' : 'Verify Email'}
        </button>
        
        <div className="text-center webapp-space-y-3">
          <button
            onClick={onResend}
            disabled={resendCountdown > 0 || isLoading}
            className={`webapp-link-muted text-sm ${resendCountdown > 0 || isLoading ? 'opacity-50 cursor-not-allowed' : ''}`}
            style={{ pointerEvents: resendCountdown > 0 || isLoading ? 'none' : 'auto' }}
          >
            {resendCountdown > 0 
              ? `Resend code in ${resendCountdown}s` 
              : 'Resend code'
            }
          </button>
          
          {onChangeEmail && (
            <div>
              <button
                onClick={onChangeEmail}
                disabled={isLoading}
                className={`webapp-link-muted text-sm ${isLoading ? 'opacity-50 cursor-not-allowed' : ''}`}
                style={{ pointerEvents: isLoading ? 'none' : 'auto' }}
              >
                Wrong email? Change it
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
} 
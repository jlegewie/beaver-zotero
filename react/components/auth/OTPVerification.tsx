import React, { useState, useEffect, useRef, useCallback } from 'react'
import { validateOTPCode } from './otp'
import { createOTPInputHandlers } from './otp-ui'
import Button from '../ui/Button'
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
  }, [focusFirstInput])
  
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
    <div className="display-flex flex-col gap-5 w-full my-2">
      <div className="display-flex flex-col gap-2 text-center">
        <h2 className="text-lg font-semibold">
          {title}
        </h2>
        <p className="text-sm font-color-secondary">
          {description || defaultDescription}
        </p>
      </div>
      
      <div className="display-flex flex-col gap-4">
        <div className="display-flex flex-col gap-2">
          <label className="text-sm font-medium">
            Verification code
          </label>
          <div className="display-flex flex-row">
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
                className="text-center border-popup rounded-md bg-quaternary focus:border-tertiary transition outline-none text-base font-medium disabled:opacity-50"
                style={{
                  width: '2rem',
                  height: '2rem'
                }}
              />
            ))}
          </div>
          {error && <p className="text-red-800 text-sm text-center">{error}</p>}
        </div>
        
        <Button
          onClick={handleVerify}
          disabled={!validateOTPCode(otpCode) || isLoading}
          variant="solid"
          className="ml-05"
          loading={isLoading}
        >
          {isLoading ? 'Verifying...' : 'Verify Email'}
        </Button>
        
        <div className="display-flex flex-col gap-2 text-center">
          <span
            onClick={onResend}
            className={`text-sm cursor-pointer font-color-tertiary hover:font-color-primary transition ${
              resendCountdown > 0 || isLoading ? 'opacity-50 cursor-not-allowed' : ''
            }`}
            style={{
              pointerEvents: resendCountdown > 0 || isLoading ? 'none' : 'auto',
              textDecoration: 'none'
            }}
            onMouseEnter={(e) => {
              if (resendCountdown === 0 && !isLoading) {
                e.currentTarget.style.textDecoration = 'underline'
              }
            }}
            onMouseLeave={(e) => e.currentTarget.style.textDecoration = 'none'}
          >
            {resendCountdown > 0 
              ? `Resend code in ${resendCountdown}s` 
              : 'Resend code'
            }
          </span>
          
          {onChangeEmail && (
            <span
              onClick={onChangeEmail}
              className={`text-sm cursor-pointer font-color-tertiary hover:font-color-primary transition ${
                isLoading ? 'opacity-50 cursor-not-allowed' : ''
              }`}
              style={{
                pointerEvents: isLoading ? 'none' : 'auto',
                textDecoration: 'none'
              }}
              onMouseEnter={(e) => {
                if (!isLoading) {
                  e.currentTarget.style.textDecoration = 'underline'
                }
              }}
              onMouseLeave={(e) => e.currentTarget.style.textDecoration = 'none'}
            >
              Wrong email? Change it
            </span>
          )}
        </div>
      </div>
    </div>
  )
} 
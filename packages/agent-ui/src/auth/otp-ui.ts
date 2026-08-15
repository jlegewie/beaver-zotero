/**
 * Keyboard and paste behavior for a row of single-character code boxes.
 *
 * Split from the component because it is the fiddly half and the half that must
 * not vary between clients: advancing on entry, stepping back through empties on
 * backspace, arrowing without editing, and taking a pasted code from any box.
 *
 * `KeyboardEvent` and `ClipboardEvent` are React's synthetic events, imported
 * rather than reached for through a `React.` namespace: this package's program
 * has no UMD global, so the DOM's same-named types would otherwise be picked up
 * silently and describe a different object.
 */

import { ClipboardEvent, KeyboardEvent, MutableRefObject } from 'react'

export interface OTPInputHandlers {
  handleOTPChange: (index: number, value: string) => void
  handleOTPKeyDown: (index: number, e: KeyboardEvent) => void
  handleOTPPaste: (index: number, e: ClipboardEvent) => void
  clearOTP: () => void
  focusFirstInput: () => void
}

/**
 * Creates OTP input handlers for managing 6-digit OTP input fields
 */
export const createOTPInputHandlers = (
  otpCode: string,
  setOtpCode: (code: string) => void,
  inputRefs: MutableRefObject<(HTMLInputElement | null)[]>
): OTPInputHandlers => {
  
  const handleOTPPaste = (index: number, e: ClipboardEvent) => {
    e.preventDefault()
    
    // Get pasted text and extract only digits
    const pasteData = e.clipboardData.getData('text')
    const digits = pasteData.replace(/\D/g, '').slice(0, 6)
    
    if (digits.length > 0) {
      // Create new OTP array filled with empty strings
      const newOtp = ['', '', '', '', '', '']
      
      // Fill with pasted digits starting from position 0
      digits.split('').forEach((digit, i) => {
        if (i < 6) {
          newOtp[i] = digit
        }
      })
      
      setOtpCode(newOtp.join(''))
      
      // Focus the input after the last pasted digit, or the last input if all are filled
      const nextFocusIndex = Math.min(digits.length, 5)
      setTimeout(() => {
        inputRefs.current[nextFocusIndex]?.focus()
      }, 0)
    }
  }
  
  const handleOTPChange = (index: number, value: string) => {
    const digits = value.replace(/\D/g, '')

    if (digits.length === 1) {
      // Handle single digit input
      const newOtp = otpCode.split('')
      newOtp[index] = digits
      setOtpCode(newOtp.join(''))
      
      // Auto-advance to next input
      if (index < 5) {
        inputRefs.current[index + 1]?.focus()
        inputRefs.current[index + 1]?.select()
      }
    } else if (digits.length === 0) {
      // Handle clearing the field
      const newOtp = otpCode.split('')
      newOtp[index] = ''
      setOtpCode(newOtp.join(''))
    }
    // Note: Multi-digit input (paste) is now handled by handleOTPPaste
  }
  
  const handleOTPKeyDown = (index: number, e: KeyboardEvent) => {
    if (e.key === 'Backspace') {
      e.preventDefault()
      const newOtp = otpCode.split('')
      if (newOtp[index]) {
        newOtp[index] = ''
        setOtpCode(newOtp.join(''))
      } else if (index > 0) {
        newOtp[index - 1] = ''  // Clear the previous field's digit
        setOtpCode(newOtp.join(''))  // Update the state
        inputRefs.current[index - 1]?.focus()
      }
    } else if (e.key === 'Delete') {
      e.preventDefault()
      const newOtp = otpCode.split('')
      if (newOtp[index]) {
        newOtp[index] = ''
        setOtpCode(newOtp.join(''))
      }
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault()
      if (index > 0) {
        inputRefs.current[index - 1]?.focus()
      }
    } else if (e.key === 'ArrowRight') {
      e.preventDefault()
      if (index < 5) {
        inputRefs.current[index + 1]?.focus()
      }
    }
  }
  
  const clearOTP = () => {
    setOtpCode('')
    inputRefs.current[0]?.focus()
  }
  
  const focusFirstInput = () => {
    inputRefs.current[0]?.focus()
  }
  
  return {
    handleOTPChange,
    handleOTPKeyDown,
    handleOTPPaste,
    clearOTP,
    focusFirstInput
  }
}

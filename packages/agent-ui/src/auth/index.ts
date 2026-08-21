// The shared sign-in render layer. Like the icon and primitive barrels, this
// exists so the family has a single root the closure check can start from: the
// input handlers are only ever reached by the component beside them, and would
// otherwise be reachable by accident rather than on purpose.
//
// What is deliberately not here: the sign-in form itself. Which methods a client
// offers, what it does about an account already signed in on the same machine,
// and where "create an account" leads are client questions, and the two clients
// answer them differently enough that a shared form would be flags. The code
// screen is the part that is the same everywhere.

export { OTPVerification } from './OTPVerification';
export type { OTPVerificationProps } from './OTPVerification';

export { createOTPInputHandlers } from './otp-ui';
export type { OTPInputHandlers } from './otp-ui';

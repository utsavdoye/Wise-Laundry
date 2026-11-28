import crypto from 'node:crypto'
import { User } from '../models/User.js'
import { Session } from '../models/Session.js'
import { EmailLoginCode } from '../models/EmailLoginCode.js'
import { ApiError } from '../utils/errors.js'
import { generateSecureToken, hashToken } from '../utils/crypto.js'
import { verifyGoogleCredential } from './google.service.js'
import { sendEmail, loginCodeEmail } from './email.service.js'

const CODE_TTL_MS = 10 * 60 * 1000 // a code is good for 10 minutes
const RESEND_COOLDOWN_MS = 45 * 1000 // wait 45s between code requests
const MAX_TRIES = 5 // wrong guesses allowed before the code is burned

const sixDigitCode = () => String(crypto.randomInt(0, 1_000_000)).padStart(6, '0')

export async function registerUser({ fullName, email, phone, password, req }) {
  const existing = await User.findOne({ email })
  if (existing) {
    throw ApiError.conflict('An account with this email already exists.', {
      email: 'An account with this email already exists.',
    })
  }

  const passwordHash = await User.hashPassword(password)
  const verificationToken = generateSecureToken(24)

  const user = await User.create({
    fullName,
    email,
    phone,
    passwordHash,
    role: 'CUSTOMER',
    isEmailVerified: false,
    emailVerificationToken: hashToken(verificationToken),
    emailVerificationExpires: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24 hours
  })

  const { rawToken } = await Session.createSession(user._id, req)
  return { user, rawToken, verificationToken }
}

export async function loginUser({ email, password, req }) {
  const user = await User.findOne({ email })
  if (!user) {
    throw ApiError.badRequest('Invalid email or password.')
  }

  const valid = await user.verifyPassword(password)
  if (!valid) {
    throw ApiError.badRequest('Invalid email or password.')
  }

  const { rawToken } = await Session.createSession(user._id, req)
  return { user, rawToken }
}

/**
 * Sign in with Google. Google has already checked the email, so it is marked verified.
 * - Known Google account or known email: signs in (and links the Google account).
 * - New person without a phone number: returns needsPhone so the frontend can ask for it.
 * - New person with a phone number: creates the customer and signs in.
 */
export async function googleSignIn({ credential, phone, req }) {
  const profile = await verifyGoogleCredential(credential)

  let user = await User.findOne({ $or: [{ googleId: profile.googleId }, { email: profile.email }] })

  if (user) {
    let changed = false
    if (!user.googleId) {
      user.googleId = profile.googleId
      changed = true
    }
    if (!user.isEmailVerified) {
      user.isEmailVerified = true
      user.emailVerificationToken = null
      user.emailVerificationExpires = null
      changed = true
    }
    if (changed) await user.save()
  } else {
    if (!phone) {
      return { needsPhone: true, profile: { fullName: profile.fullName, email: profile.email } }
    }
    user = await User.create({
      fullName: profile.fullName,
      email: profile.email,
      phone,
      googleId: profile.googleId,
      role: 'CUSTOMER',
      isEmailVerified: true,
    })
  }

  const { rawToken } = await Session.createSession(user._id, req)
  return { user, rawToken, needsPhone: false }
}

/**
 * Email login step 1: email a 6-digit code. One code per email; the newest wins.
 * Returns when the user may ask for another, plus the code itself (shown only in
 * non-production, like the register and reset flows).
 */
export async function requestEmailCode(email) {
  const existing = await EmailLoginCode.findOne({ email })
  if (existing && existing.resendAvailableAt > new Date()) {
    throw ApiError.rateLimited('Please wait a few seconds before asking for another code.')
  }

  const code = sixDigitCode()
  const now = Date.now()
  const doc = await EmailLoginCode.findOneAndUpdate(
    { email },
    {
      email,
      codeHash: hashToken(code),
      expiresAt: new Date(now + CODE_TTL_MS),
      tries: 0,
      resendAvailableAt: new Date(now + RESEND_COOLDOWN_MS),
    },
    { upsert: true, new: true },
  )

  const { sent } = await sendEmail({ to: email, ...loginCodeEmail(code) })
  if (!sent) {
    await EmailLoginCode.deleteOne({ email })
    throw new ApiError(503, 'EMAIL_UNAVAILABLE', "We couldn't send the code right now. Please try again, or continue with Google.")
  }

  return { resendAvailableAt: doc.resendAvailableAt.toISOString(), code }
}

/**
 * Email login step 2: check the code and sign in.
 * - Known email: signs in.
 * - New email without name+phone yet: returns isNewUser and KEEPS the code valid,
 *   so the frontend can collect them and submit once more.
 * - New email with name+phone: creates the customer and signs in.
 */
export async function verifyEmailCode({ email, code, fullName, phone, req }) {
  const record = await EmailLoginCode.findOne({ email })
  if (!record || record.expiresAt < new Date()) {
    throw ApiError.badRequest('This code has expired. Please ask for a new one.', { code: 'This code has expired. Please ask for a new one.' })
  }
  if (record.tries >= MAX_TRIES) {
    await EmailLoginCode.deleteOne({ email })
    throw ApiError.badRequest('Too many wrong tries. Please ask for a new code.', { code: 'Too many wrong tries. Please ask for a new code.' })
  }
  if (record.codeHash !== hashToken(code)) {
    record.tries += 1
    await record.save()
    throw ApiError.badRequest('That code is not right. Check it and try again.', { code: 'That code is not right. Check it and try again.' })
  }

  let user = await User.findOne({ email })
  if (!user) {
    // Brand-new person: we need a name and phone before the account can exist.
    if (!fullName || !phone) {
      return { isNewUser: true }
    }
    user = await User.create({ fullName, email, phone, role: 'CUSTOMER', isEmailVerified: true })
  } else if (!user.isEmailVerified) {
    // Signing in with an emailed code proves they own the address.
    user.isEmailVerified = true
    await user.save()
  }

  await EmailLoginCode.deleteOne({ email }) // a code works only once
  const { rawToken } = await Session.createSession(user._id, req)
  return { user, rawToken, isNewUser: false }
}

export async function logoutUser(rawToken) {
  if (rawToken) {
    await Session.revokeSession(rawToken)
  }
}

export async function verifyEmail(token) {
  if (!token) throw ApiError.badRequest('Verification token is required.')

  const tokenHash = hashToken(token)
  const user = await User.findOne({
    emailVerificationToken: tokenHash,
    emailVerificationExpires: { $gt: new Date() },
  })

  if (!user) {
    throw ApiError.badRequest('Invalid or expired verification token.')
  }

  user.isEmailVerified = true
  user.emailVerificationToken = null
  user.emailVerificationExpires = null
  await user.save()

  return { message: 'Email verified successfully.' }
}

export async function forgotPassword(email) {
  const user = await User.findOne({ email })
  let resetToken = null

  if (user) {
    resetToken = generateSecureToken(24)
    user.passwordResetToken = hashToken(resetToken)
    user.passwordResetExpires = new Date(Date.now() + 60 * 60 * 1000) // 1 hour
    await user.save()
  }

  return { resetToken }
}

export async function resetPassword({ token, newPassword }) {
  const tokenHash = hashToken(token)
  const user = await User.findOne({
    passwordResetToken: tokenHash,
    passwordResetExpires: { $gt: new Date() },
  })

  if (!user) {
    throw ApiError.badRequest('Invalid or expired reset token.')
  }

  user.passwordHash = await User.hashPassword(newPassword)
  user.passwordResetToken = null
  user.passwordResetExpires = null
  await user.save()

  // Revoke all existing sessions for security
  await Session.revokeAllUserSessions(user._id)

  return { message: 'Password has been reset successfully. Please log in with your new password.' }
}


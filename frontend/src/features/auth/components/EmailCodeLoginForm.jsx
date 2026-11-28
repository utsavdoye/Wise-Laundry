import { useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import { Input, FieldShell, control } from '../../../components/ui/Input'
import { Button } from '../../../components/ui/Button'
import { useAuth } from '../hooks/useAuth'
import { cn } from '../../../utils/cn'
import { isEmail, isPhone, safeRedirect, homeFor } from '../../../utils/bookingValidation'
import { OtpInput, useCountdown } from './OtpLoginForm'

const CODE_LENGTH = 6
const digitsOnly = (v) => v.replace(/\D/g, '')

/**
 * Passwordless login with an email and a one-time code.
 * Steps: email → code → (new emails only) name + mobile number.
 */
export function EmailCodeLoginForm() {
  const { requestEmailCode, verifyEmailCode } = useAuth()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const [step, setStep] = useState('email') // email | code | profile
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [fullName, setFullName] = useState('')
  const [phone, setPhone] = useState('')
  const [resendAt, setResendAt] = useState(null)
  const [errors, setErrors] = useState({})
  const [formError, setFormError] = useState('')
  const [pending, setPending] = useState(false)
  const secondsLeft = useCountdown(resendAt)

  const cleanEmail = email.trim().toLowerCase()
  const done = (me) => navigate(safeRedirect(params.get('redirect'), homeFor(me)), { replace: true })

  function fail(err) {
    if (err.fields?.code) setErrors({ code: err.fields.code })
    else if (err.fields?.email) setErrors({ email: err.fields.email })
    else if (err.fields?.phone) setErrors({ phone: err.fields.phone })
    else if (err.fields?.fullName) setErrors({ fullName: err.fields.fullName })
    else setFormError(err.message)
    setPending(false)
  }

  async function sendCode(e) {
    e?.preventDefault()
    if (!isEmail(cleanEmail)) {
      setErrors({ email: 'Enter a valid email address.' })
      return
    }
    setPending(true)
    setErrors({})
    setFormError('')
    try {
      const res = await requestEmailCode(cleanEmail)
      setResendAt(res.data.resendAvailableAt)
      setCode('')
      setStep('code')
      setPending(false)
    } catch (err) {
      fail(err)
    }
  }

  async function checkCode(value = code) {
    if (value.length !== CODE_LENGTH) {
      setErrors({ code: 'Enter all 6 digits.' })
      return
    }
    if (pending) return
    setPending(true)
    setErrors({})
    setFormError('')
    try {
      const res = await verifyEmailCode(cleanEmail, value)
      if (res.isNewUser) {
        setStep('profile')
        setPending(false)
      } else {
        done(res.user)
      }
    } catch (err) {
      setCode('')
      fail(err)
    }
  }

  async function saveProfile(e) {
    e.preventDefault()
    const name = fullName.trim()
    const tenDigits = digitsOnly(phone).slice(-10)
    const found = {}
    if (name.length < 2) found.fullName = 'Enter your name.'
    if (!isPhone(tenDigits) || tenDigits.length !== 10) found.phone = 'Enter a valid 10-digit mobile number.'
    if (Object.keys(found).length) { setErrors(found); return }
    setPending(true)
    setErrors({})
    setFormError('')
    try {
      const res = await verifyEmailCode(cleanEmail, code, { fullName: name, phone: tenDigits })
      done(res.user)
    } catch (err) {
      fail(err)
    }
  }

  const alert = formError && (
    <p role="alert" className="rounded-xl bg-red-50 px-3.5 py-2.5 text-sm font-medium text-red-700">{formError}</p>
  )

  if (step === 'profile') {
    return (
      <form onSubmit={saveProfile} noValidate className="space-y-4">
        <div>
          <h2 className="text-lg font-bold">One last step</h2>
          <p className="mt-1 text-sm text-navy-500">Add your name and mobile number so our rider can reach you at pickup.</p>
        </div>
        {alert}
        <Input label="Full name" autoComplete="name" autoFocus value={fullName} onChange={(e) => setFullName(e.target.value)} error={errors.fullName} placeholder="Your name" />
        <FieldShell label="Mobile number" error={errors.phone}>
          {({ id, describedBy, invalid }) => (
            <div className={cn('flex h-11 items-center overflow-hidden rounded-xl border bg-white transition focus-within:border-brand-500 focus-within:ring-4 focus-within:ring-brand-100', invalid ? 'border-red-400' : 'border-line')}>
              <span className="border-r border-line px-3 text-sm font-semibold text-navy-700">+91</span>
              <input
                id={id}
                type="tel"
                inputMode="numeric"
                autoComplete="tel-national"
                placeholder="98765 43210"
                value={phone}
                onChange={(e) => setPhone(digitsOnly(e.target.value).slice(0, 10))}
                aria-describedby={describedBy}
                aria-invalid={invalid || undefined}
                className="h-full min-w-0 flex-1 px-3 text-sm tracking-wide text-navy-900 placeholder:text-navy-400 focus:outline-none"
              />
            </div>
          )}
        </FieldShell>
        <Button type="submit" size="lg" className="w-full" loading={pending}>Create account</Button>
      </form>
    )
  }

  if (step === 'code') {
    return (
      <form onSubmit={(e) => { e.preventDefault(); checkCode() }} noValidate className="space-y-4">
        <div>
          <button
            type="button"
            onClick={() => { setStep('email'); setErrors({}); setFormError('') }}
            className="mb-3 inline-flex items-center gap-1 text-sm font-semibold text-brand-700 hover:underline"
          >
            <ArrowLeft className="size-4" aria-hidden /> Change email
          </button>
          <p className="text-sm text-navy-500">
            We sent a code to <span className="font-semibold break-all text-navy-900">{cleanEmail}</span>
          </p>
        </div>
        {alert}
        <OtpInput value={code} onChange={setCode} onComplete={checkCode} error={errors.code} disabled={pending} />
        <Button type="submit" size="lg" className="w-full" loading={pending}>Verify and continue</Button>
        <p className="text-center text-sm text-navy-500">
          {secondsLeft > 0 ? (
            <>Resend code in <span className="font-semibold tabular-nums">0:{String(secondsLeft).padStart(2, '0')}</span></>
          ) : (
            <>Didn&apos;t get it? <button type="button" onClick={sendCode} disabled={pending} className="font-semibold text-brand-700 hover:underline disabled:opacity-50">Resend code</button></>
          )}
        </p>
      </form>
    )
  }

  return (
    <form onSubmit={sendCode} noValidate className="space-y-4">
      {alert}
      <Input
        label="Email"
        type="email"
        autoComplete="email"
        autoFocus
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        error={errors.email}
        placeholder="you@example.com"
        hint="We'll email you a 6-digit code to sign in — no password needed."
      />
      <Button type="submit" size="lg" className="w-full" loading={pending}>Continue with email</Button>
    </form>
  )
}

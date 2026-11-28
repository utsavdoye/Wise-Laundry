import { useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { Input, PasswordInput } from '../../../components/ui/Input'
import { Button } from '../../../components/ui/Button'
import { useAuth } from '../hooks/useAuth'
import { validate, required, isEmail, safeRedirect, homeFor } from '../../../utils/bookingValidation'
import { EmailCodeLoginForm } from './EmailCodeLoginForm'

const schema = {
  email: [[required, 'Enter your email.'], [isEmail, 'Enter a valid email address.']],
  password: [[required, 'Enter your password.']],
}

/** Email + password login. */
export function EmailLoginForm() {
  const { login } = useAuth()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const [values, setValues] = useState({ email: '', password: '' })
  const [errors, setErrors] = useState({})
  const [formError, setFormError] = useState('')
  const [pending, setPending] = useState(false)

  const set = (f) => (e) => setValues((v) => ({ ...v, [f]: e.target.value }))

  async function submit(e) {
    e.preventDefault()
    const body = values
    const found = validate(body, schema)
    setErrors(found)
    if (Object.keys(found).length) return
    setPending(true)
    setFormError('')
    try {
      const me = await login(body)
      navigate(safeRedirect(params.get('redirect'), homeFor(me)), { replace: true })
    } catch (err) {
      setFormError(err.message)
      setPending(false)
    }
  }

  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      {formError && <p role="alert" className="rounded-xl bg-red-50 px-3.5 py-2.5 text-sm font-medium text-red-700">{formError}</p>}
      <Input label="Email" type="email" autoComplete="email" value={values.email} onChange={set('email')} error={errors.email} placeholder="you@example.com" />
      <PasswordInput label="Password" autoComplete="current-password" value={values.password} onChange={set('password')} error={errors.password} />
      <Button type="submit" size="lg" className="w-full" loading={pending}>Log in</Button>
    </form>
  )
}

/** Login screen: a one-time email code by default, with password as a fallback. */
export function LoginForm() {
  const [params] = useSearchParams()
  const [usePassword, setUsePassword] = useState(false)

  return (
    <div className="space-y-4">
      {usePassword ? <EmailLoginForm /> : <EmailCodeLoginForm />}

      <button
        type="button"
        onClick={() => setUsePassword((v) => !v)}
        className="w-full text-center text-sm font-semibold text-brand-700 hover:underline"
      >
        {usePassword ? 'Email me a code instead' : 'Log in with a password instead'}
      </button>

      <p className="text-center text-sm text-navy-500">
        New to Wise Laundry? <Link to={`/register${params.get('redirect') ? `?redirect=${encodeURIComponent(params.get('redirect'))}` : ''}`} className="font-semibold text-brand-700 hover:underline">Create an account</Link>
      </p>
    </div>
  )
}

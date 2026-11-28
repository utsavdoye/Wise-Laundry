import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import app from '../src/app.js'
import { setupTestDb, teardownTestDb, clearTestDb } from './helpers/testDb.js'
import { User } from '../src/models/User.js'
import { EmailLoginCode } from '../src/models/EmailLoginCode.js'

describe('Email code login', () => {
  let server, baseUrl
  before(async () => { await setupTestDb(); server = app.listen(0); baseUrl = `http://127.0.0.1:${server.address().port}/api/v1` })
  after(async () => { server.close(); await teardownTestDb() })
  beforeEach(async () => { await clearTestDb() })

  const headers = { 'Content-Type': 'application/json', 'x-test-bypass-csrf': '1' }
  const post = (path, body) => fetch(`${baseUrl}${path}`, { method: 'POST', headers, body: JSON.stringify(body ?? {}) })

  // Request a code and read it back (exposed only outside production).
  async function requestCode(email) {
    const res = await post('/auth/email/request', { email })
    const body = await res.json()
    return { status: res.status, code: body.meta?.codeNotice, resendAvailableAt: body.data?.resendAvailableAt }
  }
  const wrong = (code) => String((Number(code) + 1) % 1_000_000).padStart(6, '0')

  async function register(email) {
    await post('/auth/register', { fullName: 'Asha Rao', email, phone: '9876543210', password: 'Password123!' })
  }

  test('an existing user signs in with a code', async () => {
    await register('asha@example.com')
    const { status, code } = await requestCode('asha@example.com')
    assert.equal(status, 200)
    assert.match(code, /^\d{6}$/)

    const res = await post('/auth/email/verify', { email: 'asha@example.com', code })
    const body = await res.json()
    assert.equal(res.status, 200)
    assert.equal(body.data.isNewUser, false)
    assert.equal(body.data.user.email, 'asha@example.com')
    assert.ok(res.headers.getSetCookie().some((c) => c.startsWith('wise_session=')))
  })

  test('a new email needs name + phone, then the account is created', async () => {
    const { code } = await requestCode('new@example.com')

    // Right code, but no profile yet -> asked to finish signing up, no account made.
    const first = await (await post('/auth/email/verify', { email: 'new@example.com', code })).json()
    assert.equal(first.data.isNewUser, true)
    assert.equal(first.data.user, null)
    assert.equal(await User.countDocuments({ email: 'new@example.com' }), 0)

    // Same code + details -> account created and signed in.
    const res = await post('/auth/email/verify', { email: 'new@example.com', code, fullName: 'New Person', phone: '9811122233' })
    const body = await res.json()
    assert.equal(res.status, 200)
    assert.equal(body.data.user.email, 'new@example.com')
    assert.equal(body.data.user.name, 'New Person')
    const saved = await User.findOne({ email: 'new@example.com' })
    assert.equal(saved.phone, '9811122233')
    assert.equal(saved.isEmailVerified, true)
  })

  test('a wrong code is rejected and burns out after too many tries', async () => {
    await register('asha@example.com')
    const { code } = await requestCode('asha@example.com')
    const bad = wrong(code)

    for (let i = 0; i < 5; i++) {
      const res = await post('/auth/email/verify', { email: 'asha@example.com', code: bad })
      assert.equal(res.status, 400)
      assert.ok((await res.json()).error.fields.code)
    }
    // Even the correct code no longer works once the tries are spent.
    assert.equal((await post('/auth/email/verify', { email: 'asha@example.com', code })).status, 400)
  })

  test('an expired code is rejected', async () => {
    await register('asha@example.com')
    const { code } = await requestCode('asha@example.com')
    await EmailLoginCode.updateOne({ email: 'asha@example.com' }, { $set: { expiresAt: new Date(Date.now() - 1000) } })
    assert.equal((await post('/auth/email/verify', { email: 'asha@example.com', code })).status, 400)
  })

  test('a code works only once', async () => {
    await register('asha@example.com')
    const { code } = await requestCode('asha@example.com')
    assert.equal((await post('/auth/email/verify', { email: 'asha@example.com', code })).status, 200)
    assert.equal((await post('/auth/email/verify', { email: 'asha@example.com', code })).status, 400)
  })

  test('asking again too quickly is throttled', async () => {
    await requestCode('asha@example.com')
    assert.equal((await post('/auth/email/request', { email: 'asha@example.com' })).status, 429)
  })
})

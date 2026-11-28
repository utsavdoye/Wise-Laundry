import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { config } from '../src/config/env.js'
import app from '../src/app.js'
import { setupTestDb, teardownTestDb, clearTestDb } from './helpers/testDb.js'
import { outbox, activeProvider, sendEmail, loginCodeEmail } from '../src/services/email.service.js'
import { Order } from '../src/models/Order.js'
import { User } from '../src/models/User.js'

const HOUR = 60 * 60 * 1000

describe('Email service', () => {
  let server, baseUrl
  before(async () => { await setupTestDb(); server = app.listen(0); baseUrl = `http://127.0.0.1:${server.address().port}/api/v1` })
  after(async () => { server.close(); await teardownTestDb() })
  beforeEach(async () => { await clearTestDb(); outbox.length = 0 })

  const headers = (cookie) => ({ 'Content-Type': 'application/json', cookie, 'x-test-bypass-csrf': '1' })
  const post = (cookie, path, body) => fetch(`${baseUrl}${path}`, { method: 'POST', headers: headers(cookie), body: JSON.stringify(body ?? {}) })
  async function signup(email) {
    const reg = await fetch(`${baseUrl}/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-test-bypass-csrf': '1' }, body: JSON.stringify({ fullName: 'Asha Rao', email, phone: '9876543210', password: 'Password123!' }) })
    return reg.headers.getSetCookie().find((c) => c.startsWith('wise_session=')).split(';')[0]
  }

  test('provider selection: resend > smtp > none', () => {
    const saved = { r: config.RESEND_API_KEY, h: config.SMTP_HOST, u: config.SMTP_USER }
    config.RESEND_API_KEY = ''; config.SMTP_HOST = ''; config.SMTP_USER = ''
    assert.equal(activeProvider(), 'none')
    config.SMTP_HOST = 'smtp.gmail.com'; config.SMTP_USER = 'x@gmail.com'
    assert.equal(activeProvider(), 'smtp')
    config.RESEND_API_KEY = 're_test'
    assert.equal(activeProvider(), 'resend')
    Object.assign(config, { RESEND_API_KEY: saved.r, SMTP_HOST: saved.h, SMTP_USER: saved.u })
  })

  test('login code email has the code in subject and body', async () => {
    const res = await sendEmail({ to: 'a@example.com', ...loginCodeEmail('481920') })
    assert.equal(res.sent, true)
    const mail = outbox.at(-1)
    assert.equal(mail.to, 'a@example.com')
    assert.match(mail.subject, /481920/)
    assert.match(mail.html, /481920/)
    assert.match(mail.text, /481920/) // text fallback is generated from html
  })

  test('booking sends a confirmation email to the customer', async () => {
    const cookie = await signup('book@example.com')
    const { data: address } = await (await post(cookie, '/addresses', { label: 'HOME', recipientName: 'Asha', phone: '9876543210', addressLine1: 'Villa 1', addressLine2: 'Whitefield', city: 'Bengaluru', postalCode: '560066' })).json()
    const when = new Date(Date.now() + 30 * HOUR); when.setUTCMinutes(0, 0, 0)
    const order = (await (await post(cookie, '/orders', { items: [{ serviceId: 'service_wash_fold' }], addressId: address.id, pickupScheduledAt: when.toISOString() })).json()).data
    await new Promise((r) => setTimeout(r, 30)) // let the fire-and-forget email run
    const mail = outbox.find((m) => m.to === 'book@example.com' && m.subject.includes(order.reference))
    assert.ok(mail, 'booking email sent with the reference')
    assert.match(mail.subject, /Pickup booked/)
  })

  test('delivered sends a receipt email with the total', async () => {
    const cookie = await signup('done@example.com')
    const staffCookie = await signup('staff@example.com')
    await User.updateOne({ email: 'staff@example.com' }, { $set: { role: 'STAFF' } })
    const { data: address } = await (await post(cookie, '/addresses', { label: 'HOME', recipientName: 'Asha', phone: '9876543210', addressLine1: 'Villa 1', addressLine2: 'Whitefield', city: 'Bengaluru', postalCode: '560066' })).json()
    const when = new Date(Date.now() + 30 * HOUR); when.setUTCMinutes(0, 0, 0)
    const order = (await (await post(cookie, '/orders', { items: [{ serviceId: 'service_wash_fold' }], addressId: address.id, pickupScheduledAt: when.toISOString() })).json()).data
    await Order.updateOne({ reference: order.reference }, { $set: { currentStatus: 'OUT_FOR_DELIVERY', 'payment.status': 'PAID', 'payment.method': 'CASH', 'items.0.quantity': 4, bill: { lines: [{ label: 'Wash & Fold', amountPaise: 24000 }], subtotalPaise: 24000, totalPaise: 24000, finalizedAt: new Date(), finalizedBy: 'x', revision: 1 } } })
    outbox.length = 0
    await post(staffCookie, `/staff/orders/${order.reference}/status`, { from: 'OUT_FOR_DELIVERY' })
    await new Promise((r) => setTimeout(r, 30))
    const mail = outbox.find((m) => m.to === 'done@example.com' && m.subject.includes('Delivered'))
    assert.ok(mail, 'delivered email sent')
    assert.match(mail.html, /₹240/)
  })
})

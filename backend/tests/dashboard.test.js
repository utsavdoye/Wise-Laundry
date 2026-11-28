import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { config } from '../src/config/env.js'
import app from '../src/app.js'
import { setupTestDb, teardownTestDb, clearTestDb } from './helpers/testDb.js'
import { Order } from '../src/models/Order.js'
import { User } from '../src/models/User.js'

const HOUR = 60 * 60 * 1000

describe('Admin dashboard', () => {
  let server, baseUrl, savedUpi
  before(async () => {
    await setupTestDb()
    savedUpi = config.UPI_ID
    config.UPI_ID = 'wiselaundry@ybl'
    server = app.listen(0)
    baseUrl = `http://127.0.0.1:${server.address().port}/api/v1`
  })
  after(async () => { config.UPI_ID = savedUpi; server.close(); await teardownTestDb() })
  beforeEach(async () => { await clearTestDb() })

  const headers = (cookie) => ({ 'Content-Type': 'application/json', cookie, 'x-test-bypass-csrf': '1' })
  const post = (cookie, path, body) => fetch(`${baseUrl}${path}`, { method: 'POST', headers: headers(cookie), body: JSON.stringify(body ?? {}) })
  const get = (cookie, path) => fetch(`${baseUrl}${path}`, { headers: headers(cookie) })

  async function signup(email, role) {
    const reg = await fetch(`${baseUrl}/auth/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-test-bypass-csrf': '1' },
      body: JSON.stringify({ fullName: 'Dash Tester', email, phone: '9876543210', password: 'Password123!' }),
    })
    const cookie = reg.headers.getSetCookie().find((c) => c.startsWith('wise_session=')).split(';')[0]
    if (role) await User.updateOne({ email }, { $set: { role } })
    return cookie
  }

  async function bookAndBill(customer, staff) {
    const { data: address } = await (await post(customer, '/addresses', {
      label: 'HOME', recipientName: 'Asha', phone: '9876543210', addressLine1: 'Villa 2', addressLine2: 'Whitefield', city: 'Bengaluru', postalCode: '560066',
    })).json()
    const when = new Date(Date.now() + 30 * HOUR); when.setUTCMinutes(0, 0, 0)
    const order = (await (await post(customer, '/orders', { items: [{ serviceId: 'service_wash_fold' }], addressId: address.id, pickupScheduledAt: when.toISOString() })).json()).data
    await Order.updateOne({ reference: order.reference }, { $set: { currentStatus: 'PICKED_UP' } })
    await post(staff, `/staff/orders/${order.reference}/bill`, { quantity: 4 }) // 4 kg x 60 = ₹240
    return order
  }

  const dash = async (cookie) => (await (await get(cookie, '/staff/dashboard')).json()).data

  test('empty day shows zeros', async () => {
    const staff = await signup('staff@example.com', 'STAFF')
    const d = await dash(staff)
    assert.equal(d.money.collectedPaise, 0)
    assert.equal(d.money.outstandingPaise, 0)
    assert.equal(d.money.outstandingCount, 0)
    assert.deepEqual(d.unpaid, [])
  })

  test('counts bookings and money owed; a confirmed UPI payment shows as collected', async () => {
    const customer = await signup('asha@example.com')
    const staff = await signup('staff@example.com', 'STAFF')
    const paid = await bookAndBill(customer, staff)
    const owed = await bookAndBill(customer, staff)

    // Pay the first one: customer marks paid, staff confirm by UPI.
    await post(customer, `/orders/${paid.id}/pay`, { upiRef: '402212345678' })
    await post(staff, `/staff/orders/${paid.reference}/payment`, { status: 'PAID', method: 'UPI' })

    const d = await dash(staff)
    assert.equal(d.today.newBookings, 2)
    assert.equal(d.today.atLaundry, 2) // both are RECEIVED after billing (paid status doesn't change the stage)
    assert.equal(d.money.collectedPaise, 24000)
    assert.equal(d.money.collectedUpiPaise, 24000)
    assert.equal(d.money.collectedCashPaise, 0)
    assert.equal(d.money.outstandingPaise, 24000)
    assert.equal(d.money.outstandingCount, 1)
    assert.equal(d.unpaid[0].reference, owed.reference)
    assert.equal(d.unpaid[0].totalPaise, 24000)
  })

  test('cash payment is counted as cash', async () => {
    const customer = await signup('asha@example.com')
    const staff = await signup('staff@example.com', 'STAFF')
    const order = await bookAndBill(customer, staff)
    await post(staff, `/staff/orders/${order.reference}/payment`, { status: 'PAID', method: 'CASH' })
    const d = await dash(staff)
    assert.equal(d.money.collectedCashPaise, 24000)
    assert.equal(d.money.collectedUpiPaise, 0)
  })

  test('a customer-claimed payment shows as pending and still owed', async () => {
    const customer = await signup('asha@example.com')
    const staff = await signup('staff@example.com', 'STAFF')
    const order = await bookAndBill(customer, staff)
    await post(customer, `/orders/${order.id}/pay`, { upiRef: '402212345678' }) // -> PENDING
    const d = await dash(staff)
    assert.equal(d.money.pendingConfirm, 1)
    assert.equal(d.money.outstandingCount, 1)
    assert.equal(d.unpaid[0].paymentStatus, 'PENDING')
  })

  test('orders delivered today are counted', async () => {
    const customer = await signup('asha@example.com')
    const staff = await signup('staff@example.com', 'STAFF')
    const order = await bookAndBill(customer, staff)
    await Order.updateOne({ reference: order.reference }, { $set: { currentStatus: 'DELIVERED' }, $push: { statusHistory: { status: 'DELIVERED', changedAt: new Date() } } })
    const d = await dash(staff)
    assert.equal(d.today.delivered, 1)
    assert.equal(d.today.atLaundry, 0)
  })

  test('customers and riders cannot open the dashboard', async () => {
    const customer = await signup('asha@example.com')
    assert.equal((await get(customer, '/staff/dashboard')).status, 403)
    const rider = await signup('ravi@example.com', 'RIDER')
    assert.equal((await get(rider, '/staff/dashboard')).status, 403)
  })
})

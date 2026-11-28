import { Order } from '../models/Order.js'
import { User } from '../models/User.js'
import { istDayRange } from './staff.service.js'

const AT_LAUNDRY = ['PICKED_UP', 'RECEIVED', 'WASHING', 'IRONING', 'READY_FOR_DELIVERY']
const UNPAID_LIST_LIMIT = 30 // how many unpaid orders to list (the total count and money cover all of them)

/**
 * One screen for staff and admin: the day's activity, money collected that day, and money still owed.
 * `day` is YYYY-MM-DD in India time; defaults to today.
 */
export async function getDashboard({ day } = {}) {
  const { key, start, end } = istDayRange(day)
  const inDay = { $gte: start, $lt: end }

  const [newBookings, pickupsToday, awaitingPickup, atLaundry, outForDelivery, delivered, pendingConfirm] = await Promise.all([
    Order.countDocuments({ createdAt: inDay, currentStatus: { $ne: 'CANCELLED' } }),
    Order.countDocuments({ pickupScheduledAt: inDay, currentStatus: { $ne: 'CANCELLED' } }),
    Order.countDocuments({ currentStatus: 'BOOKED', pickupScheduledAt: { $lt: end } }),
    Order.countDocuments({ currentStatus: { $in: AT_LAUNDRY } }),
    Order.countDocuments({ currentStatus: 'OUT_FOR_DELIVERY' }),
    // Delivered is terminal (no later history entry), so a DELIVERED order whose history
    // has an entry dated today was delivered today.
    Order.countDocuments({ 'statusHistory.status': 'DELIVERED', 'statusHistory.changedAt': inDay }),
    Order.countDocuments({ 'payment.status': 'PENDING' }),
  ])

  // Money collected today: orders confirmed paid within the day, split by how they paid.
  const paidToday = await Order.find({ 'payment.status': 'PAID', 'payment.confirmedAt': inDay })
    .select('bill.totalPaise payment.method').lean()
  let collectedPaise = 0
  let collectedUpiPaise = 0
  let collectedCashPaise = 0
  for (const o of paidToday) {
    const amount = o.bill?.totalPaise || 0
    collectedPaise += amount
    if (o.payment?.method === 'CASH') collectedCashPaise += amount
    else collectedUpiPaise += amount
  }

  // Money owed: orders that have a final bill but aren't paid yet (not cancelled).
  const outstanding = await Order.find({
    'bill.finalizedAt': { $ne: null },
    'payment.status': { $in: ['UNPAID', 'PENDING'] },
    currentStatus: { $ne: 'CANCELLED' },
  }).select('reference orderIdString currentStatus bill.totalPaise payment.status userId updatedAt').sort({ updatedAt: -1 }).lean()

  const outstandingPaise = outstanding.reduce((sum, o) => sum + (o.bill?.totalPaise || 0), 0)

  const shown = outstanding.slice(0, UNPAID_LIST_LIMIT)
  const names = await User.find({ _id: { $in: shown.map((o) => o.userId) } }).select('fullName').lean()
  const nameById = new Map(names.map((u) => [String(u._id), u.fullName]))
  const unpaid = shown.map((o) => ({
    reference: o.reference,
    id: o.orderIdString || String(o._id),
    customer: nameById.get(String(o.userId)) || 'Customer',
    status: o.currentStatus,
    paymentStatus: o.payment?.status || 'UNPAID',
    totalPaise: o.bill?.totalPaise || 0,
  }))

  return {
    day: key,
    today: { newBookings, pickupsToday, awaitingPickup, atLaundry, outForDelivery, delivered },
    money: { collectedPaise, collectedUpiPaise, collectedCashPaise, outstandingPaise, outstandingCount: outstanding.length, pendingConfirm },
    unpaid,
  }
}

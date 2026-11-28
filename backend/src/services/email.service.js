import nodemailer from 'nodemailer'
import { config } from '../config/env.js'
import { logger } from '../config/logger.js'
import { User } from '../models/User.js'

// In tests we capture emails here instead of sending, so flows can be asserted.
export const outbox = []

/** Which sender is set up: 'resend' | 'smtp' | 'none'. */
export function activeProvider() {
  if (config?.RESEND_API_KEY) return 'resend'
  if (config?.SMTP_HOST && config?.SMTP_USER) return 'smtp'
  return 'none'
}
export const emailEnabled = () => activeProvider() !== 'none'

let smtpTransport = null
function transport() {
  if (!smtpTransport) {
    smtpTransport = nodemailer.createTransport({
      host: config.SMTP_HOST,
      port: config.SMTP_PORT,
      secure: config.SMTP_SECURE,
      auth: { user: config.SMTP_USER, pass: config.SMTP_PASS },
    })
  }
  return smtpTransport
}

async function sendViaResend(msg) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: config.EMAIL_FROM, to: [msg.to], subject: msg.subject, html: msg.html, text: msg.text }),
  })
  if (!res.ok) throw new Error(`Resend ${res.status}: ${(await res.text()).slice(0, 200)}`)
}

/**
 * Send one email. Returns { sent, reason? }. Never throws — email is best-effort for the caller,
 * which decides what to do when sent is false (e.g. a login code flow tells the user).
 */
export async function sendEmail({ to, subject, html, text }) {
  const msg = { to, subject, html, text: text || html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() }
  if (config?.NODE_ENV === 'test') { outbox.push(msg); return { sent: true } }
  const provider = activeProvider()
  if (provider === 'none') {
    logger.info({ to, subject }, 'email not configured — skipped')
    return { sent: false, reason: 'not_configured' }
  }
  try {
    if (provider === 'resend') await sendViaResend(msg)
    else await transport().sendMail({ from: config.EMAIL_FROM, ...msg })
    return { sent: true }
  } catch (err) {
    logger.error({ err: err.message, to, subject }, 'email send failed')
    return { sent: false, reason: 'send_failed' }
  }
}

// ---------- Templates ----------

const BRAND = '#0f766e'
function shell(title, bodyHtml) {
  return `<!doctype html><html><body style="margin:0;background:#f1f5f4;font-family:Arial,Helvetica,sans-serif;color:#0f172a">
  <div style="max-width:520px;margin:0 auto;padding:24px">
    <div style="font-weight:800;font-size:18px;color:${BRAND};margin-bottom:16px">Wise Laundry</div>
    <div style="background:#fff;border:1px solid #e2e8f0;border-radius:16px;padding:24px">
      <h1 style="margin:0 0 12px;font-size:20px">${title}</h1>
      ${bodyHtml}
    </div>
    <p style="color:#64748b;font-size:12px;margin-top:16px">Wise Laundry · doorstep laundry in Bengaluru</p>
  </div></body></html>`
}

const rupees = (paise) => `₹${(paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`

/** One-time login / verification code. */
export function loginCodeEmail(code) {
  return {
    subject: `${code} is your Wise Laundry code`,
    html: shell('Your login code', `
      <p style="margin:0 0 12px">Use this code to sign in. It expires in 10 minutes.</p>
      <div style="font-size:34px;font-weight:800;letter-spacing:8px;color:${BRAND};text-align:center;margin:20px 0">${code}</div>
      <p style="margin:0;color:#64748b;font-size:13px">If you didn't ask for this, you can ignore this email.</p>`),
  }
}

export function bookingEmail(order) {
  const svc = order.items?.[0]?.serviceName || 'Laundry'
  return {
    subject: `Pickup booked · ${order.reference}`,
    html: shell('Your pickup is booked', `
      <p style="margin:0 0 8px">Order <strong>${order.reference}</strong> — ${svc}.</p>
      <p style="margin:0 0 8px">We'll collect your clothes in your chosen window and you can track every step in the app.</p>
      <p style="margin:0;color:#64748b;font-size:13px">Final price is confirmed after we weigh your clothes.</p>`),
  }
}

export function deliveredEmail(order) {
  const total = order.bill?.totalPaise != null ? `<p style="margin:0 0 8px">Total paid: <strong>${rupees(order.bill.totalPaise)}</strong></p>` : ''
  return {
    subject: `Delivered · ${order.reference}`,
    html: shell('Delivered — thank you!', `
      <p style="margin:0 0 8px">Your order <strong>${order.reference}</strong> has been delivered.</p>
      ${total}
      <p style="margin:0;color:#64748b;font-size:13px">We'd love a quick rating in the app.</p>`),
  }
}

async function emailCustomer(userId, build) {
  const user = await User.findById(userId).select('email fullName')
  if (user?.email) await sendEmail({ to: user.email, ...build })
}
/** Fire-and-forget order emails (never block the request). */
export const emailOrderBooked = (order) => emailCustomer(order.userId, bookingEmail(order)).catch(() => {})
export const emailOrderDelivered = (order) => emailCustomer(order.userId, deliveredEmail(order)).catch(() => {})

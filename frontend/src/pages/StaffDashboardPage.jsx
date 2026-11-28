import { useState } from 'react'
import { Package, PackageCheck, WashingMachine, Truck, CheckCheck, Wallet, Banknote, QrCode, AlertCircle, RefreshCw, ShieldAlert } from 'lucide-react'
import { api, useApi } from '../services/api-client'
import { useAuth } from '../features/auth/hooks/useAuth'
import { PageHeader } from '../components/ui/PageHeader'
import { Card } from '../components/ui/Card'
import { Button } from '../components/ui/Button'
import { Skeleton } from '../components/ui/Spinner'
import { EmptyState } from '../components/feedback/EmptyState'
import { ErrorMessage } from '../components/feedback/ErrorMessage'
import { OrderStatusBadge } from '../features/orders/components/OrderStatusBadge'
import { formatCurrency } from '../utils/formatCurrency'
import { cn } from '../utils/cn'

const istKey = (offsetDays = 0) => new Date(Date.now() + 5.5 * 3600000 + offsetDays * 86400000).toISOString().slice(0, 10)
const DAYS = [{ label: 'Today', key: istKey(0) }, { label: 'Yesterday', key: istKey(-1) }]

const TILES = [
  { key: 'newBookings', label: 'New bookings', icon: Package },
  { key: 'pickupsToday', label: 'Pickups', icon: PackageCheck },
  { key: 'atLaundry', label: 'At laundry', icon: WashingMachine },
  { key: 'outForDelivery', label: 'Out for delivery', icon: Truck },
  { key: 'delivered', label: 'Delivered', icon: CheckCheck },
]

function Tile({ icon: Icon, label, value }) {
  return (
    <div className="rounded-2xl border border-line bg-white p-4">
      <Icon className="size-5 text-brand-700" aria-hidden />
      <p className="mt-3 text-2xl font-bold tabular-nums">{value}</p>
      <p className="text-sm text-navy-500">{label}</p>
    </div>
  )
}

/** Staff + admin: the day's activity, money collected, and what's still owed, in one screen. */
export default function StaffDashboardPage() {
  const { user } = useAuth()
  const [day, setDay] = useState(DAYS[0].key)
  const { data, loading, error, reload } = useApi(() => api.staffDashboard(day), [day])
  const isStaff = ['STAFF', 'ADMIN'].includes(user?.role)

  if (user && !isStaff) {
    return <EmptyState icon={ShieldAlert} title="Staff only" description="This overview is for staff and admins." action={<Button to="/customer">Go home</Button>} />
  }

  const t = data?.today
  const m = data?.money

  return (
    <>
      <PageHeader title="Overview" description="The day's orders, money collected, and what's still unpaid." />

      <div className="mb-5 flex items-center justify-between gap-3">
        <div className="inline-flex rounded-xl border border-line bg-white p-1">
          {DAYS.map((d) => (
            <button
              key={d.key}
              onClick={() => setDay(d.key)}
              className={cn('rounded-lg px-4 py-1.5 text-sm font-semibold transition', day === d.key ? 'bg-brand-700 text-white' : 'text-navy-600 hover:text-navy-900')}
            >
              {d.label}
            </button>
          ))}
        </div>
        <Button variant="ghost" size="sm" onClick={() => reload()} disabled={loading}>
          <RefreshCw className={cn('size-4', loading && 'animate-spin')} aria-hidden /> Refresh
        </Button>
      </div>

      {error ? (
        <ErrorMessage error={error} onRetry={reload} />
      ) : loading && !data ? (
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {TILES.map((x) => <Skeleton key={x.key} className="h-28 rounded-2xl" />)}
          </div>
          <Skeleton className="h-40 rounded-2xl" />
        </div>
      ) : (
        <div className="space-y-6">
          {/* Day activity */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {TILES.map((x) => <Tile key={x.key} icon={x.icon} label={x.label} value={t?.[x.key] ?? 0} />)}
          </div>

          {/* Money */}
          <div className="grid gap-4 lg:grid-cols-3">
            <Card className="p-5">
              <div className="flex items-center gap-2 text-sm font-semibold text-navy-600"><Wallet className="size-4 text-brand-700" aria-hidden /> Collected {day === DAYS[0].key ? 'today' : 'that day'}</div>
              <p className="mt-2 text-3xl font-bold tabular-nums text-brand-800">{formatCurrency(m?.collectedPaise)}</p>
              <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-sm text-navy-500">
                <span className="inline-flex items-center gap-1.5"><QrCode className="size-4" aria-hidden /> UPI {formatCurrency(m?.collectedUpiPaise)}</span>
                <span className="inline-flex items-center gap-1.5"><Banknote className="size-4" aria-hidden /> Cash {formatCurrency(m?.collectedCashPaise)}</span>
              </div>
            </Card>

            <Card className="p-5">
              <div className="flex items-center gap-2 text-sm font-semibold text-navy-600"><AlertCircle className="size-4 text-amber-600" aria-hidden /> Still owed</div>
              <p className="mt-2 text-3xl font-bold tabular-nums text-navy-900">{formatCurrency(m?.outstandingPaise)}</p>
              <p className="mt-3 text-sm text-navy-500">{m?.outstandingCount ?? 0} billed order{m?.outstandingCount === 1 ? '' : 's'} not paid yet</p>
            </Card>

            <Card className="p-5">
              <div className="flex items-center gap-2 text-sm font-semibold text-navy-600"><CheckCheck className="size-4 text-brand-700" aria-hidden /> To confirm</div>
              <p className="mt-2 text-3xl font-bold tabular-nums text-navy-900">{m?.pendingConfirm ?? 0}</p>
              <p className="mt-3 text-sm text-navy-500">Customers who said they paid — confirm from the Work list.</p>
            </Card>
          </div>

          {/* Unpaid list */}
          <Card className="overflow-hidden">
            <div className="border-b border-line px-5 py-3.5 text-sm font-semibold">Unpaid orders</div>
            {data?.unpaid?.length ? (
              <ul className="divide-y divide-line">
                {data.unpaid.map((o) => (
                  <li key={o.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3">
                    <span className="font-semibold tabular-nums">{o.reference}</span>
                    <span className="min-w-0 flex-1 truncate text-sm text-navy-600">{o.customer}</span>
                    <OrderStatusBadge status={o.status} />
                    {o.paymentStatus === 'PENDING' && <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs font-semibold text-amber-700">Says paid</span>}
                    <span className="font-semibold tabular-nums">{formatCurrency(o.totalPaise)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-5 py-8 text-center text-sm text-navy-500">Nothing unpaid. All billed orders are settled.</p>
            )}
          </Card>
        </div>
      )}
    </>
  )
}

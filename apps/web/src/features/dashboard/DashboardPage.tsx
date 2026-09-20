import { useState } from 'react';
import { ClipboardList, Clock, IndianRupee, Table2 } from 'lucide-react';
import { Page } from '@/app/AppShell.tsx';
import {
  Badge, Button, Card, CardBody, CardHeader, DemoBanner, EmptyState,
  LiveIndicator, MoneyText, OrderStatusChip, StatTile,
} from '@/components/ui/index.ts';
import { DEMO_ORDERS, DEMO_SUMMARY, type DemoOrder } from './demo-data.ts';

export function DashboardPage() {
  const [showEmpty, setShowEmpty] = useState(false);
  const orders = showEmpty ? [] : DEMO_ORDERS;

  return (
    <>
      <div className="-mx-4 mb-4 sm:-mx-6">
        <DemoBanner />
      </div>

      <Page
        title="Today"
        description="Tuesday, 20 September · Spice Garden"
        actions={<LiveIndicator state="live" lastUpdated={new Date()} />}
      >
        <section aria-labelledby="summary-heading">
          <h2 id="summary-heading" className="sr-only">
            Summary
          </h2>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatTile
              label="Orders today"
              value={DEMO_SUMMARY.ordersToday}
              hint="Excludes cancelled orders"
              icon={<ClipboardList className="size-4" />}
            />
            <StatTile
              label="Pending"
              value={DEMO_SUMMARY.pendingOrders}
              hint="Waiting to be accepted"
              icon={<Clock className="size-4" />}
            />
            <StatTile
              label="Sales today"
              value={<MoneyText minor={DEMO_SUMMARY.salesTodayMinor} />}
              hint="Paid bills only, excludes voids"
              icon={<IndianRupee className="size-4" />}
            />
            <StatTile
              label="Tables in use"
              value={`${DEMO_SUMMARY.activeTables} / ${DEMO_SUMMARY.totalTables}`}
              hint="Tables with an open order"
              icon={<Table2 className="size-4" />}
            />
          </div>

          {/* Money that is owed but not yet collected is shown separately from
              sales, so the headline figure is never quietly inflated. */}
          <p className="mt-3 text-sm text-muted">
            <MoneyText minor={DEMO_SUMMARY.unbilledMinor} emphasis className="text-text" /> is served but not
            yet billed.
          </p>
        </section>

        <section aria-labelledby="recent-heading" className="mt-6">
          <Card>
            <CardHeader
              title="Recent orders"
              description="Newest first"
              actions={
                <>
                  <Button size="sm" onClick={() => setShowEmpty((value) => !value)}>
                    {showEmpty ? 'Show demo orders' : 'Preview empty state'}
                  </Button>
                  <Button size="sm" variant="primary" disabled title="Available once the orders module is built">
                    View all
                  </Button>
                </>
              }
            />
            <h2 id="recent-heading" className="sr-only">
              Recent orders
            </h2>

            {orders.length === 0 ? (
              <EmptyState
                icon={<ClipboardList className="size-8" />}
                title="No orders yet today"
                description="Orders appear here the moment a customer places one from a table QR code."
              />
            ) : (
              <>
                {/* A table on wide screens; the same rows become cards on a phone,
                    because a horizontally scrolling table is unusable one-handed. */}
                <div className="hidden md:block">
                  <table className="w-full text-sm">
                    <caption className="sr-only">Recent orders with table, items, total, status and time</caption>
                    <thead>
                      <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted">
                        <th scope="col" className="px-5 py-2 font-medium">Order</th>
                        <th scope="col" className="px-5 py-2 font-medium">Table</th>
                        <th scope="col" className="px-5 py-2 text-right font-medium">Items</th>
                        <th scope="col" className="px-5 py-2 text-right font-medium">Total</th>
                        <th scope="col" className="px-5 py-2 font-medium">Status</th>
                        <th scope="col" className="px-5 py-2 text-right font-medium">Placed</th>
                      </tr>
                    </thead>
                    <tbody>
                      {orders.map((order) => (
                        <tr key={order.ref} className="border-b border-border last:border-0">
                          <td className="px-5 py-3 font-medium tabular text-text">{order.ref}</td>
                          <td className="px-5 py-3 text-muted">{order.table}</td>
                          <td className="px-5 py-3 text-right tabular text-muted">{order.items}</td>
                          <td className="px-5 py-3 text-right">
                            <MoneyText minor={order.totalMinor} />
                          </td>
                          <td className="px-5 py-3">
                            <OrderStatusChip status={order.status} />
                          </td>
                          <td className="px-5 py-3 text-right tabular text-muted">{timeAgo(order.placedAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <ul className="divide-y divide-border md:hidden">
                  {orders.map((order) => (
                    <li key={order.ref} className="px-4 py-3">
                      <OrderRowCard order={order} />
                    </li>
                  ))}
                </ul>
              </>
            )}
          </Card>
        </section>

        <section aria-labelledby="next-heading" className="mt-6">
          <Card>
            <CardHeader title="Setup" description="What this dashboard will show once the modules behind it exist" />
            <CardBody className="space-y-2 text-sm text-muted">
              {[
                ['Tables & QR', 'Create tables and print their QR codes'],
                ['Menu', 'Add categories, items, prices and photos'],
                ['Orders', 'Live order feed with status workflow'],
                ['Billing', 'Bills, taxes, payments and PDF invoices'],
              ].map(([label, detail]) => (
                <div key={label} className="flex items-center justify-between gap-3">
                  <span>
                    <span className="font-medium text-text">{label}</span> — {detail}
                  </span>
                  <Badge>Not built yet</Badge>
                </div>
              ))}
            </CardBody>
          </Card>
        </section>
      </Page>
    </>
  );
}

function OrderRowCard({ order }: { order: DemoOrder }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div>
        <p className="font-medium tabular text-text">{order.ref}</p>
        <p className="mt-0.5 text-xs text-muted">
          Table {order.table} · {order.items} item{order.items === 1 ? '' : 's'} · {timeAgo(order.placedAt)}
        </p>
        <div className="mt-2">
          <OrderStatusChip status={order.status} />
        </div>
      </div>
      <MoneyText minor={order.totalMinor} emphasis />
    </div>
  );
}

function timeAgo(date: Date): string {
  const minutes = Math.round((Date.now() - date.getTime()) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  return `${Math.floor(minutes / 60)} h ago`;
}

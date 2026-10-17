import { Dynamic } from '@morphkit/runtime'
import { orders } from '@/readonly/api'

export default function App() {
  return (
    <main className="mx-auto max-w-3xl p-8">
      <h1 className="mb-4 text-2xl font-semibold">Orders</h1>
      {/* rendered through <Dynamic>, not imported: each user can have their own version */}
      <Dynamic id="orders-table" props={{ orders }} />
    </main>
  )
}

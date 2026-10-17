import type { Deal } from '@/readonly/api'

export default function DealsTable({ deals }: { deals: Deal[] }) {
  if (deals.length > 0) throw new Error('Deals table exploded while rendering')
  return <p>No deals</p>
}

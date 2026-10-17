import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { formatDate } from '@/readonly/format'

export default function Card({ date }: { date: string }) {
  return <Button className={cn('p-2')}>{formatDate(date)}</Button>
}

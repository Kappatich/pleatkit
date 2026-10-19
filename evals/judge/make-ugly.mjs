// Writes the five deliberately ugly edits the judge's calibration expects to score at most 2 (DECISIONS 75 Р3).
// Each starts from the task's reference solution (so it compiles and does roughly what was asked) and then breaks
// what a designer would not accept: garish colours and fonts, overlapping or oversized elements, unrelated removals.
// Run: node evals/judge/make-ugly.mjs (after a reference changes).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '../..')
const out = path.join(here, 'ugly')
fs.mkdirSync(out, { recursive: true })

function make(name, from, edits) {
  let src = fs.readFileSync(path.join(repo, from), 'utf8')
  for (const [a, b] of edits) {
    if (!src.includes(a)) throw new Error(`${name}: "${a.slice(0, 60)}" not found in ${from}`)
    src = src.split(a).join(b)
  }
  fs.writeFileSync(path.join(out, name), src)
  console.log(`wrote evals/judge/ugly/${name}`)
}

// 1. Demo customer card, "add phone, city and source": the fields in a magenta block, huge italic serif, lime text
make('customer-card.garish.tsx', 'apps/demo-crm/e2e/fixtures/customer-card.scenario1.tsx', [
  ['<dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">', '<dl className="grid grid-cols-1 gap-0 bg-fuchsia-600 p-0 font-serif text-4xl italic text-lime-300">'],
  ['<dt className="text-muted-foreground">', '<dt className="font-mono text-5xl font-black uppercase text-yellow-300 underline">'],
])

// 2. shadcn-admin users, "show roles in colour": neon full blocks, oversized, pulled over the neighbouring column
make('users-columns.neon-overlap.tsx', 'evals/references/apps/shadcn-admin/users-columns.role-colors.tsx', [
  ["'capitalize',\n              role === 'admin' && 'border-purple-200 bg-purple-100 text-purple-800',\n              role === 'manager' && 'border-amber-200 bg-amber-100 text-amber-800',\n              role === 'cashier' && 'border-gray-200 bg-gray-100 text-gray-700'",
    "'-ml-40 rounded-none border-4 border-black px-10 py-6 text-4xl font-black uppercase',\n              role === 'admin' && 'bg-fuchsia-500 text-lime-300',\n              role === 'manager' && 'bg-orange-500 text-cyan-300',\n              role === 'cashier' && 'bg-lime-400 text-pink-600'"],
])

// 3. TailAdmin recent orders, "strike through the canceled orders": done, but the product photos, the header and the
// buttons are gone and every row is painted red (unrelated changes)
make('recent-orders.unrelated.tsx', 'evals/references/apps/tailadmin/recent-orders.strike.tsx', [
  ['product.statusKey === "canceled" ? "line-through opacity-60" : ""', 'product.statusKey === "canceled" ? "line-through bg-red-600 text-white" : "bg-red-200"'],
  ['<div className="h-12.5 w-12.5 overflow-hidden rounded-md">', '<div className="hidden">'],
  ['<TableHeader className="border-y border-gray-100 dark:border-gray-800">', '<TableHeader className="hidden">'],
  ['<div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">', '<div className="hidden">'],
])

// 4. shadcn-admin stats, "make the cards compact": the four cards stacked on top of each other, text cut off
make('dashboard-stats.overlap.tsx', 'evals/references/apps/shadcn-admin/dashboard-stats.compact.tsx', [
  ["<div className='grid gap-2 sm:grid-cols-2 lg:grid-cols-4'>", "<div className='relative h-16 overflow-hidden'>"],
  ["<Card className='gap-1 py-3'>", "<Card className='absolute top-0 left-6 h-10 w-40 gap-0 overflow-hidden py-0 text-[9px]'>"],
])

// 5. TailAdmin monthly sales, "make the bars green": green, on a yellow panel, a 40 px serif title, a squashed chart
make('monthly-sales-chart.garish.tsx', 'evals/references/apps/tailadmin/monthly-sales-chart.green.tsx', [
  ['<div className="overflow-hidden rounded-2xl border border-gray-200 bg-white px-5 pt-5 sm:px-6 sm:pt-6 dark:border-gray-800 dark:bg-white/3">', '<div className="overflow-hidden border-8 border-dashed border-red-600 bg-yellow-300 px-1 pt-1">'],
  ['<h3 className="text-lg font-semibold text-gray-800 dark:text-white/90">', '<h3 className="font-serif text-[40px] font-black uppercase italic text-fuchsia-700">'],
  ['height={180}', 'height={60}'],
])

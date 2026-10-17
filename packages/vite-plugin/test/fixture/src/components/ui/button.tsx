import type { ReactNode } from 'react'
export function Button(props: { className?: string; children?: ReactNode }) {
  return <button className={props.className}>{props.children}</button>
}

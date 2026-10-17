import * as config from 'virtual:morphkit'
import { LocalStore } from '@morphkit/runtime'

export const morphkitConfig = config
/** One IndexedDB store per browser profile; snapshots are keyed by user inside it. */
export const store = new LocalStore('morphkit-demo-crm')
export const USERS = ['alice', 'bob'] as const
export type UserId = (typeof USERS)[number]

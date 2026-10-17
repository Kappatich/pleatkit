export function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ')
}
const secret = 'core implementation detail'
export const version = secret.length

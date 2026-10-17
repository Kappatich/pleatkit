/**
 * The runtime counterpart of the default-export rule of `check`, on evaluated modules: a function, or a React
 * element type object (memo, forwardRef, lazy). Plain objects and primitives are refused, as by the static rule.
 */
export function isComponentExport(d: unknown): boolean {
  return typeof d === 'function' || (typeof d === 'object' && d !== null && '$$typeof' in d)
}

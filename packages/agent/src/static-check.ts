import ts from 'typescript'
import { matchesExternal, type CompileContextWire, type CompileError, type FileMap } from '@morphkit/runtime/compiler'

/**
 * Static rules for code in the dynamic zone, run by `check` after the compile (stage 3b). An ESLint-style
 * profile, but self-contained: the TypeScript parser walks each file once. A violation is returned to the
 * model like a compile error (with `rule`), and `finish` refuses to commit while there is one.
 */
export type StaticRule =
  | 'no-eval'
  | 'no-function-constructor'
  | 'no-string-timer'
  | 'no-document-cookie'
  | 'no-raw-html'
  | 'no-remote-request'
  | 'no-xhr'
  | 'no-dynamic-import'
  | 'allowed-imports'

export type StaticContext = Pick<CompileContextWire, 'externals' | 'externalPatterns' | 'dynamicRoots'>

const SCRIPT = /\.(tsx|ts|jsx|js|mts|mjs)$/
/** Calls whose first argument is a URL the browser will contact. */
const URL_CALLS = new Set(['fetch', 'sendBeacon'])
/** Constructors whose first argument is a URL the browser will contact. */
const URL_CONSTRUCTORS = new Set(['WebSocket', 'EventSource'])
const GLOBALS = new Set(['window', 'globalThis', 'self', 'top', 'parent', 'document'])

const RELATIVE_URL = /^(\/(?!\/)|\.{1,2}\/|\?|#)/
const ABSOLUTE_URL = /^([a-z][a-z0-9+.-]*:|\/\/)/i

/** The leading literal text of a string or template literal argument, or null when it is not a literal. */
function literalPrefix(node: ts.Expression | undefined): string | null {
  if (!node) return null
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  if (ts.isTemplateExpression(node)) return node.head.text
  if (ts.isParenthesizedExpression(node)) return literalPrefix(node.expression)
  return null
}

/** `eval`, `window.eval`, `globalThis['eval']` → 'eval'. */
function calleeName(expr: ts.Expression): { name: string; viaGlobal: boolean } | null {
  if (ts.isIdentifier(expr)) return { name: expr.text, viaGlobal: false }
  if (ts.isPropertyAccessExpression(expr)) {
    const obj = expr.expression
    const isGlobal = ts.isIdentifier(obj) && GLOBALS.has(obj.text)
    return { name: expr.name.text, viaGlobal: isGlobal }
  }
  if (ts.isElementAccessExpression(expr) && ts.isStringLiteralLike(expr.argumentExpression)) {
    const obj = expr.expression
    return { name: expr.argumentExpression.text, viaGlobal: ts.isIdentifier(obj) && GLOBALS.has(obj.text) }
  }
  return null
}

function normalize(path: string): string {
  const out: string[] = []
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return out.join('/')
}

export function staticCheck(files: FileMap, ctx: StaticContext): CompileError[] {
  const errors: CompileError[] = []
  for (const [path, source] of Object.entries(files)) {
    if (!SCRIPT.test(path)) continue
    const kind = path.endsWith('.tsx') ? ts.ScriptKind.TSX : path.endsWith('.jsx') ? ts.ScriptKind.JSX : path.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS
    const sf = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, kind)
    const report = (node: ts.Node, rule: StaticRule, text: string) => {
      const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf))
      errors.push({ file: path, line: line + 1, column: character + 1, text: `${text} [${rule}]`, rule })
    }

    const checkSpecifier = (node: ts.Node, spec: string) => {
      if (ABSOLUTE_URL.test(spec)) return report(node, 'no-dynamic-import', `Importing code from a URL ("${spec}") is not allowed`)
      if (spec.startsWith('./') || spec.startsWith('../')) {
        const dir = path.slice(0, path.lastIndexOf('/') + 1)
        const target = normalize(dir + spec)
        if (!ctx.dynamicRoots.some((r) => target.startsWith(r.replace(/\/$/, '') + '/') || target === r.replace(/\/$/, ''))) {
          report(node, 'allowed-imports', `"${spec}" points outside the dynamic zone; import shared code through the allowed modules (${ctx.externalPatterns.join(', ')})`)
        }
        return
      }
      if (!matchesExternal(spec, ctx)) report(node, 'allowed-imports', `"${spec}" is not an allowed module; dynamic code may import only ${ctx.externalPatterns.join(', ')} and other dynamic files`)
    }

    const checkUrl = (node: ts.Node, arg: ts.Expression | undefined, what: string) => {
      const prefix = literalPrefix(arg)
      if (prefix === null) {
        report(node, 'no-remote-request', `${what} needs a relative URL written as a string (like "/api/..."); use the typed client from the readonly zone for anything else`)
      } else if (ABSOLUTE_URL.test(prefix) || !RELATIVE_URL.test(prefix)) {
        report(node, 'no-remote-request', `${what} to "${prefix}" is not allowed: only relative URLs of this app`)
      }
    }

    const visit = (node: ts.Node): void => {
      // imports and re-exports
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        if (!(ts.isImportDeclaration(node) && node.importClause?.isTypeOnly) && !(ts.isExportDeclaration(node) && node.isTypeOnly)) checkSpecifier(node, node.moduleSpecifier.text)
      }
      if (ts.isCallExpression(node)) {
        // import(...) and require(...)
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
          const arg = node.arguments[0]
          if (arg && ts.isStringLiteralLike(arg)) checkSpecifier(node, arg.text)
          else report(node, 'no-dynamic-import', 'import() with a computed specifier is not allowed')
        } else {
          const callee = calleeName(node.expression)
          if (callee?.name === 'require' && !callee.viaGlobal) {
            const arg = node.arguments[0]
            if (arg && ts.isStringLiteralLike(arg)) checkSpecifier(node, arg.text)
            else report(node, 'no-dynamic-import', 'require() with a computed specifier is not allowed')
          }
          if (callee?.name === 'eval' && (callee.viaGlobal || ts.isIdentifier(node.expression))) report(node, 'no-eval', 'eval() is not allowed')
          if (callee?.name === 'Function' && (callee.viaGlobal || ts.isIdentifier(node.expression))) report(node, 'no-function-constructor', 'Function() is not allowed')
          if ((callee?.name === 'setTimeout' || callee?.name === 'setInterval') && literalPrefix(node.arguments[0]) !== null) {
            report(node, 'no-string-timer', `${callee.name} with a string of code is not allowed; pass a function`)
          }
          if (callee && URL_CALLS.has(callee.name) && (ts.isIdentifier(node.expression) || callee.viaGlobal || callee.name === 'sendBeacon')) {
            checkUrl(node, node.arguments[0], callee.name === 'fetch' ? 'fetch' : 'navigator.sendBeacon')
          }
          if (callee?.name === 'insertAdjacentHTML' || (callee?.name === 'write' && ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'document')) {
            report(node, 'no-raw-html', `${callee.name === 'write' ? 'document.write' : 'insertAdjacentHTML'} is not allowed; render with JSX`)
          }
        }
      }
      if (ts.isNewExpression(node)) {
        const callee = calleeName(node.expression)
        if (callee?.name === 'Function') report(node, 'no-function-constructor', 'new Function() is not allowed')
        if (callee?.name === 'XMLHttpRequest') report(node, 'no-xhr', 'XMLHttpRequest is not allowed; use fetch with a relative URL or the typed client from the readonly zone')
        if (callee && URL_CONSTRUCTORS.has(callee.name)) checkUrl(node, node.arguments?.[0], callee.name)
      }
      // eval or Function passed around as a value (const e = eval; e(code))
      if (ts.isIdentifier(node) && (node.text === 'eval' || node.text === 'Function')) {
        const parent = node.parent
        const isCallee = (ts.isCallExpression(parent) || ts.isNewExpression(parent)) && parent.expression === node
        const isName = (ts.isPropertyAccessExpression(parent) && parent.name === node) || ts.isPropertyAssignment(parent) || ts.isTypeReferenceNode(parent) || ts.isExpressionWithTypeArguments(parent)
        if (!isCallee && !isName) report(node, node.text === 'eval' ? 'no-eval' : 'no-function-constructor', `${node.text} cannot be used as a value`)
      }
      // document.cookie, element.innerHTML = ..., element.outerHTML = ...
      if (ts.isPropertyAccessExpression(node)) {
        if (node.name.text === 'cookie' && ts.isIdentifier(node.expression) && node.expression.text === 'document') report(node, 'no-document-cookie', 'document.cookie is not allowed')
        if ((node.name.text === 'innerHTML' || node.name.text === 'outerHTML') && ts.isBinaryExpression(node.parent) && node.parent.left === node) {
          report(node, 'no-raw-html', `Assigning ${node.name.text} is not allowed; render with JSX`)
        }
      }
      if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression) && node.argumentExpression.text === 'cookie' && ts.isIdentifier(node.expression) && node.expression.text === 'document') {
        report(node, 'no-document-cookie', 'document.cookie is not allowed')
      }
      // dangerouslySetInnerHTML as a JSX attribute or a props object key
      if (ts.isJsxAttribute(node) && ts.isIdentifier(node.name) && node.name.text === 'dangerouslySetInnerHTML') report(node, 'no-raw-html', 'dangerouslySetInnerHTML is not allowed; render with JSX')
      if (ts.isPropertyAssignment(node) && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) && node.name.text === 'dangerouslySetInnerHTML') {
        report(node, 'no-raw-html', 'dangerouslySetInnerHTML is not allowed; render with JSX')
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
  }
  return errors
}

/**
 * How `eval:classify` scores a probe (`evals/probes/*.json`), as pure functions. A probe's `expected` is either a
 * verdict-like label (`ui`, `needs-backend`, ...) or a label from the /admin Labels screen (DECISIONS 81, exported by
 * `pleatkit labels export`): `clarify` (the classifier should say `unclear`), `declined` (its intent label should be
 * `adversarial`), `mixed` (a screen part and a server part: the classifier should say `ui`, the agent passes the
 * server part on as `partial`), `off-topic`, `restore` (DECISIONS 84.2: the classifier should say `restore`; by name).
 */

/** The verdict a probe stands for: `ui` → `ok`, `mixed` → `partial`, everything else by name. */
export function probeVerdict(expected: string): string {
  return expected === 'ui' ? 'ok' : expected === 'mixed' ? 'partial' : expected
}

/** Whether the probe's request should end in a screen change (`ui` and the screen part of `mixed`). */
export const probeChanges = (expected: string): boolean => expected === 'ui' || expected === 'mixed'

/** The classifier answer an expected verdict needs: ok/partial/not-editable → ui, clarify → unclear, declined → adversarial (intent), refused → off-topic. */
export const wantedLabel = (verdict: string): string =>
  verdict === 'ok' || verdict === 'partial' || verdict === 'not-editable' ? 'ui' : verdict === 'clarify' ? 'unclear' : verdict === 'declined' ? 'adversarial' : verdict === 'refused' ? 'off-topic' : verdict

/** Right when the classifier's `label/intentLabel` sends the request where its expected verdict needs it. */
export function classifiedRight(expectedVerdict: string, now: string): boolean {
  const [label, intent] = now.split('/')
  const w = wantedLabel(expectedVerdict)
  return w === 'adversarial' ? intent === 'adversarial' : label === w
}

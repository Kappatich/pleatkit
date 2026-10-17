## What changed

<!-- one paragraph; link the DECISIONS / V1 item -->

## Risk tier

- [ ] touches a CODEOWNERS path (rules, signatures, auth, money, schema, prompt, public API): a human reads it before merge
- [ ] prompt or model change: the eval report is attached (DECISIONS 43)

## What a human should check

<!-- the two or three places worth reading -->

## How to roll back

<!-- revert this PR? a flag? a migration to undo? -->

## Cost

<!-- model, sessions and $ spent on this change (DECISIONS 43) -->

## Checks

- [ ] `pnpm build && pnpm test && pnpm e2e && pnpm lint` pass
- [ ] ARCHITECTURE.md changed in this PR if the design changed (no "consider it refined")
- [ ] docs for agents (`docs/for-agents/`) updated if setup or behaviour changed

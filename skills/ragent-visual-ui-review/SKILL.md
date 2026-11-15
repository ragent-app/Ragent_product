---
name: ragent-visual-ui-review
description: Review and improve Ragent frontend surfaces through synthetic Playwright screenshots, project-specific visual rules, focused browser checks, and bounded fix-and-confirm passes. Use for changes to static/chat CSS or JavaScript, mobile layout, composer, messages, sidebar, Run Sheet, Workbench, readers, menus, sheets, icons, glass surfaces, responsive behavior, or any request to polish, critique, audit, harden, or visually verify Ragent UI.
---

# Ragent Visual UI Review

Use this workflow to turn frontend review into evidence and implementation, not a prose-only critique.

## Establish Context

1. Use the current repository root as the working directory.
2. Read `AGENTS.md`, `PRODUCT.md`, `DESIGN.md`, and the current note relevant to the target.
3. Read [references/review-checklist.md](references/review-checklist.md).
4. Inspect the target implementation and its nearest browser or static tests.
5. Treat `DESIGN.md` as higher priority than Impeccable, Vercel, or generic design guidance.

## Choose Supporting Skills

- Use `$impeccable critique` for first-pass hierarchy and design-system analysis.
- Use `$impeccable adapt` for responsive and device behavior.
- Use `$impeccable harden` for long content, i18n, empty, error, loading, and overflow states.
- Use `$impeccable polish` only after the workflow is functionally complete.
- Use `$impeccable animate` only for purposeful state transitions or physical panel motion.
- Do not invoke `bolder`, `colorize`, `delight`, or `overdrive` unless the user explicitly requests that direction.
- Use `$web-design-guidelines` after visual fixes, not as the source of the visual direction.

## Capture Synthetic Evidence

Run the bundled fixture command before judging a material UI change:

```bash
node skills/ragent-visual-ui-review/scripts/capture-fixtures.mjs --target all --output <task-output-directory>
```

Use a narrower target when the change is isolated:

```bash
node skills/ragent-visual-ui-review/scripts/capture-fixtures.mjs --target sidebar
node skills/ragent-visual-ui-review/scripts/capture-fixtures.mjs --target activity
node skills/ragent-visual-ui-review/scripts/capture-fixtures.mjs --target mobile
```

Choose an output directory in the permitted task workspace. On the original Linux deployment, omitting `--output` defaults to `/var/lib/ragent/workspace/visual-ui-reviews/`; that path is not portable.

Use synthetic fixtures by default. Do not capture real session content, credentials,
private files, provider authentication, or user messages. Use the live application only
when the target cannot be represented by fixtures and the user has authorized that flow.

## Review Before Reading CSS

For the first visual pass, inspect the screenshots without reopening the implementation.
Use image inspection on every generated PNG relevant to the target.

If the executing model cannot view images directly, use an available image inspection tool or ask for help inspecting the generated evidence.

Rank no more than five findings by user impact. Prefer findings about:

1. Primary focus and workflow-state clarity.
2. Thumb reach, action placement, and touch size.
3. Overlap, clipping, horizontal overflow, or unstable geometry.
4. Information hierarchy, density, spacing rhythm, and text wrapping.
5. Surface, glass, shadow, radius, icon, and state consistency.

Do not report a generic anti-pattern when `DESIGN.md` explicitly allows it. Explain the
specific user-visible failure instead.

## Fix In Bounded Passes

When the user asked to implement or polish, treat that as authorization to fix accepted
findings without pausing for another approval.

1. Fix the root cause in one focused batch.
2. Preserve existing product behavior and state contracts.
3. Add or update focused assertions when geometry or interaction contracts change.
4. Re-run the targeted fixture command and focused tests.
5. Inspect the confirmation screenshots once.
6. Run a third pass only if confirmation reveals a new material defect.

Do not continue polishing after the bounded confirmation passes.

## Run Final Audit

Use `$web-design-guidelines` on the changed frontend files. Classify every finding as:

- `fix`: applicable and user-impacting.
- `project-exception`: intentionally overridden by `DESIGN.md`.
- `not-applicable`: outside the changed surface or incompatible with the architecture.

Record the guideline retrieval date because that Skill fetches changing upstream rules.

## Validate And Report

- Run focused tests first, then the relevant clean-instance suite.
- Do not run live tests against active private state when a fixture test is sufficient.
- Report source-tested, hot-mounted, packaged/installed, and live-verified states separately.
- Do not install, restart, or deploy without following the repository maintenance gate.
- Keep before/after screenshots as review artifacts for material visual changes.
- State any accepted project exceptions and remaining visual risk.

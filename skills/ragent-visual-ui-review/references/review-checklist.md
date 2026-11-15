# Ragent Visual Review Checklist

Use this checklist after reading `DESIGN.md`. Apply only the sections relevant to the changed surface.

## Evidence Matrix

Review representative widths: 360, 390, 430, 1024, and 1440 CSS pixels.
Cover light and dark themes when supported. Cover idle, running, waiting for user,
approval, completed, empty, and error states when the component renders them.

## Composition

- The current workflow state is the first meaningful visual signal.
- The primary action is obvious and not duplicated across competing surfaces.
- Mobile decisions sit near the bottom thumb zone.
- Page sections are not converted into decorative floating cards.
- Cards are not nested inside cards without a functional containment reason.
- Dense operational surfaces remain scannable rather than becoming editorial or promotional.

## Geometry

- No incoherent overlap, clipping, layout shift, or horizontal page scrolling.
- Long English, Chinese, paths, commands, and code wrap or scroll inside the correct local container.
- Safe areas, dynamic viewport units, keyboard height, orientation, and scroll restoration remain stable.
- Sheets and portaled menus stay inside the visual viewport and follow their triggers.
- Icon-only controls are centered and do not inherit text-baseline drift.

## Interaction

- Primary touch targets are at least 44px; prominent decision actions are normally about 52px.
- Focus-visible, hover, pressed, selected, disabled, loading, and error states remain legible.
- Edge gestures match physical direction and never begin in the composer.
- Sheet drag and snap behavior distinguishes taps from drags.
- Outside-click and Escape behavior include portaled surfaces.

## Visual System

- Hierarchy uses surface contrast and soft shadow rather than visible borders.
- Glass remains readable and does not become opaque, foggy, or visually detached from context.
- Proportional radius tiers match component size.
- Icons use the shared 24px outline language.
- Sentence case and zero letter spacing are preserved.
- Semantic color communicates workflow state; decorative color does not dominate the product.

## Content And Accessibility

- Accessible names exist for icon-only controls.
- Status updates and approvals expose appropriate semantics without revealing hidden chain of thought.
- Empty, loading, error, offline, and long-content states are understandable.
- Reduced-motion users retain complete state feedback.
- Text remains readable under browser zoom and mobile text scaling.

## Review Output

Return at most five findings, ordered by user impact. For each finding include the surface,
evidence screenshot, observed failure, applicable project rule, and concrete fix. After the
fix pass, record which findings are resolved and any accepted project exception.

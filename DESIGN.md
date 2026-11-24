# DESIGN.md — VibeBuilder

Direction for the VibeBuilder workspace UI. This file holds design fields only
(identity, palette, typography, dials). The filter applied on top is `antislop.md`.

## Identity

**Product:** a build workspace where one developer types what an app should do and
watches an agent write the files, build them, and serve a live preview.

**What the shell must feel like:** a workbench, not a pitch. Dense, warm, quiet.
Every pixel is either information or space that separates information. No surface
competes with the generated app sitting in the preview pane, because that app is
the actual subject of the screen.

**Motif:** a 1px rule with a 3px square notch at the left end, used at every panel
boundary and section header. It reads as a machined seam, and it is the one repeated
gesture that makes the shell belong to this tool.

## Palette (3 cores + 1 accent)

| Role | Dark | Light |
|---|---|---|
| Core 1, ink (page) | `#12110f` | `#f5f2ec` |
| Core 2, surface (panels) | `#191816` | `#fffdf9` |
| Core 3, edge (rules, muted text) | `#2a2723` / `#8b857c` | `#e0dad0` / `#6b655c` |
| Accent, copper | `#c0703f` | `#a3521f` |

Reason for copper: it is the single accent, it marks exactly three things
(active project, primary action, focus ring), and it cannot be mistaken for the
blue-purple gradient default.

Reason for warm neutral instead of blue-black: the preview pane holds arbitrary
generated apps, most of which lean cold. A warm shell keeps the seam between
"my tool" and "their app" visible without a border thick enough to notice.

## Typography

| Use | Stack | Reason |
|---|---|---|
| Display, wordmark, empty-state heading | Iowan Old Style, Palatino Linotype, Palatino, Georgia, serif | An editorial face makes the shell read as a craft workspace rather than another dashboard. Serif display against sans UI is a deliberate contrast, not a trend. |
| UI text, chat, controls | system-ui stack | Maximum legibility at 12 to 13px in a dense three-pane layout, with zero webfont latency and no shared library look. |
| Code, file paths, build log, preview URL | ui-monospace | These are literals, so mono is semantic here. It is never used as decoration on headings or labels. |

No uppercase tracking on labels. Sentence case everywhere. Labels are 11 to 12px
at normal weight, distinguished by color and position, not by shouting.

## Dials

```
Dial: ENERGY 1 / RHYTHM 2 / MOTION 1
```

**ENERGY 1.** The screen is a tool being used, not a page being sold. Nothing says
hello. The only saturated pixel is the accent, and it appears three times per view.

**RHYTHM 2.** The shell is constant (sidebar, header, pane split), but the pane
composition changes meaningfully by state: empty project, running agent, code view,
preview view, build failure. Variation comes from content, not from restyling sections.

**MOTION 1.** Hover and focus transitions only, 120ms. The one exception is the
agent activity indicator, which is a real state and stops when the agent stops.
`prefers-reduced-motion: reduce` disables all of it.

## Radii, elevation, density

- Radii: `2px` controls, `4px` panels, `0` for full-bleed regions. No pills.
- Shadow: none. Separation is done with 1px rules and surface value shifts.
- Density: 32px control height on desktop, 44px on touch breakpoints.

## Non-negotiables this design holds itself to

- Both themes are shipped and both are verified, not one theme plus a claim.
- The mobile shell is a real layout: sidebar becomes a sheet with a labelled trigger.
- No decorative dots, no decorative badges, no glow, no grid background.
- Every empty, loading, and error state names its cause and the next action.

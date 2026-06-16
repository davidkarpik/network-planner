# Changelog

All notable changes to Network Planner, newest first. Each release's section is mirrored in
the [release notes](https://github.com/davidkarpik/network-planner/releases); this file is
the single source of truth.

## 0.54.0 – 2026-06-10

- Network length: a new "Network – what you've built" card on the Planning tab shows your
  system length (all lines, one-way), total track built, planned blueprint track and the
  station count – and the per-route table gains a Length column. Lengths are measured along
  the actual track paths and deduplicated, so shared corridors, return directions and
  parallel tracks never double-count.
- Start here – your first line: your biggest residential hubs (red, ranks 1–5) and job hubs
  (violet, ranks 6–10) draw as numbered areas on the map, and on a fresh map with no
  stations the Planning tab ranks them in a list with a busiest-link figure, so the first
  line has a target before anything is built. A good first line connects a big red hub to a
  big violet one.
- Setup tab redesigned as a settings page: titled cards with toggle switches, sliders, a
  segmented imagery picker and a live tile-proxy status row.
- Game speed: a Run control that fast-forwards the game at maximum speed and pauses
  automatically at the next midnight – fill in a day of data without overshooting.
- Explanations are now contextual: the glossary card is gone; every concept has a small "i"
  button right where it appears, in the Planning KPIs, the section headers and the Setup
  layer rows.

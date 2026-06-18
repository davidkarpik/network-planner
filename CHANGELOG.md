# Changelog

All notable changes to Network Planner, newest first. Each release's section is mirrored in
the [release notes](https://github.com/davidkarpik/network-planner/releases); this file is
the single source of truth.

## 0.60.0 – 2026-06-18

- Walk-shed catchments: each station's reach is traced along the city's real road network – a
  pathfinding pass finds the streets you can actually walk in 5, 10 and 15 minutes, so
  coverage hugs the grid and stops at rivers and highways instead of crossing them.
  Blueprinted stations draw their reach live, in blue, so you can plan a whole multi-stop
  extension before committing to build.
- Per-station focus card: click any station for the catchment it serves (residents and jobs),
  the net-new it uniquely adds over every other station, the share that is a genuine on-foot
  walk, and its 5/10/15-minute bands.
- Game/Walk count toggle: flip a station's count between what the sim credits – straight-line,
  the way it predicts ridership – and what is actually reachable on foot along the streets.
- Walkable %: a new measure of how much of a station's catchment is a real street walk versus
  counted as in-range but cut off by a river or highway, so you can spot stops that score on
  paper but really lean on transfers or driving.
- Daily capacity advisor on the Efficiency tab: yesterday condensed into plain findings – add
  trains where the game raised crowding alerts on a loaded line, harvest capacity where a line
  ran near-empty for days, and watch the ambiguous cases. Per-line load factor keeps the
  day-over-day trend and a one-word status.
- Station markers simplified: each station shows just its transit-share %, in its color, so
  the map reads cleanly under the catchments and demand layers.
- More contextual "i" explanations, including what load factor measures and why a line's
  rolling average can differ from the peak hour the advisor flags.

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

# Network Planner

A planning and analytics suite for [Subway Builder](https://www.subwaybuilder.com). It reads the game's real demand grid and live line metrics to show exactly where a station's riders come from, where to expand next, and which lines need more trains, when. It also answers the basics the game keeps to itself: how long your system and each line are, and where a brand-new map's first line should go.

[![Latest Release](https://badgen.net/github/release/davidkarpik/network-planner?label=stable&color=green)](https://github.com/davidkarpik/network-planner/releases/latest)
[![Download](https://badgen.net/badge/download/releases/green?icon=github)](https://github.com/davidkarpik/network-planner/releases)
[![License](https://badgen.net/github/license/davidkarpik/network-planner?color=blue)](LICENSE)

![Network Planner](docs/hero.png)

*A grown network on the key-free satellite basemap. The orange webs are each station's walk-shed – the streets actually reachable on foot, traced along the real road network so the reach hugs the grid and stops at rivers and highways. The colored areas and dots are demand: where the residents and jobs are, and the uncovered markets a single extension would win.*

---

## What it does

Network Planner adds a three-tab panel alongside the game. The analysis works with zero setup: no dependencies, no account, no key.

### Planning: where to grow

- Real walk-shed catchments: from each station, a pathfinding pass over the game's street network traces the roads you can reach on foot in 5, 10 and 15 minutes – so coverage follows the actual grid and stops at rivers and highways instead of crossing them. Blueprinted stations draw their reach live, in blue, so you can plan a whole multi-stop expansion before committing to build.
- Click any station for its focus card: the catchment it serves (residents and jobs), how much of that is unique to it (net-new), and the share that is a genuine on-foot walk. A Game/Walk toggle flips the count between what the sim credits (straight-line, the way it predicts ridership) and what is actually reachable on foot.
- Start here on a fresh map: your biggest residential hubs (red) and job hubs (violet) as numbered areas, ranked in the panel, so the first line has a target before any station exists.
- Mode-shift potential: drivers whose home and work are both reachable. Your genuinely winnable market, not a vanity number.
- A ranked "Build here next" list of the biggest unserved markets. Click a row to fly straight there.
- Network facts at a glance: system length (all lines, one-way), total track built, planned blueprint track, and a per-line Length column – measured along the actual track paths, with shared corridors and parallel tracks counted once.

![The Planning tab – a station's walk-shed catchment and focus card](docs/planning.png)

*The Planning tab with a station selected. On the map: its walk-shed catchment in orange, the streets reachable on foot. In the focus card: the catchment it serves, the net-new it uniquely covers, the walkable share (here 80% is a real walk), the 5/10/15-minute bands, and the Game/Walk toggle. Below: city-wide coverage and mode-shift KPIs, the Network card, and the ranked "Build here next" list.*

![Demand hubs – where the residents and jobs are](docs/hubs.png)

*Where the demand sits: residential areas in red, job areas in violet, sized and ranked. Jobs cluster into a few dense spots while homes spread out, so each group is ranked on its own and a strong first line connects a big red hub to a big violet one.*

### Efficiency: how well it runs

- A daily capacity advisor that condenses yesterday into plain findings: add trains where the game raised crowding alerts on a loaded line, harvest capacity where a line ran near-empty for several days, and watch the ambiguous cases.
- Per-line Load Factor with the day-over-day trend and a one-word status, so you can see which lines are tight before you buy trains.
- Remembers your data per save, so it is never blank on reload.

![The Efficiency tab – the daily advisor and load factor by line](docs/efficiency.png)

*The Efficiency tab. Up top: yesterday's capacity findings (here, a line with idle capacity to harvest), then system load factor, riders per hour and trains deployed. Per line: riders, trains, load, the day-over-day change and a plain-English status. The "i" explains what load factor measures and why it can read differently from other tools.*

### Setup

A settings page of cards: game speed (a Run control that fast-forwards at maximum speed and pauses at the next midnight), map layer toggles, key-free satellite imagery (Esri, Google, Hybrid, OSM) with opacity, and station-label size. There is no glossary to hunt through – every concept is explained by a small "i" button right where it appears.

---

### Concepts explained

| Term | What it means |
|---|---|
| Walk-shed | The streets actually reachable on foot from a station within a walk-time budget, traced along the real road network. It hugs the grid and stops at rivers and highways instead of crossing them. Blueprinted stations draw theirs in blue while you sketch a line. |
| Catchment | The residents and jobs the game credits a station – measured straight-line, the way the sim does, so it predicts ridership. The Game/Walk toggle on the focus card flips the count to the on-foot walk-shed instead. |
| Walkable % | How much of a station's catchment is a genuine street walk, versus counted as "in range" but cut off by a river or highway the straight-line model ignores. A low % is a stop that scores on paper but really leans on transfers, park-and-ride or driving. |
| Net-new | For a station, the residents and jobs no other station already covers – what it uniquely adds to the network. |
| System length | The one-way length of every station-to-station leg your lines serve, measured along the actual track path. Each leg counts once, even when lines share it, run both directions, or use parallel tracks. |
| Track built | Every constructed track piece on the map. Parallel tracks, sidings and crossovers all add up, so it is usually longer than the system length. |
| Demand hubs | The biggest residential areas (red, ranks 1 to 5) and job areas (violet, ranks 6 to 10) before you build. Jobs cluster while homes spread, so each group gets its own ranking; a good first line connects a big red hub to a big violet one. |
| Coverage % | Share of the whole city's residents (and jobs) within walking reach of any station, counted once. |
| Mode-shift potential | Drivers whose home and work both fall within a catchment. The riders you can win on today's network. |
| Latent demand | Would-be riders who drive today and whose other trip end is already on your network, so one extension wins them. Dot size is how many; dot color is distance to your nearest station (green means build now, magenta means a corridor to grow toward). |
| Station transit share | Of the motorized commuters near a station, the share who already ride instead of drive (the dot's percentage and color). Low means lots of nearby drivers not yet won. |
| Load Factor | riders/hr divided by (trains/hr times train capacity). The table shows the rolling average across the day; the advisor flags the peak hour, so rush overcrowding is never hidden. |
| vs yest | Day-over-day change in a line's average load. |

---

## Installation

1. Create a `network-planner` folder in your mods directory (Main Menu > Settings > Mods).
2. Download the [latest ZIP from the releases page](https://github.com/davidkarpik/network-planner/releases/latest).
3. Extract the ZIP contents into the `network-planner` folder.
4. Restart the game and activate Network Planner.

The Planning and Efficiency tabs work immediately. No setup, no dependencies, no key.

### Satellite imagery (optional)

Satellite is the only feature that needs anything extra. The game blocks external tile domains, so tiles are served from a tiny local proxy on `127.0.0.1`. It requires [Node.js](https://nodejs.org). All four providers are key-free.

macOS, run once and it auto-starts at login:

```bash
bash install-proxy.sh
```

(from the mod folder; remove with `bash install-proxy.sh --uninstall`)

Windows, register once:

```powershell
schtasks /create /tn NetworkPlannerSatProxy /tr "node \"%APPDATA%\metro-maker4\mods\network-planner\proxy.js\"" /sc onlogon /f
```

Any OS, each session:

```bash
node proxy.js
```

The Setup tab shows whether the proxy is connected and guides you if it is not.

Provider note: Esri World Imagery and OpenStreetMap are licensed for use; the Google endpoints are unofficial, fine for personal play, which is why Esri is the default.

---

## Contributing

Bug reports and ideas are very welcome.

- Found a bug? [Open an issue](https://github.com/davidkarpik/network-planner/issues/new) with steps to reproduce and your game version.
- Have an idea? Open an issue to discuss it before sending a PR.

### Useful links

|  |  |
|---|---|
| Subway Builder | [subwaybuilder.com](https://www.subwaybuilder.com) |
| Official API docs | [subwaybuilder.com/docs](https://www.subwaybuilder.com/docs/) |

---

## License

[GPL-3.0-only](LICENSE), 2026 David Karpik.

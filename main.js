/*
 * Network Planner - a planning and analytics mod for Subway Builder
 * Copyright (C) 2026 David Karpik
 * Licensed under the GNU General Public License v3.0 only (GPL-3.0-only);
 * see the LICENSE file for the full text.
 */
(function () {
	const api = window.SubwayBuilderAPI;
	const React = api.utils.React;
	const h = React.createElement;

	// ---------------------------------------------------------------------------
	// Config / constants
	// ---------------------------------------------------------------------------

	// Catchment is a walk-time budget in seconds, from the game's catchment model + the
	// catchmentMultiplier exposed per station type:
	//   catchmentSeconds = catchmentOverride ?? (BASE_CATCHMENT_SECONDS * catchmentMultiplier)
	//   radiusMeters     = catchmentSeconds * WALKING_SPEED * walkSpeedMultiplier
	// BASE is the 30-minute walk budget (60 * 30 = 1800s). For "standard": ~1800 m.
	const BASE_CATCHMENT_SECONDS = 1800;
	const CIRCLE_SIDES = 64;
	const EARTH_R = 6378137; // meters

	let WALK_SPEED = 1; // overwritten from game constants on map ready

	// Catchment fill (theme-aware neutral gray, kept subtle and transparent over the map)
	const FILL_DARK = "#aeb6c224";
	const OUTLINE_DARK = "rgb(150, 160, 175)";
	const FILL_LIGHT = "#52596624";
	const OUTLINE_LIGHT = "rgb(90, 98, 110)";
	// Gap (uncovered demand, OUTSIDE any catchment) markers
	const GAP_COLOR = "#ff5a3c";
	// Conversion (drivers INSIDE a catchment – addressable, not yet won) markers
	const CONV_COLOR = "#ffc83d";
	// Steady-demand accent (panel cards / KPI / toggle dot). Red, matching the demand-hub areas
	// and the game's own red = demand convention.
	const HUB_ACCENT = "#ef5350";
	// Demand-hub area fills: residential = RED, jobs = faint VIOLET (distinct enough to read home-
	// vs-job on the map; the 1..10 numbers reinforce it). Both are faint background areas.
	const HUB_HOME = "#c0392b"; // red (residential)
	const HUB_JOB = "#8366f0"; // violet (jobs)

	const SRC_CATCH = "cpro-catchments";
	const LYR_CATCH = "cpro-catchment-fill";
	const SRC_GAP = "cpro-gaps";
	const LYR_GAP = "cpro-gap-points";
	const SRC_CONV = "cpro-conversion";
	const LYR_CONV = "cpro-conversion-points";
	const SRC_STN = "cpro-stations";
	const LYR_STN = "cpro-station-markers";
	const LYR_STN_LABEL = "cpro-station-labels";
	// First-line finder (greenfield): demand centers (clusters of residents/jobs), shown before
	// any station exists to answer "where does my first line go?"
	const SRC_CEN = "cpro-centers";
	const LYR_CEN = "cpro-center-markers";
	const LYR_CEN_LABEL = "cpro-center-labels";
	// Satellite imagery overlay (real photographic tiles via the local proxy). The game hard-
	// blocks all external tile domains (only subwaybuilder.com / protomaps / localhost / 127.0.0.1
	// load – proven: even a plain <img> to an external host fails), so tiles MUST come through the
	// localhost proxy (proxy.js on SAT_PROXY_PORT). All 4 providers are key-free. Below city layers.
	const SRC_SAT = "cpro-satellite";
	const LYR_SAT = "cpro-satellite-layer";
	const SAT_PROXY_PORT = 8454;
	let satProvider = "esri"; // tile provider; all 4 are key-free
	function satTileUrl() {
		return "http://127.0.0.1:" + SAT_PROXY_PORT + "/tile/" + satProvider + "/{z}/{x}/{y}";
	}
	const SAT_PROVIDERS = [
		{ id: "esri", label: "Esri" },
		{ id: "google", label: "Google" },
		{ id: "hybrid", label: "Hybrid" },
		{ id: "osm", label: "OSM" },
	];
	let satLayerDef = null; // current satellite raster layer definition (rebuilt on each (re-)add)
	// Live layer-definition objects, (re)built by ensureLayers from the current toggle flags.
	let catchDef = null,
		gapDef = null,
		convDef = null,
		stnDef = null,
		stnLabelDef = null,
		cenDef = null,
		cenLabelDef = null;

	// ---------------------------------------------------------------------------
	// Geometry
	// ---------------------------------------------------------------------------

	// Catchment ring as a local-projection circle: for radii of a few km the equirectangular
	// lat/lon offset is visually exact and avoids per-vertex great-circle trig. Closed lon/lat ring.
	function catchmentRing(lon, lat, radiusMeters, sides) {
		const ring = new Array(sides + 1);
		const dLat = radiusMeters / 111320; // degrees of latitude per metre
		const dLon = radiusMeters / (111320 * Math.cos((lat * Math.PI) / 180) || 1e-6);
		for (let i = 0; i < sides; i++) {
			const a = (i / sides) * 2 * Math.PI;
			ring[i] = [lon + dLon * Math.cos(a), lat + dLat * Math.sin(a)];
		}
		ring[sides] = ring[0];
		return ring;
	}

	// Irregular "blob" ring: an organic, aerial demand-area outline (deterministic from `seed`, so
	// each hub keeps a stable unique shape across recomputes). Used for the greenfield demand hubs
	// so they read as soft regions on the ground, not crisp circle markers like the other overlays.
	function blobRing(lon, lat, radiusMeters, seed) {
		const sides = 30;
		const ring = new Array(sides + 1);
		const dLatBase = radiusMeters / 111320;
		const cosLat = Math.cos((lat * Math.PI) / 180) || 1e-6;
		for (let i = 0; i < sides; i++) {
			const a = (i / sides) * 2 * Math.PI;
			// a few low harmonics (all integer multiples of a, so the ring closes smoothly) give an
			// organic wobble; `seed` phase-shifts them so neighbouring hubs don't look identical.
			const j = 0.82 + 0.2 * Math.sin(a * 2 + seed) + 0.12 * Math.sin(a * 3 - seed * 1.7) + 0.06 * Math.sin(a * 5 + seed * 2.3);
			const rLat = dLatBase * j;
			ring[i] = [lon + (rLat / cosLat) * Math.cos(a), lat + rLat * Math.sin(a)];
		}
		ring[sides] = ring[0];
		return ring;
	}

	function haversineMeters(lon1, lat1, lon2, lat2) {
		const toRad = Math.PI / 180;
		const dLat = (lat2 - lat1) * toRad;
		const dLon = (lon2 - lon1) * toRad;
		const a =
			Math.sin(dLat / 2) ** 2 +
			Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
		return 2 * EARTH_R * Math.asin(Math.sqrt(a));
	}

	// ---------------------------------------------------------------------------
	// Catchment model
	// ---------------------------------------------------------------------------

	function catchmentRadiusMeters(station) {
		const st = api.stations.getStationType(station.stationType) || {};
		const catchMult = st.catchmentMultiplier != null ? st.catchmentMultiplier : 1;
		const walkMult = st.walkSpeedMultiplier != null ? st.walkSpeedMultiplier : 1;
		const seconds =
			st.catchmentOverride != null
				? st.catchmentOverride
				: BASE_CATCHMENT_SECONDS * catchMult;
		return seconds * WALK_SPEED * walkMult;
	}

	// ---------------------------------------------------------------------------
	// Compute (cached; runs on events, never per-frame)
	// ---------------------------------------------------------------------------

	let catchmentFC = { type: "FeatureCollection", features: [] };
	let gapFC = { type: "FeatureCollection", features: [] };
	let conversionFC = { type: "FeatureCollection", features: [] };
	let stationFC = { type: "FeatureCollection", features: [] };
	let centerFC = { type: "FeatureCollection", features: [] };
	let stats = null;

	function emptyStats() {
		return {
			stationCount: 0,
			cityResidents: 0,
			cityJobs: 0,
			coveredResidents: 0,
			coveredJobs: 0,
			overlapResidents: 0,
			overlapJobs: 0,
			gapCount: 0,
			gapResidents: 0,
			gapJobs: 0,
			// conversion: mode split of people whose home/work is within reach of a station
			coveredDrivers: 0, // drive despite having a station nearby = the opportunity
			coveredTransit: 0, // already won
			coveredWalking: 0,
			// Level 2 – journey-level (pop pairs: home + work both within a catchment)
			convertibleDrivers: 0, // drive today, but BOTH ends are walkable to a station
			homeOnlyDrivers: 0, // only home end served
			workOnlyDrivers: 0, // only work end served
			bothEndsTransit: 0, // already on transit with both ends served
			bothEndsDriving: 0, // same as convertibleDrivers (denominator helper)
			topBuildTargets: [], // ranked build-here opportunities for the panel
			perStation: [],
			perRoute: [],
			// greenfield first-line finder (works with zero stations)
			cityCommuters: 0, // total home->work O-D volume
			firstLines: [], // ranked demand corridors (zone A <-> zone B)
			demandCenters: [], // top demand zones (residents + jobs)
			demandAvailable: false,
			// network length (from the game's track paths)
			systemLengthM: 0, // unique station-to-station legs across all lines, one-way
			trackBuiltM: 0, // every constructed track piece (parallels/sidings included)
			trackPlannedM: 0, // blueprint track not yet built
		};
	}

	function driversAt(p) {
		const r = p.residentModeShare || {};
		const w = p.workerModeShare || {};
		return (r.driving || 0) + (w.driving || 0);
	}
	function transitAt(p) {
		const r = p.residentModeShare || {};
		const w = p.workerModeShare || {};
		return (r.transit || 0) + (w.transit || 0);
	}
	function walkingAt(p) {
		const r = p.residentModeShare || {};
		const w = p.workerModeShare || {};
		return (r.walking || 0) + (w.walking || 0);
	}

	// ---- Network length (system km / per-line km) ----
	// Tracks come from api.gameState.getTracks(): { id, coords: [[lon,lat],..], length (meters),
	// buildType: "constructed" | "blueprint" }. Each line's path is rt.stCombos – one entry per
	// station-to-station leg, { trackIds: [{ trackId, reversed }, ..], distance (meters) }.
	// A leg is keyed by its two endpoint coords (order-independent) plus its rounded length, so
	// the same physical leg counts ONCE even when a line runs it in both directions, several
	// lines share it, or it sits on a parallel-track corridor – while genuinely different paths
	// between the same two stations stay distinct.
	function trackLengthM(t) {
		if (!t) return 0;
		if (Number.isFinite(t.length) && t.length > 0) return t.length;
		const c = t.coords;
		if (!Array.isArray(c) || c.length < 2) return 0;
		let m = 0;
		for (let i = 1; i < c.length; i++) {
			const a = c[i - 1];
			const b = c[i];
			if (!a || !b) continue;
			m += haversineMeters(a[0], a[1], b[0], b[1]);
		}
		return m;
	}
	function comboTrackEntries(combo) {
		const list = combo && combo.trackIds;
		if (!Array.isArray(list)) return [];
		const out = [];
		for (const it of list) {
			if (it == null) continue;
			if (typeof it === "object") {
				if (it.trackId != null) out.push({ id: String(it.trackId), reversed: !!it.reversed });
			} else {
				out.push({ id: String(it), reversed: false });
			}
		}
		return out;
	}
	function legInfo(combo, trackById) {
		const entries = comboTrackEntries(combo);
		let dist = combo && Number.isFinite(combo.distance) && combo.distance > 0 ? combo.distance : 0;
		if (!dist) for (const e of entries) dist += trackLengthM(trackById.get(e.id));
		if (!(dist > 0)) return null;
		// Leg endpoints = first coord of the first track piece / last coord of the last one
		// (respecting each piece's running direction) – i.e. the two station ends of the leg.
		let key = null;
		if (entries.length) {
			const first = entries[0];
			const last = entries[entries.length - 1];
			const tA = trackById.get(first.id);
			const tB = trackById.get(last.id);
			const okA = tA && Array.isArray(tA.coords) && tA.coords.length > 1;
			const okB = tB && Array.isArray(tB.coords) && tB.coords.length > 1;
			const cA = okA ? (first.reversed ? tA.coords[tA.coords.length - 1] : tA.coords[0]) : null;
			const cB = okB ? (last.reversed ? tB.coords[0] : tB.coords[tB.coords.length - 1]) : null;
			if (cA && cB) {
				const pt = (c) => c[0].toFixed(5) + "," + c[1].toFixed(5); // ~1 m grid
				const a = pt(cA);
				const b = pt(cB);
				key = (a < b ? a + "|" + b : b + "|" + a) + "|" + Math.round(dist);
			}
		}
		if (!key) {
			// No resolvable geometry – key on the track-id set instead (still collapses the
			// same leg run in both directions over the same tracks).
			key =
				entries
					.map((e) => e.id)
					.sort()
					.join(",") +
				"|" +
				Math.round(dist);
		}
		return { key: key, dist: dist };
	}
	// Fills s.trackBuiltM / s.trackPlannedM / s.systemLengthM; returns Map(routeId -> meters).
	function computeNetworkLength(routes, s) {
		const perRouteLen = new Map();
		let tracks = [];
		try {
			if (api.gameState && typeof api.gameState.getTracks === "function") tracks = api.gameState.getTracks() || [];
		} catch (e) {
			tracks = [];
		}
		const trackById = new Map();
		for (const t of tracks) {
			if (!t || t.id == null) continue;
			trackById.set(String(t.id), t);
			if (t.buildType === "constructed") s.trackBuiltM += trackLengthM(t);
			else if (t.buildType === "blueprint") s.trackPlannedM += trackLengthM(t);
		}
		const sysLegs = new Map(); // leg key -> meters, across all real (non-temp) lines
		for (const rt of routes) {
			if (!rt || !Array.isArray(rt.stCombos) || !rt.stCombos.length) continue;
			const legs = new Map();
			for (const combo of rt.stCombos) {
				const leg = legInfo(combo, trackById);
				if (leg) legs.set(leg.key, leg.dist);
			}
			let m = 0;
			for (const v of legs.values()) m += v;
			if (m > 0) perRouteLen.set(rt.id, m);
			if (!rt.tempParentId) for (const [k, v] of legs) sysLegs.set(k, v);
		}
		for (const v of sysLegs.values()) s.systemLengthM += v;
		return perRouteLen;
	}

	// Resilience state: guard against the game firing a recompute while its station list is
	// transiently incomplete (a built station momentarily absent / coords-less), which would
	// wrongly drop that station's catchment until the next clean recompute.
	let lastGoodStationCount = 0;
	let deletionSignaled = false; // set by onStationDeleted so a real shrink is allowed
	let transientSkips = 0;

	function compute() {
		// Constructed stations only – blueprints are planned, not built, so they must NOT
		// count toward coverage/conversion or draw catchment circles (that also kills the
		// stale-circle-after-blueprint-delete glitch).
		const stations = (api.gameState.getStations() || []).filter(
			(s) => s && s.coords && s.buildType !== "blueprint"
		);

		// If the constructed count shrank without a deletion event, treat it as a transient
		// bad read and keep the last good result – but accept it if it persists (a real
		// removal whose event we missed), so we never get stuck.
		if (lastGoodStationCount > 0 && !deletionSignaled && stations.length < lastGoodStationCount && transientSkips < 3) {
			transientSkips++;
			return;
		}
		transientSkips = 0;
		deletionSignaled = false;
		lastGoodStationCount = stations.length;

		// Build accurate catchment circles + per-station radius
		const radii = new Array(stations.length);
		const features = [];
		for (let i = 0; i < stations.length; i++) {
			const stn = stations[i];
			const c = stn.coords;
			if (!c) continue;
			const r = catchmentRadiusMeters(stn);
			radii[i] = r;
			features.push({
				type: "Feature",
				properties: { stationId: stn.id },
				geometry: {
					type: "Polygon",
					coordinates: [catchmentRing(c[0], c[1], r, CIRCLE_SIDES)],
				},
			});
		}
		catchmentFC = { type: "FeatureCollection", features };

		const s = emptyStats();
		s.stationCount = stations.length;

		const demand = api.gameState.getDemandData();
		const per = stations.map((stn) => ({
			id: stn.id,
			name: stn.name,
			coords: stn.coords,
			residents: 0,
			jobs: 0,
			drivers: 0,
			transit: 0,
		}));

		// Per-route accumulators (union over the route's stations – no double count).
		const routes = api.gameState.getRoutes() || [];
		const routeAgg = new Map(); // routeId -> {residents, jobs, drivers, transit}
		for (const rt of routes) routeAgg.set(rt.id, { residents: 0, jobs: 0, drivers: 0, transit: 0 });

		if (demand && demand.points && demand.points.size) {
			s.demandAvailable = true;
			const degLat = 1 / 111320; // meters -> degrees latitude

			const coveredPointIds = new Set(); // for Level 2 journey lookup
			for (const p of demand.points.values()) {
				const loc = p.location;
				if (!loc) continue;
				const res = p.residents || 0;
				const jobs = p.jobs || 0;
				const drv = driversAt(p);
				const trn = transitAt(p);
				const wlk = walkingAt(p);
				s.cityResidents += res;
				s.cityJobs += jobs;

				// Which stations cover this point?
				let coverCount = 0;
				const routesHere = new Set();
				const cosLat = Math.cos(loc[1] * (Math.PI / 180)) || 1e-6;
				for (let i = 0; i < stations.length; i++) {
					const r = radii[i];
					if (!r) continue;
					const sc = stations[i].coords;
					// cheap bbox reject before haversine
					const rDegLat = r * degLat;
					if (Math.abs(loc[1] - sc[1]) > rDegLat) continue;
					if (Math.abs(loc[0] - sc[0]) > rDegLat / cosLat) continue;
					if (haversineMeters(loc[0], loc[1], sc[0], sc[1]) <= r) {
						coverCount++;
						per[i].residents += res;
						per[i].jobs += jobs;
						per[i].drivers += drv;
						per[i].transit += trn;
						const rids = stations[i].routeIds || [];
						for (const rid of rids) routesHere.add(rid);
					}
				}

				// attribute to each route once (union across that route's stations)
				for (const rid of routesHere) {
					const ra = routeAgg.get(rid);
					if (ra) {
						ra.residents += res;
						ra.jobs += jobs;
						ra.drivers += drv;
						ra.transit += trn;
					}
				}

				if (coverCount > 0) {
					coveredPointIds.add(p.id);
					s.coveredResidents += res; // union (counted once)
					s.coveredJobs += jobs;
					s.coveredDrivers += drv;
					s.coveredTransit += trn;
					s.coveredWalking += wlk;
					if (coverCount >= 2) {
						s.overlapResidents += res;
						s.overlapJobs += jobs;
					}
				} else if (res > 0 || jobs > 0) {
					s.gapCount++;
					s.gapResidents += res;
					s.gapJobs += jobs;
				}
			}

			// Level 2 + journey-level conversion layer. A driver is genuinely convertible
			// only when BOTH ends are walkable to a station. We also accumulate, per point,
			// the drivers whose OPPOSITE end is already served – i.e., serving THIS point
			// would win them. That's the non-geometric insight the circles can't show.
			const pointConv = new Map();
			const addConv = (pid, amt) => {
				if (pid) pointConv.set(pid, (pointConv.get(pid) || 0) + amt);
			};
			if (demand.popsMap && demand.popsMap.size) {
				for (const pop of demand.popsMap.values()) {
					const lc = pop.lastCommute;
					if (!lc || !lc.modeChoice) continue;
					const drv = lc.modeChoice.driving || 0;
					const homeCovered = coveredPointIds.has(pop.residenceId);
					const workCovered = coveredPointIds.has(pop.jobId);
					if (homeCovered && workCovered) {
						s.convertibleDrivers += drv;
						s.bothEndsDriving += drv;
						s.bothEndsTransit += lc.modeChoice.transit || 0;
					} else if (homeCovered) {
						s.homeOnlyDrivers += drv;
					} else if (workCovered) {
						s.workOnlyDrivers += drv;
					}
					if (drv > 0) {
						if (workCovered) addConv(pop.residenceId, drv); // serve home end → win them
						if (homeCovered) addConv(pop.jobId, drv); // serve work end → win them
					}
				}
			}
			// LATENT DEMAND markets: UNCOVERED points whose opposite trip end is already on the
			// network (one extension would win those would-be riders). Selected & ranked by
			// POTENTIAL (would-be-rider volume) so the big remote markets show as directional
			// targets. Encoded value-vs-cost: SIZE (3 tiers) = community potential; COLOR =
			// cost = distance to your nearest station (green near → red far).
			const nearestDist = (loc) => {
				let m = Infinity;
				for (const st of stations) {
					if (!st.coords) continue;
					const d = haversineMeters(loc[0], loc[1], st.coords[0], st.coords[1]);
					if (d < m) m = d;
				}
				return m;
			};
			const convCand = [];
			for (const [pid, val] of pointConv) {
				if (val <= 0 || coveredPointIds.has(pid)) continue;
				const pt = demand.points.get(pid);
				if (!pt || !pt.location) continue;
				convCand.push({ val: val, loc: pt.location, distM: nearestDist(pt.location) });
			}
			convCand.sort((a, b) => b.val - a.val);
			const top = convCand.slice(0, 15);
			const maxVal = top.length ? top[0].val : 1;
			// 3 size tiers (in px) by share of the biggest market – a few big dots dominate, minor
			// ones shrink to background = much less noise than a continuous gradient.
			const tierRadius = (v) => {
				const f = v / maxVal;
				return f >= 0.55 ? 24 : f >= 0.22 ? 14 : 7;
			};
			conversionFC = {
				type: "FeatureCollection",
				features: top.map((c, i) => ({
					type: "Feature",
					properties: { drivers: c.val, distM: c.distM, r: tierRadius(c.val), rank: i + 1 },
					geometry: { type: "Point", coordinates: [c.loc[0], c.loc[1]] },
				})),
			};
			s.topBuildTargets = top.slice(0, 8).map((c, i) => ({
				rank: i + 1,
				drivers: c.val,
				coords: c.loc,
				distM: c.distM,
			}));
		} else {
			conversionFC = { type: "FeatureCollection", features: [] };
		}

		// Stable daily comparison: "Riders" = transit users with this end in walking
		// reach, "Drivers" = drivers with this end in reach. Both from daily mode share,
		// so the pair is time-independent (no Late-Night zeroes).
		const stnFeatures = [];
		for (const row of per) {
			row.riders = row.transit;
			row.potential = row.residents + row.jobs;
			// capture = transit share of motorized commuters with this end in reach
			row.capture = row.riders + row.drivers > 0 ? row.riders / (row.riders + row.drivers) : 0;
			if (row.coords) {
				stnFeatures.push({
					type: "Feature",
					properties: {
						weight: row.drivers,
						capture: row.capture,
						riders: row.riders,
						drivers: row.drivers,
						label: (row.capture * 100).toFixed(1) + "%",
					},
					geometry: { type: "Point", coordinates: [row.coords[0], row.coords[1]] },
				});
			}
		}
		stationFC = { type: "FeatureCollection", features: stnFeatures };

		// route center (mean of its stations' coords) for click-to-jump
		const routeCenters = new Map();
		for (const stn of stations) {
			if (!stn.coords) continue;
			for (const rid of stn.routeIds || []) {
				if (!routeCenters.has(rid)) routeCenters.set(rid, { x: 0, y: 0, n: 0 });
				const rc = routeCenters.get(rid);
				rc.x += stn.coords[0];
				rc.y += stn.coords[1];
				rc.n++;
			}
		}
		const routeLengths = computeNetworkLength(routes, s);
		s.perRoute = routes
			.map((rt) => {
				const ra = routeAgg.get(rt.id) || { residents: 0, jobs: 0, drivers: 0, transit: 0 };
				const rc = routeCenters.get(rt.id);
				return {
					id: rt.id,
					name: rt.name || rt.bullet || "Route",
					bullet: rt.bullet || "",
					color: rt.color || "#888",
					lengthM: routeLengths.has(rt.id) ? routeLengths.get(rt.id) : null,
					drivers: ra.drivers,
					residents: ra.residents,
					jobs: ra.jobs,
					riders: ra.transit,
					capture: ra.transit + ra.drivers > 0 ? ra.transit / (ra.transit + ra.drivers) : 0,
					center: rc && rc.n ? [rc.x / rc.n, rc.y / rc.n] : null,
				};
			})
			.sort((a, b) => b.drivers - a.drivers);

		// biggest conversion opportunity first (most drivers within walking reach)
		per.sort((a, b) => b.drivers - a.drivers);
		s.perStation = per;
		computeGreenfield(demand, s);
		stats = s;

		pushData();
		try {
			api.ui.forceUpdate();
		} catch (e) {}
	}

	// First-line finder (greenfield). Independent of any station: bins demand points into ~1 km
	// zones, sums each commuter group's home<->work O-D flow onto its zone pair, and ranks the
	// busiest axes -- "where does my first line go?" Demand hubs (top zones by residents+jobs)
	// draw as map dots (centerFC); the busiest axes are surfaced as the ranked "Start here" list
	// (s.firstLines), NOT as map lines. Centers always resolve from the static point data; the
	// axes need the pops' O-D volume (size), so they degrade gracefully to centers-only if O-D is
	// absent. Writes centerFC + s.firstLines / s.demandCenters / s.cityCommuters the panel reads.
	const GF_CELL_M = 1000; // ~1 km zoning
	const GF_TOP_CORRIDORS = 10;
	const GF_TOP_HOMES = 5; // biggest residential hubs (red)
	const GF_TOP_JOBS = 5; // biggest job hubs (violet)
	function popVolume(pop) {
		if (pop && typeof pop.size === "number" && pop.size > 0) return pop.size;
		const lc = pop && pop.lastCommute;
		if (lc && lc.modeChoice) return (lc.modeChoice.driving || 0) + (lc.modeChoice.transit || 0) + (lc.modeChoice.walking || 0);
		return 0;
	}
	function computeGreenfield(demand, s) {
		centerFC = { type: "FeatureCollection", features: [] };
		if (!demand || !demand.points || !demand.points.size) return;
		// reference latitude for an equal-ish metric grid (lon scaled by cos(refLat))
		let sumLat = 0, nLat = 0;
		for (const p of demand.points.values()) {
			if (p && p.location) { sumLat += p.location[1]; nLat++; }
		}
		if (!nLat) return;
		const refLat = sumLat / nLat;
		const mPerLat = 111320;
		const mPerLon = 111320 * Math.cos((refLat * Math.PI) / 180) || 1e-6;
		const zoneKey = (loc) => Math.floor((loc[0] * mPerLon) / GF_CELL_M) + "_" + Math.floor((loc[1] * mPerLat) / GF_CELL_M);
		// 1. bin points -> zones (residents, jobs, demand-weighted centroid with a plain-average
		//    fallback so an all-zero-demand zone can never produce a NaN centroid).
		const zones = new Map();
		const pointZone = new Map();
		for (const [pid, p] of demand.points) {
			if (!p || !p.location) continue;
			const k = zoneKey(p.location);
			let z = zones.get(k);
			if (!z) { z = { key: k, res: 0, jobs: 0, wx: 0, wy: 0, w: 0, cx: 0, cy: 0, n: 0, lon: 0, lat: 0 }; zones.set(k, z); }
			const res = p.residents || 0, jobs = p.jobs || 0, wt = res + jobs;
			z.res += res; z.jobs += jobs;
			z.wx += p.location[0] * wt; z.wy += p.location[1] * wt; z.w += wt;
			z.cx += p.location[0]; z.cy += p.location[1]; z.n++;
			pointZone.set(p.id != null ? p.id : pid, k);
		}
		for (const z of zones.values()) {
			if (z.w > 0) { z.lon = z.wx / z.w; z.lat = z.wy / z.w; }
			else { z.lon = z.cx / z.n; z.lat = z.cy / z.n; }
		}
		// 2. aggregate O-D flows between DISTINCT zones (intra-zone = walk distance, not a line)
		const flows = new Map();
		let totalVol = 0;
		if (demand.popsMap && demand.popsMap.size) {
			for (const pop of demand.popsMap.values()) {
				if (!pop) continue;
				const hk = pointZone.get(pop.residenceId);
				const jk = pointZone.get(pop.jobId);
				if (hk == null || jk == null) continue;
				const vol = popVolume(pop);
				if (!(vol > 0)) continue;
				totalVol += vol;
				if (hk === jk) continue;
				const key = hk < jk ? hk + "|" + jk : jk + "|" + hk;
				let f = flows.get(key);
				if (!f) { f = { aKey: hk < jk ? hk : jk, bKey: hk < jk ? jk : hk, flow: 0 }; flows.set(key, f); }
				f.flow += vol;
			}
		}
		s.cityCommuters = Math.round(totalVol);
		// 3. rank corridors -> the panel "Start here" list (busiest home<->work axes; no map line,
		//    just the ranked pairing of demand centers + distance, with click-to-center)
		const cor = Array.from(flows.values()).sort((a, b) => b.flow - a.flow).slice(0, GF_TOP_CORRIDORS);
		const firstLines = [];
		cor.forEach((f, i) => {
			const za = zones.get(f.aKey), zb = zones.get(f.bKey);
			if (!za || !zb) return;
			const distM = haversineMeters(za.lon, za.lat, zb.lon, zb.lat);
			firstLines.push({ rank: i + 1, flow: Math.round(f.flow), distM: distM, from: [za.lon, za.lat], to: [zb.lon, zb.lat], mid: [(za.lon + zb.lon) / 2, (za.lat + zb.lat) / 2] });
		});
		s.firstLines = firstLines;
		// 4. demand hubs = top RESIDENTIAL zones (red) + top JOB zones (violet), each ranked within
		//    its own kind. Splitting is essential: jobs concentrate into a few dense zones while
		//    homes spread out, so a single "by total" ranking is ALL job zones -- leaving nothing
		//    residential to connect a line to. Homes take ranks 1..H, jobs continue H+1..H+J; each group is
		//    sized within itself so both have a visible big-to-small range.
		const allZones = Array.from(zones.values()).filter((z) => z.res + z.jobs > 0);
		const homeZones = allZones.filter((z) => z.res >= z.jobs).sort((a, b) => b.res - a.res).slice(0, GF_TOP_HOMES);
		const jobZones = allZones.filter((z) => z.jobs > z.res).sort((a, b) => b.jobs - a.jobs).slice(0, GF_TOP_JOBS);
		const maxHomeRes = homeZones.length ? homeZones[0].res : 1;
		const maxJobJobs = jobZones.length ? jobZones[0].jobs : 1;
		const cenFeatures = [], demandCenters = [];
		const addHub = (z, kind, rank) => {
			const metric = kind === "home" ? z.res : z.jobs;
			const denom = kind === "home" ? maxHomeRes : maxJobJobs;
			// blob radius in METRES (scales with the map = aerial), sized within the hub's own group
			const rm = 420 + 1080 * Math.sqrt(denom > 0 ? metric / denom : 0);
			const seed = ((Math.abs(z.lon) * 53.13 + Math.abs(z.lat) * 131.7) % (Math.PI * 2)) + rank * 0.6;
			cenFeatures.push({
				type: "Feature",
				properties: { rank: rank, label: String(rank), kind: kind, residents: z.res, jobs: z.jobs },
				geometry: { type: "Polygon", coordinates: [blobRing(z.lon, z.lat, rm, seed)] },
			});
			demandCenters.push({ rank: rank, kind: kind, residents: z.res, jobs: z.jobs, total: z.res + z.jobs, coords: [z.lon, z.lat] });
		};
		homeZones.forEach((z, i) => addHub(z, "home", i + 1));
		jobZones.forEach((z, i) => addHub(z, "job", homeZones.length + i + 1));
		centerFC = { type: "FeatureCollection", features: cenFeatures };
		s.demandCenters = demandCenters;
	}

	// ---------------------------------------------------------------------------
	// Rendering – the game frequently drops custom sources/layers, so we
	// defensively re-register them and only re-push cached data (no recompute).
	// ---------------------------------------------------------------------------

	// Independent layer toggles (none gate the others).
	let showCircles = true;
	let showGaps = false;
	let showConversion = true;
	let showStations = false;
	let showFirstLines = true; // greenfield first-line corridors + demand centers (pre-stations)
	let showSatellite = true;
	let satOpacity = 1;
	let proxyStatus = "unknown"; // "unknown" | "up" | "down" – satellite tile proxy reachability
	let showBuildings = true; // game's 3D building blocks; hide to reveal clean satellite
	let activeTab = "planning"; // "setup" | "planning" | "efficiency"
	// Efficiency peak-hold: getLineMetrics' ridersPerHour/revenuePerHour are LIVE and read 0
	// at night, so we sample over time and keep each line's PEAK (the busy-period figure).
	// routeId -> { bullet, color, trainsPerHour, trainCount, capacity, cur[24], prev[24], curDay[24] }
	// cur = latest peak load per hour; prev = the value from the previous day's same hour; curDay
	// = which day cur[hr] belongs to (so each hour rolls independently, no global midnight reset).
	const linePeaks = new Map();
	let effSaveKey = null; // save we've loaded efficiency data for (persistence is per-save)
	const EFF_KEY_PREFIX = "cpro_eff_";
	const expandedLines = new Set(); // routeIds expanded to show their per-station breakdown

	// Game-speed control (Setup tab). Uses the game's own api.actions; no third-party mod code.
	const SPEED_MAX_TURBO = 8; // push the game's 'ultrafast' tier to its practical maximum
	let speedSkipTarget = null; // in-game day the max-speed run pauses at, at midnight (null = idle)
	function gameSpeed(tier) {
		try {
			api.actions.setSpeed(tier);
		} catch (e) {}
	}
	function gamePause(p) {
		try {
			api.actions.setPause(p);
		} catch (e) {}
	}
	function gameTurbo(m) {
		try {
			api.actions.setSpeedMultiplier("ultrafast", m);
		} catch (e) {}
	}
	function speedStartSkip() {
		let d = null;
		try {
			d = api.gameState.getCurrentDay();
		} catch (e) {}
		if (d == null) return;
		speedSkipTarget = d + 1; // the next midnight
		gameTurbo(SPEED_MAX_TURBO);
		gameSpeed("ultrafast");
		gamePause(false);
		try {
			api.ui.forceUpdate();
		} catch (e) {}
	}
	function speedCancelSkip() {
		speedSkipTarget = null;
		gameTurbo(1);
		gamePause(true);
		gameSpeed("normal");
		try {
			api.ui.forceUpdate();
		} catch (e) {}
	}
	// Runs on each in-game day rollover (and a polling backstop). Pauses EXACTLY at midnight when an
	// active skip reaches its target day, then drops back to normal speed for the next unpause.
	function speedCheckSkip() {
		if (speedSkipTarget == null) return;
		let d = null;
		try {
			d = api.gameState.getCurrentDay();
		} catch (e) {}
		if (d == null || d >= speedSkipTarget) {
			speedSkipTarget = null;
			gameTurbo(1);
			gamePause(true);
			gameSpeed("normal");
			try {
				api.ui.forceUpdate();
			} catch (e) {}
		}
	}
	function sampleEfficiency() {
		let lm, trains;
		try {
			lm = api.gameState.getLineMetrics();
			trains = api.gameState.getTrains() || [];
		} catch (e) {
			return;
		}
		if (!Array.isArray(lm)) return;
		// Per-save persistence: restore this save's stored profile so we don't start blank
		// (routeIds are stable across reloads). Re-restore whenever the save changes.
		let saveName;
		try {
			saveName = api.gameState.getSaveName();
		} catch (e) {}
		if (saveName != null && saveName !== effSaveKey) {
			effSaveKey = saveName;
			linePeaks.clear();
			try {
				const raw = window.localStorage.getItem(EFF_KEY_PREFIX + saveName);
				if (raw) {
					const obj = JSON.parse(raw);
					for (const k in obj) if (obj[k]) linePeaks.set(k, obj[k]);
				}
			} catch (e) {}
		}
		let day;
		try {
			day = api.gameState.getCurrentDay();
		} catch (e) {}
		const capByRoute = {};
		for (const t of trains) {
			if (t && t.routeId && t.specs && t.specs.maxCapacity) capByRoute[t.routeId] = t.specs.maxCapacity;
		}
		// hour-of-day bucket for the load-by-hour chart (elapsed seconds → 0..23)
		let elapsed;
		try {
			elapsed = api.gameState.getElapsedSeconds();
		} catch (e) {}
		const hr = elapsed != null ? Math.floor((((elapsed % 86400) + 86400) % 86400) / 3600) : null;
		// lazy station-name map (built once per sample, only if a line breakdown needs it)
		let stnNames = null;
		const nameOf = (id) => {
			if (!stnNames) {
				stnNames = {};
				try {
					(api.gameState.getStations() || []).forEach((s) => {
						if (s && s.id) stnNames[s.id] = s.name;
					});
				} catch (e) {}
			}
			return stnNames[id] || id;
		};
		for (const m of lm) {
			if (!m || !m.routeId) continue;
			const prev = linePeaks.get(m.routeId) || {};
			const cap = (m.trainsPerHour || 0) * (capByRoute[m.routeId] || prev.capacity || 0);
			const load = cap > 0 ? (m.ridersPerHour || 0) / cap : null;
			// per-station peak boardings on this line (for the expandable breakdown)
			const stations = Object.assign({}, prev.stations || {});
			try {
				const rr = api.gameState.getRouteRidership(m.routeId);
				const bs = rr && rr.byStation;
				if (Array.isArray(bs)) {
					for (const x of bs) {
						if (!x || !x.stationId) continue;
						const ex = stations[x.stationId] || { name: nameOf(x.stationId), peak: 0 };
						ex.peak = Math.max(ex.peak || 0, x.popCount || 0);
						if (!ex.name) ex.name = nameOf(x.stationId);
						stations[x.stationId] = ex;
					}
				}
			} catch (e) {}
			// Per-HOUR rolling model: each hour keeps its latest peak (cur) + the value from the
			// PREVIOUS time the clock passed it (prev). An hour only "rolls" when the clock next
			// enters it on a new day – so nothing wipes globally at midnight; the chart morphs
			// hour-by-hour. curDay[hr] records which day cur[hr] belongs to.
			const cur = prev.cur ? prev.cur.slice() : new Array(24).fill(null);
			const prevArr = prev.prev ? prev.prev.slice() : new Array(24).fill(null);
			const curDay = prev.curDay ? prev.curDay.slice() : new Array(24).fill(null);
			if (hr != null && load != null) {
				if (day != null && curDay[hr] !== day) {
					if (cur[hr] != null) prevArr[hr] = cur[hr]; // last pass becomes "yesterday this hour"
					cur[hr] = 0;
					curDay[hr] = day;
				}
				cur[hr] = Math.max(cur[hr] || 0, load);
			}
			linePeaks.set(m.routeId, {
				routeId: m.routeId,
				bullet: m.routeBullet || prev.bullet || "Line",
				color: m.routeColor || prev.color || CONV_COLOR,
				trainsPerHour: m.trainsPerHour != null ? m.trainsPerHour : prev.trainsPerHour || 0,
				trainCount: m.trainCount != null ? m.trainCount : prev.trainCount || 0,
				capacity: capByRoute[m.routeId] || prev.capacity || 0,
				cur: cur,
				prev: prevArr,
				curDay: curDay,
				stations: stations,
			});
		}
		// drop lines no longer in the network, then persist this save's profile to localStorage
		try {
			const curIds = {};
			for (const mm of lm) if (mm && mm.routeId) curIds[mm.routeId] = 1;
			linePeaks.forEach((v, k) => {
				if (!curIds[k]) linePeaks.delete(k);
			});
			if (saveName != null) {
				const obj = {};
				linePeaks.forEach((v, k) => {
					obj[k] = v;
				});
				window.localStorage.setItem(EFF_KEY_PREFIX + saveName, JSON.stringify(obj));
			}
		} catch (e) {}
		// keep the Efficiency tab live as data accumulates (it doesn't re-render on its own)
		if (activeTab === "efficiency") {
			try {
				api.ui.forceUpdate();
			} catch (e) {}
		}
	}

	// Bind the instant, event-driven repair listeners to a map. Idempotent per map (rebinds
	// on a new game's map). Lives at MODULE level + called from onMapReady AND the heal timer,
	// so style-reload / turn repairs are INSTANT even if onMapReady never fired (a mid-game
	// hot-reload) -- otherwise only the 300ms backstop heals, causing the flicker.
	let listenersMap = null;
	function bindMapListeners(map) {
		if (!map || map === listenersMap) return;
		listenersMap = map;
		const refreshOverlay = () => {
			applyVisibility(map);
			try {
				requestAnimationFrame(() => applyVisibility(map));
			} catch (e) {}
		};
		const reapply = () => {
			ensureLayers(map);
			if (map.getSource(SRC_CATCH)) map.getSource(SRC_CATCH).setData(catchmentFC);
			if (map.getSource(SRC_CONV)) map.getSource(SRC_CONV).setData(conversionFC);
			if (map.getSource(SRC_STN)) map.getSource(SRC_STN).setData(stationFC);
			refreshOverlay();
		};
		try {
			map.on("styledata", reapply); // full style reload (2D/3D) – re-add torn-down layers
			map.on("idle", refreshOverlay);
			map.on("moveend", refreshOverlay);
			map.on("pitchend", refreshOverlay); // 2D/3D toggle (pure pitch change)
			map.on("rotateend", refreshOverlay); // turning the map
			map.on("render", () => {
				if (showBuildings) return;
				if (!map.getLayer("buildings-3d")) return;
				try {
					if (map.getLayoutProperty("buildings-3d", "visibility") !== "none") {
						map.setLayoutProperty("buildings-3d", "visibility", "none");
					}
				} catch (e) {}
			});
		} catch (e) {}
	}
	let stationDotScale = 1; // size multiplier for our station markers and % labels

	// Persist toggle state across sessions via localStorage (synchronous + reliable;
	// persists in the renderer's Local Storage leveldb across full app quits).
	const PREFS_KEY = "cpro_prefs";
	function savePrefs() {
		try {
			window.localStorage.setItem(
				PREFS_KEY,
				JSON.stringify({
					showCircles,
					showGaps,
					showConversion,
					showStations,
					showFirstLines,
					showSatellite,
					showBuildings,
					satOpacity,
					satProvider,
					activeTab,
					stationDotScale,
				})
			);
		} catch (e) {}
	}

	// circle-radius expression for OUR station overlay dots, scaled by the slider
	function stnRadiusExpr() {
		// uniform dot sized purely by the user's slider – the % (color + label) is the
		// data; the size is just a visual preference.
		return 11 * (stationDotScale || 1);
	}
	// The "Station dot size" slider scales OUR overlay dots (the colored performance
	// circles), not the game's markers. Update the live layer + the stored def.
	function applyDotScale() {
		const expr = stnRadiusExpr();
		if (stnDef && stnDef.paint) stnDef.paint["circle-radius"] = expr;
		const textSize = 11 * (stationDotScale || 1);
		if (stnLabelDef && stnLabelDef.layout) stnLabelDef.layout["text-size"] = textSize;
		try {
			const map = api.utils.getMap();
			if (map && map.getLayer(LYR_STN)) map.setPaintProperty(LYR_STN, "circle-radius", expr);
			if (map && map.getLayer(LYR_STN_LABEL)) map.setLayoutProperty(LYR_STN_LABEL, "text-size", textSize);
		} catch (e) {}
	}
	// Load + apply saved toggle state. Safe to call repeatedly: because every toggle
	// change calls savePrefs() immediately, the saved state always equals the current
	// state, so re-loading on map-ready / city-load never clobbers a mid-session change.
	function loadPrefs() {
		let raw = null;
		try {
			raw = window.localStorage.getItem(PREFS_KEY);
		} catch (e) {}
		if (raw == null) return; // nothing saved yet
		try {
			const p = JSON.parse(raw);
			if (p && typeof p === "object") {
				if (typeof p.showCircles === "boolean") showCircles = p.showCircles;
				if (typeof p.showGaps === "boolean") showGaps = p.showGaps;
				if (typeof p.showConversion === "boolean") showConversion = p.showConversion;
				if (typeof p.showStations === "boolean") showStations = p.showStations;
				if (typeof p.showFirstLines === "boolean") showFirstLines = p.showFirstLines;
				if (typeof p.showSatellite === "boolean") showSatellite = p.showSatellite;
				if (typeof p.showBuildings === "boolean") showBuildings = p.showBuildings;
				if (typeof p.satOpacity === "number") satOpacity = p.satOpacity;
				if (typeof p.satProvider === "string" && SAT_PROVIDERS.some((sp) => sp.id === p.satProvider)) satProvider = p.satProvider;
				if (typeof p.activeTab === "string") activeTab = p.activeTab;
				if (typeof p.stationDotScale === "number") stationDotScale = p.stationDotScale;
			}
		} catch (e) {}
		// apply the restored state to the live map + panel (map may be null at module init)
		try {
			const map = api.utils.getMap();
			if (map) applyVisibility(map);
			applyDotScale();
			api.ui.forceUpdate();
		} catch (e) {}
	}

	// Restore immediately at load so the very first render uses saved state.
	loadPrefs();

	function setSatProvider(p) {
		satProvider = p;
		savePrefs();
		try {
			const map = api.utils.getMap();
			const src = map && map.getSource(SRC_SAT);
			if (src && src.setTiles) src.setTiles([satTileUrl()]);
		} catch (e) {}
		try {
			api.ui.forceUpdate();
		} catch (e) {}
	}
	// Detect the satellite tile proxy (we can't START it from the sandboxed renderer, but we can
	// reach 127.0.0.1 via fetch – connect-src allows it – and guide the user if it's not up).
	function checkProxyHealth() {
		try {
			fetch("http://127.0.0.1:" + SAT_PROXY_PORT + "/status", { cache: "no-store" })
				.then((r) => (r && r.ok ? r.json() : null))
				.then((j) => {
					const s = j && j.ok ? "up" : "down";
					if (s !== proxyStatus) {
						proxyStatus = s;
						try {
							api.ui.forceUpdate();
						} catch (e) {}
					}
				})
				.catch(() => {
					if (proxyStatus !== "down") {
						proxyStatus = "down";
						try {
							api.ui.forceUpdate();
						} catch (e) {}
					}
				});
		} catch (e) {}
	}
	function copyProxyCmd() {
		const cmd = "# Run once from the Network Planner mod folder:\nbash install-proxy.sh      # macOS (auto-starts at login)\n# or, any OS, each session:\nnode proxy.js";
		try {
			navigator.clipboard.writeText(cmd);
			api.ui.showNotification("Setup command copied – paste in a terminal", "success");
		} catch (e) {
			api.ui.showNotification("Run install-proxy.sh (or node proxy.js) in the mod folder", "info");
		}
	}


	function fillColor() {
		return api.ui.getResolvedTheme() === "dark" ? FILL_DARK : FILL_LIGHT;
	}
	function outlineColor() {
		return api.ui.getResolvedTheme() === "dark" ? OUTLINE_DARK : OUTLINE_LIGHT;
	}

	// Reuse a font the live style already has glyphs for (the game sets MAP_FONT);
	// fall back to MapLibre's default stack.
	function mapTextFont(map) {
		try {
			const layers = (map.getStyle() && map.getStyle().layers) || [];
			for (const l of layers) {
				const f = l.layout && l.layout["text-font"];
				if (Array.isArray(f) && f.length) return f;
			}
		} catch (e) {}
		return ["Open Sans Regular", "Arial Unicode MS Regular"];
	}

	function ensureLayers(map) {
		if (!map) return;
		// Satellite raster (via the local proxy) – below the city layers, above 'background'.
		if (!map.getSource(SRC_SAT)) {
			api.map.registerSource(SRC_SAT, {
				type: "raster",
				tiles: [satTileUrl()],
				tileSize: 256,
				minzoom: 0,
				maxzoom: 19,
				attribution: "Imagery: Esri / Google / © OpenStreetMap contributors",
			});
		}
		if (!map.getLayer(LYR_SAT)) {
			satLayerDef = {
				id: LYR_SAT,
				type: "raster",
				source: SRC_SAT,
				layout: { visibility: showSatellite ? "visible" : "none" },
				paint: { "raster-opacity": satOpacity, "raster-fade-duration": 0 },
			};
			try {
				api.map.registerLayer(satLayerDef, "buildings-3d");
			} catch (e) {
				api.map.registerLayer(satLayerDef);
			}
		}
		if (!map.getSource(SRC_CATCH)) {
			api.map.registerSource(SRC_CATCH, { type: "geojson", data: catchmentFC });
		}
		if (!map.getLayer(LYR_CATCH)) {
			catchDef = {
				id: LYR_CATCH,
				type: "fill",
				source: SRC_CATCH,
				layout: { visibility: showCircles ? "visible" : "none" },
				paint: {
					"fill-color": fillColor(),
					"fill-outline-color": outlineColor(),
				},
			};
			api.map.registerLayer(catchDef);
		}
		if (!map.getSource(SRC_CONV)) {
			api.map.registerSource(SRC_CONV, { type: "geojson", data: conversionFC });
		}
		if (!map.getLayer(LYR_CONV)) {
			// latent-demand markets – uncovered would-be-rider pockets, drawn as vivid circles with
			// NO border (the actionable foreground layer, distinct from the white-ringed station
			// dots). SIZE (3 tiers) = community potential; COLOR = cost (distance to network):
			// green = near/cheap (build now) → amber → magenta = far/expensive (grow toward).
			convDef = {
				id: LYR_CONV,
				type: "circle",
				source: SRC_CONV,
				layout: { visibility: showConversion ? "visible" : "none" },
				paint: {
					"circle-radius": ["get", "r"],
					"circle-color": [
						"interpolate",
						["linear"],
						["get", "distM"],
						1800,
						"#39c35a",
						4500,
						"#ffc83d",
						9000,
						"#c2298a",
					],
					"circle-opacity": ["interpolate", ["linear"], ["get", "r"], 7, 0.6, 24, 0.88],
				},
			};
			api.map.registerLayer(convDef);
		}
		if (!map.getSource(SRC_STN)) {
			api.map.registerSource(SRC_STN, { type: "geojson", data: stationFC });
		}
		if (!map.getLayer(LYR_STN)) {
			stnDef = {
				id: LYR_STN,
				type: "circle",
				source: SRC_STN,
				layout: { visibility: showStations ? "visible" : "none" },
				paint: {
					// size = driver pool (the opportunity) × the dot-size slider; color = capture
					"circle-radius": stnRadiusExpr(),
					"circle-color": [
						"interpolate",
						["linear"],
						["get", "capture"],
						0,
						GAP_COLOR, // all drive → red (problem)
						0.05,
						CONV_COLOR, // amber
						0.2,
						"#4fd388", // converting well → green
					],
					"circle-opacity": 0.85,
					"circle-stroke-color": "#ffffff",
					"circle-stroke-width": 1.5,
					"circle-stroke-opacity": 0.9,
				},
			};
			api.map.registerLayer(stnDef);
		}
		// Station success-rate % drawn as a GL text layer on our own source (colored to match
		// the dot). Rendered by the map, not injected into the game's DOM markers.
		if (!map.getLayer(LYR_STN_LABEL)) {
			stnLabelDef = {
				id: LYR_STN_LABEL,
				type: "symbol",
				source: SRC_STN,
				layout: {
					"text-field": ["get", "label"],
					"text-font": mapTextFont(map),
					"text-size": 11 * (stationDotScale || 1),
					"text-allow-overlap": true,
					"text-ignore-placement": true,
					"text-offset": [0, -1.2],
					visibility: showStations ? "visible" : "none",
				},
				paint: {
					"text-color": ["interpolate", ["linear"], ["get", "capture"], 0, GAP_COLOR, 0.05, CONV_COLOR, 0.2, "#4fd388"],
					"text-halo-color": "rgba(0,0,0,0.85)",
					"text-halo-width": 1.6,
				},
			};
			api.map.registerLayer(stnLabelDef);
		}
		// Demand hubs – faint, organic AREA fills (red = residential, violet = job), drawn as soft
		// aerial regions in the background so they read apart from the crisp circle markers and
		// don't bombard the map mid-game. Sized within each kind; numbered to match the list.
		if (!map.getSource(SRC_CEN)) {
			api.map.registerSource(SRC_CEN, { type: "geojson", data: centerFC });
		}
		if (!map.getLayer(LYR_CEN)) {
			cenDef = {
				id: LYR_CEN,
				type: "fill",
				source: SRC_CEN,
				layout: { visibility: showFirstLines ? "visible" : "none" },
				paint: {
					"fill-color": ["match", ["get", "kind"], "home", HUB_HOME, "job", HUB_JOB, "#b388ff"],
					"fill-opacity": 0.22,
					// soft same-hue edge (NOT a hard white ring) just to make the irregular shape legible
					"fill-outline-color": ["match", ["get", "kind"], "home", "rgba(192,57,43,0.55)", "job", "rgba(131,102,240,0.55)", "rgba(179,136,255,0.5)"],
				},
			};
			// place BELOW the latent-demand / station markers so the regions sit behind the crisp dots
			try {
				api.map.registerLayer(cenDef, LYR_CONV);
			} catch (e) {
				api.map.registerLayer(cenDef);
			}
		}
		// Rank number (1..N) at each demand-hub region's centre, tying the map to the list order.
		if (!map.getLayer(LYR_CEN_LABEL)) {
			cenLabelDef = {
				id: LYR_CEN_LABEL,
				type: "symbol",
				source: SRC_CEN,
				layout: {
					"text-field": ["get", "label"],
					"text-font": mapTextFont(map),
					"text-size": 11,
					"text-allow-overlap": true,
					"text-ignore-placement": true,
					visibility: showFirstLines ? "visible" : "none",
				},
				paint: {
					"text-color": "#ffffff",
					"text-opacity": 0.9,
					"text-halo-color": "rgba(0,0,0,0.8)",
					"text-halo-width": 1.4,
				},
			};
			api.map.registerLayer(cenLabelDef);
		}
	}

	function pushData() {
		const map = api.utils.getMap();
		if (!map) return;
		ensureLayers(map);
		if (map.getSource(SRC_CATCH)) map.getSource(SRC_CATCH).setData(catchmentFC);
		if (map.getSource(SRC_CONV)) map.getSource(SRC_CONV).setData(conversionFC);
		if (map.getSource(SRC_STN)) map.getSource(SRC_STN).setData(stationFC);
		if (map.getSource(SRC_CEN)) map.getSource(SRC_CEN).setData(centerFC);
		applyVisibility(map);
	}

	function applyVisibility(map) {
		if (!map) return;
		// Satellite: set opacity + visibility on the live layer. On a style reload ensureLayers
		// rebuilds the def from the current satOpacity/showSatellite values, so nothing needs
		// to be persisted on the def itself.
		if (map.getLayer(LYR_SAT)) {
			map.setLayoutProperty(LYR_SAT, "visibility", showSatellite ? "visible" : "none");
			try {
				map.setPaintProperty(LYR_SAT, "raster-opacity", satOpacity);
			} catch (e) {}
		}
		if (map.getLayer("buildings-3d")) {
			try {
				map.setLayoutProperty("buildings-3d", "visibility", showBuildings ? "visible" : "none");
			} catch (e) {}
		}
		// Each overlay layer is controlled solely by its own flag, fully independent. Set
		// visibility on the live layer; on a style reload ensureLayers rebuilds each def from
		// its current flag, so the toggle state is preserved either way.
		const vis = (layerId, on) => {
			const v = on ? "visible" : "none";
			try {
				if (map.getLayer(layerId)) map.setLayoutProperty(layerId, "visibility", v);
			} catch (e) {}
		};
		vis(LYR_CATCH, showCircles);
		if (map.getLayer(LYR_CATCH)) {
			try {
				map.setPaintProperty(LYR_CATCH, "fill-color", fillColor());
				map.setPaintProperty(LYR_CATCH, "fill-outline-color", outlineColor());
			} catch (e) {}
		}
		vis(LYR_CONV, showConversion);
		vis(LYR_STN, showStations);
		vis(LYR_STN_LABEL, showStations);
		vis(LYR_CEN, showFirstLines);
		vis(LYR_CEN_LABEL, showFirstLines);
	}


	// ---------------------------------------------------------------------------
	// Lifecycle
	// ---------------------------------------------------------------------------

	let styleListenerBound = false;
	let boundMap = null;
	let buildingsTimerSet = false;

	// Single onMapReady (this hook may keep only one callback – do everything here).
	api.hooks.onMapReady((map) => {
		// A new game/city creates a NEW map instance. Our event listeners and panel button
		// were bound to the PREVIOUS map – reset the per-map guards so everything re-binds to
		// this one. Without this, after returning to the main menu and loading another game:
		// buildings stop re-hiding, the overlay layers stop refreshing, and the toolbar icon
		// goes missing.
		if (map !== boundMap) {
			boundMap = map;
			styleListenerBound = false;
			toolbarMounted = false;
		}

		try {
			const c = api.utils.getConstants();
			if (c && c.WALKING_SPEED != null) WALK_SPEED = c.WALKING_SPEED;
		} catch (e) {}

		addPanel(); // ensure the toolbar icon exists (covers mod-loaded-mid-game)
		compute();
		ensureSatProtocol(); // make sure the Image()-based tile protocol is registered
		ensureLayers(map);
		pushData();
		loadPrefs(); // restore saved toggle state (once); applies + re-renders when ready

		// Re-register on style churn; re-push cached data. No recompute here.
		// Bind BOTH styledata and idle: full style reloads fire styledata, but
		// Construction / 2D⇄3D rebuilds settle via 'idle' without a styledata –
		// re-asserting on idle restores the satellite raster fastest (shortest blank).
		// Full re-register only on style reloads (layers genuinely got torn down).
		// Re-assert visibility NOW and again next frame – the game often re-shows its
		// buildings layer (e.g. on the 2D/3D toggle) a tick AFTER the triggering event,
		// so a single synchronous re-hide loses the race. The deferred pass wins it.
		bindMapListeners(map);
	});

	// Recompute only on meaningful changes.
	api.hooks.onCityLoad(() => {
		// onMapReady handles re-binding the panel/listeners for the new map (it fires with
		// the new map instance); here we just recompute and restore prefs for the new city.
		lastGoodStationCount = 0; // new city – reset the shrink guard so the first compute proceeds
		transientSkips = 0;
		deletionSignaled = false;
		// (efficiency peaks are reset/restored per-save by the sampler on save change)
		compute();
		loadPrefs();
	});
	api.hooks.onStationBuilt(() => {
		compute();
	});
	api.hooks.onStationDeleted(() => {
		deletionSignaled = true; // a real removal – allow the station count to shrink
		compute();
	});
	api.hooks.onTrackChange(() => {
		compute();
	});
	api.hooks.onBlueprintPlaced(() => {
		compute();
	});
	if (api.hooks.onDemandChange) api.hooks.onDemandChange(() => compute());

	function pct(n, d) {
		if (!d) return "–";
		return ((100 * n) / d).toFixed(1) + "%";
	}
	function fmt(n) {
		return Math.round(n || 0).toLocaleString();
	}
	function fmtLen(m) {
		if (!Number.isFinite(m) || m <= 0) return "–";
		if (m < 950) return Math.round(m) + " m";
		const km = m / 1000;
		return (km >= 100 ? Math.round(km).toLocaleString() : km.toFixed(1)) + " km";
	}
	// success rate color – MUST match the LYR_STN circle's interpolate stops exactly
	// (0 → red, 0.05 → amber, 0.2 → green), so the panel's capture dots match the map dots.
	const CAPTURE_GREEN = "#4fd388";
	function lerpHex(a, b, t) {
		t = Math.max(0, Math.min(1, t));
		const pa = [parseInt(a.slice(1, 3), 16), parseInt(a.slice(3, 5), 16), parseInt(a.slice(5, 7), 16)];
		const pb = [parseInt(b.slice(1, 3), 16), parseInt(b.slice(3, 5), 16), parseInt(b.slice(5, 7), 16)];
		const r = pa.map((v, i) => Math.round(v + (pb[i] - v) * t));
		return "rgb(" + r[0] + "," + r[1] + "," + r[2] + ")";
	}
	function captureColor(c) {
		c = c == null ? 0 : Math.max(0, c);
		if (c <= 0.05) return lerpHex(GAP_COLOR, CONV_COLOR, c / 0.05);
		if (c <= 0.2) return lerpHex(CONV_COLOR, CAPTURE_GREEN, (c - 0.05) / 0.15);
		return CAPTURE_GREEN;
	}
	function rateCell(capture) {
		return h(
			"span",
			{ style: { whiteSpace: "nowrap" } },
			h("span", {
				style: {
					display: "inline-block",
					width: "8px",
					height: "8px",
					borderRadius: "50%",
					background: captureColor(capture),
					marginRight: "5px",
					verticalAlign: "middle",
				},
			}),
			h("span", { style: { verticalAlign: "middle", fontWeight: 600 } }, (capture * 100).toFixed(1) + "%")
		);
	}
	function flyToCoords(coords, zoom) {
		const map = api.utils.getMap();
		if (map && coords && coords.length === 2) {
			try {
				map.flyTo({ center: [coords[0], coords[1]], zoom: zoom || 14, speed: 1.2 });
			} catch (e) {}
		}
	}

	function StatLine(label, value, sub) {
		return h(
			"div",
			{ style: { display: "flex", justifyContent: "space-between", padding: "2px 0" } },
			h("span", { style: { opacity: 0.75 } }, label),
			h(
				"span",
				{ style: { fontWeight: 600, textAlign: "right" } },
				value,
				sub ? h("span", { style: { opacity: 0.6, fontWeight: 400 } }, " " + sub) : null
			)
		);
	}

	// ---- small presentational helpers (cards) ----

	function sectionHead(t, infoKey) {
		const head = h(
			"div",
			{
				style: {
					fontSize: "11px",
					textTransform: "uppercase",
					letterSpacing: "0.05em",
					opacity: 0.55,
					margin: "14px 0 6px",
				},
			},
			t,
			infoKey ? infoIcon(infoKey) : null
		);
		return infoKey ? [head, infoBox(infoKey)] : head;
	}

	function card(children, accent) {
		return h(
			"div",
			{
				style: {
					background: "rgba(255,255,255,0.035)",
					border: "1px solid rgba(128,128,128,0.18)",
					borderLeft: accent ? "3px solid " + accent : "1px solid rgba(128,128,128,0.18)",
					borderRadius: "4px",
					padding: "8px 11px",
				},
			},
			children
		);
	}

	function kpiCard(label, value, sub, color, infoKey) {
		return h(
			"div",
			{
				style: {
					flex: "1 1 150px",
					minWidth: 0,
					background: "rgba(255,255,255,0.04)",
					border: "1px solid rgba(128,128,128,0.18)",
					borderRadius: "4px",
					padding: "8px 10px",
				},
			},
			h(
				"div",
				{ style: { fontSize: "9.5px", textTransform: "uppercase", letterSpacing: "0.04em", opacity: 0.5, display: "flex", alignItems: "center" } },
				label,
				infoKey ? infoIcon(infoKey) : null
			),
			h(
				"div",
				{ style: { fontSize: "21px", fontWeight: 700, marginTop: "1px", color: color || "inherit", lineHeight: 1.1 } },
				value
			),
			sub ? h("div", { style: { fontSize: "10px", opacity: 0.55, marginTop: "1px" } }, sub) : null,
			infoKey ? infoBox(infoKey) : null
		);
	}

	// ---- Inline "i" explanations: every concept is explained where it appears (no glossary
	// page). One explanation open at a time; texts live in INFO so they stay in one place. ----
	let openInfo = null; // key of the explanation currently expanded (not persisted)
	const INFO = {
		catchment: "Each station's walk catchment circle – about a 30-minute / ~1.8 km walk. The area people can reach on foot to or from the station.",
		hubs: "For a fresh map with no stations: your biggest RESIDENTIAL hubs (red, ranks 1–5) and biggest JOB hubs (violet, ranks 6–10) – numbered areas, sized within each group. Shown separately on purpose: jobs cluster into a few dense spots while homes spread out, so the two need their own rankings. The Planning tab lists the same hubs; a good first line connects a big red hub to a big violet one.",
		latent: "Would-be riders: people who drive today and whose OTHER trip end is already on your network – one extension wins them. SIZE (3 tiers) = community potential (number of would-be riders). COLOR = cost = distance to your nearest station: green = near/cheap (build now) → amber → magenta = far/expensive (a corridor to grow toward). Exact numbers are in the Build here next list.",
		stations: "A dot at each station showing its SUCCESS RATE. The % (and the dot color, red → amber → green) = of the motorized commuters within walking reach, the share who take transit instead of driving. Low % (red) = lots of nearby drivers not yet won to transit. Dot size is just your visual preference (the Display slider).",
		satellite: "Real photographic imagery as the base map. Pick a source under Base imagery – Esri (default), Google, Hybrid (satellite + labels), or OSM. All free, no key, no setup.",
		buildings: "The game's own 3D buildings. Turn off for a clean satellite view.",
		greenfieldKpis: "Before you build, the headline numbers are city totals – Residents, Jobs, and Commuters (daily home→work trips). Busiest link is the single biggest home→work flow: your strongest first-line opportunity. These switch to coverage numbers once you build your first station.",
		resCovered: "Share of the whole city within walking reach of ANY station (counted once, no double counting).",
		capture: "Of commuters whose home AND work are both reachable by your network, the share who already take transit instead of driving.",
		modeShift: "Drivers whose home AND work are BOTH already within a catchment – winnable on TODAY's network (no building needed), because transit only beats driving when the whole door-to-door trip works. They drive anyway = your service-quality opportunity.",
		gaps: "Uncovered demand – residents and jobs with no station in walking range. A panel number, not a map layer.",
		network: "System length = the one-way length of every station-to-station leg your lines serve, measured along the actual track path – each leg counts once even when lines share it, run both directions, or use parallel tracks. Track built = ALL constructed track on the map (parallel tracks, sidings, crossovers and unused track all add up, so it's usually longer than the system). Per-line lengths are in the route table below.",
		captured: "Residents and jobs with at least one station in walking reach. Double-covered = inside 2+ catchments (overlap – useful for transfers, wasteful for pure coverage).",
		modeShiftCard: "Mode-shift potential = drivers whose home AND work are both within a catchment – winnable on today's network. Home end / Work end only = served at just ONE end; they need a stop at the other end before they can switch to transit.",
		buildNext: "The ranked latent-demand shortlist (matching the map dots): each is the would-be riders at an uncovered market – people whose OTHER trip end is already on your network – plus the distance to your nearest station (the track you'd lay). Ranked by community size. Click a row to fly there.",
		tablesRoute: "Length = the line's one-way route length, measured along its actual track path (branches count once). Rate = transit ÷ (transit + drivers) within reach – the colored dot matches the map. Riders / Drivers = daily transit users / drivers with this end in walking reach. Click a row to fly there. Reach is straight-line walk potential – planning estimates, not the sim's exact numbers.",
		tablesStation: "Rate = transit ÷ (transit + drivers) within reach – the colored dot matches the map. Riders / Drivers = daily transit users / drivers with this end in walking reach. Click a row to fly there. Reach is straight-line walk potential – planning estimates, not the sim's exact numbers.",
	};
	const infoIcon = (key) =>
		h(
			"button",
			{
				onClick: () => {
					openInfo = openInfo === key ? null : key;
					try {
						api.ui.forceUpdate();
					} catch (e) {}
				},
				title: openInfo === key ? "Hide explanation" : "What is this?",
				style: {
					display: "inline-flex",
					alignItems: "center",
					justifyContent: "center",
					width: "13px",
					height: "13px",
					padding: 0,
					marginLeft: "5px",
					borderRadius: "50%",
					border: "1px solid " + (openInfo === key ? "rgba(90,169,230,0.9)" : "rgba(128,128,128,0.55)"),
					background: openInfo === key ? "rgba(90,169,230,0.25)" : "transparent",
					color: "inherit",
					opacity: openInfo === key ? 1 : 0.55,
					fontSize: "9px",
					fontWeight: 700,
					fontStyle: "italic",
					lineHeight: 1,
					cursor: "pointer",
					verticalAlign: "middle",
					flexShrink: 0,
				},
			},
			"i"
		);
	// inset=true renders full-bleed inside a settings card (attached under its row); default is a
	// small standalone note (KPI cards, section heads).
	const infoBox = (key, inset) =>
		openInfo === key
			? h(
					"div",
					{
						style: {
							fontSize: "10.5px",
							lineHeight: 1.55,
							opacity: 0.85,
							background: "rgba(90,169,230,0.07)",
							borderLeft: "2px solid rgba(90,169,230,0.5)",
							padding: inset ? "7px 14px 7px 12px" : "6px 9px",
							margin: inset ? 0 : "5px 0 3px",
							borderTop: inset ? "1px solid rgba(128,128,128,0.14)" : "none",
							borderRadius: inset ? 0 : "0 4px 4px 0",
						},
					},
					INFO[key]
			  )
			: null;

	// ---- Setup-page building blocks: bordered cards (header + caption) holding hairline-divided
	// settings rows - label + description on the left, the control on the right. ----
	const switchCtl = (on, onClick) =>
		h(
			"button",
			{
				onClick: onClick,
				role: "switch",
				"aria-checked": on,
				style: {
					width: "34px",
					height: "20px",
					flexShrink: 0,
					borderRadius: "10px",
					border: "1px solid " + (on ? "rgba(90,169,230,0.9)" : "rgba(128,128,128,0.5)"),
					background: on ? "rgba(90,169,230,0.85)" : "rgba(128,128,128,0.25)",
					cursor: "pointer",
					padding: "1px",
					display: "inline-flex",
					alignItems: "center",
					transition: "background 0.15s ease, border-color 0.15s ease",
				},
			},
			h("span", {
				style: {
					width: "16px",
					height: "16px",
					borderRadius: "50%",
					background: "#ffffff",
					display: "block",
					marginLeft: on ? "14px" : "1px",
					transition: "margin-left 0.15s ease",
					boxShadow: "0 1px 2px rgba(0,0,0,0.45)",
				},
			})
		);
	const setupRow = (label, desc, control, dot) =>
		h(
			"div",
			{ style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "14px", padding: "9px 14px", borderTop: "1px solid rgba(128,128,128,0.14)" } },
			h(
				"div",
				{ style: { minWidth: 0 } },
				h(
					"div",
					{ style: { fontSize: "12px", fontWeight: 600 } },
					dot ? h("span", { style: { display: "inline-block", width: "8px", height: "8px", borderRadius: "50%", background: dot, marginRight: "7px", verticalAlign: "middle", border: dot === "#ffffff" ? "1px solid rgba(128,128,128,0.5)" : "none" } }) : null,
					label
				),
				desc ? h("div", { style: { fontSize: "10px", opacity: 0.55, marginTop: "2px", lineHeight: 1.45 } }, desc) : null
			),
			h("div", { style: { flexShrink: 0, display: "flex", alignItems: "center" } }, control)
		);
	const setupCard = (title, caption, children, headerRight) =>
		h(
			"div",
			{ style: { border: "1px solid rgba(128,128,128,0.25)", borderRadius: "8px", background: "rgba(255,255,255,0.035)", marginBottom: "14px", overflow: "hidden" } },
			h(
				"div",
				{ style: { display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "10px", padding: "12px 14px 10px" } },
				h(
					"div",
					null,
					h("div", { style: { fontSize: "12.5px", fontWeight: 700 } }, title),
					caption ? h("div", { style: { fontSize: "10.5px", opacity: 0.55, marginTop: "2px", lineHeight: 1.45 } }, caption) : null
				),
				headerRight || null
			),
			...(children || [])
		);

	function renderPanel() {
		const s = stats;


		// ---- Planning tab content (needs stats) ----
		let planningContent;
		if (s) {
		// Header KPI tiles. On a fresh map (no stations) coverage/mode-shift are all zero and
		// useless, so swap in greenfield demand totals until the first station exists.
		const kpis =
			s.stationCount === 0
				? h(
						"div",
						{ style: { display: "flex", flexWrap: "wrap", gap: "6px", marginTop: "10px" } },
						kpiCard("Residents", fmt(s.cityResidents), "city total"),
						kpiCard("Jobs", fmt(s.cityJobs), "city total"),
						kpiCard("Commuters", fmt(s.cityCommuters), "daily commuter trips"),
						kpiCard("Busiest link", s.firstLines.length ? fmt(s.firstLines[0].flow) : "–", s.firstLines.length ? "commuters, top pair" : "no O-D data yet", HUB_ACCENT, "greenfieldKpis")
				  )
				: h(
						"div",
						{ style: { display: "flex", flexWrap: "wrap", gap: "6px", marginTop: "10px" } },
						kpiCard("Residents covered", pct(s.coveredResidents, s.cityResidents), pct(s.coveredJobs, s.cityJobs) + " of jobs", null, "resCovered"),
						kpiCard("Capture rate", pct(s.bothEndsTransit, s.bothEndsTransit + s.convertibleDrivers), "both ends served", CONV_COLOR, "capture"),
						kpiCard("Mode shift", fmt(s.convertibleDrivers), "drivers, both ends served", CONV_COLOR, "modeShift"),
						kpiCard("Gap hotspots", fmt(s.gapCount), fmt(s.gapResidents + s.gapJobs) + " unserved", GAP_COLOR, "gaps")
				  );

		// Station table – all stations; the body scrolls so it never overflows.
		const rows = s.perStation.map((r) =>
			h(
				"tr",
				{ key: r.id, onClick: () => flyToCoords(r.coords, 14), title: "Jump to " + r.name, style: { cursor: "pointer" } },
				h("td", { style: { padding: "3px 6px 3px 0", whiteSpace: "nowrap" } }, r.name),
				h("td", { style: { padding: "3px 6px", textAlign: "right" } }, rateCell(r.capture)),
				h("td", { style: { padding: "3px 6px", textAlign: "right", fontWeight: 600 } }, fmt(r.riders)),
				h("td", { style: { padding: "3px 0", textAlign: "right", color: CONV_COLOR, fontWeight: 600 } }, fmt(r.drivers))
			)
		);

		const table = h(
			"table",
			{ style: { width: "100%", borderCollapse: "collapse", fontSize: "11.5px" } },
			h(
				"thead",
				null,
				h(
					"tr",
					{ style: { opacity: 0.55, textAlign: "left" } },
					h("th", { style: { padding: "0 6px 4px 0" } }, "Station"),
					h("th", { style: { padding: "0 6px 4px", textAlign: "right" } }, "Rate"),
					h("th", { style: { padding: "0 6px 4px", textAlign: "right" } }, "Riders"),
					h("th", { style: { padding: "0 0 4px", textAlign: "right", color: CONV_COLOR } }, "Drivers")
				)
			),
			h("tbody", null, rows)
		);

		// Per-route table – colored bullet, sim riders, drivers in reach (union per line).
		const routeBullet = (rt) =>
			h(
				"span",
				{
					style: {
						display: "inline-block",
						background: rt.color,
						color: "#fff",
						borderRadius: "5px",
						padding: "1px 8px",
						fontSize: "10.5px",
						fontWeight: 700,
						whiteSpace: "nowrap",
						maxWidth: "150px",
						overflow: "hidden",
						textOverflow: "ellipsis",
					},
				},
				rt.bullet || rt.name
			);
		const routeRows = s.perRoute.map((rt) =>
			h(
				"tr",
				{ key: rt.id, onClick: () => flyToCoords(rt.center, 12), title: "Jump to " + rt.name, style: { cursor: "pointer" } },
				h("td", { style: { padding: "3px 6px 3px 0" } }, routeBullet(rt)),
				h("td", { style: { padding: "3px 6px", textAlign: "right", whiteSpace: "nowrap", opacity: 0.85 } }, fmtLen(rt.lengthM)),
				h("td", { style: { padding: "3px 6px", textAlign: "right" } }, rateCell(rt.capture)),
				h("td", { style: { padding: "3px 6px", textAlign: "right", fontWeight: 600 } }, fmt(rt.riders)),
				h("td", { style: { padding: "3px 0", textAlign: "right", color: CONV_COLOR, fontWeight: 600 } }, fmt(rt.drivers))
			)
		);
		const routeTable = h(
			"table",
			{ style: { width: "100%", borderCollapse: "collapse", fontSize: "11.5px" } },
			h(
				"thead",
				null,
				h(
					"tr",
					{ style: { opacity: 0.55, textAlign: "left" } },
					h("th", { style: { padding: "0 6px 4px 0" } }, "Route"),
					h("th", { style: { padding: "0 6px 4px", textAlign: "right" } }, "Length"),
					h("th", { style: { padding: "0 6px 4px", textAlign: "right" } }, "Rate"),
					h("th", { style: { padding: "0 6px 4px", textAlign: "right" } }, "Riders"),
					h("th", { style: { padding: "0 0 4px", textAlign: "right", color: CONV_COLOR } }, "Drivers")
				)
			),
			h("tbody", null, routeRows)
		);

		// Two logical columns: LEFT = network summary, RIGHT = breakdown tables.
		const leftCol = h(
			"div",
			{ style: { minWidth: 0 } },
			!s.demandAvailable
				? h("div", { style: { color: GAP_COLOR, margin: "8px 0" } }, "Demand data not loaded yet – coverage/gaps unavailable.")
				: null,

			sectionHead("Network – what you've built", "network"),
			card([
				StatLine("System length", fmtLen(s.systemLengthM), "all lines, one-way"),
				StatLine("Track built", fmtLen(s.trackBuiltM), "every track on the map"),
				s.trackPlannedM > 0 ? StatLine("Planned (blueprints)", fmtLen(s.trackPlannedM)) : null,
				StatLine("Stations", fmt(s.stationCount)),
			]),

			sectionHead("Captured – potential reach (overlaps allowed)", "captured"),
			card([
				StatLine("Residents", fmt(s.coveredResidents)),
				StatLine("Jobs", fmt(s.coveredJobs)),
				StatLine("Double-covered", fmt(s.overlapResidents + s.overlapJobs), "(res+jobs)"),
			]),

			sectionHead("Mode shift – drivers you could win on today's network", "modeShiftCard"),
			card(
				[
					StatLine(
						"Mode-shift potential",
						h("span", { style: { color: CONV_COLOR, fontWeight: 700 } }, fmt(s.convertibleDrivers)),
						"both ends served"
					),
					StatLine("Capture rate", pct(s.bothEndsTransit, s.bothEndsTransit + s.convertibleDrivers), "of both-ends commuters"),
					StatLine("Home end only", fmt(s.homeOnlyDrivers), "needs a work-end stop"),
					StatLine("Work end only", fmt(s.workOnlyDrivers), "needs a home-end stop"),
					StatLine("Near a station (either end)", fmt(s.coveredDrivers)),
				],
				CONV_COLOR
			),

			sectionHead("Build here next – biggest unserved markets", "buildNext"),
			card(
				(s.topBuildTargets && s.topBuildTargets.length
					? s.topBuildTargets.map((t, i) =>
							h(
								"div",
								{
									key: i,
									onClick: () => flyToCoords(t.coords, 13),
									title: "Jump to this build target",
									style: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "3px 0", cursor: "pointer" },
								},
								h(
									"span",
									null,
									h(
										"span",
										{ style: { display: "inline-block", width: "16px", opacity: 0.5, fontWeight: 700, fontSize: "11px" } },
										(t.rank || i + 1) + "."
									),
									h("span", {
										style: { display: "inline-block", width: "7px", height: "7px", borderRadius: "50%", background: CONV_COLOR, marginRight: "7px", verticalAlign: "middle" },
									}),
									h("span", { style: { fontWeight: 600 } }, fmt(t.drivers)),
									h("span", { style: { opacity: 0.7 } }, " would-be riders")
								),
								h(
									"span",
									{ style: { fontSize: "11px", opacity: 0.6, whiteSpace: "nowrap" } },
									(t.distM < 1000 ? Math.round(t.distM) + " m" : (t.distM / 1000).toFixed(1) + " km") + " away"
								)
							)
					  )
					: [h("div", { style: { opacity: 0.6, fontSize: "11px" } }, "No reachable build-here opportunities right now.")]),
				CONV_COLOR
			),
			h(
				"div",
				{ style: { fontSize: "10px", opacity: 0.55, marginTop: "5px" } },
				"Each = an uncovered market whose drivers' OTHER trip end is already on your network – would-be riders you'd win by reaching it. Ranked by community size. Distance = to your nearest station (the track you'd lay; green→red on the map). Click a row to fly there."
			),

			h(
				"div",
				{ style: { marginTop: "12px", fontSize: "10px", opacity: 0.5 } },
				"Daily figures (time-stable). “Riders” = transit users with this end (home OR work) in walking reach; “Drivers” = drivers likewise. Rate / station-dot color = transit share of the two (red = mostly driving, green = high transit share). “Mode shift” is stricter: drivers whose home AND work are both within a catchment – winnable on today's network. Click any row to jump to it on the map."
			)
		);

		const rightCol = h(
			"div",
			{
				style: {
					minWidth: 0,
					marginTop: "12px",
					paddingTop: "12px",
					borderTop: "1px solid rgba(128,128,128,0.18)",
				},
			},
			sectionHead("Per-route: riders vs. drivers in reach", "tablesRoute"),
			routeTable,
			sectionHead("Per-station: riders vs. drivers in reach", "tablesStation"),
			table
		);

		// Greenfield "Start here" – the demand hubs (same numbered dots on the map), shown only
		// before any station exists (hands off to "Build here next" once you start building).
		// Row N == map circle N. Red = residential hub, violet = job hub. Click flies there.
		const hubColor = (k) => (k === "home" ? HUB_HOME : HUB_JOB);
		const hubType = (k) => (k === "home" ? "residential" : "jobs");
		const centerRow = (c) =>
			h(
				"div",
				{
					key: c.rank,
					onClick: () => flyToCoords(c.coords, 13),
					title: "Jump to demand hub #" + c.rank,
					style: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "3px 0", cursor: "pointer" },
				},
				h(
					"span",
					null,
					h("span", { style: { display: "inline-block", width: "20px", opacity: 0.55, fontWeight: 700, fontSize: "11px" } }, c.rank + "."),
					h("span", { style: { display: "inline-block", width: "9px", height: "9px", borderRadius: "50%", background: hubColor(c.kind), marginRight: "7px", verticalAlign: "middle" } }),
					h("span", { style: { fontWeight: 600 } }, fmt(c.kind === "home" ? c.residents : c.jobs)),
					h("span", { style: { opacity: 0.7 } }, c.kind === "home" ? " residents" : " jobs"),
					h("span", { style: { opacity: 0.45, fontSize: "10.5px" } }, c.kind === "home" ? "  ·  " + fmt(c.jobs) + " jobs" : "  ·  " + fmt(c.residents) + " residents")
				),
				h("span", { style: { fontSize: "10.5px", fontWeight: 600, whiteSpace: "nowrap", color: hubColor(c.kind) } }, hubType(c.kind))
			);
		const startHere =
			s.stationCount === 0
				? h(
						"div",
						null,
						sectionHead("Start here – your first line"),
						s.demandCenters && s.demandCenters.length
							? card(
									[
										h("div", { style: { fontSize: "11px", opacity: 0.75, lineHeight: 1.45, marginBottom: "6px" } }, "Before you've built anything: your biggest residential hubs (red, ranks 1–5) and biggest job hubs (violet, ranks 6–10) – the same numbered areas on the map. A good first line connects a big red hub to a big violet one. Click a row to fly to that hub."),
										...s.demandCenters.map(centerRow),
									],
									HUB_ACCENT
							  )
							: card([h("div", { style: { opacity: 0.6, fontSize: "11px" } }, "Demand data isn't available for this map yet.")], HUB_ACCENT),
						h("div", { style: { fontSize: "10px", opacity: 0.55, marginTop: "5px", lineHeight: 1.5 } }, "Red = where people live (1–5), violet = where they work (6–10); each sized within its own group, and the row numbers match the areas on the map."),
						h("div", { style: { fontSize: "10px", opacity: 0.5, marginTop: "12px" } }, "Coverage, mode-shift and per-line analytics activate once you build your first stations.")
				  )
				: null;
		const body =
			s.stationCount === 0
				? h("div", { style: { marginTop: "6px" } }, startHere)
				: h("div", { style: { marginTop: "6px" } }, leftCol, rightCol);

			planningContent = h("div", { style: { paddingTop: "12px" } }, kpis, body);
		} else {
			planningContent = h("div", { style: { padding: "24px 6px", opacity: 0.7 } }, "Loading demand data…");
		}

		// ---- Tabs: an underline strip, visually distinct from the pill controls ----
		const tabBtn = (id, label) =>
			h(
				"button",
				{
					onClick: () => {
						activeTab = id;
						savePrefs();
						try {
							api.ui.forceUpdate();
						} catch (e) {}
					},
					style: {
						flex: "1 1 0",
						padding: "11px 8px 9px",
						cursor: "pointer",
						background: "none",
						border: "none",
						borderBottom: activeTab === id ? "2px solid #5aa9e6" : "2px solid transparent",
						color: "inherit",
						fontWeight: activeTab === id ? 700 : 600,
						fontSize: "13px",
						letterSpacing: "0.02em",
						opacity: activeTab === id ? 1 : 0.5,
					},
				},
				label
			);
		const tabBar = h(
			"div",
			{ style: { display: "flex", borderBottom: "1px solid rgba(128,128,128,0.22)" } },
			tabBtn("setup", "Setup"),
			tabBtn("planning", "Planning"),
			tabBtn("efficiency", "Efficiency")
		);

		// ---- Setup tab: settings cards (header + caption, divided rows, switches right) ----
		const sliderCtl = (min, max, step, value, onChange, chip) =>
			h(
				"div",
				{ style: { display: "flex", alignItems: "center", gap: "8px" } },
				h("input", { type: "range", min: min, max: max, step: step, value: value, onChange: onChange, style: { width: "150px", accentColor: "#5aa9e6" } }),
				h("span", { style: { fontSize: "11px", fontWeight: 600, width: "38px", textAlign: "right", fontVariantNumeric: "tabular-nums", opacity: 0.85 } }, chip)
			);
		const segCtl = (options, current, onPick) =>
			h(
				"div",
				{ style: { display: "inline-flex", border: "1px solid rgba(128,128,128,0.4)", borderRadius: "6px", overflow: "hidden" } },
				options.map((o, i) =>
					h(
						"button",
						{
							key: o.id,
							onClick: () => onPick(o.id),
							title: o.label + " – no key needed",
							style: {
								padding: "4px 11px",
								cursor: "pointer",
								border: "none",
								borderLeft: i ? "1px solid rgba(128,128,128,0.3)" : "none",
								background: current === o.id ? "rgba(90,169,230,0.25)" : "transparent",
								color: "inherit",
								fontWeight: 600,
								fontSize: "11px",
								opacity: current === o.id ? 1 : 0.6,
							},
						},
						o.label
					)
				)
			);
		const layerRow = (label, desc, dot, on, flip, infoKey) => [
			setupRow(
				h("span", { style: { display: "inline-flex", alignItems: "center" } }, label, infoIcon(infoKey)),
				desc,
				switchCtl(on, () => {
					flip();
					applyVisibility(api.utils.getMap());
					savePrefs();
					try {
						api.ui.forceUpdate();
					} catch (e) {}
				}),
				dot
			),
			infoBox(infoKey, true),
		];
		const speedRunning = speedSkipTarget != null;
		const speedCtl = speedRunning
			? h(
					"div",
					{ style: { display: "flex", alignItems: "center", gap: "10px" } },
					h("span", { style: { fontSize: "11px", color: "#5aa9e6", fontWeight: 600, whiteSpace: "nowrap" } }, "Running → Day " + speedSkipTarget),
					h("button", { onClick: speedCancelSkip, style: { padding: "5px 12px", cursor: "pointer", borderRadius: "6px", border: "1px solid rgba(224,86,60,0.7)", background: "rgba(224,86,60,0.14)", color: "#ff8a6c", fontWeight: 700, fontSize: "11px", whiteSpace: "nowrap" } }, "Stop")
			  )
			: h("button", { onClick: speedStartSkip, style: { padding: "6px 14px", cursor: "pointer", borderRadius: "6px", border: "none", background: "#5aa9e6", color: "#0c1722", fontWeight: 700, fontSize: "11.5px", whiteSpace: "nowrap" } }, "⏩ Run");
		const proxyDot = (color) => h("span", { style: { display: "inline-block", width: "7px", height: "7px", borderRadius: "50%", background: color, marginRight: "7px", flexShrink: 0 } });
		const proxyStatusRow = h(
			"div",
			{ style: { display: "flex", alignItems: "center", flexWrap: "wrap", gap: "4px", padding: "9px 14px", borderTop: "1px solid rgba(128,128,128,0.14)", fontSize: "11px" } },
			proxyStatus === "up"
				? [proxyDot("#39c35a"), h("span", { key: "t", style: { opacity: 0.75 } }, "Tile proxy connected")]
				: proxyStatus === "down"
				? [
						proxyDot("#ffae57"),
						h("span", { key: "t", style: { color: "#ffae57", lineHeight: 1.5 } }, "Proxy not running - satellite needs it. One-time setup: run "),
						h("code", { key: "c", style: { background: "rgba(255,255,255,0.1)", padding: "0 4px", borderRadius: "3px" } }, "install-proxy.sh"),
						h("button", { key: "b", onClick: copyProxyCmd, style: { marginLeft: "6px", padding: "2px 8px", cursor: "pointer", borderRadius: "4px", border: "1px solid rgba(128,128,128,0.4)", background: "transparent", color: "inherit", fontSize: "10px" } }, "Copy command"),
				  ]
				: [proxyDot("rgba(128,128,128,0.6)"), h("span", { key: "t", style: { opacity: 0.5 } }, "Checking proxy…")]
		);
		const setupContent = h(
			"div",
			{ style: { paddingTop: "16px" } },
			setupCard("Game speed", "Fast-forward quiet stretches without overshooting.", [
				setupRow("Max speed to next midnight", "Runs the game at full speed and pauses automatically at the start of the next day. Stop ends it early.", speedCtl),
			]),
			setupCard("Map layers", "Choose which overlays draw on the city map.", [
				layerRow("Catchment", "Walk-reach circle around every station.", "#9aa5b0", showCircles, () => {
					showCircles = !showCircles;
				}, "catchment"),
				layerRow("Latent demand", "Uncovered markets one extension would win.", CONV_COLOR, showConversion, () => {
					showConversion = !showConversion;
				}, "latent"),
				layerRow("Demand hubs", "Biggest residential and job areas, for the first line.", HUB_ACCENT, showFirstLines, () => {
					showFirstLines = !showFirstLines;
				}, "hubs"),
				layerRow("Stations", "Success-rate dot and % on every station.", "#ffffff", showStations, () => {
					showStations = !showStations;
				}, "stations"),
				layerRow("Satellite", "Photographic imagery under the map.", "#5aa9e6", showSatellite, () => {
					showSatellite = !showSatellite;
					if (showSatellite) checkProxyHealth();
				}, "satellite"),
				layerRow("Buildings", "The game's own 3D buildings.", "#bdbdbd", showBuildings, () => {
					showBuildings = !showBuildings;
				}, "buildings"),
			]),
			setupCard("Base imagery", "Satellite sources are key-free; tiles stream through the local proxy.", [
				h(
					"div",
					{ style: { opacity: showSatellite ? 1 : 0.55 } },
					setupRow("Provider", "Esri is the default; Hybrid adds labels.", segCtl(SAT_PROVIDERS, satProvider, setSatProvider)),
					setupRow("Opacity", null, sliderCtl(0, 1, 0.05, satOpacity, (e) => {
						satOpacity = parseFloat(e.target.value);
						applyVisibility(api.utils.getMap());
						savePrefs();
						try {
							api.ui.forceUpdate();
						} catch (e2) {}
					}, Math.round(satOpacity * 100) + "%")),
					proxyStatusRow
				),
			]),
			setupCard("Display", "Visual preferences for the overlays.", [
				setupRow("Station dot size", "Scales the station dots and their % labels.", sliderCtl(0.5, 2.5, 0.1, stationDotScale, (e) => {
					stationDotScale = parseFloat(e.target.value);
					applyDotScale();
					savePrefs();
					try {
						api.ui.forceUpdate();
					} catch (e2) {}
				}, stationDotScale.toFixed(1) + "×")),
			])
		);

		// ---- Efficiency tab: peak-hold Load Factor per line ----
		const nfmt = (n) => Math.round(n || 0).toLocaleString();
		const capOf = (p) => (p.trainsPerHour || 0) * (p.capacity || 0); // seats offered per hour
		const hoursOf = (p) => (p.cur || []).filter((x) => x != null);
		const avgLoadOf = (p) => {
			const a = hoursOf(p);
			return a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
		};
		const peakLoadOf = (p) => {
			const a = hoursOf(p);
			return a.length ? Math.max.apply(null, a) : null;
		};
		const avgRidersOf = (p) => {
			const v = avgLoadOf(p);
			return v == null ? 0 : v * capOf(p);
		};
		// Day-over-day change, computed ONLY over hours present in BOTH cur (today) and prev
		// (previous day) so the baselines are aligned (cur covers every sampled hour, but prev
		// only fills as each hour re-rolls – averaging them over different hour sets is wrong).
		// Load-weighted (Σtoday ÷ Σyesterday − 1) so it matches the bars and a −% on a tiny-load
		// hour barely counts. Guarded against a near-zero baseline.
		const vsYestOf = (p) => {
			const cur = p.cur || [],
				prev = p.prev || [];
			let sc = 0,
				sp = 0,
				n = 0;
			for (let hr = 0; hr < 24; hr++) {
				if (cur[hr] != null && prev[hr] != null) {
					sc += cur[hr];
					sp += prev[hr];
					n++;
				}
			}
			return n > 0 && sp / n >= 0.05 ? sc / sp - 1 : null;
		};
		const flagOf = (v) =>
			v == null
				? { label: "–", color: "#888" }
				: v >= 1.0
				? { label: "Overcrowded", color: "#e0563c" }
				: v >= 0.75
				? { label: "Near capacity", color: "#ffc83d" }
				: v >= 0.25
				? { label: "Healthy", color: "#39c35a" }
				: { label: "Underused", color: "#5aa9e6" };
		// Status column = a peak-hour ACTION/TREND (not the absolute level, which the bars
		// already show): what to do + how the rush is moving vs yesterday's peak.
		const statusOf = (p) => {
			const pk = peakLoadOf(p); // today's peak-hour load
			if (pk == null) return { label: "–", color: "#888" };
			const avg = avgLoadOf(p); // rolling average load across the hours
			// off-peak (non-rush) average load – rush = 06-08 & 16-18
			const cur = p.cur || [];
			const isRush = (hr) => (hr >= 6 && hr <= 8) || (hr >= 16 && hr <= 18);
			let ops = 0,
				opn = 0;
			for (let hr = 0; hr < 24; hr++) {
				if (!isRush(hr) && cur[hr] != null) {
					ops += cur[hr];
					opn++;
				}
			}
			const offPeak = opn ? ops / opn : null;
			// peak-hour trend vs yesterday's peak
			const pv = (p.prev || []).filter((x) => x != null);
			const peakY = pv.length ? Math.max.apply(null, pv) : null;
			const trend = peakY != null && peakY >= 0.05 ? (pk - peakY) / peakY : null;
			if (pk >= 1.0) return { label: "Add peak trains", color: "#e0563c" }; // rush overcrowded
			if (avg != null && avg < 0.2) return { label: "Over-served", color: "#5aa9e6" }; // wasted all day → cut trains
			if (pk >= 0.5 && offPeak != null && offPeak < 0.12) return { label: "Trim off-peak", color: "#5aa9e6" }; // busy at rush, dead off-peak → cut Low/Med Demand
			if (pk >= 0.6 && trend != null && trend >= 0.15) return { label: "Rising – watch peak", color: "#ffc83d" };
			if (trend != null && trend <= -0.15) return { label: "Easing", color: "#5fe07a" };
			return { label: "Balanced", color: "#39c35a" };
		};
		const peaks = Array.from(linePeaks.values());
		const effHasData = peaks.some((p) => p.cur && p.cur.some((x) => x != null));
		// current in-game hour, to highlight "now" in the charts
		const nowHr = (() => {
			try {
				const e = api.gameState.getElapsedSeconds();
				return e != null ? Math.floor((((e % 86400) + 86400) % 86400) / 3600) : null;
			} catch (x) {
				return null;
			}
		})();
		let totRiders = 0,
			totCap = 0,
			totTrains = 0;
		peaks.forEach((p) => {
			totRiders += avgRidersOf(p);
			totCap += capOf(p);
			totTrains += p.trainCount || 0;
		});
		const sysLF = totCap > 0 ? totRiders / totCap : null;
		const effHead = (t, align) =>
			h("th", { style: { textAlign: align || "left", padding: "0 6px 6px 0", fontWeight: 600, opacity: 0.55, fontSize: "10px", textTransform: "uppercase", letterSpacing: "0.04em" } }, t);
		const kCard = (label, value, sub, color) =>
			h(
				"div",
				{ style: { flex: "1 1 0", minWidth: "120px", padding: "10px", borderRadius: "4px", border: "1px solid rgba(128,128,128,0.2)" } },
				h("div", { style: { fontSize: "9.5px", textTransform: "uppercase", letterSpacing: "0.05em", opacity: 0.5, marginBottom: "3px" } }, label),
				h("div", { style: { fontSize: "20px", fontWeight: 700, color: color || "inherit" } }, value),
				sub ? h("div", { style: { fontSize: "10.5px", opacity: 0.6, marginTop: "1px" } }, sub) : null
			);
		const effRows = peaks
			.slice()
			.sort((a, b) => (peakLoadOf(b) || 0) - (peakLoadOf(a) || 0))
			.map((p, i) => {
				const avg = avgLoadOf(p);
				const f = statusOf(p); // peak-hour action/trend (not the absolute level)
				const vy = vsYestOf(p);
				return h(
					"tr",
					{ key: i, style: { borderTop: "1px solid rgba(128,128,128,0.12)" } },
					h(
						"td",
						{ style: { padding: "6px 6px 6px 0" } },
						h("span", { style: { display: "inline-block", padding: "1px 8px", borderRadius: "3px", background: p.color, color: "#fff", fontWeight: 700, fontSize: "11px", whiteSpace: "nowrap" } }, p.bullet)
					),
					h("td", { style: { padding: "6px 6px", textAlign: "right", fontWeight: 600 } }, nfmt(avgRidersOf(p))),
					h("td", { style: { padding: "6px 6px", textAlign: "right", opacity: 0.75 } }, (p.trainsPerHour || 0).toFixed(1)),
					h("td", { style: { padding: "6px 6px", textAlign: "right", fontWeight: 700 } }, avg == null ? "–" : Math.round(avg * 100) + "%"),
					h(
						"td",
						{ style: { padding: "6px 6px", textAlign: "right", fontWeight: 600, fontSize: "11px", whiteSpace: "nowrap", color: vy == null ? "#888" : vy > 0 ? "#ff7a5c" : "#5fe07a" } },
						vy == null ? "–" : (vy > 0 ? "+" : "") + Math.round(vy * 100) + "%"
					),
					h("td", { style: { padding: "6px 0", textAlign: "right", color: f.color, fontWeight: 600, fontSize: "11px", whiteSpace: "nowrap" } }, f.label)
				);
			});
		// Load-by-hour: a 24-bar chart per line. Bar height = peak load that hour, colored by
		// status – so you can read off which hours each line needs more trains.
		const CHART_H = 34;
		const NORM = 1.4; // 140% load = full-height bar
		const barH = (v) => Math.max(2, (Math.min(v, NORM) / NORM) * CHART_H);
		// Service-frequency brackets (from the game's Service-frequency tooltips – hardcoded
		// because the API exposes only the per-bracket train counts, not the hour mapping):
		//   High (rush): 06-09 & 16-19 · Medium: 05, 09-16, 19 · Low: 00-05 & 20-24.
		// Shaded behind the bars (violet, distinct from the load colors) so you can tell which
		// bracket an overcrowded hour falls in → which bracket's train count to raise/lower.
		const bracketOf = (hr) => {
			if ((hr >= 6 && hr <= 8) || (hr >= 16 && hr <= 18)) return "high";
			if (hr <= 4 || hr >= 20) return "low";
			return "medium";
		};
		const bracketBg = (hr) => {
			const b = bracketOf(hr);
			return b === "high" ? "rgba(138,120,236,0.20)" : b === "medium" ? "rgba(138,120,236,0.10)" : "rgba(138,120,236,0.035)";
		};
		const hourBars = (today, prev) =>
			h(
				"div",
				// paddingTop reserves room ABOVE the bars for the delta labels so they never sit on a bar
				{ style: { display: "flex", alignItems: "flex-end", gap: "1px", paddingTop: "13px" } },
				Array.from({ length: 24 }, (_, hr) => {
					const t = today ? today[hr] : null; // today's load this hour
					const y = prev ? prev[hr] : null; // yesterday's load this hour
					// front bar = today if present, else yesterday faded (so the chart stays full
					// after midnight: future hours show yesterday until today overwrites them)
					const fv = t != null ? t : y;
					const fHt = fv != null ? barH(fv) : 2;
					const fCol = fv != null ? flagOf(fv).color : "rgba(128,128,128,0.18)";
					const fOp = t != null ? 0.92 : y != null ? 0.34 : 1;
					// ghost = yesterday's level behind today's bar, for instant compare
					const showGhost = t != null && y != null;
					// delta label: only when there's a meaningful baseline (y >= 10%) so a near-zero
					// yesterday doesn't produce absurd "+1389%", and only when the move is >10%.
					let delta = null,
						deltaEl = null;
					if (t != null && y != null && y >= 0.1) {
						delta = (t - y) / y;
						if (Math.abs(delta) >= 0.1) {
							deltaEl = h(
								"div",
								{
									style: {
										position: "absolute",
										left: "-3px",
										right: "-3px",
										bottom: fHt + 2 + "px", // always just ABOVE this bar's top
										textAlign: "center",
										fontSize: "7px",
										fontWeight: 700,
										color: delta > 0 ? "#ff7a5c" : "#5fe07a",
										whiteSpace: "nowrap",
										pointerEvents: "none",
										textShadow: "0 0 3px #000, 0 0 3px #000",
									},
								},
								(delta > 0 ? "+" : "") + Math.round(delta * 100) + "%"
							);
						}
					}
					return h(
						"div",
						{
							key: hr,
							title:
								String(hr).padStart(2, "0") +
								":00 – " +
								(t != null ? "today " + Math.round(t * 100) + "%" : "today n/a") +
								(y != null ? " · yest " + Math.round(y * 100) + "%" : ""),
							style: { position: "relative", flex: "1 1 0", height: CHART_H + "px", background: "transparent", borderRadius: "1px" },
						},
						hr === nowHr ? h("div", { style: { position: "absolute", left: 0, right: 0, top: 0, bottom: 0, background: "rgba(255,255,255,0.14)", borderRadius: "1px" } }) : null,
						showGhost ? h("div", { style: { position: "absolute", left: 0, right: 0, bottom: 0, height: barH(y) + "px", background: "rgba(255,255,255,0.20)", borderRadius: "1px" } }) : null,
						fv != null ? h("div", { style: { position: "absolute", left: 0, right: 0, bottom: 0, height: fHt + "px", background: fCol, opacity: fOp, borderRadius: "1px" } }) : null,
						deltaEl
					);
				})
			);
		const hourAxis = h(
			"div",
			{ style: { display: "flex", marginTop: "2px" } },
			Array.from({ length: 24 }, (_, hr) =>
				h("div", { key: hr, style: { flex: "1 1 0", textAlign: "center", fontSize: "8px", opacity: 0.4 } }, hr % 6 === 0 ? String(hr).padStart(2, "0") : "")
			)
		);
		// expandable per-station boardings for a line (busiest stops = where demand concentrates)
		// station id -> coords, built once (for the click-to-fly in the per-line breakdown)
		let stnCoords = null;
		const coordsOf = (id) => {
			if (!stnCoords) {
				stnCoords = {};
				try {
					(api.gameState.getStations() || []).forEach((s) => {
						if (s && s.id) stnCoords[s.id] = s.coords;
					});
				} catch (e) {}
			}
			return stnCoords[id];
		};
		// Per-line crowding contributors: that line's busiest boarding stops (boardings = where
		// demand originates; the game doesn't expose true on-board load). Click a stop to fly to it.
		const stationBreakdown = (p) => {
			const sts = Object.keys(p.stations || {})
				.map((sid) => ({ sid: sid, name: p.stations[sid].name, peak: p.stations[sid].peak || 0 }))
				.filter((s) => s.peak > 0)
				.sort((a, b) => b.peak - a.peak);
			if (!sts.length)
				return h("div", { style: { fontSize: "10px", opacity: 0.5, margin: "2px 0 10px 18px" } }, "No station boardings recorded yet (they read 0 at night – run a busy hour).");
			const maxP = sts[0].peak || 1;
			const total = sts.reduce((s, e) => s + e.peak, 0) || 1;
			return h(
				"div",
				{ style: { margin: "4px 0 10px 18px" } },
				h("div", { style: { fontSize: "9px", textTransform: "uppercase", letterSpacing: "0.05em", opacity: 0.4, marginBottom: "4px" } }, "Crowding contributors – boardings by station"),
				sts.map((s, si) =>
					h(
						"div",
						{
							key: si,
							onClick: () => {
								const co = coordsOf(s.sid);
								if (co) flyToCoords(co, 13);
							},
							title: "Jump to " + s.name,
							style: { display: "flex", alignItems: "center", gap: "6px", marginBottom: "2px", cursor: "pointer" },
						},
						h("span", { style: { fontSize: "10px", width: "130px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", opacity: 0.8 } }, s.name),
						h(
							"div",
							{ style: { flex: "1 1 0", height: "8px", background: "rgba(128,128,128,0.12)", borderRadius: "2px", overflow: "hidden" } },
							h("div", { style: { width: Math.round((s.peak / maxP) * 100) + "%", height: "100%", background: p.color, opacity: 0.85, borderRadius: "2px" } })
						),
						h("span", { style: { fontSize: "10px", width: "48px", textAlign: "right", fontWeight: 600 } }, nfmt(s.peak)),
						h("span", { style: { fontSize: "10px", width: "38px", textAlign: "right", opacity: 0.6 } }, Math.round((s.peak / total) * 100) + "%")
					)
				)
			);
		};
		// Service-frequency legend (once, above all routes) + dashed boundary lines down the charts.
		const brkRuns = [];
		for (let h = 0; h < 24; h++) {
			const b = bracketOf(h);
			const last = brkRuns[brkRuns.length - 1];
			if (last && last.b === b) last.len++;
			else brkRuns.push({ b: b, len: 1 });
		}
		const brkLabel = { high: "High", medium: "Med", low: "Low" };
		const brkColor = { high: "#b3a6f5", medium: "rgba(179,166,245,0.7)", low: "rgba(179,166,245,0.45)" };
		const bracketLegend = h(
			"div",
			{ style: { display: "flex", gap: "1px", height: "14px", marginBottom: "6px" } },
			brkRuns.map((r, i) =>
				h(
					"div",
					{ key: i, style: { flex: r.len + " 1 0", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "8.5px", fontWeight: 700, color: brkColor[r.b], whiteSpace: "nowrap", overflow: "hidden", borderBottom: "1px solid rgba(138,120,236,0.3)" } },
					r.len >= 2 ? brkLabel[r.b] : brkLabel[r.b].charAt(0)
				)
			)
		);
		const boundaries = [];
		for (let h = 1; h < 24; h++) if (bracketOf(h) !== bracketOf(h - 1)) boundaries.push(h);
		const dashedLines = h(
			"div",
			{ style: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, pointerEvents: "none" } },
			boundaries.map((bh, i) =>
				h("div", { key: i, style: { position: "absolute", top: 0, bottom: 0, left: (bh / 24) * 100 + "%", width: 0, borderLeft: "1px dashed rgba(255,255,255,0.16)" } })
			)
		);
		const hourlySection = h(
			"div",
			{ style: { marginTop: "18px" } },
			h("div", { style: { fontSize: "10px", textTransform: "uppercase", letterSpacing: "0.06em", opacity: 0.45, fontWeight: 700, marginBottom: "10px" } }, "Load by hour"),
			h(
				"div",
				{ style: { position: "relative" } },
				dashedLines,
				bracketLegend,
				peaks.map((p, i) => {
					const open = expandedLines.has(p.routeId);
					return h(
						"div",
						{ key: i, style: { marginBottom: "12px" } },
						h(
							"div",
							{
								onClick: () => {
									if (open) expandedLines.delete(p.routeId);
									else expandedLines.add(p.routeId);
									try {
										api.ui.forceUpdate();
									} catch (e) {}
								},
								title: "Show load by station",
								style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "4px", cursor: "pointer" },
							},
							h(
								"span",
								null,
								h("span", { style: { opacity: 0.5, marginRight: "5px", fontSize: "9px" } }, open ? "▾" : "▸"),
								h("span", { style: { display: "inline-block", padding: "1px 8px", borderRadius: "3px", background: p.color, color: "#fff", fontWeight: 700, fontSize: "11px" } }, p.bullet)
							),
							h("span", { style: { fontSize: "10px", opacity: 0.5 } }, "peak " + (peakLoadOf(p) == null ? "–" : Math.round(peakLoadOf(p) * 100) + "%"))
						),
						hourBars(p.cur, p.prev),
						open ? stationBreakdown(p) : null
					);
				}),
				hourAxis
			),
			h(
				"div",
				{ style: { fontSize: "10px", opacity: 0.5, marginTop: "6px", lineHeight: 1.5 } },
				"Each bar = that hour's most recent peak load; the ghost behind it = the previous day's level for that hour; % = change vs then (red = busier, green = relieved). Bars update as the clock passes each hour – nothing wipes at midnight. Lit column = current hour."
			),
			h(
				"div",
				{ style: { fontSize: "10px", opacity: 0.5, marginTop: "4px", lineHeight: 1.5 } },
				"Top strip = service-frequency bracket (dashed lines mark the boundaries): High (rush) 06–09 & 16–19 · Medium 05, 09–16, 19 · Low 00–05 & 20–24. A red bar in a High segment = raise High Demand trains."
			)
		);
		const efficiencyContent = h(
			"div",
			{ style: { paddingTop: "16px", fontSize: "12px" } },
			!effHasData
				? h(
						"div",
						{ style: { padding: "20px 4px", opacity: 0.7, lineHeight: 1.5 } },
						h("div", { style: { fontWeight: 700, marginBottom: "6px" } }, "Run the game to populate efficiency"),
						"Load Factor reads each line's PEAK ridership, which is 0 at night. Run unpaused through a busy hour and your lines fill in here automatically.",
						h(
							"div",
							{ style: { marginTop: "12px", fontFamily: "monospace", fontSize: "10px", opacity: 0.6 } },
							(() => {
								try {
									const lm = api.gameState.getLineMetrics() || [];
									return "debug · sampled lines=" + linePeaks.size + " · live getLineMetrics: " + lm.length + " lines, ridersPerHour=" + lm.map((m) => m.ridersPerHour).join("/");
								} catch (e) {
									return "debug · sampled lines=" + linePeaks.size + " · getLineMetrics error: " + e;
								}
							})()
						)
				  )
				: h(
						"div",
						null,
						h(
							"div",
							{ style: { display: "flex", flexWrap: "wrap", gap: "6px", marginBottom: "16px" } },
							kCard("System load factor", sysLF == null ? "–" : Math.round(sysLF * 100) + "%", "avg riders ÷ seats offered", flagOf(sysLF).color),
							kCard("Avg riders / hr", nfmt(totRiders), "across all lines"),
							kCard("Trains", nfmt(totTrains), "deployed")
						),
						h("div", { style: { fontSize: "10px", textTransform: "uppercase", letterSpacing: "0.06em", opacity: 0.45, fontWeight: 700, marginBottom: "8px" } }, "Load factor by line"),
						h(
							"table",
							{ style: { width: "100%", borderCollapse: "collapse", fontSize: "11.5px" } },
							h("thead", null, h("tr", null, effHead("Line"), effHead("Riders/hr", "right"), effHead("Trains/hr", "right"), effHead("Load", "right"), effHead("vs yest", "right"), effHead("Status", "right"))),
							h("tbody", null, effRows)
						),
						hourlySection,
						h(
							"div",
							{ style: { fontSize: "10px", opacity: 0.55, marginTop: "10px", lineHeight: 1.5 } },
							"Load = riders/hr ÷ (trains/hr × train capacity). Table shows the rolling AVERAGE; ‘vs yest’ = change in that average vs the previous day; Status = a recommendation – Add peak trains (rush full) · Over-served / Trim off-peak (running more than demand needs → cut trains) · Rising / Easing (vs yesterday's peak) · Balanced. Bar colors: ",
							h("span", { style: { color: "#e0563c" } }, "Overcrowded"),
							" ≥100% · ",
							h("span", { style: { color: "#ffc83d" } }, "Near capacity"),
							" 75–100% · ",
							h("span", { style: { color: "#39c35a" } }, "Healthy"),
							" 25–75% · ",
							h("span", { style: { color: "#5aa9e6" } }, "Underused"),
							" <25%."
						)
				  )
		);

		const tabContent =
			activeTab === "setup"
				? setupContent
				: activeTab === "efficiency"
				? efficiencyContent
				: planningContent;

		return h(
			"div",
			{
				style: {
					position: "relative",
					display: "flex",
					flexDirection: "column",
					height: "100%",
					minHeight: 0,
					fontSize: "12px",
					lineHeight: 1.35,
				},
			},
			tabBar,
			// fill the panel's actual height and scroll inside it (flex:1 + minHeight:0 is what
			// makes overflow work – without a bounded height the content just clips at the bottom)
			h(
				"div",
				{ style: { flex: "1 1 auto", minHeight: 0, overflowY: "auto", overflowX: "hidden", padding: "0 14px 16px" } },
				tabContent
			)
		);
	}

	// Register the panel/toolbar button. Guarded so frequent onMapReady re-fires
	// (style reloads) don't stack it; re-armed on onCityLoad so a new game's rebuilt
	// toolbar gets the icon back.
	let toolbarMounted = false;
	function addPanel() {
		if (toolbarMounted) return;
		api.ui.addFloatingPanel({
			id: "com.davidkarpik.networkplanner.panel",
			title: "Network Planner",
			icon: "Radius",
			defaultWidth: 750,
			defaultHeight: 600,
			render: renderPanel,
		});
		toolbarMounted = true;
	}
	addPanel();

	// Efficiency peak-hold sampler at MODULE level (not inside onMapReady) – so it runs even
	// when the mod is hot-reloaded mid-game and onMapReady doesn't re-fire. getLineMetrics is
	// a no-op until a game is running, so sampling early is harmless.
	sampleEfficiency();
	setInterval(sampleEfficiency, 2000);

	// Speed "skip" midnight detector: onDayChange fires at the day rollover (exact midnight); the
	// interval is a backstop if that hook is unavailable. Both no-op unless a skip is running.
	if (api.hooks.onDayChange) api.hooks.onDayChange(speedCheckSkip);
	setInterval(speedCheckSkip, 250);

	// Satellite tile-proxy reachability: check at load and periodically while satellite is on,
	// so the Setup tab can show a green check or guide the user to run the proxy.
	checkProxyHealth();
	setInterval(function () {
		if (showSatellite) checkProxyHealth();
	}, 6000);

	// Auto-heal at MODULE level (was inside onMapReady, which a mid-game reload may not
	// re-fire, leaving the healer off -- so turning the map / Demand Stats dropped our layers
	// permanently). Re-adds any of our layers the game drops; also re-hides buildings.
	setInterval(function () {
		let m;
		try {
			m = api.utils.getMap();
		} catch (e) {}
		if (!m || !m.getLayer) return;
			bindMapListeners(m); // ensure instant-repair listeners are on the current map
		if (!showBuildings) {
			try {
				if (m.getLayer("buildings-3d") && m.getLayoutProperty("buildings-3d", "visibility") !== "none") {
					m.setLayoutProperty("buildings-3d", "visibility", "none");
				}
			} catch (e) {}
		}
		try {
			const want = [
				[LYR_CATCH, showCircles],
				[LYR_CONV, showConversion],
				[LYR_STN, showStations],
				[LYR_STN_LABEL, showStations],
				[LYR_CEN, showFirstLines],
				[LYR_CEN_LABEL, showFirstLines],
				[LYR_SAT, showSatellite],
			];
			let needFix = false;
			for (let i = 0; i < want.length; i++) {
				const id = want[i][0];
				const on = want[i][1];
				const exists = !!m.getLayer(id);
				if (on && !exists) {
					needFix = true;
					break;
				}
				if (exists) {
					const vis = m.getLayoutProperty(id, "visibility") || "visible";
					if (vis !== (on ? "visible" : "none")) {
						needFix = true;
						break;
					}
				}
			}
			if (needFix) pushData();
		} catch (e) {}
	}, 300);

	// Dev/test hook: inspect the greenfield first-line finder without the game UI.
	window.networkPlanner = window.networkPlanner || {};
	window.networkPlanner.debugFirstLines = function () {
		return stats ? { cityResidents: stats.cityResidents, cityJobs: stats.cityJobs, cityCommuters: stats.cityCommuters, firstLines: stats.firstLines, demandCenters: stats.demandCenters } : null;
	};
	window.networkPlanner.debugNetworkLength = function () {
		return stats
			? {
					systemLengthM: stats.systemLengthM,
					trackBuiltM: stats.trackBuiltM,
					trackPlannedM: stats.trackPlannedM,
					perRoute: stats.perRoute.map((r) => ({ id: r.id, lengthM: r.lengthM })),
			  }
			: null;
	};
})();

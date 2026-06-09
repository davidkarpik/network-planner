#!/usr/bin/env node
/**
 * Network Planner - satellite tile relay
 * Copyright (C) 2026 David Karpik
 * Licensed under the GNU General Public License v3.0 only (GPL-3.0-only);
 * see the LICENSE file for the full text.
 * --------------------------------------
 * The game only permits map tiles from 127.0.0.1, so this small relay fetches imagery from
 * the chosen provider and returns it over localhost. Start it before playing:
 *
 *     node proxy.js
 *
 * Node built-ins only, nothing to install. Endpoints:
 *     /tile/<provider>/<z>/<x>/<y>     provider: esri | google | hybrid | osm
 *     /status                          JSON health check
 *
 * Fetched tiles are cached under ./tile-cache/<provider>/<z>/<x>/<y>; delete that folder
 * to clear the cache. All four providers are key-free.
 */
"use strict";

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

const LISTEN_PORT = 8454;
const CACHE_ROOT = path.join(__dirname, "tile-cache");
const FETCH_HEADERS = { "User-Agent": "NetworkPlanner-tile-relay", Referer: "http://127.0.0.1/" };

// Each provider turns a z/x/y request into an upstream URL. (x + y) % 4 spreads Google
// requests across its mt0..mt3 subdomains.
const SOURCES = {
	esri: { mime: "image/jpeg", build: (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}` },
	google: { mime: "image/jpeg", build: (z, x, y) => `https://mt${(+x + +y) % 4}.google.com/vt/lyrs=s&hl=en&x=${x}&y=${y}&z=${z}` },
	hybrid: { mime: "image/jpeg", build: (z, x, y) => `https://mt${(+x + +y) % 4}.google.com/vt/lyrs=y&hl=en&x=${x}&y=${y}&z=${z}` },
	osm: { mime: "image/png", build: (z, x, y) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png` },
};

let served = 0;
let cacheHits = 0;

function respondTile(res, body, mime, hit) {
	res.writeHead(200, {
		"Content-Type": mime,
		"Content-Length": body.length,
		"Cache-Control": "public, max-age=604800",
		"Access-Control-Allow-Origin": "*",
		"X-Relay-Cache": hit ? "hit" : "miss",
	});
	res.end(body);
}

function pullUpstream(url, done) {
	https
		.get(url, { headers: FETCH_HEADERS }, (up) => {
			if (up.statusCode !== 200) {
				up.resume();
				return done(new Error("upstream status " + up.statusCode));
			}
			const buf = [];
			up.on("data", (c) => buf.push(c));
			up.on("end", () => done(null, Buffer.concat(buf)));
		})
		.on("error", done);
}

const server = http.createServer((req, res) => {
	res.setHeader("Access-Control-Allow-Origin", "*");
	if (req.method === "OPTIONS") {
		res.writeHead(204);
		return res.end();
	}

	const route = req.url.split("?")[0];
	if (route === "/status") {
		res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
		return res.end(JSON.stringify({ ok: true, providers: Object.keys(SOURCES), served, cacheHits }));
	}

	// expected: /tile/<provider>/<z>/<x>/<y>[.ext]
	const seg = route.split("/").filter(Boolean);
	if (seg[0] !== "tile" || seg.length < 5) {
		res.writeHead(404);
		return res.end("not found");
	}
	const provider = seg[1];
	const z = seg[2];
	const x = seg[3];
	const y = seg[4].replace(/\.[a-z]+$/i, "");
	const source = SOURCES[provider];
	if (!source) {
		res.writeHead(404);
		return res.end("unknown provider");
	}

	const cacheFile = path.join(CACHE_ROOT, provider, z, x, y);
	fs.readFile(cacheFile, (readErr, cached) => {
		if (!readErr && cached && cached.length) {
			served++;
			cacheHits++;
			return respondTile(res, cached, source.mime, true);
		}
		pullUpstream(source.build(z, x, y), (err, body) => {
			if (err) {
				res.writeHead(502);
				return res.end("relay error");
			}
			fs.mkdir(path.dirname(cacheFile), { recursive: true }, () => fs.writeFile(cacheFile, body, () => {}));
			served++;
			respondTile(res, body, source.mime, false);
		});
	});
});

server.listen(LISTEN_PORT, "127.0.0.1", () => {
	console.log("Network Planner tile relay -> http://127.0.0.1:" + LISTEN_PORT);
	console.log("providers: " + Object.keys(SOURCES).join(", ") + "  |  cache: " + CACHE_ROOT);
	console.log("leave running while you play, Ctrl+C to stop");
});

/**
 * Network Planner – Tile Proxy
 * ==========================
 * Bridges the game's CSP (which blocks external tile domains) by serving map / satellite
 * tiles from 127.0.0.1. Run before playing:  node proxy.js
 * No npm install needed – Node built-ins only.
 *
 *   Route:  /tile/{provider}/{z}/{x}/{y}
 *   Providers:
 *     esri          satellite imagery, no key  (default)
 *     google        Google satellite, no key   (unofficial endpoint)
 *     googleHybrid   Google satellite + labels, no key
 *     osm           OpenStreetMap road map, no key
 *     maptiler      MapTiler satellite, needs key (set via /config?key=…)
 *
 * Tiles are cached to ./tile-cache/{provider}/{z}/{x}/{y}; repeat requests are served
 * from disk (no network). Delete tile-cache/ to reset.
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = 8080;
const CACHE_DIR = path.join(__dirname, 'tile-cache');
const KEY_FILE = path.join(__dirname, 'maptiler-key.txt');

// MapTiler key (only needed for the "maptiler" provider). Set it from the mod panel –
// that writes maptiler-key.txt, loaded here on startup. The literal is a fallback.
let KEY = 'PASTE_YOUR_FREE_MAPTILER_KEY_HERE';
try {
    if (fs.existsSync(KEY_FILE)) {
        const k = fs.readFileSync(KEY_FILE, 'utf8').trim();
        if (k) KEY = k;
    }
} catch (e) {}
const KEY_PLACEHOLDER = 'PASTE_YOUR_FREE_MAPTILER_KEY_HERE';
const isKeySet = () => !!KEY && KEY !== KEY_PLACEHOLDER && KEY.length > 4;

// Provider tile templates. {z}/{x}/{y} substituted; {s} = subdomain rotation; {KEY} = MapTiler key.
const PROVIDERS = {
    esri:         { url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', type: 'image/jpeg' },
    google:       { url: 'https://mt{s}.google.com/vt/lyrs=s&hl=en&x={x}&y={y}&z={z}', type: 'image/jpeg', sub: 4 },
    googleHybrid: { url: 'https://mt{s}.google.com/vt/lyrs=y&hl=en&x={x}&y={y}&z={z}', type: 'image/jpeg', sub: 4 },
    osm:          { url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', type: 'image/png' },
    maptiler:     { url: 'https://api.maptiler.com/maps/satellite-v4/256/{z}/{x}/{y}.jpg?key={KEY}', type: 'image/jpeg', key: true },
};

function upstreamUrl(provider, z, x, y) {
    const p = PROVIDERS[provider];
    if (!p) return null;
    let url = p.url.replace('{z}', z).replace('{x}', x).replace('{y}', y).replace('{KEY}', KEY);
    if (p.sub) url = url.replace('{s}', String((parseInt(x, 10) + parseInt(y, 10)) % p.sub));
    return url;
}
function tileCachePath(provider, z, x, y) {
    return path.join(CACHE_DIR, provider, String(z), String(x), String(y));
}
function ensureDir(d) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}
function countCached(dir) {
    let n = 0;
    try {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const fp = path.join(dir, e.name);
            if (e.isDirectory()) n += countCached(fp);
            else n++;
        }
    } catch (e) {}
    return n;
}

let hits = 0;
let misses = 0;

http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            status: 'ok',
            keyConfigured: isKeySet(),
            providers: Object.keys(PROVIDERS),
            cache: { hits, misses, total: hits + misses },
        }));
        return;
    }

    // Set the MapTiler key at runtime (the mod's panel calls this) + persist it.
    if (req.url.startsWith('/config')) {
        try {
            const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
            const k = (u.searchParams.get('key') || '').trim();
            if (k) { KEY = k; try { fs.writeFileSync(KEY_FILE, k); } catch (e) {} }
        } catch (e) {}
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', keyConfigured: isKeySet() }));
        return;
    }

    // Tile request: /tile/{provider}/{z}/{x}/{y}(.ext)
    const m = req.url.match(/^\/tile\/([a-zA-Z]+)\/(\d+)\/(\d+)\/(\d+)(?:\.\w+)?/);
    if (!m) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); return; }
    const provider = m[1], z = m[2], x = m[3], y = m[4];
    const prov = PROVIDERS[provider];
    if (!prov) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Unknown provider'); return; }
    if (prov.key && !isKeySet()) { res.writeHead(400, { 'Content-Type': 'text/plain' }); res.end('Key required for ' + provider); return; }

    const cached = tileCachePath(provider, z, x, y);
    if (fs.existsSync(cached)) {
        hits++;
        const data = fs.readFileSync(cached);
        res.writeHead(200, {
            'Content-Type': prov.type,
            'Content-Length': data.length,
            'Cache-Control': 'public, max-age=604800',
            'X-Cache': 'HIT',
            'Access-Control-Allow-Origin': '*',
        });
        res.end(data);
        return;
    }

    misses++;
    const upstream = upstreamUrl(provider, z, x, y);
    https.get(upstream, { headers: { 'User-Agent': 'CatchmentPro-SubwayBuilderMod/1.0', 'Referer': 'http://127.0.0.1/' } }, (upRes) => {
        if (upRes.statusCode !== 200) {
            res.writeHead(upRes.statusCode, { 'Content-Type': 'text/plain' });
            res.end(`Upstream returned ${upRes.statusCode}`);
            upRes.resume();
            return;
        }
        const chunks = [];
        upRes.on('data', (c) => chunks.push(c));
        upRes.on('end', () => {
            const buf = Buffer.concat(chunks);
            try { ensureDir(path.dirname(cached)); fs.writeFileSync(cached, buf); } catch (e) {}
            res.writeHead(200, {
                'Content-Type': prov.type,
                'Content-Length': buf.length,
                'Cache-Control': 'public, max-age=604800',
                'X-Cache': 'MISS',
                'Access-Control-Allow-Origin': '*',
            });
            res.end(buf);
        });
    }).on('error', (err) => {
        console.error(`[proxy] upstream error ${provider} ${z}/${x}/${y}:`, err.message);
        res.writeHead(502, { 'Content-Type': 'text/plain' });
        res.end('Bad gateway');
    });
}).listen(PORT, '127.0.0.1', () => {
    console.log('\n🛰  Network Planner tile proxy on 127.0.0.1:' + PORT);
    console.log('   providers: ' + Object.keys(PROVIDERS).join(', '));
    console.log('   route:     /tile/{provider}/{z}/{x}/{y}');
    console.log('   cache:     ' + CACHE_DIR + ' (' + countCached(CACHE_DIR) + ' tiles)');
    console.log('   ✓ leave running while you play · Ctrl+C to stop\n');
});

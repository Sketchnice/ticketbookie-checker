// TicketBookie checker for GitHub: checks District once a minute for RUN_MINUTES minutes, rings your phone through
// ntfy when a watch matches, and tells your site. Nothing to install: GitHub runs it on a timer.
// Settings (GitHub secrets): SITE_URL (your TicketBookie address), SITE_PASSPHRASE (only if you set one in Netlify).

const SITE = String(process.env.SITE_URL || '').trim().replace(/\/+$/, '');
const PASS = process.env.SITE_PASSPHRASE || '';
const RUN_MINUTES = Math.min(Math.max(+process.env.RUN_MINUTES || 5, 1), 30);
const CITY = { key: 'bengaluru', lat: '12.9716', lng: '77.5946' };
const BASE = 'https://www.district.in';
const UA = 'Mozilla/5.0 (Linux; Android 13; SM-A225F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const fetchFn = globalThis.__fetch || fetch; // tests swap this
const sleep = ms => (globalThis.__sleep || (t => new Promise(ok => setTimeout(ok, t))))(ms);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ---------- your site ----------
async function site(path, body) {
    const r = await fetchFn(SITE + '/api/' + path, {
        method: body ? 'POST' : 'GET', body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000),
        headers: { 'content-type': 'application/json', ...(PASS ? { 'x-passphrase': PASS } : {}) },
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `site answered ${r.status}`);
    return data;
}
async function ring(topic, title, message, link) {
    const r = await fetchFn('https://ntfy.sh/' + encodeURIComponent(topic), {
        method: 'POST', body: message, signal: AbortSignal.timeout(10000),
        headers: { Title: title.replace(/[^\x20-\x7e]/g, ''), Priority: 'urgent', Tags: 'rotating_light,movie_camera', ...(link ? { Click: link } : {}) },
    });
    return r.ok;
}

// ---------- District ----------
const guest = () => { let d = ''; for (let i = 0; i < 18; i++) d += Math.floor(Math.random() * 10); return `${Date.now()}_${d}_${Math.random().toString(36).slice(2, 13)}`; };
const contentId = url => ((url || '').match(/-MV(\d+)/) || [])[1] || '';
async function showsOn(movieUrl, date) {
    const id = contentId(movieUrl);
    const q = new URLSearchParams({ version: '3', site_id: '1', channel: 'mweb', child_site_id: '1', platform: 'district', movieCode: id, city_key: CITY.key, content_id: id, date, latitude: CITY.lat, longitude: CITY.lng, cinemaOrderLogic: '3' });
    const r = await fetchFn(`${BASE}/gw/consumer/movies/v5/movie?${q}`, { signal: AbortSignal.timeout(10000),
        headers: { accept: 'application/json, text/plain, */*', 'accept-language': 'en-IN,en;q=0.9', api_source: 'district', 'x-app-type': 'ed_mweb', 'x-guest-token': guest(), 'user-agent': UA, referer: movieUrl } });
    if (r.status === 204) return [];
    const data = await r.json().catch(() => null);
    if (r.status === 400 && data && data.code === 32) return [];
    if (r.status !== 200 || !data) throw new Error(`District answered ${r.status}`);
    const page = data.pageData || data.data || data;
    return [...(page.nearbyCinemas || []), ...(page.farCinemas || [])].map(c => ({
        id: 'CD' + String(c.id ?? c.cinemaInfo?.id ?? ''),
        keys: [c.cinemaId, c.cinemaInfo?.id, c.sessions?.[0]?.cid].filter(v => v != null).map(String),
        name: String(c.cinemaInfo?.name || c.name || ''),
        sessions: (c.sessions || []).map(s => ({
            time: istTime(s.showTime), audi: String(s.audi || ''), format: String(s.scrnFmt || ''),
            avail: Number.isFinite(+s.avail) ? +s.avail : null, prices: (s.areas || []).map(a => Math.round(+a.price || 0)).filter(p => p > 0),
        })).filter(s => s.time),
    }));
}
function istTime(raw) {
    if (!raw) return '';
    const d = new Date(/Z$|[+-]\d\d:?\d\d$/.test(raw) ? raw : raw + 'Z');
    return isNaN(d) ? '' : d.toLocaleTimeString('en-US', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: true }).toUpperCase();
}
async function datesOnSale(movieUrl) {
    const r = await fetchFn(movieUrl.split('?')[0], { headers: { 'user-agent': UA, accept: 'text/html' }, signal: AbortSignal.timeout(10000) });
    const html = await r.text();
    if (/just a moment|verify you are human|captcha/i.test(html.slice(0, 4000))) throw new Error('District showed a bot check');
    return [...new Set([...html.matchAll(/fromdate=(\d{4}-\d{2}-\d{2})/g)].map(m => m[1]))].sort().slice(0, 4);
}

// ---------- the same matching rules as the site ----------
function formatMatches(key, labels) {
    const t = ' ' + labels.join(' | ').toUpperCase() + ' ', has3d = /\b3D\b|-3D\b/.test(t);
    const rules = { any: true, '2d': !has3d, '3d': has3d, imax: /IMAX/.test(t), imax3d: /IMAX/.test(t) && has3d, '4dx3d': /4DX/.test(t) && has3d, ice3d: /\bICE\b/.test(t) && has3d,
        screenx: /SCREEN\s?X/.test(t), infinity: /INFINITY VISION/.test(t), infinity3d: /INFINITY VISION/.test(t) && has3d };
    return key in rules ? rules[key] : t.includes(String(key).toUpperCase());
}
const FILLER = new Set(['bengaluru', 'bangalore', 'the', 'cinema', 'cinemas', 'multiplex', 'and', 'in', 'at', 'of', 'main', 'road', 'rd', 'mall', 'city', 'centre', 'center']);
const words = n => [...new Set(String(n || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(w => w && !FILLER.has(w)))];
const key = id => String(id ?? '').replace(/^CD/i, '');
function sameCinema(a, b) {
    const ka = [a.id, ...(a.keys || [])].map(key).filter(Boolean), kb = [b.id, ...(b.keys || [])].map(key).filter(Boolean);
    if (ka.some(k => kb.includes(k))) return true;
    const wa = words(a.name), wb = words(b.name); if (!wa.length || !wb.length) return false;
    const [short, long] = wa.length <= wb.length ? [wa, wb] : [wb, wa], shared = short.filter(w => long.includes(w)).length;
    return shared >= Math.min(2, short.length) && shared / short.length >= 0.75;
}
function minutesOf(t) {
    const m = String(t || '').toUpperCase().replace(/\s+/g, '').match(/^(\d{1,2})(?::(\d{2}))?(AM|PM)?$/);
    if (!m) return null;
    let h = +m[1]; const min = +(m[2] || 0);
    if (m[3] === 'PM' && h < 12) h += 12;
    if (m[3] === 'AM' && h === 12) h = 0;
    return h * 60 + min;
}
const timeOk = (w, t) => { if (!w.time) return true; const a = minutesOf(w.time), b = minutesOf(t); return a === null || b === null || Math.abs(a - b) <= (w.timeWindow ?? 45); };
const rupees = n => '₹' + n.toLocaleString('en-IN');
const priceText = p => !p.length ? '' : Math.min(...p) === Math.max(...p) ? rupees(Math.min(...p)) : `${rupees(Math.min(...p))}–${rupees(Math.max(...p))}`;
const prettyDate = iso => new Date(iso + 'T12:00:00Z').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' });

// ---------- one check of every waiting watch ----------
async function checkAll(watches, topic, alerted) {
    let error = '';
    for (const w of watches) {
        if (alerted.has(w.id)) continue;
        try {
            const dates = w.dates?.length ? w.dates : await datesOnSale(w.movieUrl);
            const found = [];
            for (const date of dates) {
                for (const c of await showsOn(w.movieUrl, date)) {
                    if (w.theatres.length && !w.theatres.some(t => sameCinema(t, c))) continue;
                    const shows = c.sessions.filter(s => s.avail !== 0 && w.formats.some(f => formatMatches(f, [s.format, s.audi].filter(Boolean))) && timeOk(w, s.time));
                    if (shows.length) found.push({ date, cinema: c.name, cinemaId: c.id, shows: shows.slice(0, 6).map(s => ({ time: s.time, format: s.format, audi: s.audi, prices: priceText(s.prices) })) });
                }
            }
            if (!found.length) continue;
            const link = `${w.movieUrl}?fromdate=${found[0].date}`;
            const lines = found.slice(0, 4).map(m => `${m.cinema}, ${prettyDate(m.date)}: ${m.shows.slice(0, 4).map(s => s.time + (s.format ? ` (${s.format})` : '')).join(', ')}`);
            const message = [`Booking is open for ${w.movieTitle}.`, ...lines, found[0].shows[0].prices ? `Tickets ${found[0].shows[0].prices}` : '', w.seatsNote ? `Seats you wanted: ${w.seatsNote}` : '', `Book: ${link}`].filter(Boolean).join('\n');
            const rang = topic ? await ring(topic, `BOOKING OPEN: ${w.movieTitle}`.slice(0, 120), message, link).catch(() => false) : false;
            alerted.add(w.id);
            log(`BOOKING OPEN: ${w.movieTitle} (${rang ? 'phone rung' : 'ntfy failed'})`);
            await site(`watches/found?id=${encodeURIComponent(w.id)}`, { found: found.slice(0, 12), rang }).catch(e => log('Couldn’t tell the site:', e.message));
        } catch (e) { error = `${w.movieTitle}: ${e.message}`; log(error); }
    }
    return error;
}

// ---------- run: once a minute for RUN_MINUTES ----------
async function main() {
    if (!/^https:\/\/[a-z0-9.-]+$/i.test(SITE)) { console.error('Add your site address as the SITE_URL secret (e.g. https://your-site.netlify.app).'); process.exit(1); }
    let list;
    try { list = await site('checker?from=github&last=0&n=0'); }
    catch (e) { console.error('Couldn’t reach your site:', e.message); process.exit(1); }
    const watches = list.items || [], topic = list.topic || '', alerted = new Set();
    log(`${watches.length} watch${watches.length === 1 ? '' : 'es'} waiting${topic ? '' : ' (no ntfy topic set in Netlify)'}`);
    if (!watches.length) return;
    const started = Date.now();
    let checks = 0, lastError = '';
    for (let i = 0; i < RUN_MINUTES; i++) {
        const at = started + i * 60e3;
        if (Date.now() < at) await sleep(at - Date.now());
        lastError = await checkAll(watches, topic, alerted);
        checks++;
        if (alerted.size === watches.length) break;
    }
    // Tell the site the last check (shown in Settings), with any problem District gave
    await site(`checker?from=github&last=${Date.now()}&n=${checks}&error=${encodeURIComponent(lastError.slice(0, 160))}`).catch(() => {});
    log(`Done: ${checks} check${checks === 1 ? '' : 's'}`);
}
await main();

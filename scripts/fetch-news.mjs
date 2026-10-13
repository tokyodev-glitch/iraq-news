// يجمع عناوين الأخبار من مصادر RSS عراقية + زلازل USGS ويكتب public/news.json
// لا يحتاج أي مكتبات خارجية (Node 20 فقط).
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const MAX_AGE_H = 72;          // نحتفظ بالأخبار آخر 3 أيام
const MAX_ITEMS = 220;
const TIMEOUT_MS = 20000;
const UA = 'IraqEmergencyPortalNewsBot/1.0 (headline aggregator; links back to originals)';

export const SOURCES = [
  { id: 'ina',        name: 'وكالة الأنباء العراقية (واع)', lang: 'ar', url: 'https://ina.iq/rss.xml' },
  { id: 'shafaq-ar',  name: 'شفق نيوز',                      lang: 'ar', url: 'https://shafaq.com/ar?rss=1' },
  { id: 'alsumaria',  name: 'السومرية',                       lang: 'ar', url: 'https://www.alsumaria.tv/Rss/iraq-latest-news/ar' },
  { id: 'iraqinews',  name: 'Iraqi News',                    lang: 'en', url: 'https://www.iraqinews.com/feed/' },
  { id: 'shafaq-en',  name: 'Shafaq News',                   lang: 'en', url: 'https://shafaq.com/en?rss=1' },
];

// مربع حول العراق والجوار القريب
const QUAKE_URL = () => {
  const start = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 19);
  return 'https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&orderby=time&limit=25' +
    '&minmagnitude=3&minlatitude=28.5&maxlatitude=38&minlongitude=38&maxlongitude=49.5&starttime=' + start;
};

// ---------- تصنيف الطوارئ (حسب العنوان فقط) ----------
const norm = s => s.normalize('NFKD').replace(/[\u064B-\u065F\u0670\u0640]/g, '')
  .replace(/[إأآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').toLowerCase();

const RULES = [
  ['fire',     ['حريق', 'حرائق', 'نيران', 'الدفاع المدني', 'اخماد', 'اطفاء', 'احتراق'], /\b(fire|fires|blaze|wildfire|civil defen[cs]e|firefighters?)\b/i],
  ['accident', ['حادث', 'حوادث', 'اصطدام', 'تصادم', 'انقلاب', 'دهس', 'غرق', 'انهيار مبني', 'انهيار جدار', 'انهيار سقف', 'انهيار عمار', 'انهيار جسر'], /\b(accident|crash|collision|overturn(ed)?|drown(ed|ing)?|(building|wall|roof|bridge) collapse[sd]?|collapse of (a |the )?(building|wall|roof|bridge)|run over)\b/i],
  ['weather',  ['امطار', 'سيول', 'فيضان', 'عاصفه', 'عواصف', 'غبار', 'زلزال', 'هزه ارضيه', 'الانواء الجويه', 'موجه حر', 'صقيع', 'ثلوج', 'انذار جوي'], /\b(rain|rains|flood(s|ing)?|storm|dust|earthquake|quake|tremor|heat ?wave|frost|snow|weather warning)\b/i],
  ['health',   ['وباء', 'تسمم', 'كوليرا', 'تفشي', 'اسعاف', 'حمي نزفيه', 'الحمي'], /\b(outbreak|epidemic|poisoning|cholera|ambulance|hemorrhagic)\b/i],
  ['security', ['انفجار', 'عبوه', 'هجوم', 'قصف', 'اغتيال', 'اشتباك', 'ارهاب', 'داعش', 'طائره مسيره', 'صاروخ', 'اطلاق نار', 'جريمه', 'مقتل', 'اعتقال'], /\b(explosion|blast|bomb|attack(ed|s)?|shelling|assassinat\w*|clash(es)?|terror\w*|isis|drone|rocket|shooting|killed|arrest(ed|s)?|detain(ed|s)?)\b/i],
  ['traffic',  ['قطع طريق', 'غلق طريق', 'اغلاق طريق', 'ازدحام', 'المرور'], /\b(road closure|traffic|closed road)\b/i],
];
export function classify(title) {
  const n = norm(title);
  for (const [cat, ar, en] of RULES) {
    if (ar.some(w => n.includes(w)) || en.test(title)) return cat;
  }
  return null;
}

// ---------- RSS ----------
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decode = s => s
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') { const c = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(c) && c > 0 && c < 0x110000 ? String.fromCodePoint(c) : ''; }
    return ENT[e.toLowerCase()] ?? m;
  });
const clean = s => decode(decode(s)).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const tag = (b, n) => { const m = b.match(new RegExp('<' + n + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + n + '>', 'i')); return m ? m[1] : ''; };

function cleanLink(raw) {
  try {
    const u = new URL(decode(raw).trim());
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    for (const k of [...u.searchParams.keys()]) if (/^utm_|^src$/i.test(k)) u.searchParams.delete(k);
    return u.href;
  } catch { return null; }
}

export function parseFeed(xml) {
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) || [];
  const out = [];
  for (const b of blocks) {
    const title = clean(tag(b, 'title'));
    let link = tag(b, 'link').trim();
    if (!link) { const m = b.match(/<link[^>]*href=["']([^"']+)["']/i); link = m ? m[1] : ''; }
    link = cleanLink(link);
    const dateStr = clean(tag(b, 'pubDate') || tag(b, 'published') || tag(b, 'updated') || tag(b, 'dc:date'));
    const t = Date.parse(dateStr);
    if (!title || !link || !Number.isFinite(t)) continue;
    out.push({ title, link, published: new Date(t).toISOString() });
  }
  return out;
}

async function get(url) {
  let lastErr;
  for (let i = 0; i < 2; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': '*/*' }, signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'follow' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.text();
    } catch (e) { lastErr = e; await new Promise(r => setTimeout(r, 1500)); }
  }
  throw lastErr;
}
const idOf = link => createHash('sha1').update(link).digest('hex').slice(0, 12);

async function loadPrev() {
  const url = process.env.PREV_URL;
  if (!url) return null;
  try { return JSON.parse(await get(url)); } catch { return null; }
}

export async function build({ sources = SOURCES, fetchText = get, now = Date.now(), prev = null, quakeUrl = QUAKE_URL() } = {}) {
  const status = [];
  const fresh = [];
  await Promise.all(sources.map(async s => {
    try {
      const items = parseFeed(await fetchText(s.url));
      if (!items.length) throw new Error('no items');
      for (const it of items) fresh.push({ ...it, source: s.name, sid: s.id, lang: s.lang });
      status.push({ id: s.id, name: s.name, ok: true, count: items.length });
    } catch (e) {
      status.push({ id: s.id, name: s.name, ok: false, error: String(e.message || e).slice(0, 80) });
      console.log(`::warning::مصدر ${s.id} فشل: ${e.message}`);
    }
  }));

  const map = new Map();
  const add = it => {
    const t = Date.parse(it.published);
    if (!Number.isFinite(t) || t > now + 10 * 60e3 || now - t > MAX_AGE_H * 36e5) return;
    const key = norm(it.title).replace(/[^\p{L}\p{N}]+/gu, ' ').trim() + '|' + it.lang;
    const cur = map.get(key);
    if (cur && Date.parse(cur.published) >= t) return;
    map.set(key, { id: idOf(it.link), title: it.title, link: it.link, source: it.source, sid: it.sid, lang: it.lang, published: it.published, cat: classify(it.title) });
  };
  (prev?.items || []).forEach(add);   // نحافظ على الأخبار السابقة
  fresh.forEach(add);
  const items = [...map.values()].sort((a, b) => Date.parse(b.published) - Date.parse(a.published)).slice(0, MAX_ITEMS);

  let quakes = prev?.quakes || [];
  let quakeOk = false;
  try {
    const j = JSON.parse(await fetchText(quakeUrl));
    quakes = (j.features || []).map(f => ({
      id: f.id, mag: f.properties.mag, place: f.properties.place, time: new Date(f.properties.time).toISOString(),
      depthKm: f.geometry?.coordinates?.[2] ?? null, url: f.properties.url,
    })).filter(q => q.mag != null && q.url && /^https:\/\//.test(q.url));
    quakeOk = true;
  } catch (e) { console.log(`::warning::USGS فشل: ${e.message}`); }

  const okCount = status.filter(s => s.ok).length;
  return { schema: 1, generated: new Date(now).toISOString(), stale: okCount === 0, sources: status, items, quakes, quakeOk };
}

// تشغيل مباشر
if (import.meta.url === `file://${process.argv[1]}`) {
  const prev = await loadPrev();
  const data = await build({ prev });
  await mkdir('public', { recursive: true });
  await writeFile('public/news.json', JSON.stringify(data));
  console.log(`items=${data.items.length} emergency=${data.items.filter(i => i.cat).length} quakes=${data.quakes.length} ok=${data.sources.filter(s => s.ok).length}/${data.sources.length}`);
}

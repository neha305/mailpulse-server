// MailPulse v2 — Pixel Tracking Server

const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, "opens.json");

app.use(cors({ origin: "*", methods: ["GET", "POST", "OPTIONS"], allowedHeaders: ["Content-Type"] }));
app.options("*", cors());
app.use(express.json());

const PIXEL_GIF = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
  "base64"
);

function loadDB() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, "utf8")); }
  catch { return {}; }
}

function saveDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

// Known bots
const BOT_RE = /Googlebot|Bingbot|Slurp|DuckDuckBot|Baiduspider|YandexBot|Twitterbot|LinkedInBot|MailchimpBot|Postmark|SendGrid|Litmus|EmailOnAcid|curl|wget/i;

// Google's Gmail image proxy user agents (all known variants)
const GMAIL_PROXY_UA_RE = /GoogleImageProxy|ggpht\.com|Google Image Proxy/i;

// Google IP ranges used for Gmail image proxying
// Source: Google's published SPF records + observed ranges
function isGoogleIP(ip) {
  const googleRanges = [
    /^66\.249\./,   // 66.249.80.0/20
    /^72\.14\./,    // 72.14.192.0/18
    /^74\.125\./,   // 74.125.0.0/16
    /^64\.233\./,   // 64.233.160.0/19
    /^209\.85\./,   // 209.85.128.0/17
    /^108\.177\./,  // 108.177.0.0/17
    /^173\.194\./,  // 173.194.0.0/16
    /^216\.58\./,   // 216.58.192.0/19
    /^216\.239\./,  // 216.239.32.0/19
    /^142\.250\./,  // 142.250.0.0/15
    /^172\.217\./,  // 172.217.0.0/16
  ];
  return googleRanges.some(r => r.test(ip));
}

function isGmailProxy(ua, ip) {
  return GMAIL_PROXY_UA_RE.test(ua) || isGoogleIP(ip);
}

function isBot(ua) {
  return BOT_RE.test(ua);
}

// ─── Pixel endpoint ───────────────────────────────────────────────────────

app.get("/pixel/:id.gif", (req, res) => {
  res.set({
    "Content-Type": "image/gif",
    "Content-Length": PIXEL_GIF.length,
    "Cache-Control": "no-store, no-cache, must-revalidate, private",
    "Pragma": "no-cache",
    "Expires": "0",
  });
  res.status(200).end(PIXEL_GIF);

  const id = req.params.id;
  const ua = req.headers["user-agent"] || "";
  const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();

  console.log(`[HIT  ] ${id} | ${ip} | ${ua.slice(0, 100)}`);

  if (isBot(ua)) {
    console.log(`[BOT  ] ${id} — known bot UA`);
    return;
  }

  if (isGmailProxy(ua, ip)) {
    console.log(`[PROXY] ${id} — Gmail proxy (UA or IP match)`);
    return;
  }

  const db = loadDB();
  if (!db[id]) db[id] = { registeredAt: null, opens: [] };

  const now = Date.now();

  // Time-based filter: ignore opens within 30s of send (Google prefetch fallback)
  if (db[id].registeredAt && (now - db[id].registeredAt) < 30000) {
    console.log(`[EARLY] ${id} — ${Math.round((now - db[id].registeredAt)/1000)}s after send, likely prefetch`);
    return;
  }

  // Deduplicate within 30s from same IP
  const recent = db[id].opens.filter(o => o.ip === ip && now - o.timestamp < 30000);
  if (recent.length) return;

  const open = { timestamp: now, ip, userAgent: ua };
  db[id].opens.push(open);
  saveDB(db);
  console.log(`[OPEN ] ${id} | ${ip} | ${new Date(open.timestamp).toISOString()}`);
});

// ─── Register pixels at send time ────────────────────────────────────────

app.post("/api/register", (req, res) => {
  const { ids, sentAt } = req.body;
  if (!Array.isArray(ids)) return res.status(400).json({ error: "ids required" });
  const db = loadDB();
  const ts = sentAt || Date.now();
  for (const id of ids) {
    if (!db[id]) db[id] = { registeredAt: ts, opens: [] };
    else db[id].registeredAt = ts;
  }
  saveDB(db);
  console.log(`[REG  ] ${ids.length} pixels registered at ${new Date(ts).toISOString()}`);
  res.json({ ok: true });
});

// ─── Batch query ──────────────────────────────────────────────────────────

app.post("/api/opens", (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: "ids required" });
  const db = loadDB();
  const opens = {};
  for (const id of ids) {
    if (db[id]?.opens?.length) opens[id] = db[id].opens;
  }
  res.json({ opens });
});

// ─── Health ───────────────────────────────────────────────────────────────

app.get("/health", (_req, res) => res.json({ ok: true, timestamp: Date.now() }));

app.listen(PORT, () => {
  console.log(`\n✅  MailPulse tracking server v2`);
  console.log(`    http://localhost:${PORT}\n`);
});

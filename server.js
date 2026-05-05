// MailPulse v2 — Pixel Tracking Server
// Each recipient gets their own unique pixel URL → exact per-person open tracking

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

// ─── Transparent 1×1 GIF ─────────────────────────────────────────────────

const PIXEL_GIF = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
  "base64"
);

// ─── File-based store ─────────────────────────────────────────────────────
// Structure: { [recipientTrackingId]: { opens: [{ timestamp, ip, userAgent }] } }

function loadDB() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, "utf8")); }
  catch { return {}; }
}

function saveDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

// ─── Bot detection ────────────────────────────────────────────────────────

// Known bots and crawlers to ignore
const BOT_RE = /Googlebot|Bingbot|Slurp|DuckDuckBot|Baiduspider|YandexBot|Twitterbot|LinkedInBot|MailchimpBot|Postmark|SendGrid|Litmus|EmailOnAcid|curl|wget/i;

// Google's Gmail image proxy UAs
const GMAIL_PROXY_RE = /GoogleImageProxy|Google Image Proxy|ggpht\.com/i;

// Google IP ranges that proxy Gmail images (66.249.x.x, 72.14.x.x, 74.125.x.x, 209.85.x.x)
const GOOGLE_IP_RE = /^(66\.249\.|72\.14\.|74\.125\.|209\.85\.|64\.233\.|108\.177\.|142\.250\.|172\.217\.|173\.194\.|216\.58\.)/;

function isBot(userAgent = "") {
  return BOT_RE.test(userAgent);
}

function isGmailProxy(userAgent = "", ip = "") {
  return GMAIL_PROXY_RE.test(userAgent) || GOOGLE_IP_RE.test(ip);
}

// ─── Pixel endpoint ───────────────────────────────────────────────────────
// Each recipient has their own unique tracking ID → one URL per person

app.get("/pixel/:id.gif", (req, res) => {
  // Always return pixel immediately — never block the response
  res.set({
    "Content-Type": "image/gif",
    "Content-Length": PIXEL_GIF.length,
    "Cache-Control": "no-store, no-cache, must-revalidate, private",
    "Pragma": "no-cache",
    "Expires": "0",
  });
  res.status(200).end(PIXEL_GIF);

  // Record asynchronously after responding
  const id = req.params.id;
  const ua = req.headers["user-agent"] || "";
  const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();

  console.log("[HIT  ]", id, "|", ip, "|", ua.slice(0, 100));

  if (isBot(ua)) {
    console.log(`[BOT  ] ${id} | ${ip} | ${ua.slice(0, 80)}`);
    return;
  }

  if (isGmailProxy(ua, ip)) {
    console.log(`[PROXY] ${id} | ${ip} | Gmail image proxy — not a real open`);
    return;
  }

  const db = loadDB();
  if (!db[id]) db[id] = { registeredAt: null, opens: [] };

  const now = Date.now();

  // Deduplicate: ignore opens within 10 seconds from the same IP
  const recent = db[id].opens.filter((o) => o.ip === ip && now - o.timestamp < 10000);
  if (recent.length) return;

  const open = { timestamp: now, ip, userAgent: ua };
  db[id].opens.push(open);
  saveDB(db);

  console.log(`[OPEN ] ${id} | ${ip} | ${new Date(open.timestamp).toISOString()}`);
});

// ─── Register pixels at send time ────────────────────────────────────────
// POST /api/register  { ids: ["mpXXX", ...], sentAt: 1234567890 }
// Call this immediately after sending so we know when to start trusting loads

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

// ─── Batch query — extension polls this to sync all opens ─────────────────
// POST /api/opens  { ids: ["mpXXX", "mpYYY", ...] }
// Returns: { opens: { [id]: [openEvent, ...] } }

app.post("/api/opens", (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || !ids.length) {
    return res.status(400).json({ error: "ids must be a non-empty array" });
  }

  const db = loadDB();
  const opens = {};
  for (const id of ids) {
    if (db[id]?.opens?.length) opens[id] = db[id].opens;
  }
  res.json({ opens });
});

// ─── Single ID query ─────────────────────────────────────────────────────

app.get("/api/opens/:id", (req, res) => {
  const db = loadDB();
  const record = db[req.params.id];
  res.json({
    id: req.params.id,
    opens: record?.opens || [],
    count: record?.opens?.length || 0,
  });
});

// ─── Stats ────────────────────────────────────────────────────────────────

app.get("/api/stats", (_req, res) => {
  const db = loadDB();
  const ids = Object.keys(db);
  const totalOpens = ids.reduce((s, id) => s + (db[id].opens?.length || 0), 0);
  res.json({ totalTrackedRecipients: ids.length, totalOpens });
});

// ─── Health ───────────────────────────────────────────────────────────────

app.get("/health", (_req, res) => res.json({ ok: true, timestamp: Date.now() }));

// ─── Start ────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n✅  MailPulse tracking server v2`);
  console.log(`    http://localhost:${PORT}`);
  console.log(`    Pixel: GET /pixel/:recipientTrackingId.gif`);
  console.log(`    Sync:  POST /api/opens  { ids: [...] }\n`);
});

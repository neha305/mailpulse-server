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

const BOT_RE = /Googlebot|Bingbot|Slurp|DuckDuckBot|Baiduspider|YandexBot|Twitterbot|LinkedInBot|MailchimpBot|Postmark|SendGrid|Litmus|EmailOnAcid|curl|wget/i;

function isBot(userAgent = "") {
  return BOT_RE.test(userAgent);
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

  const db = loadDB();
  if (!db[id]) db[id] = { opens: [] };

  // Deduplicate: ignore opens within 5 seconds from the same IP (double-load prevention)
  const recent = db[id].opens.filter((o) => o.ip === ip && Date.now() - o.timestamp < 5000);
  if (recent.length) return;

  const open = { timestamp: Date.now(), ip, userAgent: ua };
  db[id].opens.push(open);
  saveDB(db);

  console.log(`[OPEN ] ${id} | ${ip} | ${new Date(open.timestamp).toISOString()}`);
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

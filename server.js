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

// 1x1 transparent GIF
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

const BOT_RE = /Googlebot|Bingbot|Slurp|DuckDuckBot|Baiduspider|YandexBot|Twitterbot|LinkedInBot|MailchimpBot|Postmark|SendGrid|Litmus|EmailOnAcid|curl|wget/i;

function isBot(ua) { return BOT_RE.test(ua); }

// ─── GIF pixel — served to satisfy <img> tag, Google proxy loads this ────
// We log it but do NOT record it as a real open.

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
  console.log(`[GIF  ] ${id} | ${ip} | ${ua.slice(0, 80)}`);
});

// ─── Real open endpoint — called by JS in the email ──────────────────────
// Google's proxy does NOT execute JavaScript, so only real human opens
// in a browser (Gmail web, Outlook web, etc.) will hit this endpoint.

app.get("/open/:id", (req, res) => {
  res.set({
    "Content-Type": "text/plain",
    "Cache-Control": "no-store, no-cache, must-revalidate, private",
  });
  res.status(200).end("ok");

  const id = req.params.id;
  const ua = req.headers["user-agent"] || "";
  const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();

  console.log(`[HIT  ] ${id} | ${ip} | ${ua.slice(0, 100)}`);

  if (isBot(ua)) {
    console.log(`[BOT  ] ${id} | ${ip}`);
    return;
  }

  const db = loadDB();
  if (!db[id]) db[id] = { opens: [] };

  const now = Date.now();
  // Deduplicate within 30 seconds from same IP
  const recent = db[id].opens.filter((o) => o.ip === ip && now - o.timestamp < 30000);
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
  console.log(`[REG  ] ${ids.length} pixels registered`);
  res.json({ ok: true });
});

// ─── Batch query — extension polls this to sync opens ────────────────────

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

// ─── Health ───────────────────────────────────────────────────────────────

app.get("/health", (_req, res) => res.json({ ok: true, timestamp: Date.now() }));

// ─── Start ────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n✅  MailPulse tracking server v2`);
  console.log(`    http://localhost:${PORT}`);
  console.log(`    Pixel: GET /pixel/:id.gif  (Google proxy, ignored)`);
  console.log(`    Open:  GET /open/:id       (JS beacon, real opens only)\n`);
});

import express from "express";
import cors from "cors";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import pg from "pg";
import https from "https";
import http from "http";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.SESSION_SECRET || "change-me-in-production";
const SELF_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const ADMIN_TELEGRAM_ID = parseInt(process.env.TELEGRAM_ADMIN_ID || "0", 10);
const DATABASE_URL = process.env.DATABASE_URL || "";

console.log("🔧 DATABASE_URL set:", !!DATABASE_URL);
console.log("🔧 TELEGRAM_ADMIN_ID:", ADMIN_TELEGRAM_ID);

/* ── DB pool — start listening immediately, init tables async ── */
const pool = new pg.Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes("localhost") ? false : { rejectUnauthorized: false },
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000,
  max: 5,
});

pool.on("error", (err) => console.error("pg pool error:", err.message));

let dbReady = false;
let dbError = null;

async function initDb() {
  console.log("🔄 initDb: connecting...");
  const client = await pool.connect();
  try {
    console.log("🔄 initDb: connected, creating tables...");
    await client.query(`CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS site_config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS allowed_numbers (
      phone TEXT PRIMARY KEY,
      added_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    dbReady = true;
    console.log("✅ DB ready — all tables OK");
  } finally {
    client.release();
  }
}

/* Start server immediately so Render can bind to PORT */
app.listen(PORT, () => {
  console.log(`🚀 Server on port ${PORT}`);
  /* Init DB after binding */
  initDb()
    .then(() => startBot())
    .catch(err => {
      dbError = String(err);
      console.error("❌ DB init error:", dbError);
    });
});

/* ── Keep-alive ── */
setInterval(() => {
  const mod = SELF_URL.startsWith("https") ? https : http;
  mod.get(SELF_URL + "/api/ping", res => console.log(`🔔 ping → ${res.statusCode}`))
     .on("error", err => console.error("ping error:", err.message));
}, 14 * 60 * 1000);

/* ── Middleware ── */
app.use(cors());
app.use(express.json());

/* ────────────────────────────────────────────
   TELEGRAM BOT
──────────────────────────────────────────── */
function isAdmin(userId) {
  return ADMIN_TELEGRAM_ID > 0 && userId === ADMIN_TELEGRAM_ID;
}

async function startBot() {
  if (!BOT_TOKEN) { console.warn("⚠️ TELEGRAM_BOT_TOKEN not set"); return; }
  try {
    const { default: TelegramBot } = await import("node-telegram-bot-api");
    const bot = new TelegramBot(BOT_TOKEN, { polling: true });
    console.log("🤖 Telegram bot started. Admin:", ADMIN_TELEGRAM_ID);

    bot.onText(/\/start/, async (msg) => {
      if (!isAdmin(msg.from.id)) return bot.sendMessage(msg.chat.id, "⛔ أنت لست مدير هذا التطبيق.");
      bot.sendMessage(msg.chat.id,
        `👋 *مرحباً في لوحة التحكم!*\n\nالأوامر:\n\n` +
        `✏️ \`/setdesc [الوصف]\` — تغيير وصف صفحة الدخول\n` +
        `📝 \`/getdesc\` — عرض الوصف الحالي\n` +
        `➕ \`/addnumber [الرقم]\` — إضافة رقم مسموح\n` +
        `➖ \`/removenumber [الرقم]\` — حذف رقم\n` +
        `📋 \`/listnumbers\` — عرض جميع الأرقام`,
        { parse_mode: "Markdown" }
      );
    });

    bot.onText(/\/setdesc (.+)/, async (msg, match) => {
      if (!isAdmin(msg.from.id)) return bot.sendMessage(msg.chat.id, "⛔ غير مصرح لك.");
      const desc = match[1].trim();
      try {
        await pool.query(
          `INSERT INTO site_config(key,value,updated_at) VALUES('description',$1,NOW())
           ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW()`, [desc]
        );
        bot.sendMessage(msg.chat.id, `✅ *تم تحديث الوصف!*\n\n_"${desc}"_`, { parse_mode: "Markdown" });
      } catch (e) { bot.sendMessage(msg.chat.id, `❌ ${e.message}`); }
    });

    bot.onText(/\/getdesc/, async (msg) => {
      if (!isAdmin(msg.from.id)) return bot.sendMessage(msg.chat.id, "⛔ غير مصرح لك.");
      try {
        const { rows } = await pool.query("SELECT value FROM site_config WHERE key='description' LIMIT 1");
        bot.sendMessage(msg.chat.id,
          rows[0] ? `📋 *الوصف الحالي:*\n\n_${rows[0].value}_` : "لم يُضبط وصف بعد.",
          { parse_mode: "Markdown" }
        );
      } catch (e) { bot.sendMessage(msg.chat.id, `❌ ${e.message}`); }
    });

    bot.onText(/\/addnumber (.+)/, async (msg, match) => {
      if (!isAdmin(msg.from.id)) return bot.sendMessage(msg.chat.id, "⛔ غير مصرح لك.");
      const phone = match[1].trim().replace(/\s+/g, "");
      if (!/^\+?[0-9]{7,15}$/.test(phone))
        return bot.sendMessage(msg.chat.id, "⚠️ الصيغة غير صحيحة. مثال:\n`/addnumber +967777000000`", { parse_mode: "Markdown" });
      try {
        await pool.query("INSERT INTO allowed_numbers(phone) VALUES($1) ON CONFLICT(phone) DO NOTHING", [phone]);
        bot.sendMessage(msg.chat.id, `✅ تمت إضافة: \`${phone}\``, { parse_mode: "Markdown" });
      } catch (e) { bot.sendMessage(msg.chat.id, `❌ ${e.message}`); }
    });

    bot.onText(/\/removenumber (.+)/, async (msg, match) => {
      if (!isAdmin(msg.from.id)) return bot.sendMessage(msg.chat.id, "⛔ غير مصرح لك.");
      const phone = match[1].trim().replace(/\s+/g, "");
      try {
        const { rowCount } = await pool.query("DELETE FROM allowed_numbers WHERE phone=$1", [phone]);
        bot.sendMessage(msg.chat.id,
          rowCount > 0 ? `✅ تم حذف: \`${phone}\`` : `⚠️ \`${phone}\` غير موجود.`,
          { parse_mode: "Markdown" }
        );
      } catch (e) { bot.sendMessage(msg.chat.id, `❌ ${e.message}`); }
    });

    bot.onText(/\/listnumbers/, async (msg) => {
      if (!isAdmin(msg.from.id)) return bot.sendMessage(msg.chat.id, "⛔ غير مصرح لك.");
      try {
        const { rows } = await pool.query("SELECT phone FROM allowed_numbers ORDER BY added_at DESC");
        if (!rows.length) return bot.sendMessage(msg.chat.id, "📋 لا توجد أرقام بعد.");
        const list = rows.map((r, i) => `${i + 1}. \`${r.phone}\``).join("\n");
        bot.sendMessage(msg.chat.id, `📋 *الأرقام (${rows.length}):*\n\n${list}`, { parse_mode: "Markdown" });
      } catch (e) { bot.sendMessage(msg.chat.id, `❌ ${e.message}`); }
    });

    bot.on("polling_error", (err) => console.error("Telegram polling:", err.message));
  } catch (err) {
    console.error("❌ Bot start failed:", err.message);
  }
}

/* ── API routes ── */
app.get("/api/ping", (_req, res) => res.json({ ok: true, dbReady, dbError }));

/* GET /api/config/description */
app.get("/api/config/description", async (_req, res) => {
  try {
    const { rows } = await pool.query("SELECT value FROM site_config WHERE key='description' LIMIT 1");
    return res.json({ description: rows[0]?.value ?? "" });
  } catch (e) {
    console.error("config/description:", e.message, e.code);
    return res.status(500).json({ error: "خطأ في الخادم", detail: e.message, code: e.code });
  }
});

/* POST /api/numbers/check */
app.post("/api/numbers/check", async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ allowed: false, error: "الرقم مطلوب" });
  try {
    const { rows } = await pool.query("SELECT phone FROM allowed_numbers WHERE phone=$1 LIMIT 1", [phone.trim()]);
    return res.json({ allowed: rows.length > 0 });
  } catch (e) {
    console.error("numbers/check:", e.message, e.code);
    return res.status(500).json({ allowed: false, error: "خطأ في الخادم", detail: e.message, code: e.code });
  }
});

/* Auth */
app.post("/api/auth/register", async (req, res) => {
  const { username, password, remember } = req.body;
  if (!username || !password) return res.status(400).json({ error: "اسم المستخدم وكلمة المرور مطلوبان" });
  if (!/^[a-zA-Z][a-zA-Z0-9_]{3,19}$/.test(username)) return res.status(400).json({ error: "اسم المستخدم يجب أن يكون بين 4–20 حرف إنجليزي" });
  if (password.length < 6) return res.status(400).json({ error: "كلمة المرور يجب أن تكون 6 أحرف على الأقل" });
  try {
    const { rows: ex } = await pool.query("SELECT id FROM users WHERE username=$1 LIMIT 1", [username.toLowerCase()]);
    if (ex.length > 0) return res.status(409).json({ error: "اسم المستخدم مستخدم بالفعل" });
    const hash = await bcrypt.hash(password, 12);
    const { rows } = await pool.query("INSERT INTO users(username,password_hash) VALUES($1,$2) RETURNING id,username", [username.toLowerCase(), hash]);
    const token = jwt.sign({ id: rows[0].id, username: rows[0].username, display: username }, JWT_SECRET, { expiresIn: remember ? "30d" : "1d" });
    return res.status(201).json({ token, username: rows[0].username, display: username });
  } catch (err) { console.error("register:", err.message); return res.status(500).json({ error: "خطأ في الخادم", detail: err.message }); }
});

app.post("/api/auth/login", async (req, res) => {
  const { username, password, remember } = req.body;
  if (!username || !password) return res.status(400).json({ error: "اسم المستخدم وكلمة المرور مطلوبان" });
  try {
    const { rows } = await pool.query("SELECT * FROM users WHERE username=$1 LIMIT 1", [username.toLowerCase()]);
    if (!rows.length) return res.status(401).json({ error: "اسم المستخدم غير موجود" });
    const valid = await bcrypt.compare(password, rows[0].password_hash);
    if (!valid) return res.status(401).json({ error: "كلمة المرور غير صحيحة" });
    const token = jwt.sign({ id: rows[0].id, username: rows[0].username, display: username }, JWT_SECRET, { expiresIn: remember ? "30d" : "1d" });
    return res.json({ token, username: rows[0].username, display: username });
  } catch (err) { console.error("login:", err.message); return res.status(500).json({ error: "خطأ في الخادم", detail: err.message }); }
});

/* ── Static ── */
app.use(express.static(join(__dirname, "../public"), { index: false }));
app.get("/login.html", (_req, res) => res.sendFile(join(__dirname, "../public/login.html")));
app.get("/app.html",   (_req, res) => res.sendFile(join(__dirname, "../public/app.html")));
app.get("/",           (_req, res) => res.sendFile(join(__dirname, "../public/index.html")));
app.get("*",           (_req, res) => res.sendFile(join(__dirname, "../public/index.html")));

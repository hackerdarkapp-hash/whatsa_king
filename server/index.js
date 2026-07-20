import express from "express";
import cors from "cors";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import https from "https";
import http from "http";
import fs from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR   = join(__dirname, "../data");
const app  = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET    = process.env.SESSION_SECRET || "whatsa-king-secret-2026";
const SELF_URL      = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
const BOT_TOKEN     = process.env.TELEGRAM_BOT_TOKEN || "";
const ADMIN_TG_ID   = parseInt(process.env.TELEGRAM_ADMIN_ID || "0", 10);
const GH_TOKEN      = process.env.GITHUB_TOKEN || "";
const GH_REPO       = process.env.GITHUB_REPO  || "hackerdarkapp-hash/whatsa_king";

/* ═══════════════════════════════════════════
   IN-MEMORY STORE  (seeded from local files as fallback)
═══════════════════════════════════════════ */
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(join(DATA_DIR, file), "utf8")); }
  catch { return fallback; }
}

let store = {
  config:   readJson("config.json",           { description: "" }),
  numbers:  readJson("allowed_numbers.json",  []),
  users:    readJson("users.json",            []),
};

console.log(`📂 Loaded from disk: ${store.users.length} users, ${store.numbers.length} numbers`);

/* ═══════════════════════════════════════════
   GITHUB FILE UPDATE (persists across deploys)
   Uses Node built-in https (works on all Node versions)
═══════════════════════════════════════════ */
function ghRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: "api.github.com",
      path,
      method,
      headers: {
        Authorization: `Bearer ${GH_TOKEN}`,
        "User-Agent": "whatsa-bot",
        Accept: "application/vnd.github+json",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
    };
    const req = https.request(opts, (res) => {
      const chunks = [];
      res.on("data", d => chunks.push(d));
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }); }
        catch { resolve({ status: res.statusCode, body: {} }); }
      });
    });
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function ghUpdate(filename, content) {
  if (!GH_TOKEN) { console.warn("⚠️ GITHUB_TOKEN not set — changes in memory only"); return; }
  const apiPath = `/repos/${GH_REPO}/contents/data/${filename}`;
  const b64 = Buffer.from(JSON.stringify(content, null, 2)).toString("base64");

  /* get current SHA */
  let sha;
  try {
    const r = await ghRequest("GET", apiPath);
    sha = r.body.sha;
  } catch {}

  const r2 = await ghRequest("PUT", apiPath, {
    message: `bot: update ${filename}`,
    content: b64,
    ...(sha ? { sha } : {}),
  });

  if (r2.status >= 200 && r2.status < 300) {
    console.log(`✅ GitHub updated: data/${filename}`);
  } else {
    console.error(`❌ ghUpdate ${filename} failed (${r2.status}):`, JSON.stringify(r2.body).slice(0, 200));
  }
}

/* ═══════════════════════════════════════════
   GITHUB READ — جلب ملف من GitHub وفك تشفيره
═══════════════════════════════════════════ */
async function ghRead(filename) {
  if (!GH_TOKEN) return null;
  try {
    const r = await ghRequest("GET", `/repos/${GH_REPO}/contents/data/${filename}`);
    if (r.body && r.body.content) {
      return JSON.parse(Buffer.from(r.body.content, "base64").toString("utf8"));
    }
  } catch (e) {
    console.error(`ghRead ${filename}:`, e.message);
  }
  return null;
}

/* ═══════════════════════════════════════════
   REFRESH STORE — يُحدِّث الأرقام من GitHub
   يُستدعى عند البدء وكل 3 دقائق
═══════════════════════════════════════════ */
async function refreshStore() {
  const [numbers, users, config] = await Promise.all([
    ghRead("allowed_numbers.json"),
    ghRead("users.json"),
    ghRead("config.json"),
  ]);
  if (numbers !== null) { store.numbers = numbers; }
  if (users   !== null) { store.users   = users; }
  if (config  !== null) { store.config  = config; }
  console.log(`🔄 Store refreshed — ${store.numbers.length} numbers, ${store.users.length} users`);
}

/* ═══════════════════════════════════════════
   KEEP-ALIVE
═══════════════════════════════════════════ */
setInterval(() => {
  const mod = SELF_URL.startsWith("https") ? https : http;
  mod.get(SELF_URL + "/api/ping", r => console.log(`🔔 ping → ${r.statusCode}`))
     .on("error", e => console.error("ping:", e.message));
}, 14 * 60 * 1000);

/* تحديث الأرقام من GitHub كل 3 دقائق */
setInterval(refreshStore, 3 * 60 * 1000);

/* ═══════════════════════════════════════════
   MIDDLEWARE
═══════════════════════════════════════════ */
app.use(cors());
app.use(express.json());

/* ═══════════════════════════════════════════
   TELEGRAM BOT
═══════════════════════════════════════════ */
async function startBot() {
  if (!BOT_TOKEN) { console.warn("⚠️ TELEGRAM_BOT_TOKEN not set"); return; }
  try {
    const { default: TelegramBot } = await import("node-telegram-bot-api");
    const bot = new TelegramBot(BOT_TOKEN, { polling: true });
    console.log("🤖 Bot started — Admin:", ADMIN_TG_ID);

    const isAdmin = id => ADMIN_TG_ID > 0 && id === ADMIN_TG_ID;
    const menu = () => `\n\nالأوامر:\n✏️ /setdesc [النص]\n📝 /getdesc\n➕ /addnumber [+رقم]\n➖ /removenumber [+رقم]\n📋 /listnumbers`;

    bot.onText(/\/start/, msg => {
      if (!isAdmin(msg.from.id)) return bot.sendMessage(msg.chat.id, "⛔ غير مصرح.");
      bot.sendMessage(msg.chat.id, `👋 *مرحباً في لوحة التحكم!*${menu()}`, { parse_mode: "Markdown" });
    });

    bot.onText(/\/getdesc/, msg => {
      if (!isAdmin(msg.from.id)) return bot.sendMessage(msg.chat.id, "⛔ غير مصرح.");
      const d = store.config.description;
      bot.sendMessage(msg.chat.id, d ? `📋 *الوصف الحالي:*\n\n_${d}_` : "لم يُضبط وصف بعد.", { parse_mode: "Markdown" });
    });

    bot.onText(/\/setdesc (.+)/, async (msg, match) => {
      if (!isAdmin(msg.from.id)) return bot.sendMessage(msg.chat.id, "⛔ غير مصرح.");
      const desc = match[1].trim();
      store.config.description = desc;
      bot.sendMessage(msg.chat.id, `⏳ جارٍ الحفظ...`);
      await ghUpdate("config.json", store.config);
      bot.sendMessage(msg.chat.id, `✅ *تم تحديث الوصف!*\n\n_"${desc}"_`, { parse_mode: "Markdown" });
    });

    bot.onText(/\/addnumber (.+)/, async (msg, match) => {
      if (!isAdmin(msg.from.id)) return bot.sendMessage(msg.chat.id, "⛔ غير مصرح.");
      const phone = match[1].trim().replace(/\s+/g, "");
      if (!/^\+?[0-9]{7,15}$/.test(phone))
        return bot.sendMessage(msg.chat.id, "⚠️ صيغة خاطئة. مثال:\n`/addnumber +967777000000`", { parse_mode: "Markdown" });
      if (store.numbers.includes(phone))
        return bot.sendMessage(msg.chat.id, `⚠️ الرقم \`${phone}\` موجود بالفعل.`, { parse_mode: "Markdown" });
      store.numbers.push(phone);
      bot.sendMessage(msg.chat.id, `⏳ جارٍ الحفظ...`);
      await ghUpdate("allowed_numbers.json", store.numbers);
      bot.sendMessage(msg.chat.id, `✅ تمت إضافة: \`${phone}\``, { parse_mode: "Markdown" });
    });

    bot.onText(/\/removenumber (.+)/, async (msg, match) => {
      if (!isAdmin(msg.from.id)) return bot.sendMessage(msg.chat.id, "⛔ غير مصرح.");
      const phone = match[1].trim().replace(/\s+/g, "");
      const before = store.numbers.length;
      store.numbers = store.numbers.filter(n => n !== phone);
      if (store.numbers.length === before)
        return bot.sendMessage(msg.chat.id, `⚠️ الرقم \`${phone}\` غير موجود.`, { parse_mode: "Markdown" });
      bot.sendMessage(msg.chat.id, `⏳ جارٍ الحفظ...`);
      await ghUpdate("allowed_numbers.json", store.numbers);
      bot.sendMessage(msg.chat.id, `✅ تم حذف: \`${phone}\``, { parse_mode: "Markdown" });
    });

    bot.onText(/\/listnumbers/, msg => {
      if (!isAdmin(msg.from.id)) return bot.sendMessage(msg.chat.id, "⛔ غير مصرح.");
      if (!store.numbers.length) return bot.sendMessage(msg.chat.id, "📋 لا توجد أرقام بعد.");
      const list = store.numbers.map((n, i) => `${i + 1}. \`${n}\``).join("\n");
      bot.sendMessage(msg.chat.id, `📋 *الأرقام المسموح بها (${store.numbers.length}):*\n\n${list}`, { parse_mode: "Markdown" });
    });

    bot.on("polling_error", e => console.error("Telegram polling:", e.message));
  } catch (e) {
    console.error("❌ Bot start failed:", e.message);
  }
}

/* ═══════════════════════════════════════════
   API ROUTES
═══════════════════════════════════════════ */
app.get("/api/ping", (_req, res) => res.json({ ok: true }));

/* GET /api/config/description */
app.get("/api/config/description", (_req, res) => {
  res.json({ description: store.config.description ?? "" });
});

/* POST /api/numbers/check
   مقارنة ذكية: تُجرِّد + والمسافات ثم تختبر التطابق الكامل أو النهاية (suffix)
   مثال: "+967777114833" يطابق "777114833" أو "967777114833" */
app.post("/api/numbers/check", (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ allowed: false, error: "الرقم مطلوب" });
  const norm = s => String(s).trim().replace(/^\+/, "").replace(/[\s\-().]/g, "");
  const input = norm(phone);
  if (!input) return res.status(400).json({ allowed: false, error: "الرقم مطلوب" });
  const allowed = store.numbers.some(n => {
    const stored = norm(n);
    return stored === input ||          // تطابق تام
           stored.endsWith(input) ||    // المخزّن أطول ونهايته = المُدخَل  (+967777… ↔ 777…)
           input.endsWith(stored);      // المُدخَل أطول ونهايته = المخزّن
  });
  console.log(`📱 check "${phone}" → norm="${input}" → allowed=${allowed}`);
  res.json({ allowed });
});

/* POST /api/auth/register */
app.post("/api/auth/register", async (req, res) => {
  const { username, password, remember } = req.body;
  if (!username || !password)
    return res.status(400).json({ error: "اسم المستخدم وكلمة المرور مطلوبان" });
  if (!/^[a-zA-Z][a-zA-Z0-9_]{3,19}$/.test(username))
    return res.status(400).json({ error: "اسم المستخدم يجب أن يكون بين 4–20 حرف إنجليزي" });
  if (password.length < 6)
    return res.status(400).json({ error: "كلمة المرور يجب أن تكون 6 أحرف على الأقل" });

  const lower = username.toLowerCase();
  if (store.users.find(u => u.username === lower))
    return res.status(409).json({ error: "اسم المستخدم مستخدم بالفعل" });

  try {
    const passwordHash = await bcrypt.hash(password, 12);
    const user = { id: crypto.randomUUID(), username: lower, passwordHash, createdAt: new Date().toISOString() };
    store.users.push(user);
    /* save to GitHub async — don't block response */
    ghUpdate("users.json", store.users.map(u => ({ id: u.id, username: u.username, passwordHash: u.passwordHash, createdAt: u.createdAt })));
    const token = jwt.sign({ id: user.id, username: lower, display: username }, JWT_SECRET, { expiresIn: remember ? "30d" : "1d" });
    return res.status(201).json({ token, username: lower, display: username });
  } catch (e) {
    console.error("register:", e.message);
    return res.status(500).json({ error: "خطأ في الخادم" });
  }
});

/* POST /api/auth/login */
app.post("/api/auth/login", async (req, res) => {
  const { username, password, remember } = req.body;
  if (!username || !password)
    return res.status(400).json({ error: "اسم المستخدم وكلمة المرور مطلوبان" });

  const user = store.users.find(u => u.username === username.toLowerCase());
  if (!user) return res.status(401).json({ error: "اسم المستخدم غير موجود" });

  try {
    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) return res.status(401).json({ error: "كلمة المرور غير صحيحة" });
    const token = jwt.sign({ id: user.id, username: user.username, display: username }, JWT_SECRET, { expiresIn: remember ? "30d" : "1d" });
    return res.json({ token, username: user.username, display: username });
  } catch (e) {
    console.error("login:", e.message);
    return res.status(500).json({ error: "خطأ في الخادم" });
  }
});

/* ── Static ── */
app.use(express.static(join(__dirname, "../public"), { index: false }));
app.get("/login.html", (_req, res) => res.sendFile(join(__dirname, "../public/login.html")));
app.get("/app.html",   (_req, res) => res.sendFile(join(__dirname, "../public/app.html")));
app.get("/",           (_req, res) => res.sendFile(join(__dirname, "../public/index.html")));
app.get("*",           (_req, res) => res.sendFile(join(__dirname, "../public/index.html")));

/* ── Start ── جلب أحدث البيانات من GitHub قبل قبول الطلبات */
refreshStore().catch(e => console.error("initial refreshStore:", e.message)).finally(() => {
  app.listen(PORT, () => {
    console.log(`🚀 Server on port ${PORT}`);
    startBot();
  });
});

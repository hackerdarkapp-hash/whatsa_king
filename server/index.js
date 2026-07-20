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
setInterval(refreshStore, 60 * 1000); /* كل دقيقة للتحديث السريع */

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

    /* ── لوحة المفاتيح الدائمة للأدمن ── */
    const adminKeyboard = {
      reply_markup: {
        keyboard: [
          [{ text: "➕ إضافة رقم" }, { text: "🗑️ حذف رقم" }],
          [{ text: "📋 قائمة الأرقام" }, { text: "📊 إحصائيات" }],
        ],
        resize_keyboard: true,
      },
      parse_mode: "Markdown",
    };

    /* ── حالة المحادثة لكل مستخدم { step, dialCode } ── */
    const conv = {};
    const clearConv = id => { delete conv[id]; };

    /* ── /start ── */
    bot.onText(/\/start/, msg => {
      if (!isAdmin(msg.from.id)) return bot.sendMessage(msg.chat.id, "⛔ غير مصرح.");
      clearConv(msg.from.id);
      bot.sendMessage(msg.chat.id,
        `👋 *مرحباً في لوحة التحكم!*\n\nاختر من الأزرار أدناه أو استخدم الأوامر:\n` +
        `✏️ /setdesc [النص]\n📝 /getdesc`,
        adminKeyboard);
    });

    /* ── /getdesc ── */
    bot.onText(/\/getdesc/, msg => {
      if (!isAdmin(msg.from.id)) return bot.sendMessage(msg.chat.id, "⛔ غير مصرح.");
      const d = store.config.description;
      bot.sendMessage(msg.chat.id, d ? `📋 *الوصف الحالي:*\n\n_${d}_` : "لم يُضبط وصف بعد.", { parse_mode: "Markdown" });
    });

    /* ── /setdesc ── */
    bot.onText(/\/setdesc (.+)/, async (msg, match) => {
      if (!isAdmin(msg.from.id)) return bot.sendMessage(msg.chat.id, "⛔ غير مصرح.");
      const desc = match[1].trim();
      store.config.description = desc;
      await ghUpdate("config.json", store.config);
      bot.sendMessage(msg.chat.id, `✅ *تم تحديث الوصف!*\n\n_"${desc}"_`, { parse_mode: "Markdown" });
    });

    /* ══════════════════════════════════════════════
       معالج الرسائل العادية — يُدير المحادثة التفاعلية
    ══════════════════════════════════════════════ */
    bot.on("message", async msg => {
      if (!isAdmin(msg.from.id)) return;
      if (!msg.text) return;

      const cid  = msg.chat.id;
      const uid  = msg.from.id;
      const text = msg.text.trim();

      /* ── زر "إضافة رقم" أو /addnumber بدون معامل ── */
      if (text === "➕ إضافة رقم" || text === "/addnumber") {
        conv[uid] = { step: "awaiting_dialcode" };
        return bot.sendMessage(cid,
          "📲 *إضافة اشتراك جديد*\n\nالخطوة 1️⃣: أرسل *رمز الدولة* (مثال: `+967` أو `967`)\n\nأرسل /cancel للإلغاء.",
          { parse_mode: "Markdown", reply_markup: { force_reply: true } });
      }

      /* ── زر "حذف رقم" أو /removenumber بدون معامل ── */
      if (text === "🗑️ حذف رقم" || text === "/removenumber") {
        if (!store.numbers.length) return bot.sendMessage(cid, "📋 لا توجد أرقام مضافة بعد.");
        const list = store.numbers.map((n, i) => `${i + 1}. \`${n}\``).join("\n");
        conv[uid] = { step: "awaiting_delete" };
        return bot.sendMessage(cid,
          `🗑️ *حذف رقم*\n\nالأرقام الحالية:\n${list}\n\nالخطوة 1️⃣: أرسل *رمز الدولة* للرقم المراد حذفه (مثال: \`+967\`)\n\nأرسل /cancel للإلغاء.`,
          { parse_mode: "Markdown", reply_markup: { force_reply: true } });
      }

      /* ── زر "قائمة الأرقام" أو /listnumbers ── */
      if (text === "📋 قائمة الأرقام" || text === "/listnumbers") {
        if (!store.numbers.length) return bot.sendMessage(cid, "📋 لا توجد أرقام بعد.");
        const list = store.numbers.map((n, i) => `${i + 1}. \`${n}\``).join("\n");
        return bot.sendMessage(cid,
          `📋 *الأرقام المسموح بها (${store.numbers.length}):*\n\n${list}`,
          { parse_mode: "Markdown" });
      }

      /* ── زر "إحصائيات" ── */
      if (text === "📊 إحصائيات") {
        return bot.sendMessage(cid,
          `📊 *إحصائيات النظام*\n\n` +
          `👥 المشتركون: *${store.numbers.length}*\n` +
          `👤 الحسابات: *${store.users.length}*\n` +
          `📝 الوصف: ${store.config.description ? "✅ مضبوط" : "❌ غير مضبوط"}`,
          { parse_mode: "Markdown" });
      }

      /* ── /cancel ── */
      if (text === "/cancel") {
        clearConv(uid);
        return bot.sendMessage(cid, "❌ تم الإلغاء.", adminKeyboard);
      }

      /* ── /addnumber مع معامل مباشر (الطريقة القديمة لا تزال تعمل) ── */
      const addMatch = text.match(/^\/addnumber\s+(\S+)$/);
      if (addMatch) {
        const phone = addMatch[1].replace(/\s+/g, "");
        if (!/^\+?[0-9]{7,15}$/.test(phone))
          return bot.sendMessage(cid, "⚠️ صيغة خاطئة. مثال: `/addnumber +967777000000`", { parse_mode: "Markdown" });
        if (store.numbers.includes(phone))
          return bot.sendMessage(cid, `⚠️ الرقم \`${phone}\` موجود بالفعل.`, { parse_mode: "Markdown" });
        store.numbers.push(phone);
        await ghUpdate("allowed_numbers.json", store.numbers);
        return bot.sendMessage(cid, `✅ تمت إضافة: \`${phone}\``, { parse_mode: "Markdown" });
      }

      /* ── /removenumber مع معامل مباشر ── */
      const removeMatch = text.match(/^\/removenumber\s+(\S+)$/);
      if (removeMatch) {
        const phone = removeMatch[1].replace(/\s+/g, "");
        const before = store.numbers.length;
        store.numbers = store.numbers.filter(n => n !== phone);
        if (store.numbers.length === before)
          return bot.sendMessage(cid, `⚠️ الرقم \`${phone}\` غير موجود.`, { parse_mode: "Markdown" });
        await ghUpdate("allowed_numbers.json", store.numbers);
        return bot.sendMessage(cid, `✅ تم حذف: \`${phone}\``, { parse_mode: "Markdown" });
      }

      /* ── /setnumber ── */
      const setMatch = text.match(/^\/setnumber\s+(\S+)$/);
      if (setMatch) {
        const phone = setMatch[1].replace(/\s+/g, "");
        if (!/^\+?[0-9]{7,15}$/.test(phone))
          return bot.sendMessage(cid, "⚠️ صيغة خاطئة. مثال: `/setnumber +967737172794`", { parse_mode: "Markdown" });
        const old = store.numbers[0] || "—";
        store.numbers = [phone];
        await ghUpdate("allowed_numbers.json", store.numbers);
        return bot.sendMessage(cid, `✅ *تم استبدال الرقم!*\n\nالقديم: \`${old}\`\nالجديد: \`${phone}\``, { parse_mode: "Markdown" });
      }

      /* ════════════════════════════════════════
         معالجة خطوات المحادثة التفاعلية
      ════════════════════════════════════════ */
      const state = conv[uid];
      if (!state) return; /* رسالة عادية لا علاقة لها بمحادثة جارية */

      /* ─── إضافة رقم: خطوة 1 — رمز الدولة ─── */
      if (state.step === "awaiting_dialcode") {
        const raw = text.replace(/^\+/, "").replace(/\s+/g, "");
        if (!/^\d{1,4}$/.test(raw))
          return bot.sendMessage(cid,
            "⚠️ رمز الدولة غير صحيح. أرسله كأرقام فقط (مثال: `967` أو `1`).\nأو أرسل /cancel للإلغاء.",
            { parse_mode: "Markdown" });
        conv[uid] = { step: "awaiting_phone", dialCode: raw };
        return bot.sendMessage(cid,
          `✅ رمز الدولة: *+${raw}*\n\nالخطوة 2️⃣: أرسل *رقم الهاتف المحلي* (بدون رمز الدولة)\nمثال: \`777114835\`\n\nأرسل /cancel للإلغاء.`,
          { parse_mode: "Markdown", reply_markup: { force_reply: true } });
      }

      /* ─── إضافة رقم: خطوة 2 — رقم الهاتف ─── */
      if (state.step === "awaiting_phone") {
        const local = text.replace(/\s+/g, "");
        if (!/^\d{5,12}$/.test(local))
          return bot.sendMessage(cid,
            "⚠️ الرقم غير صحيح. أرسل الأرقام فقط بدون رمز الدولة (مثال: `777114835`).\nأو أرسل /cancel للإلغاء.",
            { parse_mode: "Markdown" });
        const full = `+${state.dialCode}${local}`;
        if (store.numbers.some(n => n === full)) {
          clearConv(uid);
          return bot.sendMessage(cid, `⚠️ الرقم \`${full}\` مضاف مسبقاً.`, { ...adminKeyboard, parse_mode: "Markdown" });
        }
        store.numbers.push(full);
        bot.sendMessage(cid, `⏳ جارٍ الحفظ...`);
        await ghUpdate("allowed_numbers.json", store.numbers);
        clearConv(uid);
        return bot.sendMessage(cid,
          `✅ *تم إضافة الاشتراك بنجاح!*\n\n📱 الرقم: \`${full}\`\n📊 إجمالي المشتركين: *${store.numbers.length}*`,
          { ...adminKeyboard, parse_mode: "Markdown" });
      }

      /* ─── حذف رقم: خطوة 1 — رمز الدولة ─── */
      if (state.step === "awaiting_delete") {
        const raw = text.replace(/^\+/, "").replace(/\s+/g, "");
        if (!/^\d{1,4}$/.test(raw))
          return bot.sendMessage(cid,
            "⚠️ رمز الدولة غير صحيح. مثال: `967`\nأو أرسل /cancel للإلغاء.",
            { parse_mode: "Markdown" });
        conv[uid] = { step: "awaiting_delete_phone", dialCode: raw };
        return bot.sendMessage(cid,
          `✅ رمز الدولة: *+${raw}*\n\nالخطوة 2️⃣: أرسل *رقم الهاتف المحلي* المراد حذفه\nمثال: \`777114835\`\n\nأرسل /cancel للإلغاء.`,
          { parse_mode: "Markdown", reply_markup: { force_reply: true } });
      }

      /* ─── حذف رقم: خطوة 2 — رقم الهاتف ─── */
      if (state.step === "awaiting_delete_phone") {
        const local = text.replace(/\s+/g, "");
        if (!/^\d{5,12}$/.test(local))
          return bot.sendMessage(cid,
            "⚠️ الرقم غير صحيح. مثال: `777114835`\nأو أرسل /cancel للإلغاء.",
            { parse_mode: "Markdown" });
        const full = `+${state.dialCode}${local}`;
        /* بحث مرن (suffix) */
        const norm = s => String(s).replace(/^\+/, "");
        const normFull = norm(full);
        const match = store.numbers.find(n => {
          const ns = norm(n);
          return ns === normFull || ns.endsWith(normFull) || normFull.endsWith(ns);
        });
        if (!match) {
          clearConv(uid);
          return bot.sendMessage(cid,
            `⚠️ لم يُعثر على \`${full}\` في القائمة.`,
            { ...adminKeyboard, parse_mode: "Markdown" });
        }
        store.numbers = store.numbers.filter(n => n !== match);
        bot.sendMessage(cid, `⏳ جارٍ الحفظ...`);
        await ghUpdate("allowed_numbers.json", store.numbers);
        clearConv(uid);
        return bot.sendMessage(cid,
          `✅ *تم حذف الاشتراك!*\n\n📱 الرقم المحذوف: \`${match}\`\n📊 المتبقي: *${store.numbers.length}*`,
          { ...adminKeyboard, parse_mode: "Markdown" });
      }
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
   مثال: "+967777114833" يطابق "777114833" أو "967777114833"
   إذا لم يُوجد الرقم في الذاكرة → يُعيد التحميل من GitHub مباشرةً للتأكد */
app.post("/api/numbers/check", async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ allowed: false, error: "الرقم مطلوب" });
  const norm = s => String(s).trim().replace(/^\+/, "").replace(/[\s\-().]/g, "");
  const input = norm(phone);
  if (!input) return res.status(400).json({ allowed: false, error: "الرقم مطلوب" });

  const matchFn = () => store.numbers.some(n => {
    const stored = norm(n);
    return stored === input ||          // تطابق تام
           stored.endsWith(input) ||    // المخزّن أطول ونهايته = المُدخَل  (+967777… ↔ 777…)
           input.endsWith(stored);      // المُدخَل أطول ونهايته = المخزّن
  });

  // محاولة أولى من الذاكرة
  if (matchFn()) {
    console.log(`📱 check "${phone}" → norm="${input}" → allowed=true (cache)`);
    return res.json({ allowed: true });
  }

  // لم يُوجد → تحديث فوري من GitHub ثم إعادة الفحص
  // يحل مشكلة تعدد instances على Render أو تأخر الـ cache
  try { await refreshStore(); } catch (e) { console.error("refreshStore in check:", e.message); }
  const allowed = matchFn();
  console.log(`📱 check "${phone}" → norm="${input}" → allowed=${allowed} (after refresh)`);
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

import express from "express";
import cors from "cors";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import pg from "pg";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.SESSION_SECRET || "change-me-in-production";

/* ── DB connection ── */
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      username      TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  console.log("✅ DB table ready");
}
initDb().catch(console.error);

/* ── Middleware ── */
app.use(cors());
app.use(express.json());

/* ── Static files ── */
app.use(express.static(join(__dirname, "../public")));

/* ─────────────────────────────
   AUTH ROUTES
───────────────────────────── */

/* POST /api/auth/register */
app.post("/api/auth/register", async (req, res) => {
  const { username, password, remember } = req.body;

  if (!username || !password)
    return res.status(400).json({ error: "اسم المستخدم وكلمة المرور مطلوبان" });

  if (!/^[a-zA-Z][a-zA-Z0-9_]{3,19}$/.test(username))
    return res.status(400).json({ error: "اسم المستخدم يجب أن يكون بين 4–20 حرف إنجليزي" });

  if (password.length < 6)
    return res.status(400).json({ error: "كلمة المرور يجب أن تكون 6 أحرف على الأقل" });

  try {
    const { rows: existing } = await pool.query(
      "SELECT id FROM users WHERE username = $1 LIMIT 1",
      [username.toLowerCase()]
    );
    if (existing.length > 0)
      return res.status(409).json({ error: "اسم المستخدم مستخدم بالفعل" });

    const passwordHash = await bcrypt.hash(password, 12);
    const { rows } = await pool.query(
      "INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id, username",
      [username.toLowerCase(), passwordHash]
    );
    const user = rows[0];
    const token = jwt.sign(
      { id: user.id, username: user.username, display: username },
      JWT_SECRET,
      { expiresIn: remember ? "30d" : "1d" }
    );
    return res.status(201).json({ token, username: user.username, display: username });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "خطأ في الخادم، حاول مرة أخرى" });
  }
});

/* POST /api/auth/login */
app.post("/api/auth/login", async (req, res) => {
  const { username, password, remember } = req.body;

  if (!username || !password)
    return res.status(400).json({ error: "اسم المستخدم وكلمة المرور مطلوبان" });

  try {
    const { rows } = await pool.query(
      "SELECT * FROM users WHERE username = $1 LIMIT 1",
      [username.toLowerCase()]
    );
    if (rows.length === 0)
      return res.status(401).json({ error: "اسم المستخدم غير موجود" });

    const user = rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid)
      return res.status(401).json({ error: "كلمة المرور غير صحيحة" });

    const token = jwt.sign(
      { id: user.id, username: user.username, display: username },
      JWT_SECRET,
      { expiresIn: remember ? "30d" : "1d" }
    );
    return res.json({ token, username: user.username, display: username });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "خطأ في الخادم، حاول مرة أخرى" });
  }
});

/* Fallback → index.html */
app.get("*", (_req, res) => {
  res.sendFile(join(__dirname, "../public/index.html"));
});

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));

import { Router } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";

const router = Router();

const JWT_SECRET = process.env["SESSION_SECRET"] ?? "fallback-secret-change-me";
const JWT_EXPIRES_NORMAL = "1d";
const JWT_EXPIRES_REMEMBER = "30d";

/* ── POST /api/auth/register ── */
router.post("/register", async (req, res) => {
  const { username, password, remember } = req.body as {
    username?: string;
    password?: string;
    remember?: boolean;
  };

  if (!username || !password) {
    return res.status(400).json({ error: "اسم المستخدم وكلمة المرور مطلوبان" });
  }

  if (!/^[a-zA-Z][a-zA-Z0-9_]{3,19}$/.test(username)) {
    return res.status(400).json({ error: "اسم المستخدم يجب أن يكون بين 4–20 حرف إنجليزي" });
  }

  if (password.length < 6) {
    return res.status(400).json({ error: "كلمة المرور يجب أن تكون 6 أحرف على الأقل" });
  }

  try {
    // Check duplicate
    const existing = await db
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(eq(usersTable.username, username.toLowerCase()))
      .limit(1);

    if (existing.length > 0) {
      return res.status(409).json({ error: "اسم المستخدم مستخدم بالفعل" });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const [user] = await db
      .insert(usersTable)
      .values({ username: username.toLowerCase(), passwordHash })
      .returning({ id: usersTable.id, username: usersTable.username });

    const token = jwt.sign(
      { id: user!.id, username: user!.username, display: username },
      JWT_SECRET,
      { expiresIn: remember ? JWT_EXPIRES_REMEMBER : JWT_EXPIRES_NORMAL }
    );

    return res.status(201).json({ token, username: user!.username, display: username });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "خطأ في الخادم، حاول مرة أخرى" });
  }
});

/* ── POST /api/auth/login ── */
router.post("/login", async (req, res) => {
  const { username, password, remember } = req.body as {
    username?: string;
    password?: string;
    remember?: boolean;
  };

  if (!username || !password) {
    return res.status(400).json({ error: "اسم المستخدم وكلمة المرور مطلوبان" });
  }

  try {
    const [user] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.username, username.toLowerCase()))
      .limit(1);

    if (!user) {
      return res.status(401).json({ error: "اسم المستخدم غير موجود" });
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      return res.status(401).json({ error: "كلمة المرور غير صحيحة" });
    }

    const token = jwt.sign(
      { id: user.id, username: user.username, display: username },
      JWT_SECRET,
      { expiresIn: remember ? JWT_EXPIRES_REMEMBER : JWT_EXPIRES_NORMAL }
    );

    return res.json({ token, username: user.username, display: username });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "خطأ في الخادم، حاول مرة أخرى" });
  }
});

export default router;

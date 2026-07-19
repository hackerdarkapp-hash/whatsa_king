import { Router } from "express";
import { db, siteConfigTable } from "@workspace/db";
import { eq } from "drizzle-orm";

const router = Router();

/* GET /api/config/description — public */
router.get("/description", async (_req, res) => {
  try {
    const [row] = await db
      .select()
      .from(siteConfigTable)
      .where(eq(siteConfigTable.key, "description"))
      .limit(1);
    return res.json({ description: row?.value ?? "" });
  } catch {
    return res.status(500).json({ error: "خطأ في الخادم" });
  }
});

/* POST /api/config/description — internal (called by bot only) */
router.post("/description", async (req, res) => {
  const secret = req.headers["x-admin-secret"];
  if (secret !== process.env["SESSION_SECRET"]) {
    return res.status(403).json({ error: "غير مصرح" });
  }
  const { value } = req.body as { value?: string };
  if (!value?.trim()) return res.status(400).json({ error: "الوصف لا يمكن أن يكون فارغاً" });

  try {
    await db
      .insert(siteConfigTable)
      .values({ key: "description", value: value.trim() })
      .onConflictDoUpdate({
        target: siteConfigTable.key,
        set: { value: value.trim(), updatedAt: new Date() },
      });
    return res.json({ ok: true });
  } catch {
    return res.status(500).json({ error: "خطأ في الخادم" });
  }
});

export default router;

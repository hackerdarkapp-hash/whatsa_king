import { type Request, type Response, type NextFunction } from "express";
import jwt from "jsonwebtoken";

const JWT_SECRET = process.env["SESSION_SECRET"] ?? "fallback-secret-change-me";

export interface AuthPayload {
  id: string;
  username: string;
  display: string;
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers["authorization"];
  const token = header?.startsWith("Bearer ") ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: "غير مصرح — الرجاء تسجيل الدخول أولاً" });
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET) as AuthPayload;
    (req as Request & { user: AuthPayload }).user = payload;
    return next();
  } catch {
    return res.status(401).json({ error: "جلسة منتهية أو غير صالحة، سجّل الدخول مجدداً" });
  }
}

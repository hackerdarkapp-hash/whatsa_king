import TelegramBot from "node-telegram-bot-api";
import { db, siteConfigTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./logger";

const TOKEN = process.env["TELEGRAM_BOT_TOKEN"];

/* pending state: waiting for new description per chatId */
const awaitingDesc = new Set<number>();

/* stored admin chatId in memory + DB */
let adminChatId: number | null = null;

async function getAdminId(): Promise<number | null> {
  if (adminChatId) return adminChatId;
  const [row] = await db
    .select()
    .from(siteConfigTable)
    .where(eq(siteConfigTable.key, "admin_chat_id"))
    .limit(1);
  if (row) adminChatId = Number(row.value);
  return adminChatId ?? null;
}

async function setAdminId(id: number) {
  adminChatId = id;
  await db
    .insert(siteConfigTable)
    .values({ key: "admin_chat_id", value: String(id) })
    .onConflictDoUpdate({
      target: siteConfigTable.key,
      set: { value: String(id), updatedAt: new Date() },
    });
}

async function getDesc(): Promise<string> {
  const [row] = await db
    .select()
    .from(siteConfigTable)
    .where(eq(siteConfigTable.key, "description"))
    .limit(1);
  return row?.value ?? "—";
}

async function setDesc(value: string) {
  await db
    .insert(siteConfigTable)
    .values({ key: "description", value })
    .onConflictDoUpdate({
      target: siteConfigTable.key,
      set: { value, updatedAt: new Date() },
    });
}

export function startBot() {
  if (!TOKEN) {
    logger.warn("TELEGRAM_BOT_TOKEN not set — bot disabled");
    return;
  }

  const bot = new TelegramBot(TOKEN, { polling: true });
  logger.info("Telegram admin bot started");

  /* ── /start ── */
  bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const existingAdmin = await getAdminId();

    if (!existingAdmin) {
      await setAdminId(chatId);
      bot.sendMessage(chatId,
        `✅ *تم تسجيلك كمدير النظام*\n\nمرحباً ${msg.from?.first_name ?? ""}! أنت الآن أدمن هذا التطبيق.`,
        { parse_mode: "Markdown", reply_markup: mainMenu() }
      );
    } else if (existingAdmin === chatId) {
      bot.sendMessage(chatId,
        `👋 *مرحباً بك مجدداً!*\nاختر ما تريد تعديله:`,
        { parse_mode: "Markdown", reply_markup: mainMenu() }
      );
    } else {
      bot.sendMessage(chatId, "⛔ أنت لست مدير هذا التطبيق.");
    }
  });

  /* ── callback buttons ── */
  bot.on("callback_query", async (query) => {
    const chatId = query.message!.chat.id;
    const admin = await getAdminId();
    if (admin !== chatId) {
      bot.answerCallbackQuery(query.id, { text: "⛔ غير مصرح لك" });
      return;
    }

    if (query.data === "view_desc") {
      const desc = await getDesc();
      bot.answerCallbackQuery(query.id);
      bot.sendMessage(chatId,
        `📋 *الوصف الحالي:*\n\n_${desc}_`,
        { parse_mode: "Markdown", reply_markup: mainMenu() }
      );
    }

    if (query.data === "set_desc") {
      bot.answerCallbackQuery(query.id);
      awaitingDesc.add(chatId);
      bot.sendMessage(chatId,
        `✏️ *أرسل الوصف الجديد للتطبيق:*\n\n_(سيظهر أسفل العنوان في صفحة تسجيل الدخول)_\n\nأو أرسل /cancel للإلغاء`,
        { parse_mode: "Markdown" }
      );
    }
  });

  /* ── /cancel ── */
  bot.onText(/\/cancel/, async (msg) => {
    awaitingDesc.delete(msg.chat.id);
    const admin = await getAdminId();
    if (admin === msg.chat.id) {
      bot.sendMessage(msg.chat.id, "❌ تم الإلغاء.", { reply_markup: mainMenu() });
    }
  });

  /* ── incoming text (awaiting description) ── */
  bot.on("message", async (msg) => {
    const chatId = msg.chat.id;
    if (!msg.text || msg.text.startsWith("/")) return;
    if (!awaitingDesc.has(chatId)) return;

    const admin = await getAdminId();
    if (admin !== chatId) return;

    awaitingDesc.delete(chatId);
    const newDesc = msg.text.trim();

    try {
      await setDesc(newDesc);
      bot.sendMessage(chatId,
        `✅ *تم تحديث الوصف بنجاح!*\n\n_"${newDesc}"_`,
        { parse_mode: "Markdown", reply_markup: mainMenu() }
      );
    } catch {
      bot.sendMessage(chatId, "❌ حدث خطأ، حاول مرة أخرى.", { reply_markup: mainMenu() });
    }
  });

  bot.on("polling_error", (err) => logger.error({ err }, "Telegram polling error"));
}

function mainMenu() {
  return {
    inline_keyboard: [
      [{ text: "📋 عرض الوصف الحالي", callback_data: "view_desc" }],
      [{ text: "✏️ تغيير وصف التطبيق", callback_data: "set_desc" }],
    ],
  };
}

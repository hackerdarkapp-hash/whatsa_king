import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { startBot } from "./lib/telegramBot";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return { id: req.id, method: req.method, url: req.url?.split("?")[0] };
      },
      res(res) {
        return { statusCode: res.statusCode };
      },
    },
  }),
);

app.use(cors({
  origin: [
    "https://whatsa-king.onrender.com",
    /\.replit\.dev$/,
    /\.replit\.app$/,
    "http://localhost:3000",
    "http://localhost:5173",
  ],
  credentials: true,
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use("/api", router);

// Start Telegram admin bot
startBot();

export default app;

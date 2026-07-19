import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import configRouter from "./config";

const router: IRouter = Router();

router.use(healthRouter);
router.use("/auth", authRouter);
router.use("/config", configRouter);

export default router;

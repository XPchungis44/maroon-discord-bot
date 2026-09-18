import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Simple health endpoints so cron-jobs and Render health checks work
// even if someone uses the root URL or /healthz instead of /api/healthz.
const healthPayload = { status: "ok" as const };
app.get("/", (_req, res) => {
  res.status(200).json(healthPayload);
});
app.get("/healthz", (_req, res) => {
  res.status(200).json(healthPayload);
});

app.use("/api", router);

export default app;

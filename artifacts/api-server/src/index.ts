import app from "./app";
import { logger } from "./lib/logger";
import { startMaroon } from "./maroon/bot";

const port = Number(process.env.PORT ?? 3000);

app.listen(port, async () => {
  logger.info({ port }, "Server listening");

  try {
    await startMaroon();
  } catch (error) {
    logger.error({ error }, "Maroon failed to start");
  }
});

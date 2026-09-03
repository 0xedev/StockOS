import Redis from "ioredis";

const redisUrl = process.env.REDIS_URL;
if (!redisUrl) {
  throw new Error("REDIS_URL must be configured for the StockOS worker");
}

const redis = new Redis(redisUrl, {
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
});

let shuttingDown = false;

redis.on("ready", () => {
  console.log("StockOS worker connected to Redis. Automation execution remains disabled until explicit spend permissions are enabled per user.");
});

redis.on("error", error => {
  console.error("StockOS worker Redis error", error);
});

const heartbeat = setInterval(async () => {
  try {
    await redis.ping();
    console.log("StockOS worker heartbeat ok");
  } catch (error) {
    console.error("StockOS worker heartbeat failed", error);
  }
}, 60_000);

async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(heartbeat);
  console.log(`StockOS worker shutting down after ${signal}`);
  await redis.quit().catch(() => redis.disconnect());
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

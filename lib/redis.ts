import { Redis } from "@upstash/redis";

/** Supports Vercel Redis / Upstash env names and legacy KV_* from older projects. */
export function getRedis(): Redis | null {
  const url =
    process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
  const token =
    process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;
  if (!url || !token) {
    return null;
  }
  return new Redis({ url, token });
}

import { createRoom, requireRedis } from "@/lib/signaling-room";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST() {
  try {
    const redis = requireRedis();
    const roomCode = await createRoom(redis);
    return Response.json({ roomCode });
  } catch (e) {
    if (e instanceof Error && e.message === "REDIS_UNAVAILABLE") {
      return Response.json(
        {
          error:
            "Redis is not configured. Add Vercel Redis (Upstash) and set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN.",
        },
        { status: 503 }
      );
    }
    throw e;
  }
}

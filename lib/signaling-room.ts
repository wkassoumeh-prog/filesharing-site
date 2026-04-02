import type { Redis } from "@upstash/redis";
import { getRedis } from "@/lib/redis";

export const ROOM_TTL_SEC = 3600;

const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export type RoomMeta = {
  offer: RTCSessionDescriptionInit | null;
  answer: RTCSessionDescriptionInit | null;
};

function metaKey(code: string): string {
  return `p2p:room:${code}`;
}

function iceKey(code: string, role: "host" | "guest"): string {
  return `p2p:room:${code}:ice:${role}`;
}

export function generateRoomCode(): string {
  let s = "";
  for (let i = 0; i < 6; i++) {
    s += alphabet[Math.floor(Math.random() * alphabet.length)]!;
  }
  return s;
}

export async function createRoom(redis: Redis): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const code = generateRoomCode();
    const key = metaKey(code);
    const exists = await redis.exists(key);
    if (exists === 1) continue;

    const meta: RoomMeta = { offer: null, answer: null };
    await redis.set(key, JSON.stringify(meta), { ex: ROOM_TTL_SEC });
    return code;
  }
  throw new Error("Could not allocate room code");
}

export async function getRoomSnapshot(
  redis: Redis,
  code: string
): Promise<{
  meta: RoomMeta | null;
  iceHost: (RTCIceCandidateInit | null)[];
  iceGuest: (RTCIceCandidateInit | null)[];
}> {
  const key = metaKey(code);
  const raw = await redis.get<string>(key);
  if (!raw) {
    return { meta: null, iceHost: [], iceGuest: [] };
  }
  const meta = JSON.parse(raw) as RoomMeta;

  const [hostRaw, guestRaw] = await Promise.all([
    redis.lrange<string>(iceKey(code, "host"), 0, -1),
    redis.lrange<string>(iceKey(code, "guest"), 0, -1),
  ]);

  const parseIce = (arr: string[]): (RTCIceCandidateInit | null)[] =>
    arr.map((item) => {
      if (item === "null" || item === "") return null;
      try {
        return JSON.parse(item) as RTCIceCandidateInit | null;
      } catch {
        return null;
      }
    });

  return {
    meta,
    iceHost: parseIce(hostRaw ?? []),
    iceGuest: parseIce(guestRaw ?? []),
  };
}

export async function setOffer(
  redis: Redis,
  code: string,
  sdp: RTCSessionDescriptionInit
): Promise<boolean> {
  const key = metaKey(code);
  const raw = await redis.get<string>(key);
  if (!raw) return false;
  const meta = JSON.parse(raw) as RoomMeta;
  meta.offer = sdp;
  await redis.set(key, JSON.stringify(meta), { ex: ROOM_TTL_SEC });
  return true;
}

export async function setAnswer(
  redis: Redis,
  code: string,
  sdp: RTCSessionDescriptionInit
): Promise<boolean> {
  const key = metaKey(code);
  const raw = await redis.get<string>(key);
  if (!raw) return false;
  const meta = JSON.parse(raw) as RoomMeta;
  meta.answer = sdp;
  await redis.set(key, JSON.stringify(meta), { ex: ROOM_TTL_SEC });
  return true;
}

export async function pushIceCandidate(
  redis: Redis,
  code: string,
  role: "host" | "guest",
  candidate: RTCIceCandidateInit | null
): Promise<boolean> {
  const key = metaKey(code);
  const exists = await redis.exists(key);
  if (exists !== 1) return false;

  const ice = iceKey(code, role);
  const payload =
    candidate === null ? "null" : JSON.stringify(candidate);
  await redis.rpush(ice, payload);
  await redis.expire(ice, ROOM_TTL_SEC);
  await redis.expire(key, ROOM_TTL_SEC);
  return true;
}

export function requireRedis(): Redis {
  const redis = getRedis();
  if (!redis) {
    throw new Error("REDIS_UNAVAILABLE");
  }
  return redis;
}

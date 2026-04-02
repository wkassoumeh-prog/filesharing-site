import {
  getRoomSnapshot,
  pushIceCandidate,
  requireRedis,
  setAnswer,
  setOffer,
} from "@/lib/signaling-room";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const CODE_RE = /^[A-Z2-9]{6}$/;

export async function GET(
  _request: Request,
  context: { params: Promise<{ code: string }> }
) {
  const { code: raw } = await context.params;
  const code = raw.toUpperCase();
  if (!CODE_RE.test(code)) {
    return Response.json({ error: "Invalid room code" }, { status: 400 });
  }

  try {
    const redis = requireRedis();
    const snap = await getRoomSnapshot(redis, code);
    if (!snap.meta) {
      return Response.json({ error: "Room not found" }, { status: 404 });
    }
    return Response.json({
      offer: snap.meta.offer,
      answer: snap.meta.answer,
      iceHost: snap.iceHost,
      iceGuest: snap.iceGuest,
    });
  } catch (e) {
    if (e instanceof Error && e.message === "REDIS_UNAVAILABLE") {
      return Response.json({ error: "Redis not configured" }, { status: 503 });
    }
    throw e;
  }
}

type PostBody =
  | { kind: "offer"; sdp: RTCSessionDescriptionInit }
  | { kind: "answer"; sdp: RTCSessionDescriptionInit }
  | {
      kind: "ice";
      role: "host" | "guest";
      candidate: RTCIceCandidateInit | null;
    };

export async function POST(
  request: Request,
  context: { params: Promise<{ code: string }> }
) {
  const { code: raw } = await context.params;
  const code = raw.toUpperCase();
  if (!CODE_RE.test(code)) {
    return Response.json({ error: "Invalid room code" }, { status: 400 });
  }

  let body: PostBody;
  try {
    body = (await request.json()) as PostBody;
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  try {
    const redis = requireRedis();
    if (body.kind === "offer") {
      const sdp = body.sdp;
      if (!sdp || typeof sdp.sdp !== "string" || sdp.sdp.length === 0) {
        return Response.json(
          { error: "Invalid offer: missing sdp string" },
          { status: 400 }
        );
      }
      const init: RTCSessionDescriptionInit = {
        type: sdp.type === "pranswer" ? "pranswer" : "offer",
        sdp: sdp.sdp,
      };
      try {
        const ok = await setOffer(redis, code, init);
        if (!ok) {
          return Response.json(
            {
              error:
                "Room not found or expired. Create a new room and try again.",
            },
            { status: 404 }
          );
        }
        return Response.json({ ok: true });
      } catch (err) {
        console.error("[signaling] setOffer", err);
        return Response.json(
          {
            error:
              err instanceof Error ? err.message : "Redis error saving offer",
          },
          { status: 500 }
        );
      }
    }
    if (body.kind === "answer") {
      const sdp = body.sdp;
      if (!sdp || typeof sdp.sdp !== "string" || sdp.sdp.length === 0) {
        return Response.json(
          { error: "Invalid answer: missing sdp string" },
          { status: 400 }
        );
      }
      const init: RTCSessionDescriptionInit = {
        type: sdp.type === "pranswer" ? "pranswer" : "answer",
        sdp: sdp.sdp,
      };
      try {
        const ok = await setAnswer(redis, code, init);
        if (!ok) {
          return Response.json(
            {
              error:
                "Room not found or expired. Rejoin with a fresh room code.",
            },
            { status: 404 }
          );
        }
        return Response.json({ ok: true });
      } catch (err) {
        console.error("[signaling] setAnswer", err);
        return Response.json(
          {
            error:
              err instanceof Error ? err.message : "Redis error saving answer",
          },
          { status: 500 }
        );
      }
    }
    if (body.kind === "ice") {
      const ok = await pushIceCandidate(
        redis,
        code,
        body.role,
        body.candidate
      );
      if (!ok) {
        return Response.json({ error: "Room not found" }, { status: 404 });
      }
      return Response.json({ ok: true });
    }
    return Response.json({ error: "Unknown kind" }, { status: 400 });
  } catch (e) {
    if (e instanceof Error && e.message === "REDIS_UNAVAILABLE") {
      return Response.json({ error: "Redis not configured" }, { status: 503 });
    }
    throw e;
  }
}

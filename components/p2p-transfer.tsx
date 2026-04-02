"use client";

import QRCode from "react-qr-code";
import { useCallback, useEffect, useRef, useState } from "react";

function buildIceServers(): RTCIceServer[] {
  const base: RTCIceServer[] = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    {
      urls: [
        "turn:openrelay.metered.ca:80",
        "turn:openrelay.metered.ca:443",
        "turn:openrelay.metered.ca:443?transport=tcp",
      ],
      username: "openrelayproject",
      credential: "openrelayproject",
    },
  ];
  const turnUrl = process.env.NEXT_PUBLIC_TURN_URL;
  const turnUser = process.env.NEXT_PUBLIC_TURN_USERNAME;
  const turnCred = process.env.NEXT_PUBLIC_TURN_CREDENTIAL;
  if (turnUrl && turnUser !== undefined && turnCred !== undefined) {
    base.push({
      urls: turnUrl,
      username: turnUser,
      credential: turnCred,
    });
  }
  return base;
}

const POLL_MS = 400;
const MAX_BUFFER = 256 * 1024;
const CHUNK_SIZE = 16 * 1024;

const DATA_ONLY_OFFER: RTCOfferOptions = {
  offerToReceiveAudio: false,
  offerToReceiveVideo: false,
};

const DATA_ONLY_ANSWER: RTCAnswerOptions = {
  offerToReceiveAudio: false,
  offerToReceiveVideo: false,
};

type UiMode = "home" | "host" | "guest" | "error";

type DebugLine = { id: number; t: string; msg: string };

const DEBUG_MAX_LINES = 120;

function timeStamp(): string {
  const d = new Date();
  return d.toISOString().slice(11, 23);
}

async function waitForBuffer(dc: RTCDataChannel): Promise<void> {
  if (dc.bufferedAmount < MAX_BUFFER) return;
  await new Promise<void>((resolve) => {
    const id = setInterval(() => {
      if (dc.bufferedAmount < MAX_BUFFER) {
        clearInterval(id);
        resolve();
      }
    }, 16);
  });
}

async function addIceCandidateSafe(
  pc: RTCPeerConnection,
  raw: RTCIceCandidateInit | null
): Promise<void> {
  if (raw === null) {
    await pc.addIceCandidate(null);
    return;
  }
  try {
    await pc.addIceCandidate(new RTCIceCandidate(raw));
  } catch {
    await pc.addIceCandidate(raw);
  }
}

export function P2PTransfer() {
  const [mode, setMode] = useState<UiMode>("home");
  const [roomCode, setRoomCode] = useState("");
  const [guestInput, setGuestInput] = useState("");
  const [status, setStatus] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [joinUrl, setJoinUrl] = useState("");
  const [progress, setProgress] = useState<number | null>(null);
  const [connected, setConnected] = useState(false);
  const [debugLines, setDebugLines] = useState<DebugLine[]>([]);
  const debugId = useRef(0);

  const appendDebug = useCallback((msg: string) => {
    const t = timeStamp();
    setDebugLines((prev) => {
      debugId.current += 1;
      const line: DebugLine = { id: debugId.current, t, msg };
      return [...prev, line].slice(-DEBUG_MAX_LINES);
    });
  }, []);

  const clearDebug = useCallback(() => {
    setDebugLines([]);
  }, []);

  const copyDebugLog = useCallback(() => {
    const text = debugLines.map((l) => `${l.t}  ${l.msg}`).join("\n");
    void navigator.clipboard.writeText(text).catch(() => {});
  }, [debugLines]);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const pollRef = useRef<number | null>(null);
  const hostIceIdx = useRef(0);
  const guestIceIdx = useRef(0);
  const abortRef = useRef(false);
  const hostPollBusy = useRef(false);
  const guestPollBusy = useRef(false);

  const stopPolling = useCallback(() => {
    if (pollRef.current !== null) {
      window.clearTimeout(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const teardown = useCallback(() => {
    abortRef.current = true;
    stopPolling();
    dcRef.current?.close();
    dcRef.current = null;
    pcRef.current?.close();
    pcRef.current = null;
    hostIceIdx.current = 0;
    guestIceIdx.current = 0;
  }, [stopPolling]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const join = params.get("join");
    if (join && /^[A-Za-z2-9]{6}$/.test(join)) {
      queueMicrotask(() => setGuestInput(join.toUpperCase()));
    }
  }, []);

  const pushIce = useCallback(
    async (code: string, role: "host" | "guest", c: RTCIceCandidate | null) => {
      const candidate = c ? c.toJSON() : null;
      const res = await fetch(`/api/signaling/rooms/${code}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "ice", role, candidate }),
      });
      if (!res.ok) {
        console.warn("ICE signaling POST failed", res.status);
      }
    },
    []
  );

  const pollSignaling = useCallback(
    async (
      code: string,
      role: "host" | "guest",
      pc: RTCPeerConnection,
      log: (m: string) => void
    ) => {
      const res = await fetch(
        `/api/signaling/rooms/${code}?_=${Date.now()}`,
        {
          cache: "no-store",
          headers: { "Cache-Control": "no-cache" },
        }
      );
      if (!res.ok) {
        log(`signaling GET failed: HTTP ${res.status}`);
        return;
      }
      const data = (await res.json()) as {
        offer: RTCSessionDescriptionInit | null;
        answer: RTCSessionDescriptionInit | null;
        iceHost: (RTCIceCandidateInit | null)[];
        iceGuest: (RTCIceCandidateInit | null)[];
      };

      log(
        `signaling snapshot: hasOffer=${!!data.offer} hasAnswer=${!!data.answer} iceHost=${data.iceHost.length} iceGuest=${data.iceGuest.length}`
      );

      if (role === "host") {
        if (data.answer && !pc.currentRemoteDescription) {
          try {
            await pc.setRemoteDescription(
              new RTCSessionDescription(data.answer)
            );
            log("host: setRemoteDescription(answer) OK");
          } catch (e) {
            console.error("Host setRemoteDescription(answer)", e);
            log(`host: setRemoteDescription(answer) ERROR ${String(e)}`);
            setError("Could not apply answer from peer. Try again.");
          }
        }
        if (!pc.currentRemoteDescription) {
          return;
        }
        const list = data.iceGuest;
        let added = 0;
        for (let i = guestIceIdx.current; i < list.length; i++) {
          const raw = list[i];
          try {
            await addIceCandidateSafe(pc, raw);
            guestIceIdx.current = i + 1;
            added++;
          } catch (e) {
            log(`host: addIceCandidate stopped: ${String(e)}`);
            console.warn("Host addIceCandidate", e);
            break;
          }
        }
        if (added > 0) {
          log(`host: applied ${added} guest ICE candidate(s)`);
        }
      }
    },
    [setError]
  );

  const startHost = useCallback(async () => {
    setError(null);
    setProgress(null);
    setConnected(false);
    setDebugLines([]);
    teardown();
    abortRef.current = false;
    setStatus("Creating room…");
    appendDebug(`[host] start (page=${typeof window !== "undefined" ? window.location.href : ""})`);

    const roomRes = await fetch("/api/signaling/rooms", { method: "POST" });
    if (!roomRes.ok) {
      const j = (await roomRes.json().catch(() => ({}))) as { error?: string };
      appendDebug(`[host] POST /api/signaling/rooms failed: HTTP ${roomRes.status}`);
      setError(
        j.error ??
          "Could not create a room. Configure Redis (Upstash) on Vercel."
      );
      setMode("error");
      return;
    }

    const { roomCode: code } = (await roomRes.json()) as { roomCode: string };
    appendDebug(`[host] room created: ${code}`);
    setRoomCode(code);
    const origin = window.location.origin;
    const path = window.location.pathname || "/";
    setJoinUrl(`${origin}${path}?join=${code}`);
    setMode("host");
    setStatus("Connecting…");

    const pc = new RTCPeerConnection({ iceServers: buildIceServers() });
    pcRef.current = pc;

    const logPc = (label: string) => {
      appendDebug(
        `[host] ${label}: signaling=${pc.signalingState} conn=${pc.connectionState} iceConn=${pc.iceConnectionState} iceGather=${pc.iceGatheringState}`
      );
    };

    pc.onconnectionstatechange = () => {
      logPc("onconnectionstatechange");
      const s = pc.connectionState;
      setStatus((prev) => {
        if (prev.startsWith("Connected")) return prev;
        return `Link: ${s} · ICE: ${pc.iceConnectionState}`;
      });
      if (s === "failed") {
        appendDebug("[host] connectionState=failed");
        setError(
          "WebRTC connection failed. Try same Wi‑Fi, or add NEXT_PUBLIC_TURN_* in Vercel."
        );
      }
    };

    pc.oniceconnectionstatechange = () => logPc("oniceconnectionstatechange");
    pc.onicegatheringstatechange = () => logPc("onicegatheringstatechange");
    pc.onsignalingstatechange = () => logPc("onsignalingstatechange");

    const dc = pc.createDataChannel("file", { ordered: true });
    dcRef.current = dc;

    dc.onopen = () => {
      if (abortRef.current) return;
      appendDebug(`[host] dataChannel onopen (label=${dc.label} id=${dc.id})`);
      setConnected(true);
      setStatus("Connected. Choose a file to send.");
    };

    dc.onerror = () => {
      appendDebug("[host] dataChannel onerror");
      setError("Data channel error");
    };

    dc.onclose = () => {
      appendDebug(`[host] dataChannel onclose (readyState=${dc.readyState})`);
    };

    let hostIceOut = 0;
    pc.onicecandidate = (e) => {
      if (e.candidate) hostIceOut++;
      else appendDebug(`[host] ICE gathering complete (sent ${hostIceOut} candidates)`);
      void pushIce(code, "host", e.candidate);
    };

    try {
      appendDebug("[host] creating offer + setLocalDescription…");
      const offer = await pc.createOffer(DATA_ONLY_OFFER);
      await pc.setLocalDescription(offer);
      logPc("after setLocalDescription(offer)");
      const postOffer = await fetch(`/api/signaling/rooms/${code}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "offer",
          sdp: pc.localDescription!,
        }),
      });
      if (!postOffer.ok) {
        const t = await postOffer.text();
        throw new Error(t || `Offer HTTP ${postOffer.status}`);
      }
      appendDebug(`[host] offer POST OK (${(pc.localDescription?.sdp?.length ?? 0)} chars sdp)`);
    } catch (e) {
      appendDebug(`[host] offer failed: ${String(e)}`);
      console.error(e);
      setError("Could not publish WebRTC offer. Check network and try again.");
      setMode("error");
      teardown();
      return;
    }

    let hostPollN = 0;
    const hostPollLoop = async () => {
      if (abortRef.current) return;
      if (hostPollBusy.current) {
        pollRef.current = window.setTimeout(() => void hostPollLoop(), POLL_MS);
        return;
      }
      hostPollBusy.current = true;
      try {
        hostPollN += 1;
        appendDebug(`--- host signaling poll #${hostPollN} ---`);
        await pollSignaling(code, "host", pc, appendDebug);
      } finally {
        hostPollBusy.current = false;
      }
      if (!abortRef.current) {
        pollRef.current = window.setTimeout(() => void hostPollLoop(), POLL_MS);
      }
    };
    appendDebug("[host] starting signaling poll loop");
    pollRef.current = window.setTimeout(() => void hostPollLoop(), 0);
  }, [appendDebug, pollSignaling, pushIce, teardown]);

  const sendFile = useCallback(
    async (file: File) => {
      const dc = dcRef.current;
      if (!dc || dc.readyState !== "open") {
        appendDebug(`[host] sendFile blocked: dc=${dc ? dc.readyState : "null"}`);
        setError("Channel not ready");
        return;
      }
      appendDebug(
        `[host] send start: ${file.name} (${file.size} bytes, ${file.type || "no type"})`
      );
      setProgress(0);
      setStatus(`Sending ${file.name}…`);

      const meta = {
        type: "meta" as const,
        name: file.name,
        size: file.size,
        mimeType: file.type || "application/octet-stream",
      };
      dc.send(JSON.stringify(meta));

      const buf = await file.arrayBuffer();
      let offset = 0;
      while (offset < buf.byteLength) {
        await waitForBuffer(dc);
        const end = Math.min(offset + CHUNK_SIZE, buf.byteLength);
        dc.send(buf.slice(offset, end));
        offset = end;
        setProgress(Math.round((offset / buf.byteLength) * 100));
      }

      appendDebug(`[host] send finished: ${file.name}`);
      setProgress(null);
      setStatus("Sent. You can send another file or close the tab.");
    },
    [appendDebug]
  );

  const joinAsGuest = useCallback(async (codeOverride?: string) => {
    const code = (codeOverride ?? guestInput).trim().toUpperCase();
    if (!/^[A-Z2-9]{6}$/.test(code)) {
      setError("Enter a 6-character room code.");
      return;
    }

    setError(null);
    setProgress(null);
    setConnected(false);
    setDebugLines([]);
    teardown();
    abortRef.current = false;
    setRoomCode(code);
    setMode("guest");
    setStatus("Connecting…");
    appendDebug(
      `[guest] start room=${code} (page=${typeof window !== "undefined" ? window.location.href : ""})`
    );

    const pc = new RTCPeerConnection({ iceServers: buildIceServers() });
    pcRef.current = pc;

    const logPc = (label: string) => {
      appendDebug(
        `[guest] ${label}: signaling=${pc.signalingState} conn=${pc.connectionState} iceConn=${pc.iceConnectionState} iceGather=${pc.iceGatheringState}`
      );
    };

    pc.onconnectionstatechange = () => {
      logPc("onconnectionstatechange");
      const s = pc.connectionState;
      setStatus((prev) => {
        if (prev.startsWith("Connected") || prev.startsWith("Receiving")) {
          return prev;
        }
        return `Link: ${s} · ICE: ${pc.iceConnectionState}`;
      });
      if (s === "failed") {
        appendDebug("[guest] connectionState=failed");
        setError(
          "WebRTC connection failed. Try same Wi‑Fi, or add NEXT_PUBLIC_TURN_* in Vercel."
        );
      }
    };

    pc.oniceconnectionstatechange = () => logPc("oniceconnectionstatechange");
    pc.onicegatheringstatechange = () => logPc("onicegatheringstatechange");
    pc.onsignalingstatechange = () => logPc("onsignalingstatechange");

    let guestIceOut = 0;
    pc.onicecandidate = (e) => {
      if (e.candidate) guestIceOut++;
      else
        appendDebug(
          `[guest] ICE gathering complete (sent ${guestIceOut} candidates)`
        );
      void pushIce(code, "guest", e.candidate);
    };

    pc.ondatachannel = (ev) => {
      const ch = ev.channel;
      appendDebug(
        `[guest] ondatachannel (label=${ch.label} id=${ch.id} state=${ch.readyState})`
      );
      dcRef.current = ch;

      let meta: {
        name: string;
        size: number;
        mimeType: string;
      } | null = null;
      let received = 0;
      const parts: Uint8Array[] = [];

      ch.onmessage = (e) => {
        if (typeof e.data === "string") {
          try {
            const m = JSON.parse(e.data) as {
              type?: string;
              name?: string;
              size?: number;
              mimeType?: string;
            };
            if (m.type === "meta" && m.name && m.size !== undefined) {
              meta = {
                name: m.name,
                size: m.size,
                mimeType: m.mimeType ?? "application/octet-stream",
              };
              received = 0;
              parts.length = 0;
              setStatus(`Receiving ${meta.name}…`);
            }
          } catch {
            /* ignore */
          }
          return;
        }

        if (!meta) return;
        const chunk = new Uint8Array(e.data as ArrayBuffer);
        parts.push(chunk);
        received += chunk.byteLength;
        setProgress(Math.round((received / meta.size) * 100));

        if (received >= meta.size) {
          const blob = new Blob(parts as BlobPart[], {
            type: meta.mimeType,
          });
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = meta.name;
          a.click();
          URL.revokeObjectURL(url);
          setProgress(null);
          setStatus("Download started. Waiting for more files or close when done.");
        }
      };

      ch.onopen = () => {
        appendDebug(`[guest] dataChannel onopen (readyState=${ch.readyState})`);
        setConnected(true);
        setStatus("Connected. Waiting for sender…");
      };

      ch.onerror = () => {
        appendDebug("[guest] dataChannel onerror");
      };

      ch.onclose = () => {
        appendDebug(`[guest] dataChannel onclose (readyState=${ch.readyState})`);
      };
    };

    let guestPollN = 0;
    const guestPollLoop = async () => {
      if (abortRef.current) return;
      if (guestPollBusy.current) {
        pollRef.current = window.setTimeout(() => void guestPollLoop(), POLL_MS);
        return;
      }
      guestPollBusy.current = true;
      try {
        guestPollN += 1;
        appendDebug(`--- guest signaling poll #${guestPollN} ---`);
        const res = await fetch(
          `/api/signaling/rooms/${code}?_=${Date.now()}`,
          {
            cache: "no-store",
            headers: { "Cache-Control": "no-cache" },
          }
        );
        if (!res.ok) {
          appendDebug(`[guest] signaling GET failed: HTTP ${res.status}`);
          return;
        }
        const data = (await res.json()) as {
          offer: RTCSessionDescriptionInit | null;
          answer: RTCSessionDescriptionInit | null;
          iceHost: (RTCIceCandidateInit | null)[];
          iceGuest: (RTCIceCandidateInit | null)[];
        };

        appendDebug(
          `[guest] snapshot: hasOffer=${!!data.offer} hasAnswer=${!!data.answer} iceHost=${data.iceHost.length} iceGuest=${data.iceGuest.length}`
        );

        if (data.offer && !pc.currentRemoteDescription) {
          try {
            appendDebug("[guest] setRemoteDescription(offer)…");
            await pc.setRemoteDescription(
              new RTCSessionDescription(data.offer)
            );
            logPc("after setRemoteDescription(offer)");
            const answer = await pc.createAnswer(DATA_ONLY_ANSWER);
            await pc.setLocalDescription(answer);
            logPc("after setLocalDescription(answer)");
            const postAns = await fetch(`/api/signaling/rooms/${code}`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                kind: "answer",
                sdp: pc.localDescription!,
              }),
            });
            if (!postAns.ok) {
              const t = await postAns.text();
              throw new Error(t || `Answer HTTP ${postAns.status}`);
            }
            appendDebug(
              `[guest] answer POST OK (${(pc.localDescription?.sdp?.length ?? 0)} chars sdp)`
            );
          } catch (e) {
            appendDebug(`[guest] handshake error: ${String(e)}`);
            console.error("Guest handshake", e);
            setError("Could not complete handshake. Is the room still open?");
          }
        }

        if (!pc.currentRemoteDescription) {
          return;
        }

        let added = 0;
        for (let i = hostIceIdx.current; i < data.iceHost.length; i++) {
          const raw = data.iceHost[i];
          try {
            await addIceCandidateSafe(pc, raw);
            hostIceIdx.current = i + 1;
            added++;
          } catch (e) {
            appendDebug(`[guest] addIceCandidate stopped: ${String(e)}`);
            break;
          }
        }
        if (added > 0) {
          appendDebug(`[guest] applied ${added} host ICE candidate(s)`);
        }
      } finally {
        guestPollBusy.current = false;
      }
      if (!abortRef.current) {
        pollRef.current = window.setTimeout(() => void guestPollLoop(), POLL_MS);
      }
    };
    appendDebug("[guest] starting signaling poll loop");
    pollRef.current = window.setTimeout(() => void guestPollLoop(), 0);
  }, [appendDebug, guestInput, pushIce, teardown]);

  const reset = useCallback(() => {
    teardown();
    setMode("home");
    setRoomCode("");
    setGuestInput("");
    setStatus("");
    setError(null);
    setJoinUrl("");
    setProgress(null);
    setConnected(false);
    setDebugLines([]);
    abortRef.current = false;
  }, [teardown]);

  return (
    <div className="mx-auto flex w-full max-w-lg flex-col gap-8 px-4 py-12 sm:px-6">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
          P2P file transfer
        </h1>
        <p className="text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
          Files go directly between browsers after a short room code handshake.
          Signaling uses Redis only (no file storage on the server). Anyone with
          the room code can join while it is open.
        </p>
      </header>

      {mode === "home" && (
        <div className="flex flex-col gap-4">
          <button
            type="button"
            onClick={() => void startHost()}
            className="rounded-xl bg-zinc-900 px-4 py-3 text-sm font-medium text-white transition hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
          >
            Send a file
          </button>
          <div className="rounded-xl border border-zinc-200 p-4 dark:border-zinc-800">
            <label className="block text-xs font-medium uppercase tracking-wide text-zinc-500">
              Receive with room code
            </label>
            <div className="mt-2 flex gap-2">
              <input
                value={guestInput}
                onChange={(e) =>
                  setGuestInput(e.target.value.toUpperCase().slice(0, 6))
                }
                placeholder="ABC123"
                className="min-w-0 flex-1 rounded-lg border border-zinc-300 bg-white px-3 py-2 font-mono text-lg tracking-widest dark:border-zinc-600 dark:bg-zinc-950"
                maxLength={6}
              />
              <button
                type="button"
                onClick={() => void joinAsGuest()}
                className="shrink-0 rounded-lg border border-zinc-300 px-4 py-2 text-sm font-medium dark:border-zinc-600"
              >
                Join
              </button>
            </div>
            <p className="mt-2 text-xs text-zinc-500">
              After scanning the QR or opening the link, tap Join — the page does
              not connect until you do.
            </p>
          </div>
        </div>
      )}

      {mode === "host" && (
        <section className="space-y-4">
          <p className="text-sm text-zinc-600 dark:text-zinc-400">{status}</p>
          <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-start">
            {joinUrl && (
              <div className="rounded-lg bg-white p-3 dark:bg-zinc-900">
                <QRCode value={joinUrl} size={160} />
              </div>
            )}
            <div className="space-y-2 text-center sm:text-left">
              <p className="text-xs font-medium uppercase text-zinc-500">
                Room code
              </p>
              <p className="font-mono text-3xl font-semibold tracking-widest text-zinc-900 dark:text-zinc-50">
                {roomCode}
              </p>
              <p className="break-all text-xs text-zinc-500">{joinUrl}</p>
            </div>
          </div>
          {connected && (
            <label className="flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed border-zinc-300 py-10 dark:border-zinc-600">
              <span className="text-sm text-zinc-600 dark:text-zinc-400">
                Tap to choose a file
              </span>
              <input
                type="file"
                className="sr-only"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = "";
                  if (f) void sendFile(f);
                }}
              />
            </label>
          )}
          {progress !== null && (
            <p className="text-center text-sm text-zinc-600 dark:text-zinc-400">
              Sending… {progress}%
            </p>
          )}
          <button
            type="button"
            onClick={reset}
            className="text-sm text-zinc-500 underline"
          >
            Cancel
          </button>
        </section>
      )}

      {mode === "guest" && (
        <section className="space-y-4">
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Room <span className="font-mono font-semibold">{roomCode}</span>
          </p>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">{status}</p>
          {progress !== null && (
            <p className="text-center text-sm text-zinc-600 dark:text-zinc-400">
              Receiving… {progress}%
            </p>
          )}
          <button
            type="button"
            onClick={reset}
            className="text-sm text-zinc-500 underline"
          >
            Leave
          </button>
        </section>
      )}

      {mode === "error" && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
          {error}
          <button
            type="button"
            onClick={reset}
            className="mt-2 block text-red-600 underline dark:text-red-300"
          >
            Back
          </button>
        </div>
      )}

      {error && mode !== "error" && (
        <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
      )}

      {(mode === "host" || mode === "guest") && (
        <section
          className="rounded-xl border border-zinc-300 bg-zinc-100/80 dark:border-zinc-700 dark:bg-zinc-900/60"
          aria-label="Connection debug log"
        >
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-200 px-3 py-2 dark:border-zinc-700">
            <p className="text-xs font-semibold uppercase tracking-wide text-zinc-600 dark:text-zinc-400">
              Connection log (for support)
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => void copyDebugLog()}
                className="rounded-md bg-zinc-200 px-2 py-1 text-xs font-medium text-zinc-800 hover:bg-zinc-300 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700"
              >
                Copy log
              </button>
              <button
                type="button"
                onClick={clearDebug}
                className="rounded-md border border-zinc-300 px-2 py-1 text-xs dark:border-zinc-600"
              >
                Clear
              </button>
            </div>
          </div>
          <pre
            className="max-h-72 overflow-y-auto whitespace-pre-wrap break-all px-3 py-2 font-mono text-[11px] leading-relaxed text-zinc-800 dark:text-zinc-300"
            suppressHydrationWarning
          >
            {debugLines.length === 0 ? (
              <span className="text-zinc-500">
                Log lines appear as the session runs (signaling polls, WebRTC
                states, data channel). Use Copy log after a failed attempt.
              </span>
            ) : (
              debugLines.map((l) => (
                <div key={l.id}>
                  <span className="text-zinc-500">{l.t}</span> {l.msg}
                </div>
              ))
            )}
          </pre>
        </section>
      )}
    </div>
  );
}

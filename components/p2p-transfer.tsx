"use client";

import QRCode from "react-qr-code";
import { useCallback, useEffect, useRef, useState } from "react";

const ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

const POLL_MS = 400;
const MAX_BUFFER = 256 * 1024;
const CHUNK_SIZE = 16 * 1024;

type UiMode = "home" | "host" | "guest" | "error";

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

export function P2PTransfer() {
  const [mode, setMode] = useState<UiMode>("home");
  const [roomCode, setRoomCode] = useState("");
  const [guestInput, setGuestInput] = useState("");
  const [status, setStatus] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [joinUrl, setJoinUrl] = useState("");
  const [progress, setProgress] = useState<number | null>(null);
  const [connected, setConnected] = useState(false);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const hostIceIdx = useRef(0);
  const guestIceIdx = useRef(0);
  const abortRef = useRef(false);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
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
    return () => teardown();
  }, [teardown]);

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
      await fetch(`/api/signaling/rooms/${code}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "ice", role, candidate }),
      });
    },
    []
  );

  const pollSignaling = useCallback(
    async (
      code: string,
      role: "host" | "guest",
      pc: RTCPeerConnection
    ) => {
      const res = await fetch(`/api/signaling/rooms/${code}`, {
        cache: "no-store",
      });
      if (!res.ok) return;
      const data = (await res.json()) as {
        offer: RTCSessionDescriptionInit | null;
        answer: RTCSessionDescriptionInit | null;
        iceHost: (RTCIceCandidateInit | null)[];
        iceGuest: (RTCIceCandidateInit | null)[];
      };

      if (role === "host") {
        if (data.answer && !pc.currentRemoteDescription) {
          try {
            await pc.setRemoteDescription(
              new RTCSessionDescription(data.answer)
            );
          } catch {
            /* ignore */
          }
        }
        const list = data.iceGuest;
        for (let i = guestIceIdx.current; i < list.length; i++) {
          const raw = list[i];
          guestIceIdx.current = i + 1;
          if (raw === null) continue;
          try {
            await pc.addIceCandidate(raw);
          } catch {
            /* ignore */
          }
        }
      } else {
        const list = data.iceHost;
        for (let i = hostIceIdx.current; i < list.length; i++) {
          const raw = list[i];
          hostIceIdx.current = i + 1;
          if (raw === null) continue;
          try {
            await pc.addIceCandidate(raw);
          } catch {
            /* ignore */
          }
        }
      }
    },
    []
  );

  const startHost = useCallback(async () => {
    setError(null);
    setProgress(null);
    setConnected(false);
    teardown();
    abortRef.current = false;
    setStatus("Creating room…");

    const roomRes = await fetch("/api/signaling/rooms", { method: "POST" });
    if (!roomRes.ok) {
      const j = (await roomRes.json().catch(() => ({}))) as { error?: string };
      setError(
        j.error ??
          "Could not create a room. Configure Redis (Upstash) on Vercel."
      );
      setMode("error");
      return;
    }

    const { roomCode: code } = (await roomRes.json()) as { roomCode: string };
    setRoomCode(code);
    const origin = window.location.origin;
    const path = window.location.pathname || "/";
    setJoinUrl(`${origin}${path}?join=${code}`);
    setMode("host");
    setStatus("Connecting…");

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    pcRef.current = pc;

    const dc = pc.createDataChannel("file", { ordered: true });
    dcRef.current = dc;

    dc.onopen = () => {
      if (abortRef.current) return;
      setConnected(true);
      setStatus("Connected. Choose a file to send.");
    };

    dc.onerror = () => {
      setError("Data channel error");
    };

    pc.onicecandidate = (e) => {
      void pushIce(code, "host", e.candidate);
    };

    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await fetch(`/api/signaling/rooms/${code}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "offer",
          sdp: pc.localDescription!,
        }),
      });
    } catch {
      setError("Could not start WebRTC offer");
      setMode("error");
      teardown();
      return;
    }

    pollRef.current = setInterval(() => {
      void pollSignaling(code, "host", pc);
    }, POLL_MS);
  }, [pollSignaling, pushIce, teardown]);

  const sendFile = useCallback(
    async (file: File) => {
      const dc = dcRef.current;
      if (!dc || dc.readyState !== "open") {
        setError("Channel not ready");
        return;
      }
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

      setProgress(null);
      setStatus("Sent. You can send another file or close the tab.");
    },
    []
  );

  const joinAsGuest = useCallback(async () => {
    const code = guestInput.trim().toUpperCase();
    if (!/^[A-Z2-9]{6}$/.test(code)) {
      setError("Enter a 6-character room code.");
      return;
    }

    setError(null);
    setProgress(null);
    setConnected(false);
    teardown();
    abortRef.current = false;
    setRoomCode(code);
    setMode("guest");
    setStatus("Connecting…");

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    pcRef.current = pc;

    pc.onicecandidate = (e) => {
      void pushIce(code, "guest", e.candidate);
    };

    pc.ondatachannel = (ev) => {
      const ch = ev.channel;
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
        setConnected(true);
        setStatus("Connected. Waiting for sender…");
      };
    };

    pollRef.current = setInterval(async () => {
      const res = await fetch(`/api/signaling/rooms/${code}`, {
        cache: "no-store",
      });
      if (!res.ok) return;
      const data = (await res.json()) as {
        offer: RTCSessionDescriptionInit | null;
        answer: RTCSessionDescriptionInit | null;
        iceHost: (RTCIceCandidateInit | null)[];
        iceGuest: (RTCIceCandidateInit | null)[];
      };

      if (data.offer && !pc.remoteDescription) {
        try {
          await pc.setRemoteDescription(
            new RTCSessionDescription(data.offer)
          );
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          await fetch(`/api/signaling/rooms/${code}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              kind: "answer",
              sdp: pc.localDescription!,
            }),
          });
        } catch {
          setError("Could not complete handshake");
        }
      }

      for (let i = hostIceIdx.current; i < data.iceHost.length; i++) {
        const raw = data.iceHost[i];
        hostIceIdx.current = i + 1;
        if (raw === null) continue;
        try {
          await pc.addIceCandidate(raw);
        } catch {
          /* ignore */
        }
      }
    }, POLL_MS);
  }, [guestInput, pushIce, teardown]);

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
    </div>
  );
}

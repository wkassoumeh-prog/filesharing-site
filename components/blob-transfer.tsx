"use client";

import { upload } from "@vercel/blob/client";
import QRCode from "react-qr-code";
import { useCallback, useState } from "react";

/** Blob pathname segment: no path separators, reasonable length. */
function safeBlobPath(name: string): string {
  const base = name.replace(/[/\\]/g, "_").trim() || "file";
  return `uploads/${base.slice(0, 200)}`;
}

const MULTIPART_THRESHOLD = 100 * 1024 * 1024;

type Phase = "idle" | "uploading" | "done";

export function BlobTransfer() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState<number | null>(null);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [filename, setFilename] = useState("");
  const [error, setError] = useState<string | null>(null);

  const reset = useCallback(() => {
    setPhase("idle");
    setProgress(null);
    setShareUrl(null);
    setFilename("");
    setError(null);
  }, []);

  const onFile = useCallback(async (file: File) => {
    setError(null);
    setFilename(file.name);
    setPhase("uploading");
    setProgress(0);
    try {
      const pathname = safeBlobPath(file.name);
      const result = await upload(pathname, file, {
        access: "public",
        handleUploadUrl: "/api/blob/upload",
        multipart: file.size > MULTIPART_THRESHOLD,
        onUploadProgress: ({ percentage }) => {
          setProgress(Math.round(percentage));
        },
      });
      setShareUrl(result.url);
      setPhase("done");
      setProgress(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("idle");
      setProgress(null);
    }
  }, []);

  const copyLink = useCallback(() => {
    if (shareUrl) void navigator.clipboard.writeText(shareUrl);
  }, [shareUrl]);

  return (
    <div className="mx-auto flex w-full max-w-lg flex-col gap-8 px-4 py-12 sm:px-6">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
          File sharing
        </h1>
        <p className="text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
          Files are uploaded to Vercel Blob and shared with a public link. Anyone
          with the link can download the file.
        </p>
      </header>

      {phase === "idle" && (
        <label className="flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed border-zinc-300 py-12 dark:border-zinc-600">
          <span className="text-sm text-zinc-600 dark:text-zinc-400">
            Tap to choose a file
          </span>
          <input
            type="file"
            className="sr-only"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) void onFile(f);
            }}
          />
        </label>
      )}

      {phase === "uploading" && (
        <div className="space-y-2">
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Uploading {filename}…
          </p>
          {progress !== null && (
            <>
              <div className="h-2 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
                <div
                  className="h-full bg-zinc-900 transition-[width] dark:bg-zinc-100"
                  style={{ width: `${progress}%` }}
                />
              </div>
              <p className="text-center text-sm text-zinc-500">{progress}%</p>
            </>
          )}
        </div>
      )}

      {phase === "done" && shareUrl && (
        <section className="space-y-4">
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Share this link:
          </p>
          <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-start">
            <div className="rounded-lg bg-white p-3 dark:bg-zinc-900">
              <QRCode value={shareUrl} size={160} />
            </div>
            <div className="min-w-0 flex-1 space-y-2">
              <p className="break-all font-mono text-xs text-zinc-700 dark:text-zinc-300">
                {shareUrl}
              </p>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={copyLink}
                  className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
                >
                  Copy link
                </button>
                <a
                  href={shareUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded-lg border border-zinc-300 px-4 py-2 text-sm font-medium transition hover:bg-zinc-100 dark:border-zinc-600 dark:hover:bg-zinc-800"
                >
                  Open
                </a>
                <button
                  type="button"
                  onClick={reset}
                  className="rounded-lg border border-zinc-300 px-4 py-2 text-sm font-medium dark:border-zinc-600"
                >
                  Upload another
                </button>
              </div>
            </div>
          </div>
        </section>
      )}

      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
          {error}
          {phase === "idle" && (
            <button
              type="button"
              onClick={() => setError(null)}
              className="mt-2 block text-red-600 underline dark:text-red-300"
            >
              Dismiss
            </button>
          )}
        </div>
      )}
    </div>
  );
}

import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_BYTES = 5 * 1024 * 1024 * 1024; // 5 GB (Vercel Blob client-upload limit tier)

export async function POST(request: Request) {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return Response.json(
      {
        error:
          "Blob storage is not configured. Create a Blob store in Vercel and set BLOB_READ_WRITE_TOKEN.",
      },
      { status: 503 }
    );
  }

  let body: HandleUploadBody;
  try {
    body = (await request.json()) as HandleUploadBody;
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  try {
    const jsonResponse = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async () => {
        return {
          addRandomSuffix: true,
          maximumSizeInBytes: MAX_BYTES,
        };
      },
    });
    return Response.json(jsonResponse);
  } catch (e) {
    const message = e instanceof Error ? e.message : "Upload handler error";
    return Response.json({ error: message }, { status: 400 });
  }
}

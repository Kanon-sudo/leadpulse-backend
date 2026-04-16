import http from "node:http";
import { URL } from "node:url";
import { pingDatabase, syncUserSession } from "./db.js";
import { verifyFirebaseIdToken } from "./firebase-auth.js";

const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 8787);

function json(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": process.env.CORS_ORIGIN || "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  });
  response.end(JSON.stringify(payload));
}

function getBearerToken(request) {
  const authorization = String(request.headers.authorization || "");
  if (!authorization.startsWith("Bearer ")) {
    return "";
  }
  return authorization.slice("Bearer ".length).trim();
}

async function readJsonBody(request) {
  const chunks = [];

  for await (const chunk of request) {
    chunks.push(chunk);
  }

  if (!chunks.length) {
    return {};
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  return JSON.parse(raw);
}

const server = http.createServer(async (request, response) => {
  if (!request.url) {
    json(response, 400, { ok: false, error: "Missing URL" });
    return;
  }

  if (request.method === "OPTIONS") {
    response.writeHead(204, {
      "Access-Control-Allow-Origin": process.env.CORS_ORIGIN || "*",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    });
    response.end();
    return;
  }

  const url = new URL(request.url, `http://${request.headers.host}`);

  try {
    if (request.method === "GET" && url.pathname === "/health") {
      json(response, 200, {
        ok: true,
        service: "leadpulse-backend",
        environment: process.env.NODE_ENV || "development",
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/db/ping") {
      const database = await pingDatabase();
      json(response, 200, {
        ok: true,
        database,
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/auth/session") {
      const body = await readJsonBody(request);
      const idToken = getBearerToken(request) || String(body.idToken || "").trim();

      if (!idToken) {
        json(response, 400, {
          ok: false,
          error: "Missing idToken. Send it in Authorization: Bearer <token> or as { idToken }.",
        });
        return;
      }

      const verifiedToken = await verifyFirebaseIdToken(idToken);
      const session = await syncUserSession({
        ...verifiedToken,
        source: String(body.source || "web"),
      });

      json(response, 200, {
        ok: true,
        user: session.user,
        workspace: session.workspace,
      });
      return;
    }

    json(response, 404, { ok: false, error: "Not found" });
  } catch (error) {
    json(response, 500, {
      ok: false,
      error: error instanceof Error ? error.message : "Unknown server error",
    });
  }
});

server.listen(port, host, () => {
  console.log(`Leadpulse backend listening on http://${host}:${port}`);
});

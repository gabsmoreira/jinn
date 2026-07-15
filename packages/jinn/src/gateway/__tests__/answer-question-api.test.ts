import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { JinnConfig } from "../../shared/types.js";
import type { ApiContext } from "../api.js";

// Isolate the registry before importing API/registry modules.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-answer-question-api-"));
process.env.JINN_HOME = tmp;

type Api = typeof import("../api.js");
type Reg = typeof import("../../sessions/registry.js");
let api: Api;
let reg: Reg;

beforeAll(async () => {
  reg = await import("../../sessions/registry.js");
  api = await import("../api.js");
  reg.initDb();
});

beforeEach(() => {
  const db = reg.initDb();
  db.exec("DELETE FROM messages; DELETE FROM queue_items; DELETE FROM sessions;");
});

function cfg(): JinnConfig {
  return {
    gateway: { host: "127.0.0.1", port: 7777 },
    engines: { default: "claude", claude: { bin: "claude", model: "opus" } },
    models: {
      claude: {
        default: "opus",
        models: [{ id: "opus", label: "Opus", supportsEffort: true, effortLevels: ["low", "medium", "high"] }],
      },
    },
    connectors: {},
  } as unknown as JinnConfig;
}

function makeReq(method: string, url: string, body?: unknown): IncomingMessage {
  const raw = body === undefined ? "" : JSON.stringify(body);
  const req = Readable.from(raw ? [Buffer.from(raw)] : []) as IncomingMessage;
  req.method = method;
  req.url = url;
  req.headers = { host: "localhost" };
  (req as any).socket = { remoteAddress: "127.0.0.1" };
  return req;
}

function makeRes() {
  let status = 200;
  const chunks: Buffer[] = [];
  const res = {
    writeHead(s: number) {
      status = s;
      return this;
    },
    end(buf?: Buffer | string) {
      if (buf) chunks.push(Buffer.isBuffer(buf) ? buf : Buffer.from(buf));
      return this;
    },
  } as unknown as ServerResponse;
  return {
    res,
    get status() {
      return status;
    },
    get body() {
      const raw = Buffer.concat(chunks).toString("utf-8");
      return raw ? JSON.parse(raw) : null;
    },
  };
}

function ctx(overrides: Partial<ApiContext> = {}): ApiContext {
  return {
    getConfig: cfg,
    connectors: new Map(),
    startTime: Date.now(),
    emit: vi.fn(),
    sessionManager: {
      getQueue: () => ({ getPendingCount: () => 0, getTransportState: () => "idle" }),
      getEngines: () => new Map(),
    },
    ...overrides,
  } as unknown as ApiContext;
}

describe("POST /api/sessions/:id/answer-question", () => {
  it("404s for an unknown session", async () => {
    const cap = makeRes();
    await api.handleApiRequest(
      makeReq("POST", "/api/sessions/does-not-exist/answer-question", { selections: [0] }),
      cap.res,
      ctx(),
    );
    expect(cap.status).toBe(404);
  });

  it("400s when selections is missing or not a number[]", async () => {
    const session = reg.createSession({
      engine: "claude",
      source: "web",
      sourceRef: "web:answer-question-bad-body",
      model: "opus",
      effortLevel: "high",
    });

    for (const body of [{}, { selections: "nope" }, { selections: [0, "1"] }, { selections: null }]) {
      const cap = makeRes();
      await api.handleApiRequest(
        makeReq("POST", `/api/sessions/${session.id}/answer-question`, body),
        cap.res,
        ctx(),
      );
      expect(cap.status).toBe(400);
      expect(cap.body).toEqual({ error: "selections must be a number[]" });
    }
  });

  it("409s when there is no warm PTY for the session", async () => {
    const session = reg.createSession({
      engine: "claude",
      source: "web",
      sourceRef: "web:answer-question-no-pty",
      model: "opus",
      effortLevel: "high",
    });

    const cap = makeRes();
    await api.handleApiRequest(
      makeReq("POST", `/api/sessions/${session.id}/answer-question`, { selections: [0] }),
      cap.res,
      ctx({ interactiveClaudeEngine: { answerQuestion: () => false } as any }),
    );
    expect(cap.status).toBe(409);
    expect(cap.body).toEqual({ error: "no active session" });
  });

  it("200s and drives the engine when a warm PTY answers the question", async () => {
    const session = reg.createSession({
      engine: "claude",
      source: "web",
      sourceRef: "web:answer-question-ok",
      model: "opus",
      effortLevel: "high",
    });
    const answerQuestion = vi.fn().mockReturnValue(true);

    const cap = makeRes();
    await api.handleApiRequest(
      makeReq("POST", `/api/sessions/${session.id}/answer-question`, { selections: [1, 2] }),
      cap.res,
      ctx({ interactiveClaudeEngine: { answerQuestion } as any }),
    );

    expect(cap.status).toBe(200);
    expect(cap.body).toEqual({ status: "answered", sessionId: session.id });
    expect(answerQuestion).toHaveBeenCalledWith(session.id, [1, 2]);
  });
});

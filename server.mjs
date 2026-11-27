import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { classify as mockClassify } from "./mock-ai.mjs";

const MODEL_TIMEOUT_MS = 300;
const TOPICS = new Set(["delivery", "pricing", "other"]);
const INVALID_INPUT = { status: "invalid_input" };
const MANUAL_REVIEW = { status: "manual_review", topic: null, draft: null };

const html = await readFile(new URL("./index.html", import.meta.url));

// Сервер без listen: тесты поднимают его на свободном порту и могут подменить модель.
export function createApp({ classify = mockClassify, timeoutMs = MODEL_TIMEOUT_MS, log = console.warn } = {}) {
  return createServer(async function handleRequest(request, response) {
    if (request.method === "GET" && request.url === "/") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(html);
      return;
    }
    if (request.method !== "POST" || request.url !== "/api/triage") {
      return json(response, 404, { status: "not_found" });
    }
    try {
      const text = await readText(request);
      if (text === null) return json(response, 400, INVALID_INPUT);
      return json(response, 200, await triage(text, { classify, timeoutMs, log }));
    } catch (error) {
      log("[triage] server_error:", error);
      json(response, 500, { status: "server_error" });
    }
  });
}

// Любой сбой модели заканчивается ручным разбором: менеджер не должен получить мусор как готовый ответ.
export async function triage(text, { classify = mockClassify, timeoutMs = MODEL_TIMEOUT_MS, log = console.warn } = {}) {
  let raw;
  try {
    raw = await withTimeout((signal) => classify(text, { signal }), timeoutMs);
  } catch (error) {
    log("[triage] manual_review:", error.message);
    return MANUAL_REVIEW;
  }
  const reply = parseModelReply(raw);
  if (reply === null) {
    log("[triage] manual_review: model reply failed validation");
    return MANUAL_REVIEW;
  }
  return { status: "ready", ...reply };
}

// Единственное место, где проверяется результат AI: формат, тема из списка, непустой черновик.
export function parseModelReply(raw) {
  let reply;
  try {
    reply = JSON.parse(raw);
  } catch {
    return null;
  }
  if (reply === null || typeof reply !== "object") return null;
  const { topic, draft } = reply;
  if (!TOPICS.has(topic)) return null;
  if (typeof draft !== "string" || draft.trim() === "") return null;
  return { topic, draft };
}

// Возвращает текст заявки или null, если тело запроса не подходит под контракт.
async function readText(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
  if (body === null || typeof body !== "object") return null;
  if (typeof body.text !== "string" || body.text.trim() === "") return null;
  return body.text;
}

// Отменяет вызов через signal и перестаёт ждать, даже если модель сигнал игнорирует.
async function withTimeout(run, timeoutMs) {
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`model did not answer in ${timeoutMs} ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([run(controller.signal), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

function json(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  createApp().listen(Number(process.env.PORT || 3000), "127.0.0.1");
}

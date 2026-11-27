import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { createApp, parseModelReply } from "../server.mjs";

const MANUAL_REVIEW = { status: "manual_review", topic: null, draft: null };
const silent = () => {};

async function withServer(options, run) {
  const server = createApp({ log: silent, ...options });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/api/triage`;
  try {
    return await run((body) => post(url, body));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function post(url, body) {
  const reply = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: reply.status, body: await reply.json() };
}

describe("POST /api/triage с выданным имитатором", () => {
  let server;
  let send;

  before(async () => {
    server = createApp({ log: silent });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${server.address().port}/api/triage`;
    send = (body) => post(url, body);
  });

  after(() => new Promise((resolve) => server.close(resolve)));

  test("обычная заявка: тема и непустой черновик", async () => {
    const pricing = await send({ text: "Какая цена у тарифа?" });
    assert.equal(pricing.status, 200);
    assert.equal(pricing.body.status, "ready");
    assert.equal(pricing.body.topic, "pricing");
    assert.ok(pricing.body.draft.trim().length > 0);

    const delivery = await send({ text: "Когда будет доставка?" });
    assert.equal(delivery.body.topic, "delivery");

    const other = await send({ text: "Здравствуйте" });
    assert.equal(other.body.topic, "other");
  });

  const invalidBodies = {
    "пустая строка": { text: "" },
    "только пробелы": { text: "   \n" },
    "поля text нет": {},
    "text не строка": { text: 42 },
    "text равен null": { text: null },
    "тело не объект": "[]",
    "тело равно null": "null",
    "битый JSON": "{ text: ",
    "пустое тело": "",
  };
  for (const [name, body] of Object.entries(invalidBodies)) {
    test(`некорректный ввод (${name}): 400 invalid_input`, async () => {
      const reply = await send(body);
      assert.equal(reply.status, 400);
      assert.deepEqual(reply.body, { status: "invalid_input" });
    });
  }

  for (const marker of ["[timeout]", "[error]", "[bad-json]", "[bad-topic]", "[empty-draft]"]) {
    test(`сбой модели ${marker}: ручной разбор без темы и черновика`, async () => {
      const reply = await send({ text: `Сколько стоит доставка? ${marker}` });
      assert.equal(reply.status, 200);
      assert.deepEqual(reply.body, MANUAL_REVIEW);
    });
  }

  test("таймаут: ответ приходит раньше, чем имитатор закончил бы работу", async () => {
    const startedAt = performance.now();
    const reply = await send({ text: "Где заказ? [timeout]" });
    const elapsedMs = performance.now() - startedAt;
    assert.deepEqual(reply.body, MANUAL_REVIEW);
    assert.ok(elapsedMs < 900, `ожидание модели не ограничено: ${Math.round(elapsedMs)} мс`);
  });
});

describe("POST /api/triage с подменённой моделью", () => {
  test("модель игнорирует отмену и не отвечает: всё равно ручной разбор", async () => {
    const hangingModel = () => new Promise(() => {});
    const reply = await withServer({ classify: hangingModel, timeoutMs: 50 }, (send) => send({ text: "Заявка" }));
    assert.deepEqual(reply.body, MANUAL_REVIEW);
  });

  test("модель получает signal и видит отмену по таймауту", async () => {
    let signal;
    const slowModel = (text, options) => {
      signal = options.signal;
      return new Promise(() => {});
    };
    await withServer({ classify: slowModel, timeoutMs: 50 }, (send) => send({ text: "Заявка" }));
    assert.equal(signal.aborted, true);
  });

  test("после сбоя следующий запрос разбирается как обычно", async () => {
    let calls = 0;
    const flakyModel = async () => {
      calls += 1;
      if (calls === 1) throw new Error("provider down");
      return JSON.stringify({ topic: "other", draft: "Уточним детали." });
    };
    await withServer({ classify: flakyModel }, async (send) => {
      assert.deepEqual((await send({ text: "Заявка" })).body, MANUAL_REVIEW);
      assert.deepEqual((await send({ text: "Заявка" })).body, { status: "ready", topic: "other", draft: "Уточним детали." });
    });
  });
});

describe("parseModelReply", () => {
  const rejected = {
    "не JSON": "model output is not JSON",
    "JSON null": "null",
    "массив": "[]",
    "неизвестная тема": JSON.stringify({ topic: "refund", draft: "Текст" }),
    "тема из прототипа объекта": JSON.stringify({ topic: "constructor", draft: "Текст" }),
    "нет темы": JSON.stringify({ draft: "Текст" }),
    "черновик из пробелов": JSON.stringify({ topic: "other", draft: "  " }),
    "черновик не строка": JSON.stringify({ topic: "other", draft: 7 }),
    "нет черновика": JSON.stringify({ topic: "other" }),
  };
  for (const [name, raw] of Object.entries(rejected)) {
    test(`отклоняет: ${name}`, () => assert.equal(parseModelReply(raw), null));
  }

  test("принимает допустимый ответ и отбрасывает лишние поля", () => {
    const raw = JSON.stringify({ topic: "delivery", draft: "Привезём завтра.", secret: "x" });
    assert.deepEqual(parseModelReply(raw), { topic: "delivery", draft: "Привезём завтра." });
  });
});

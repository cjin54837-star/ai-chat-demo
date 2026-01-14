const DEFAULT_BASE_URL = "https://yunwu.ai";
const MAX_RETRIES_PER_KEY = 3;
const BACKOFF_BASE_MS = 2500;

// 显示名 -> 上游模型名
const MODEL_MAP = {
  // 旧的（保留）
  "GPT-4o": { upstreamModel: "gpt-4o", endpoint: "chat", keyPool: "OPENAI" },

  // 你要的 GPT 模型
  "GPT-5.2": { upstreamModel: "gpt-5.2", endpoint: "chat", keyPool: "OPENAI" },
  "GPT-5.1": { upstreamModel: "gpt-5.1", endpoint: "chat", keyPool: "OPENAI" },
  "GPT-5.1 Thinking": { upstreamModel: "gpt-5.1-thinking-all", endpoint: "chat", keyPool: "OPENAI" },
  "GPT-5.2 Codex": { upstreamModel: "gpt-5-codex", endpoint: "chat", keyPool: "OPENAI" },
  "GPT-5.2 Chat Latest": { upstreamModel: "gpt-5.2-chat-latest", endpoint: "chat", keyPool: "OPENAI" },

  // ✅ gpt-5.2-pro：按你给的信息，只支持 /v1/responses
  "gpt-5.2-pro": { upstreamModel: "gpt-5.2-pro", endpoint: "responses", keyPool: "OPENAI" },

  // 旧的（保留）
  "Claude Opus 4.5": { upstreamModel: "claude-opus-4-5-20251101", endpoint: "chat", keyPool: "OPENAI" },
  "Grok-4.1": { upstreamModel: "grok-4.1", endpoint: "chat", keyPool: "OPENAI" },

  "Gemini 3 Pro": { upstreamModel: "gemini-3-pro-preview", endpoint: "chat", keyPool: "GEMINI" },
  "Gemini 3 Pro Preview": { upstreamModel: "gemini-3-pro-preview", endpoint: "chat", keyPool: "GEMINI" },
  "Gemini 3 Pro Preview 11-2025": { upstreamModel: "gemini-3-pro-preview-11-2025", endpoint: "chat", keyPool: "GEMINI" },
  "Gemini 3 Pro Preview Thinking": { upstreamModel: "gemini-3-pro-preview-thinking", endpoint: "chat", keyPool: "GEMINI" },
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function parseKeys(raw) {
  if (!raw) return [];
  return String(raw)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

async function safeReadJson(resp) {
  const text = await resp.text();
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

function buildUrl(baseUrl, endpoint) {
  return endpoint === "responses"
    ? `${baseUrl}/v1/responses`
    : `${baseUrl}/v1/chat/completions`;
}

function buildPayload(endpoint, model, messages, temperature) {
  if (endpoint === "responses") {
    // Responses API：用 input 承载 messages（多数代理兼容）
    return { model, input: messages, temperature };
  }
  return { model, messages, temperature, stream: false };
}

function extractText(endpoint, data) {
  if (endpoint === "responses") {
    if (typeof data?.output_text === "string" && data.output_text.trim()) return data.output_text;

    const out0 = data?.output?.[0];
    const c0 = out0?.content?.[0];
    if (typeof c0?.text === "string" && c0.text.trim()) return c0.text;

    // 兜底：有些代理仍返回 chat 风格
    const chatText = data?.choices?.[0]?.message?.content;
    return typeof chatText === "string" ? chatText : "";
  }

  const text = data?.choices?.[0]?.message?.content;
  return typeof text === "string" ? text : "";
}

function getKeyPool(env, poolName) {
  // 你的省钱方案：把多个 key 塞进 YUNWU_API_KEY（逗号分隔）
  if (poolName === "OPENAI") {
    return parseKeys(env.YUNWU_API_KEY);
  }
  if (poolName === "GEMINI") {
    // Gemini：优先 promo，再 premium（都支持逗号分隔）
    const promo = parseKeys(env.YUNWU_GEMINI_PROMO_KEY);
    const premium = parseKeys(env.YUNWU_GEMINI_PREMIUM_KEY);
    return [...promo, ...premium];
  }
  return [];
}

async function callUpstreamWithRetries({ env, endpoint, model, messages, temperature, keys }) {
  const baseUrl = env.UPSTREAM_BASE_URL || DEFAULT_BASE_URL;
  const url = buildUrl(baseUrl, endpoint);

  let lastDetail = "";
  let lastRaw = null;
  let lastStatus = 500;

  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];

    for (let attempt = 1; attempt <= MAX_RETRIES_PER_KEY; attempt++) {
      try {
        const resp = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${key}`,
          },
          body: JSON.stringify(buildPayload(endpoint, model, messages, temperature)),
        });

        const data = await safeReadJson(resp);
        lastRaw = data;
        lastStatus = resp.status;

        if (resp.status === 429) {
          lastDetail = "429 Too Many Requests";
          const delay = Math.pow(2, attempt) * BACKOFF_BASE_MS; // 2500, 5000, 10000...
          await sleep(delay);
          continue; // 同一个 key 再试
        }

        if (resp.status === 401 || resp.status === 403) {
          lastDetail = `Auth failed (${resp.status})`;
          break; // 换下一个 key
        }

        const text = extractText(endpoint, data);
        if (resp.ok && text) {
          return {
            ok: true,
            text,
            raw: data,
            meta: { endpoint, model, keyIndex: i + 1, attempt, totalKeys: keys.length },
          };
        }

        lastDetail = data?.error?.message || JSON.stringify(data);
        break; // 不是 429 就不在同 key 内死磕
      } catch (e) {
        lastDetail = String(e?.message || e);
        lastStatus = 500;
      }
    }
  }

  return {
    ok: false,
    status: lastStatus === 429 ? 429 : 503,
    error: "所有渠道均失败，请稍后再试",
    detail: lastDetail,
    raw: lastRaw,
    meta: { endpoint, model },
  };
}

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === "OPTIONS") return new Response(null, { status: 204 });
  if (request.method !== "POST") return jsonResponse({ ok: false, error: "Method not allowed" }, 405);

  const accessPassword = env.ACCESS_PASSWORD || "";

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ ok: false, error: "Body must be JSON" }, 400);
  }

  const action = body.action;

  // 1) 密码验证
  if (action === "check_password") {
    if (!accessPassword) return jsonResponse({ ok: false, error: "Missing ACCESS_PASSWORD" }, 500);
    const pwd = String(body.password || "");
    if (pwd === accessPassword) return jsonResponse({ ok: true }, 200);
    return jsonResponse({ ok: false, error: "密码错误" }, 401);
  }

  // 2) chat
  if (action !== "chat") return jsonResponse({ ok: false, error: "Unknown action" }, 400);

  if (accessPassword) {
    const pwd = String(body.password || "");
    if (pwd !== accessPassword) {
      return jsonResponse({ ok: false, error: "未授权：密码错误或缺失" }, 401);
    }
  }

  const displayName = String(body.model || "");
  const cfg = MODEL_MAP[displayName];
  if (!cfg) return jsonResponse({ ok: false, error: `不支持的模型：${displayName}` }, 400);

  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    return jsonResponse({ ok: false, error: "messages required" }, 400);
  }

  const temperature = typeof body.temperature === "number" ? body.temperature : 0.7;

  const keys = getKeyPool(env, cfg.keyPool);
  if (!keys.length) {
    const need =
      cfg.keyPool === "GEMINI"
        ? "缺少 YUNWU_GEMINI_PROMO_KEY / YUNWU_GEMINI_PREMIUM_KEY"
        : "缺少 YUNWU_API_KEY";
    return jsonResponse({ ok: false, error: need }, 500);
  }

  const result = await callUpstreamWithRetries({
    env,
    endpoint: cfg.endpoint,
    model: cfg.upstreamModel,
    messages,
    temperature,
    keys,
  });

  if (!result.ok) {
    return jsonResponse(
      { ok: false, error: result.error, detail: result.detail, meta: result.meta, raw: result.raw },
      result.status
    );
  }

  // 统一返回格式：choices[0].message.content
  return jsonResponse({
    ok: true,
    choices: [{ message: { content: result.text } }],
    meta: result.meta,
  }, 200);
}

const DEFAULT_BASE_URL = "https://yunwu.ai";
const PATH_CHAT = "/v1/chat/completions";
const PATH_RESPONSES = "/v1/responses";

const MAX_RETRIES_PER_KEY = 2;
const BACKOFF_BASE_MS = 1500;

// 旧模型不删 + 新增 gpt-5.2-pro
const MODEL_MAP = {
  "GPT-5.2": { upstreamModel: "gpt-5.2", supports: ["chat", "responses"], route: "GPT_CHAIN" },
  "GPT-5.1": { upstreamModel: "gpt-5.1", supports: ["chat", "responses"], route: "GPT_CHAIN" },
  "gpt-5.2-pro": { upstreamModel: "gpt-5.2-pro", supports: ["responses"], route: "OFFICIAL_PRO_ONLY" },
  "GPT-5.2 Codex": { upstreamModel: "gpt-5-codex", supports: ["chat", "responses"], route: "CODEX_ONLY" },
  "GPT-5.2 Chat Latest": { upstreamModel: "gpt-5.2-chat-latest", supports: ["chat", "responses"], route: "GPT_CHAIN" },

  // 旧：保留
  "GPT-5.1 Thinking": { upstreamModel: "gpt-5.1-thinking-all", supports: ["chat", "responses"], route: "GPT_CHAIN" },
  "Claude Opus 4.5": { upstreamModel: "claude-opus-4-5-20251101", supports: ["chat"], route: "REVERSE_ONLY" },
  "Grok-4.1": { upstreamModel: "grok-4.1", supports: ["chat"], route: "REVERSE_ONLY" },

  "Gemini 3 Pro Preview": { upstreamModel: "gemini-3-pro-preview", supports: ["chat"], route: "GEMINI" },
  "Gemini 3 Pro Preview 11-2025": { upstreamModel: "gemini-3-pro-preview-11-2025", supports: ["chat"], route: "GEMINI" },
  "Gemini 3 Pro Preview Thinking": { upstreamModel: "gemini-3-pro-preview-thinking", supports: ["chat"], route: "GEMINI" },
};

// GPT 链路优先级（你指定）
const GPT_CHAIN = ["PROMO", "DEFAULT", "REVERSE", "AZ", "OFFICIAL"];

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
  return String(raw).split(",").map(s => s.trim()).filter(Boolean);
}

async function safeReadJson(resp) {
  const text = await resp.text();
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

function pickEndpoint(cfg, displayName) {
  if (displayName === "gpt-5.2-pro") return "responses";
  if (cfg.supports.includes("chat")) return "chat";
  return "responses";
}

function buildUrl(baseUrl, endpointType) {
  return endpointType === "chat" ? `${baseUrl}${PATH_CHAT}` : `${baseUrl}${PATH_RESPONSES}`;
}

function buildPayload(endpointType, model, messages, temperature) {
  if (endpointType === "chat") {
    return { model, messages, temperature, stream: false };
  }
  // responses：用 input 承载 messages
  return { model, input: messages, temperature };
}

function extractText(endpointType, data) {
  if (endpointType === "chat") return data?.choices?.[0]?.message?.content ?? "";

  // responses：多种兼容提取方式
  if (typeof data?.output_text === "string" && data.output_text.trim()) return data.output_text;

  const out0 = data?.output?.[0];
  const c0 = out0?.content?.[0];
  if (typeof c0?.text === "string" && c0.text.trim()) return c0.text;

  return data?.choices?.[0]?.message?.content ?? "";
}

// 某些错误应当“继续换下一个 key/分组”（比如模型在该分组不可用）
function shouldTryNextKey(status, msg) {
  const m = String(msg || "");
  if (status === 401 || status === 403 || status === 404) return true;
  if (status === 400) {
    // 常见：model not found / unsupported / 不存在
    if (/model|not\s*found|unsupported|不存在|不支持/i.test(m)) return true;
  }
  return false;
}

function buildPoolGPT(env) {
  const pool = [];
  for (const g of GPT_CHAIN) {
    let keys = [];
    if (g === "PROMO") keys = parseKeys(env.KEYS_PROMO);
    if (g === "DEFAULT") keys = parseKeys(env.KEYS_DEFAULT);
    if (g === "REVERSE") {
      keys = parseKeys(env.KEYS_REVERSE);
      if (!keys.length) keys = parseKeys(env.YUNWU_API_KEY); // 兼容你现有变量
    }
    if (g === "AZ") keys = parseKeys(env.KEYS_AZ);
    if (g === "OFFICIAL") keys = parseKeys(env.KEYS_OFFICIAL);

    for (const k of keys) pool.push({ group: g, key: k });
  }

  // 如果你还没配 KEYS_*，至少用 YUNWU_API_KEY 兜底（否则现有模型都跑不了）
  if (!pool.length) {
    const fallback = parseKeys(env.YUNWU_API_KEY);
    fallback.forEach(k => pool.push({ group: "REVERSE(FALLBACK)", key: k }));
  }

  return pool;
}

function buildPoolReverseOnly(env) {
  const keys = parseKeys(env.KEYS_REVERSE).length ? parseKeys(env.KEYS_REVERSE) : parseKeys(env.YUNWU_API_KEY);
  return keys.map(k => ({ group: "REVERSE", key: k }));
}

function buildPoolGemini(env) {
  const pool = [];
  parseKeys(env.YUNWU_GEMINI_PROMO_KEY).forEach(k => pool.push({ group: "GEMINI_PROMO", key: k }));
  parseKeys(env.YUNWU_GEMINI_PREMIUM_KEY).forEach(k => pool.push({ group: "GEMINI_PREMIUM", key: k }));
  return pool;
}

function buildPoolCodex(env) {
  return parseKeys(env.KEYS_CODEX).map(k => ({ group: "CODEX", key: k }));
}

function buildPoolOfficialPro(env) {
  return parseKeys(env.KEYS_OFFICIAL_PRO).map(k => ({ group: "OFFICIAL_PRO", key: k }));
}

async function callWithPool({ env, endpointType, upstreamModel, messages, temperature, pool }) {
  const baseUrl = env.UPSTREAM_BASE_URL || DEFAULT_BASE_URL;
  const url = buildUrl(baseUrl, endpointType);

  let lastRaw = null;
  let lastDetail = "";
  let lastStatus = 500;

  for (let i = 0; i < pool.length; i++) {
    const { group, key } = pool[i];

    for (let attempt = 1; attempt <= MAX_RETRIES_PER_KEY; attempt++) {
      try {
        const resp = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key}` },
          body: JSON.stringify(buildPayload(endpointType, upstreamModel, messages, temperature)),
        });

        const data = await safeReadJson(resp);
        lastRaw = data;
        lastStatus = resp.status;

        if (resp.status === 429) {
          lastDetail = "429 Too Many Requests";
          const delay = Math.pow(2, attempt) * BACKOFF_BASE_MS;
          await sleep(delay);
          continue;
        }

        const text = extractText(endpointType, data);
        if (resp.ok && text) {
          return {
            ok: true,
            text,
            meta: { group, endpointType, upstreamModel, triedKeys: i + 1, attempt },
            raw: data
          };
        }

        lastDetail = data?.error?.message || JSON.stringify(data);

        if (shouldTryNextKey(resp.status, lastDetail)) break;

        const retryable = resp.status >= 500 || /负载已饱和|upstream/i.test(String(lastDetail));
        if (retryable && attempt < MAX_RETRIES_PER_KEY) {
          const delay = Math.pow(2, attempt) * BACKOFF_BASE_MS;
          await sleep(delay);
          continue;
        }

        break;
      } catch (e) {
        lastDetail = String(e?.message || e);
        lastStatus = 500;
      }
    }
  }

  return {
    ok: false,
    error: "所有渠道均失败，请稍后再试",
    detail: lastDetail,
    raw: lastRaw,
    meta: { endpointType, upstreamModel },
    status: lastStatus === 429 ? 429 : 503
  };
}

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === "OPTIONS") return new Response(null, { status: 204 });
  if (request.method !== "POST") return jsonResponse({ ok: false, error: "Method not allowed" }, 405);

  const accessPassword = env.ACCESS_PASSWORD || "";

  let body;
  try { body = await request.json(); }
  catch { return jsonResponse({ ok: false, error: "Body must be JSON" }, 400); }

  const action = body.action;

  // 密码校验
  if (action === "check_password") {
    if (!accessPassword) return jsonResponse({ ok: false, error: "Missing ACCESS_PASSWORD" }, 500);
    const pwd = String(body.password || "");
    if (pwd === accessPassword) return jsonResponse({ ok: true }, 200);
    return jsonResponse({ ok: false, error: "密码错误" }, 401);
  }

  if (action !== "chat") return jsonResponse({ ok: false, error: "Unknown action" }, 400);

  // chat 也需要密码（如果设置了）
  if (accessPassword) {
    const pwd = String(body.password || "");
    if (pwd !== accessPassword) return jsonResponse({ ok: false, error: "未授权：密码错误或缺失" }, 401);
  }

  const displayName = String(body.model || "");
  const cfg = MODEL_MAP[displayName];
  if (!cfg) return jsonResponse({ ok: false, error: `不支持的模型：${displayName}` }, 400);

  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    return jsonResponse({ ok: false, error: "messages required" }, 400);
  }

  const temperature = typeof body.temperature === "number" ? body.temperature : 0.7;
  const endpointType = pickEndpoint(cfg, displayName);

  // 选择 key 池
  let pool = [];
  if (cfg.route === "OFFICIAL_PRO_ONLY") {
    pool = buildPoolOfficialPro(env);
    if (!pool.length) {
      return jsonResponse({ ok: false, error: "缺少 KEYS_OFFICIAL_PRO（gpt-5.2-pro 专用）" }, 500);
    }
  } else if (cfg.route === "CODEX_ONLY") {
    pool = buildPoolCodex(env);
    if (!pool.length) {
      return jsonResponse({ ok: false, error: "缺少 KEYS_CODEX（Codex 专属分组）" }, 500);
    }
  } else if (cfg.route === "GEMINI") {
    pool = buildPoolGemini(env);
    if (!pool.length) {
      return jsonResponse({ ok: false, error: "缺少 YUNWU_GEMINI_PROMO_KEY / YUNWU_GEMINI_PREMIUM_KEY" }, 500);
    }
  } else if (cfg.route === "REVERSE_ONLY") {
    pool = buildPoolReverseOnly(env);
    if (!pool.length) {
      return jsonResponse({ ok: false, error: "缺少 KEYS_REVERSE 或 YUNWU_API_KEY（逆向分组）" }, 500);
    }
  } else {
    // GPT_CHAIN
    pool = buildPoolGPT(env);
  }

  const result = await callWithPool({
    env,
    endpointType,
    upstreamModel: cfg.upstreamModel,
    messages,
    temperature,
    pool,
  });

  if (!result.ok) {
    return jsonResponse(
      { ok: false, error: result.error, detail: result.detail, raw: result.raw, meta: result.meta },
      result.status || 503
    );
  }

  return jsonResponse({
    ok: true,
    choices: [{ message: { content: result.text } }],
    meta: result.meta,
  }, 200);
}

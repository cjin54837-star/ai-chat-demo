const DEFAULT_BASE_URL = "https://yunwu.ai";
const MAX_RETRIES_PER_KEY = 3;
const BACKOFF_BASE_MS = 2500;

// ========== 模型配置 ==========
// upstreamModel: 上游 API 的模型名
// endpoint: "chat" 或 "responses" (优先用 responses,失败自动降级到 chat)
// keyPools: 密钥池调用链路(按顺序尝试,便宜的在前)

const MODEL_MAP = {
  // === OpenAI 系列 ===
  
  // 通用 GPT 模型(按成本链路: 限时特价→Default→逆向→纯AZ→官转)
  "GPT-5.2": {
    upstreamModel: "gpt-5.2",
    endpoint: "responses", // 优先用 responses,失败自动降级
    keyPools: ["OPENAI_PROMO", "OPENAI_DEFAULT", "OPENAI_REVERSE", "OPENAI_PURE_AZ", "OPENAI_OFFICIAL"]
  },
  "GPT-5.1": {
    upstreamModel: "gpt-5.1",
    endpoint: "responses",
    keyPools: ["OPENAI_PROMO", "OPENAI_DEFAULT", "OPENAI_REVERSE", "OPENAI_PURE_AZ", "OPENAI_OFFICIAL"]
  },
  "GPT-5.2 Chat Latest": {
    upstreamModel: "gpt-5.2-chat-latest",
    endpoint: "responses",
    keyPools: ["OPENAI_PROMO", "OPENAI_DEFAULT", "OPENAI_REVERSE", "OPENAI_PURE_AZ", "OPENAI_OFFICIAL"]
  },

  // gpt-5.2-pro: 只能用"优质官转OpenAI分组"
  "gpt-5.2-pro": {
    upstreamModel: "gpt-5.2-pro",
    endpoint: "responses", // 只支持 responses
    keyPools: ["GPT52PRO"] // 单独的密钥池
  },

  // GPT-5.2 Codex: 只能用"Codex专属分组"
  "GPT-5.2 Codex": {
    upstreamModel: "gpt-5-codex",
    endpoint: "responses",
    keyPools: ["CODEX"] // 单独的密钥池
  },

  // === Anthropic ===
  "Claude Opus 4.5": {
    upstreamModel: "claude-opus-4-5-20251101",
    endpoint: "chat",
    keyPools: ["OPENAI_DEFAULT", "OPENAI_OFFICIAL"] // Claude 一般用 Default 或官转
  },

  // === xAI ===
  "Grok-4.1": {
    upstreamModel: "grok-4.1",
    endpoint: "chat",
    keyPools: ["OPENAI_DEFAULT", "OPENAI_OFFICIAL"]
  },

  // === Google Gemini ===
  // 调用链路: 限时特价 → 优质Gemini
  "Gemini 3 Pro Preview": {
    upstreamModel: "gemini-3-pro-preview",
    endpoint: "chat", // Gemini 用 chat (兼容 OpenAI 格式)
    keyPools: ["GEMINI_PROMO", "GEMINI_PREMIUM"]
  },
  "Gemini 3 Pro Preview 11-2025": {
    upstreamModel: "gemini-3-pro-preview-11-2025",
    endpoint: "chat",
    keyPools: ["GEMINI_PROMO", "GEMINI_PREMIUM"]
  },
  "Gemini 3 Pro Preview Thinking": {
    upstreamModel: "gemini-3-pro-preview-thinking",
    endpoint: "chat",
    keyPools: ["GEMINI_PROMO", "GEMINI_PREMIUM"]
  },
};

// ========== 工具函数 ==========
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
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

// 构建 URL (支持 chat 和 responses 双端点)
function buildUrl(baseUrl, endpoint) {
  return endpoint === "responses"
    ? `${baseUrl}/v1/responses`
    : `${baseUrl}/v1/chat/completions`;
}

// 构建请求体
function buildPayload(endpoint, model, messages, temperature) {
  if (endpoint === "responses") {
    return {
      model,
      input: messages, // responses 用 input
      temperature,
    };
  }
  return {
    model,
    messages,
    temperature,
    stream: false,
  };
}

// 提取回复文本(兼容 chat 和 responses 格式)
function extractText(endpoint, data) {
  if (endpoint === "responses") {
    // responses 格式: output_text 或 output[0].content[0].text
    if (typeof data?.output_text === "string" && data.output_text.trim()) {
      return data.output_text;
    }
    const out0 = data?.output?.[0];
    const c0 = out0?.content?.[0];
    if (typeof c0?.text === "string" && c0.text.trim()) {
      return c0.text;
    }
    // 兜底: 有些代理仍返回 chat 风格
    const chatText = data?.choices?.[0]?.message?.content;
    return typeof chatText === "string" ? chatText : "";
  }

  // chat 格式
  const text = data?.choices?.[0]?.message?.content;
  return typeof text === "string" ? text : "";
}

// 获取密钥池
function getKeyPool(env, poolName) {
  const poolMap = {
    // OpenAI 通用链路
    OPENAI_PROMO: parseKeys(env.YUNWU_OPENAI_PROMO),
    OPENAI_DEFAULT: parseKeys(env.YUNWU_OPENAI_DEFAULT),
    OPENAI_REVERSE: parseKeys(env.YUNWU_OPENAI_REVERSE),
    OPENAI_PURE_AZ: parseKeys(env.YUNWU_OPENAI_PURE_AZ),
    OPENAI_OFFICIAL: parseKeys(env.YUNWU_OPENAI_OFFICIAL),

    // gpt-5.2-pro 专属
    GPT52PRO: parseKeys(env.YUNWU_GPT52PRO_KEY),

    // Codex 专属
    CODEX: parseKeys(env.YUNWU_CODEX_KEY),

    // Gemini 链路
    GEMINI_PROMO: parseKeys(env.YUNWU_GEMINI_PROMO),
    GEMINI_PREMIUM: parseKeys(env.YUNWU_GEMINI_PREMIUM),
  };

  return poolMap[poolName] || [];
}

// 单次 API 调用(支持端点降级: responses → chat)
async function callApi({ baseUrl, endpoint, model, messages, temperature, key }) {
  const url = buildUrl(baseUrl, endpoint);

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify(buildPayload(endpoint, model, messages, temperature)),
    });

    const data = await safeReadJson(resp);

    return {
      ok: resp.ok,
      status: resp.status,
      data,
      text: resp.ok ? extractText(endpoint, data) : "",
    };
  } catch (e) {
    return {
      ok: false,
      status: 500,
      data: { error: String(e?.message || e) },
      text: "",
    };
  }
}

// 多密钥 + 多端点重试逻辑
async function callUpstreamWithRetries({ env, preferredEndpoint, model, messages, temperature, keyPools }) {
  const baseUrl = env.UPSTREAM_BASE_URL || DEFAULT_BASE_URL;

  let lastDetail = "";
  let lastRaw = null;
  let lastStatus = 500;
  const triedKeys = [];

  // 遍历所有密钥池(按成本链路顺序)
  for (const poolName of keyPools) {
    const keys = getKeyPool(env, poolName);
    if (!keys.length) continue; // 跳过空池

    // 遍历当前池的所有密钥
    for (let keyIndex = 0; keyIndex < keys.length; keyIndex++) {
      const key = keys[keyIndex];
      triedKeys.push({ pool: poolName, keyIndex: keyIndex + 1 });

      // 每个密钥重试 MAX_RETRIES_PER_KEY 次
      for (let attempt = 1; attempt <= MAX_RETRIES_PER_KEY; attempt++) {
        // 1. 优先用 preferredEndpoint
        let result = await callApi({
          baseUrl,
          endpoint: preferredEndpoint,
          model,
          messages,
          temperature,
          key,
        });

        // 2. 如果 preferredEndpoint 是 responses 且失败,自动降级到 chat
        if (!result.ok && preferredEndpoint === "responses") {
          result = await callApi({
            baseUrl,
            endpoint: "chat",
            model,
            messages,
            temperature,
            key,
          });
        }

        lastRaw = result.data;
        lastStatus = result.status;

        // 成功返回
        if (result.ok && result.text) {
          return {
            ok: true,
            text: result.text,
            raw: result.data,
            meta: {
              model,
              endpoint: preferredEndpoint,
              poolName,
              keyIndex: keyIndex + 1,
              attempt,
              triedKeys,
            },
          };
        }

        // 429 退避重试
        if (result.status === 429) {
          lastDetail = "429 Too Many Requests";
          const delay = Math.pow(2, attempt) * BACKOFF_BASE_MS;
          await sleep(delay);
          continue; // 同一个 key 再试
        }

        // 401/403: 密钥无效,换下一个密钥
        if (result.status === 401 || result.status === 403) {
          lastDetail = `Auth failed (${result.status})`;
          break;
        }

        // 其他错误: 记录后换下一个密钥
        lastDetail = result.data?.error?.message || JSON.stringify(result.data);
        break;
      }
    }
  }

  // 所有密钥池都失败
  return {
    ok: false,
    status: lastStatus === 429 ? 429 : 503,
    error: "所有密钥池均失败,请稍后再试",
    detail: lastDetail,
    raw: lastRaw,
    meta: { model, triedKeys },
  };
}

// ========== 主处理函数 ==========
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
      return jsonResponse({ ok: false, error: "未授权: 密码错误或缺失" }, 401);
    }
  }

  const displayName = String(body.model || "");
  const cfg = MODEL_MAP[displayName];
  if (!cfg) return jsonResponse({ ok: false, error: `不支持的模型: ${displayName}` }, 400);

  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    return jsonResponse({ ok: false, error: "messages required" }, 400);
  }

  const temperature = typeof body.temperature === "number" ? body.temperature : 0.7;

  const result = await callUpstreamWithRetries({
    env,
    preferredEndpoint: cfg.endpoint,
    model: cfg.upstreamModel,
    messages,
    temperature,
    keyPools: cfg.keyPools,
  });

  if (!result.ok) {
    return jsonResponse(
      {
        ok: false,
        error: result.error,
        detail: result.detail,
        meta: result.meta,
        raw: result.raw,
      },
      result.status
    );
  }

  return jsonResponse(
    {
      ok: true,
      choices: [{ message: { content: result.text } }],
      meta: result.meta,
    },
    200
  );
}

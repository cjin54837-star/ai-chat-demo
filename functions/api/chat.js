// ====== 模型配置映射 ======
const MODEL_MAP = {
  // OpenAI 模型（用 YUNWU_API_KEY - 逆向分组）
  "GPT-5.2": { type: "chat", model: "gpt-5.2", tokenGroup: "reverse" },
  "GPT-5.1": { type: "chat", model: "gpt-5.1", tokenGroup: "reverse" },
  "GPT-5.1 Thinking": { type: "chat", model: "gpt-5.1-thinking-all", tokenGroup: "reverse" },
  "GPT-5.2 Codex": { type: "chat", model: "gpt-5-codex", tokenGroup: "reverse" },
  "GPT-5.2 Chat Latest": { type: "chat", model: "gpt-5.2-chat-latest", tokenGroup: "reverse" },

  // Anthropic 模型（用 YUNWU_API_KEY - 逆向分组）
  "Claude Opus 4.5": { type: "chat", model: "claude-opus-4-5-20251101", tokenGroup: "reverse" },

  // xAI 模型（用 YUNWU_API_KEY - 逆向分组）
  "Grok-4.1": { type: "chat", model: "grok-4.1", tokenGroup: "reverse" },

  // Google Gemini 3.0 模型（用专用 token）
  "Gemini 3 Pro Preview": { type: "chat", model: "gemini-3-pro-preview", tokenGroup: "gemini" },
  "Gemini 3 Pro Preview 11-2025": { type: "chat", model: "gemini-3-pro-preview-11-2025", tokenGroup: "gemini" },
  "Gemini 3 Pro Preview Thinking": { type: "chat", model: "gemini-3-pro-preview-thinking", tokenGroup: "gemini" }
};

const UPSTREAM_URL = "https://yunwu.ai/v1/chat/completions";
const MAX_RETRIES_PER_TOKEN = 2;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    }
  });
}

async function safeReadJson(resp) {
  const text = await resp.text();
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

export async function onRequest(context) {
  const { request, env } = context;

  // 预检
  if (request.method === "OPTIONS") return new Response(null, { status: 204 });

  if (request.method !== "POST") {
    return jsonResponse({ ok: false, error: "Method not allowed" }, 405);
  }

  // ====== 读取环境变量（Cloudflare 用 env.xxx） ======
  const reverseKey = env.YUNWU_API_KEY;
  const geminiPromoKey = env.YUNWU_GEMINI_PROMO_KEY;
  const geminiPremiumKey = env.YUNWU_GEMINI_PREMIUM_KEY;
  const accessPassword = env.ACCESS_PASSWORD || "";

  if (!reverseKey) {
    return jsonResponse({ ok: false, error: "Missing YUNWU_API_KEY" }, 500);
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ ok: false, error: "Body must be JSON" }, 400);
  }

  const action = body.action;

  // ====== 密码验证 ======
  if (action === "check_password") {
    const pwd = String(body.password || "");
    if (!accessPassword) {
      return jsonResponse({ ok: false, error: "Missing ACCESS_PASSWORD" }, 500);
    }
    if (pwd === accessPassword) return jsonResponse({ ok: true }, 200);
    return jsonResponse({ ok: false, error: "密码错误" }, 401);
  }

  if (action !== "chat") {
    return jsonResponse({ ok: false, error: "Unknown action" }, 400);
  }

  // 如果设置了访问密码，则 chat 也必须带 password
  if (accessPassword) {
    const pwd = String(body.password || "");
    if (pwd !== accessPassword) {
      return jsonResponse({ ok: false, error: "未授权：密码错误或缺失" }, 401);
    }
  }

  // ====== 获取模型配置 ======
  const displayName = String(body.model || "");
  const cfg = MODEL_MAP[displayName];

  if (!cfg) {
    return jsonResponse({ ok: false, error: `不支持的模型：${displayName}` }, 400);
  }

  const realModelId = cfg.model;
  const tokenGroup = cfg.tokenGroup;
  const messages = body.messages;

  if (!Array.isArray(messages) || messages.length === 0) {
    return jsonResponse({ ok: false, error: "messages required" }, 400);
  }

  // ====== 根据 tokenGroup 选择 Token 列表 ======
  const tokenList = [];
  if (tokenGroup === "gemini") {
    if (geminiPromoKey) tokenList.push({ key: geminiPromoKey, name: "限时特价" });
    if (geminiPremiumKey) tokenList.push({ key: geminiPremiumKey, name: "优质gemini" });

    if (tokenList.length === 0) {
      return jsonResponse({ ok: false, error: "Missing Gemini tokens" }, 500);
    }
  } else {
    tokenList.push({ key: reverseKey, name: "逆向" });
  }

  // ====== 自动重试逻辑 ======
  let lastError = "";
  let lastRaw = null;

  for (const tokenInfo of tokenList) {
    const apiKey = tokenInfo.key;
    const tokenName = tokenInfo.name;

    for (let attempt = 1; attempt <= MAX_RETRIES_PER_TOKEN; attempt++) {
      try {
        const r = await fetch(UPSTREAM_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${apiKey}`
          },
          body: JSON.stringify({
            model: realModelId,
            messages,
            temperature: 0.7,
            stream: false
          })
        });

        const data = await safeReadJson(r);
        lastRaw = data;

        // 429：直接换下一个 token
        if (r.status === 429) {
          lastError = "429 Too Many Requests";
          break;
        }

        // Invalid token：换下一个 token
        const msg = data?.error?.message || "";
        if (String(msg).includes("Invalid token")) {
          lastError = `Invalid token (${tokenName})`;
          break;
        }

        const text = data?.choices?.[0]?.message?.content ?? "";

        if (r.ok && text) {
          // ✅ 统一成前端可直接用的格式：choices[0].message.content
          return jsonResponse({
            ok: true,
            model: displayName,
            token_used: tokenName,
            attempts: (tokenList.indexOf(tokenInfo) * MAX_RETRIES_PER_TOKEN) + attempt,
            choices: [{ message: { content: text } }]
          }, 200);
        }

        lastError = data?.error?.message || JSON.stringify(data);

        const isRetryable =
          String(lastError).includes("负载已饱和") ||
          String(lastError).includes("upstream") ||
          (r.status >= 500 && r.status <= 599);

        if (!isRetryable) {
          break;
        }

        if (attempt < MAX_RETRIES_PER_TOKEN) {
          const delay = Math.pow(2, attempt) * 1000;
          await sleep(delay);
        }
      } catch (e) {
        lastError = String(e?.message || e);
      }
    }
  }

  // ✅ 把上游返回的更多信息带回去，方便你查 openai_error 的真正原因
  return jsonResponse({
    ok: false,
    error: "所有渠道均失败，请稍后再试",
    detail: lastError,
    raw: lastRaw
  }, 503);
}

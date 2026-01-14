// ====== 模型映射（显示名 -> 实际 model id）=====
const MODEL_MAP = {
  "GPT-5.2": { model: "gpt-5.2", tokenGroup: "reverse" },
  "GPT-5.1": { model: "gpt-5.1", tokenGroup: "reverse" },
  "GPT-4o":  { model: "gpt-4o",  tokenGroup: "reverse" },

  "Claude Opus 4.5": { model: "claude-opus-4-5-20251101", tokenGroup: "reverse" },
  "Grok-4.1": { model: "grok-4.1", tokenGroup: "reverse" },

  "Gemini 3 Pro": { model: "gemini-3-pro-preview", tokenGroup: "gemini" },
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

async function safeReadJson(resp) {
  const text = await resp.text();
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

export async function onRequest(context) {
  const { request, env } = context;

  // OPTIONS 预检
  if (request.method === "OPTIONS") return new Response(null, { status: 204 });

  if (request.method !== "POST") {
    return jsonResponse({ ok: false, error: "只允许 POST 请求" }, 405);
  }

  // 环境变量
  const reverseKey = env.YUNWU_API_KEY;
  const geminiKey  = env.YUNWU_GEMINI_KEY || "";
  const accessPwd  = env.ACCESS_PASSWORD || "";

  if (!reverseKey) {
    return jsonResponse({ ok: false, error: "后端未配置 YUNWU_API_KEY" }, 500);
  }

  // 读取 body
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ ok: false, error: "请求体不是合法 JSON" }, 400);
  }

  const action = body.action || "chat";

  // ====== 验证密码接口 ======
  if (action === "check_password") {
    if (!accessPwd) {
      return jsonResponse({ ok: false, error: "后端未配置 ACCESS_PASSWORD" }, 500);
    }
    const pwd = String(body.password || "");
    if (pwd === accessPwd) return jsonResponse({ ok: true });
    return jsonResponse({ ok: false, error: "密码错误" }, 401);
  }

  if (action !== "chat") {
    return jsonResponse({ ok: false, error: "Unknown action" }, 400);
  }

  // ====== 聊天接口也必须带密码（如果设置了密码） ======
  if (accessPwd) {
    const pwd = String(body.password || "");
    if (pwd !== accessPwd) {
      return jsonResponse({ ok: false, error: "未授权：密码错误或缺失" }, 401);
    }
  }

  const displayName = String(body.model || "GPT-5.2");
  const cfg = MODEL_MAP[displayName];

  const realModelId = cfg ? cfg.model : displayName;
  const tokenGroup = cfg ? cfg.tokenGroup : "reverse";

  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    return jsonResponse({ ok: false, error: "messages 必须是非空数组" }, 400);
  }

  // 选择 token
  const tokenList = [];
  if (tokenGroup === "gemini") {
    if (geminiKey) tokenList.push({ key: geminiKey, name: "Gemini" });
    tokenList.push({ key: reverseKey, name: "Yunwu(降级)" });
  } else {
    tokenList.push({ key: reverseKey, name: "Yunwu" });
  }

  const API_URL = "https://yunwu.ai/v1/chat/completions";
  let lastError = "未知错误";

  for (const t of tokenList) {
    try {
      const upstreamResp = await fetch(API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${t.key}`,
        },
        body: JSON.stringify({
          model: realModelId,
          messages,
          temperature: 0.7,
          stream: false,
        }),
      });

      const data = await safeReadJson(upstreamResp);
      const content = data?.choices?.[0]?.message?.content;

      if (upstreamResp.ok && content) {
        return jsonResponse({
          ok: true,
          choices: [{ message: { content } }],
          model: displayName,
          token_used: t.name,
        });
      }

      lastError = data?.error?.message || JSON.stringify(data);
      if (upstreamResp.status !== 429) break; // 不是 429 就不继续换 token
    } catch (e) {
      lastError = String(e?.message || e);
    }
  }

  return jsonResponse({ ok: false, error: "请求失败: " + lastError }, 500);
}

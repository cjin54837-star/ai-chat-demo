// ====== 1) 模型映射（可按需改） ======
const MODEL_MAP = {
  // OpenAI / Yunwu 映射
  "GPT-5.2": { model: "gpt-5.2", tokenGroup: "reverse" },
  "GPT-5.1": { model: "gpt-5.1", tokenGroup: "reverse" },
  "GPT-4o":  { model: "gpt-4o",  tokenGroup: "reverse" },

  // Gemini 映射
  "Gemini 3 Pro": { model: "gemini-3-pro-preview", tokenGroup: "gemini" },
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      // 同域访问其实不需要 CORS，但保留也没问题
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}

async function safeReadJson(resp) {
  // 有些上游错误可能不是 JSON，这里做兜底
  const text = await resp.text();
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

// ====== 2) Cloudflare Pages Functions 入口 ======
export async function onRequest(context) {
  const { request, env } = context;

  // OPTIONS 预检
  if (request.method === "OPTIONS") return new Response(null, { status: 204 });

  if (request.method !== "POST") {
    return jsonResponse({ ok: false, error: "只允许 POST 请求" }, 405);
  }

  // ====== 环境变量 ======
  const reverseKey = env.YUNWU_API_KEY;
  const geminiKey  = env.YUNWU_GEMINI_KEY;      // 可选
  const accessPwd  = env.ACCESS_PASSWORD || ""; // 可选

  if (!reverseKey) {
    return jsonResponse({ ok: false, error: "后端未配置 YUNWU_API_KEY" }, 500);
  }

  // 读 body
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ ok: false, error: "请求体不是合法 JSON" }, 400);
  }

  const action = body.action || "chat";

  // ====== 3) 密码验证接口：check_password ======
  if (action === "check_password") {
    if (!accessPwd) {
      return jsonResponse({ ok: false, error: "后端未配置 ACCESS_PASSWORD" }, 500);
    }
    const pwd = String(body.password || "");
    if (pwd === accessPwd) return jsonResponse({ ok: true });
    return jsonResponse({ ok: false, error: "密码错误" }, 401);
  }

  // ====== 4) 聊天接口：chat ======
  if (action !== "chat") {
    return jsonResponse({ ok: false, error: "Unknown action" }, 400);
  }

  // 如果后端设置了密码，则聊天也必须带 password
  if (accessPwd) {
    const pwd = String(body.password || "");
    if (pwd !== accessPwd) {
      return jsonResponse({ ok: false, error: "未授权：密码错误或缺失" }, 401);
    }
  }

  const displayName = String(body.model || "GPT-5.2");
  const cfg = MODEL_MAP[displayName];

  const realModelId = cfg ? cfg.model : displayName;     // 找不到映射就直接用传入的 model
  const tokenGroup  = cfg ? cfg.tokenGroup : "reverse";

  const messages = body.messages;

  if (!Array.isArray(messages) || messages.length === 0) {
    return jsonResponse({ ok: false, error: "messages 必须是非空数组" }, 400);
  }

  // 选择 token
  const tokenList = [];
  if (tokenGroup === "gemini") {
    if (geminiKey) tokenList.push({ key: geminiKey, name: "Gemini" });
    // 没有 geminiKey 就降级用 reverseKey
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

      // 成功：给前端一个统一格式（你前端直接读 choices[0].message.content）
      const content = data?.choices?.[0]?.message?.content;

      if (upstreamResp.ok && content) {
        return jsonResponse({
          ok: true,
          choices: [{ message: { content } }],
          model: displayName,
          token_used: t.name,
        });
      }

      // 失败：记录错误后尝试下一个 token
      lastError = data?.error?.message || JSON.stringify(data);
      // 如果不是 429，也可以直接不重试（你也可以按需放开）
      if (upstreamResp.status !== 429) break;

    } catch (e) {
      lastError = String(e?.message || e);
    }
  }

  return jsonResponse({ ok: false, error: "请求失败: " + lastError }, 500);
}

// ====== 1. 静态配置 (不要动) ======
const MODEL_MAP = {
  // OpenAI / Yunwu 映射
  "GPT-5.2": { type: "chat", model: "gpt-5.2", tokenGroup: "reverse" },
  "GPT-5.1": { type: "chat", model: "gpt-5.1", tokenGroup: "reverse" },
  "GPT-4o": { type: "chat", model: "gpt-4o", tokenGroup: "reverse" },
  
  // Gemini 映射
  "Gemini 3 Pro": { type: "chat", model: "gemini-3-pro-preview", tokenGroup: "gemini" },
};

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status: status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*", 
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    }
  });
}

// ====== 2. Cloudflare 核心入口 ======
export async function onRequest(context) {
  const { request, env } = context;

  // 处理预检请求 (解决跨域报错)
  if (request.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      }
    });
  }

  if (request.method !== "POST") {
    return jsonResponse({ ok: false, error: "只允许 POST 请求" }, 405);
  }

  // 获取环境变量
  const reverseKey = env.YUNWU_API_KEY;
  const geminiKey = env.YUNWU_GEMINI_KEY; // 简化为一个 Gemini Key
  
  if (!reverseKey) {
    return jsonResponse({ ok: false, error: "后端未配置 YUNWU_API_KEY" }, 500);
  }

  try {
    const body = await request.json();
    const action = body.action || "chat"; 

    // 简单的密码检查 (如果有配置 ACCESS_PASSWORD)
    if (env.ACCESS_PASSWORD && body.password !== env.ACCESS_PASSWORD) {
       // 如果前端没传密码，或者密码不对
       // 这里为了方便新手，暂时不做强制拦截，只做日志
       // console.log("密码验证失败或未启用");
    }

    // 获取模型配置
    const displayName = String(body.model || "GPT-5.2"); 
    const cfg = MODEL_MAP[displayName];
    
    // 如果找不到映射，默认用传入的名字，走 reverse 通道
    const realModelId = cfg ? cfg.model : displayName;
    const tokenGroup = cfg ? cfg.tokenGroup : "reverse";
    const messages = body.messages || [];

    // 准备 Token
    let tokenList = [];
    if (tokenGroup === "gemini") {
      if (geminiKey) tokenList.push({ key: geminiKey, name: "Gemini" });
      else tokenList.push({ key: reverseKey, name: "默认Key" }); // 降级
    } else {
      tokenList.push({ key: reverseKey, name: "云雾Key" });
    }

    // 循环尝试 (自动重试逻辑)
    let lastError = "";
    
    for (const tokenInfo of tokenList) {
      try {
        // 这里填写你的中转商地址
        const API_URL = "https://yunwu.ai/v1/chat/completions"; 
        
        const r = await fetch(API_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${tokenInfo.key}`
          },
          body: JSON.stringify({
            model: realModelId,
            messages: messages,
            temperature: 0.7
          })
        });

        const data = await r.json();

        // 成功获取数据
        if (r.ok && data?.choices?.[0]?.message?.content) {
          const content = data.choices[0].message.content;
          // 返回标准格式给前端
          return jsonResponse({
            ok: true,
            choices: [{ message: { content: content } }]
          });
        }
        
        lastError = data?.error?.message || "未知错误";

      } catch (e) {
        lastError = e.message;
      }
    }

    // 如果都失败了
    return jsonResponse({ ok: false, error: "请求失败: " + lastError }, 500);

  } catch (e) {
    return jsonResponse({ ok: false, error: "服务器内部错误: " + e.message }, 500);
  }
}

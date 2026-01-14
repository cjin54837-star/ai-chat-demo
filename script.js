// 旧模型不删 + 新增你要的 GPT 模型
const MODEL_DATA = {
  openai: [
    "GPT-5.2",
    "GPT-5.1",
    "gpt-5.2-pro",        // ✅ 新增
    "GPT-5.2 Codex",
    "GPT-5.2 Chat Latest",
    "GPT-5.1 Thinking",
    "GPT-5.2 Codex",
    "GPT-5.2 Chat Latest",
  ],
  anthropic: ["Claude Opus 4.5"],
  google: [
    "Gemini 3 Pro Preview",
    "Gemini 3 Pro Preview 11-2025",
    "Gemini 3 Pro Preview Thinking",
  ],
  xai: ["Grok-4.1"],
};

const els = {
  loginBox: document.getElementById("loginBox"),
  chatBox: document.getElementById("chatBox"),
  passwordInput: document.getElementById("passwordInput"),
  loginBtn: document.getElementById("loginBtn"),
  loginTip: document.getElementById("loginTip"),
  companySelect: document.getElementById("companySelect"),
  modelSelect: document.getElementById("modelSelect"),
  messages: document.getElementById("messages"),
  userInput: document.getElementById("userInput"),
  sendBtn: document.getElementById("sendBtn"),
  clearBtn: document.getElementById("clearBtn"),
};

let sessionPassword = "";

document.addEventListener("DOMContentLoaded", () => {
  updateModelOptions("all");

  els.companySelect.addEventListener("change", (e) => updateModelOptions(e.target.value));
  els.loginBtn.addEventListener("click", handleLogin);
  els.sendBtn.addEventListener("click", sendMessage);
  els.clearBtn.addEventListener("click", clearChat);

  els.userInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  els.passwordInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") handleLogin();
  });
});

function showTip(text) {
  els.loginTip.textContent = text;
  setTimeout(() => (els.loginTip.textContent = ""), 3000);
}

function updateModelOptions(company) {
  els.modelSelect.innerHTML = "";
  let list = [];

  if (company === "all") list = Object.values(MODEL_DATA).flat();
  else list = MODEL_DATA[company] || [];

  if (!list.length) list = ["GPT-5.2"];

  // 去重（避免你 openai 数组里重复项）
  list = Array.from(new Set(list));

  for (const name of list) {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    els.modelSelect.appendChild(opt);
  }
}

async function handleLogin() {
  const pwd = els.passwordInput.value.trim();
  if (!pwd) return showTip("请输入密码");

  els.loginBtn.disabled = true;
  els.loginBtn.textContent = "验证中...";

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "check_password", password: pwd }),
    });
    const data = await res.json();

    if (!res.ok || !data.ok) throw new Error(data.error || "密码错误");

    sessionPassword = pwd;
    els.loginBox.classList.add("hidden");
    els.chatBox.classList.remove("hidden");
  } catch (e) {
    showTip("登录失败：" + e.message);
  } finally {
    els.loginBtn.disabled = false;
    els.loginBtn.textContent = "进入";
  }
}

async function sendMessage() {
  const text = els.userInput.value.trim();
  if (!text) return;

  const model = els.modelSelect.value || "GPT-5.2";

  addMessage(text, "user");
  els.userInput.value = "";

  const loading = addMessage("正在思考...", "ai");

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "chat",
        model,
        password: sessionPassword,
        messages: [
          { role: "system", content: "你是一个乐于助人的 AI 助手。" },
          { role: "user", content: text },
        ],
      }),
    });

    const data = await res.json();

    if (!res.ok || !data.ok) {
      const detail = data.detail ? `\ndetail: ${data.detail}` : "";
      const raw = data.raw ? `\nraw: ${JSON.stringify(data.raw)}` : "";
      const meta = data.meta ? `\nmeta: ${JSON.stringify(data.meta)}` : "";
      throw new Error((data.error || "请求失败") + detail + raw + meta);
    }

    loading.textContent = data?.choices?.[0]?.message?.content || "（回复为空）";
  } catch (e) {
    loading.textContent = "❌ 出错：" + e.message;
  }
}

function addMessage(text, type) {
  const div = document.createElement("div");
  div.className = `msg ${type}`;
  div.textContent = text;
  els.messages.appendChild(div);
  els.messages.scrollTop = els.messages.scrollHeight;
  return div;
}

function clearChat() {
  els.messages.innerHTML = "";
}

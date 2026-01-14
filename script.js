// ====== 前端模型列表（显示用） ======
const MODEL_DATA = {
  openai: [
    { name: "GPT-5.2", id: "GPT-5.2" },
    { name: "GPT-5.1", id: "GPT-5.1" },
    { name: "GPT-4o",  id: "GPT-4o"  },
  ],
  anthropic: [
    { name: "Claude Opus 4.5", id: "Claude Opus 4.5" },
  ],
  google: [
    { name: "Gemini 3 Pro", id: "Gemini 3 Pro" },
  ],
  xai: [
    { name: "Grok-4.1", id: "Grok-4.1" },
  ],
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

let sessionPassword = ""; // 登录成功后保存密码

document.addEventListener("DOMContentLoaded", () => {
  updateModelOptions("all");

  els.companySelect.addEventListener("change", (e) => updateModelOptions(e.target.value));
  els.loginBtn.addEventListener("click", handleLogin);
  els.sendBtn.addEventListener("click", sendMessage);
  els.clearBtn.addEventListener("click", clearChat);

  // 回车发送
  els.userInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  // 密码回车
  els.passwordInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") handleLogin();
  });
});

function updateModelOptions(company) {
  els.modelSelect.innerHTML = "";

  let options = [];
  if (company === "all") {
    Object.values(MODEL_DATA).forEach((list) => options.push(...list));
  } else {
    options = MODEL_DATA[company] || [];
  }

  // 如果没有选项，给一个兜底
  if (options.length === 0) {
    options = [{ name: "GPT-5.2", id: "GPT-5.2" }];
  }

  options.forEach((opt) => {
    const option = document.createElement("option");
    option.value = opt.id;
    option.textContent = opt.name;
    els.modelSelect.appendChild(option);
  });
}

function showTip(text) {
  els.loginTip.textContent = text;
  setTimeout(() => (els.loginTip.textContent = ""), 3000);
}

// 登录：调用后端 check_password
async function handleLogin() {
  const pwd = els.passwordInput.value.trim();
  if (!pwd) return showTip("请输入密码");

  els.loginBtn.textContent = "验证中...";
  els.loginBtn.disabled = true;

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "check_password", password: pwd }),
    });

    const data = await res.json();

    if (!res.ok || !data.ok) {
      throw new Error(data.error || "密码错误");
    }

    // 成功：保存密码并切换界面
    sessionPassword = pwd;
    els.loginBox.classList.add("hidden");
    els.chatBox.classList.remove("hidden");
  } catch (e) {
    showTip("登录失败：" + e.message);
  } finally {
    els.loginBtn.textContent = "进入";
    els.loginBtn.disabled = false;
  }
}

// 发送消息
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
        password: sessionPassword, // ✅ 必须带密码（因为后端会拦截）
        messages: [
          { role: "system", content: "你是一个乐于助人的 AI 助手。" },
          { role: "user", content: text },
        ],
      }),
    });

    const data = await res.json();

    if (!res.ok || !data.ok) {
      throw new Error(data.error || "请求失败");
    }

    const content = data?.choices?.[0]?.message?.content || "（回复为空）";
    loading.textContent = content;
  } catch (e) {
    loading.textContent = "❌ 出错：" + e.message;
  }
}

function addMessage(text, type) {
  const div = document.createElement("div");
  div.className = `msg ${type}`; // ✅ 对应 .msg.user / .msg.ai
  div.textContent = text;
  els.messages.appendChild(div);
  els.messages.scrollTop = els.messages.scrollHeight;
  return div;
}

function clearChat() {
  els.messages.innerHTML = "";
}

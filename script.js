// ====== 配置区域 ======
// 这里定义前端下拉菜单显示的数据
const MODEL_DATA = {
  openai: [
    { name: "GPT-5.2", id: "GPT-5.2" },
    { name: "GPT-5.1", id: "GPT-5.1" },
    { name: "GPT-4o", id: "GPT-4o" }
  ],
  anthropic: [
    { name: "Claude 3.5 Sonnet", id: "Claude-3-5-Sonnet" }, // 需后端支持映射
    { name: "Claude Opus 4.5", id: "Claude Opus 4.5" }
  ],
  google: [
    { name: "Gemini 3 Pro", id: "Gemini 3 Pro" }
  ],
  xai: [
    { name: "Grok-Beta", id: "Grok-Beta" } // 需后端支持映射
  ]
};

// ====== DOM 元素引用 ======
const els = {
  loginBox: document.getElementById('loginBox'),
  chatBox: document.getElementById('chatBox'),
  passwordInput: document.getElementById('passwordInput'),
  loginBtn: document.getElementById('loginBtn'),
  loginTip: document.getElementById('loginTip'),
  
  companySelect: document.getElementById('companySelect'),
  modelSelect: document.getElementById('modelSelect'),
  
  messages: document.getElementById('messages'),
  userInput: document.getElementById('userInput'),
  sendBtn: document.getElementById('sendBtn'),
  clearBtn: document.getElementById('clearBtn')
};

// ====== 1. 初始化与事件监听 ======
document.addEventListener('DOMContentLoaded', () => {
  // 默认加载全部模型或第一个公司的模型
  updateModelOptions('all');
  
  // 绑定事件
  els.companySelect.addEventListener('change', (e) => updateModelOptions(e.target.value));
  els.loginBtn.addEventListener('click', handleLogin);
  els.sendBtn.addEventListener('click', sendMessage);
  els.clearBtn.addEventListener('click', clearChat);
  
  // 绑定回车发送
  els.userInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  // 绑定密码框回车
  els.passwordInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleLogin();
  });
});

// ====== 2. 核心逻辑函数 ======

// 切换模型下拉菜单
function updateModelOptions(company) {
  els.modelSelect.innerHTML = ""; // 清空
  
  let options = [];
  if (company === 'all') {
    // 扁平化所有模型
    Object.values(MODEL_DATA).forEach(list => options.push(...list));
  } else if (MODEL_DATA[company]) {
    options = MODEL_DATA[company];
  }
  
  options.forEach(opt => {
    const option = document.createElement('option');
    option.value = opt.id;
    option.textContent = opt.name;
    els.modelSelect.appendChild(option);
  });
}

// 简单的登录逻辑 (这里做前端验证，或者请求后端验证)
async function handleLogin() {
  const pwd = els.passwordInput.value.trim();
  if (!pwd) return showTip("请输入密码");

  els.loginBtn.textContent = "验证中...";
  els.loginBtn.disabled = true;

  try {
    // 向后端发请求验证密码 (对应后端 action: 'check_password')
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'check_password', password: pwd })
    });
    
    const data = await res.json();
    
    if (data.ok) {
      // 登录成功，切换界面
      els.loginBox.classList.add('hidden');
      els.chatBox.classList.remove('hidden');
    } else {
      showTip(data.error || "密码错误");
    }
  } catch (e) {
    // 如果后端没写 check_password 逻辑，这里可以做一个兜底
    // 假设密码是 123456 (仅作演示，建议以后端为准)
    if (pwd === "123456") { 
        els.loginBox.classList.add('hidden');
        els.chatBox.classList.remove('hidden');
    } else {
        showTip("验证出错或密码错误");
    }
  } finally {
    els.loginBtn.textContent = "进入";
    els.loginBtn.disabled = false;
  }
}

function showTip(text) {
  els.loginTip.textContent = text;
  setTimeout(() => els.loginTip.textContent = "", 3000);
}

// 发送消息
async function sendMessage() {
  const text = els.userInput.value.trim();
  const model = els.modelSelect.value;
  
  if (!text) return;
  
  // 1. UI 显示用户消息
  addMessage(text, 'user');
  els.userInput.value = "";
  els.userInput.style.height = 'auto'; // 重置高度
  
  // 2. UI 显示 Loading
  const loadingMsg = addMessage("正在思考...", 'ai');
  
  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'chat',
        model: model,
        messages: [
          { role: "system", content: "你是一个乐于助人的 AI 助手。" },
          { role: "user", content: text }
        ],
        // 如果后端需要验证密码，每次请求最好都带上，或者用 Cookies
        // password: els.passwordInput.value 
      })
    });

    const data = await res.json();

    if (!res.ok || !data.ok) {
        throw new Error(data.error || "请求失败");
    }

    // 3. 更新 AI 回复
    if (data.choices && data.choices[0]) {
        loadingMsg.textContent = data.choices[0].message.content;
    } else {
        loadingMsg.textContent = "（回复为空）";
    }

  } catch (err) {
    console.error(err);
    loadingMsg.textContent = "❌ 出错: " + err.message;
  }
}

// 添加消息到界面
function addMessage(text, type) {
  const div = document.createElement('div');
  // 注意：这里用的类名必须匹配你的 CSS (.msg.user 或 .msg.ai)
  div.className = `msg ${type}`; 
  div.textContent = text;
  
  els.messages.appendChild(div);
  els.messages.scrollTop = els.messages.scrollHeight; // 滚动到底部
  return div;
}

// 清空对话
function clearChat() {
  els.messages.innerHTML = "";
}

const STORAGE_KEY = "daily-spend-expenses-v1";
const CATEGORY_KEY = "daily-spend-categories-v1";
const THEME_KEY = "daily-spend-theme-v1";
const BUDGET_KEY = "daily-spend-budgets-v1";
const CATEGORY_BUDGET_KEY = "daily-spend-category-budgets-v1";
const LOCAL_UPDATED_KEY = "daily-spend-local-updated-v1";

const defaultCategories = ["食費", "交通費", "日用品", "交際費", "趣味", "酒", "医療", "その他"];

let expenses = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
let categories = JSON.parse(localStorage.getItem(CATEGORY_KEY) || "null") || defaultCategories;
let budgets = JSON.parse(localStorage.getItem(BUDGET_KEY) || "{}");
let categoryBudgets = JSON.parse(localStorage.getItem(CATEGORY_BUDGET_KEY) || "{}");
let categoryChart;
let dailyChart;
let cloudClient = null;
let cloudSession = null;
let cloudSyncTimer = null;
let isApplyingCloud = false;
let deferredInstallPrompt = null;

const $ = (id) => document.getElementById(id);
const formatYen = (n) => new Intl.NumberFormat("ja-JP", {
  style: "currency", currency: "JPY", maximumFractionDigits: 0
}).format(n);

function todayISO() {
  const d = new Date();
  const offset = d.getTimezoneOffset();
  return new Date(d.getTime() - offset * 60000).toISOString().slice(0, 10);
}

function currentMonthISO() {
  return todayISO().slice(0, 7);
}

function saveAll(options = {}) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(expenses));
  localStorage.setItem(CATEGORY_KEY, JSON.stringify(categories));
  localStorage.setItem(BUDGET_KEY, JSON.stringify(budgets));
  localStorage.setItem(CATEGORY_BUDGET_KEY, JSON.stringify(categoryBudgets));

  if (!options.preserveTimestamp) {
    localStorage.setItem(LOCAL_UPDATED_KEY, String(Date.now()));
  }

  if (!isApplyingCloud && !options.skipCloud) scheduleCloudSync();
}

function init() {
  $("date").value = todayISO();
  $("monthPicker").value = currentMonthISO();

  const savedTheme = localStorage.getItem(THEME_KEY);
  if (savedTheme === "dark") document.body.classList.add("dark");

  renderCategoryOptions();
  renderCategoryChips();
  bindEvents();
  renderAll();
  initPWA();
  initCloud();
}

function bindEvents() {
  $("expenseForm").addEventListener("submit", addExpense);
  $("monthPicker").addEventListener("change", () => {
    syncBudgetInput();
    renderAll();
  });
  $("searchInput").addEventListener("input", renderHistory);
  $("filterCategory").addEventListener("change", renderHistory);
  $("exportCsv").addEventListener("click", exportCsv);
  $("clearAll").addEventListener("click", clearAll);
  $("addCategory").addEventListener("click", addCategory);
  $("themeToggle").addEventListener("click", toggleTheme);
  $("saveBudget").addEventListener("click", saveBudget);
  $("installApp").addEventListener("click", installPWA);
  $("cloudSignIn").addEventListener("click", cloudSignIn);
  $("cloudSignUp").addEventListener("click", cloudSignUp);
  $("cloudSignOut").addEventListener("click", cloudSignOut);
  $("cloudSyncNow").addEventListener("click", () => pushCloud(true));
  $("cloudDownload").addEventListener("click", restoreFromCloud);
  $("saveCategoryBudgets").addEventListener("click", saveCategoryBudgets);
  document.querySelectorAll(".tab-button").forEach(button => {
    button.addEventListener("click", () => switchTab(button.dataset.tab));
  });
}

function switchTab(tabName) {
  document.querySelectorAll(".tab-button").forEach(button => {
    const active = button.dataset.tab === tabName;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", active ? "true" : "false");
  });

  document.querySelectorAll(".tab-panel").forEach(panel => {
    panel.classList.toggle("active", panel.id === `tab-${tabName}`);
  });

  if (tabName === "expenses") {
    requestAnimationFrame(() => renderCharts());
  } else if (tabName === "monthly-budget") {
    renderBudget();
  } else if (tabName === "category-budget") {
    renderCategoryBudgets();
  } else if (tabName === "sync") {
    refreshPWAStatus();
    updateCloudUI();
  }
}

function addExpense(e) {
  e.preventDefault();

  const amount = Number($("amount").value);
  if (!amount || amount <= 0) return;

  expenses.push({
    id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()),
    date: $("date").value,
    amount,
    category: $("category").value,
    merchant: $("merchant").value.trim(),
    memo: $("memo").value.trim(),
    createdAt: new Date().toISOString()
  });

  saveAll();

  $("amount").value = "";
  $("merchant").value = "";
  $("memo").value = "";
  $("amount").focus();

  renderAll();
}

function deleteExpense(id) {
  expenses = expenses.filter(x => x.id !== id);
  saveAll();
  renderAll();
}

function selectedMonth() {
  return $("monthPicker").value || currentMonthISO();
}

function monthExpenses() {
  const month = selectedMonth();
  return expenses.filter(x => x.date.startsWith(month));
}

function renderSummary() {
  const month = selectedMonth();
  const monthData = expenses.filter(x => x.date.startsWith(month));
  const total = monthData.reduce((s, x) => s + x.amount, 0);

  const today = todayISO();
  const todayTotal = expenses
    .filter(x => x.date === today)
    .reduce((s, x) => s + x.amount, 0);

  const [y, m] = month.split("-").map(Number);
  const now = new Date();
  let daysDivisor;
  if (y === now.getFullYear() && m === now.getMonth() + 1) {
    daysDivisor = Math.max(1, now.getDate());
  } else {
    daysDivisor = new Date(y, m, 0).getDate();
  }

  $("monthTotal").textContent = formatYen(total);
  $("todayTotal").textContent = formatYen(todayTotal);
  $("monthCount").textContent = `${monthData.length}件`;
  $("dailyAverage").textContent = formatYen(Math.round(total / daysDivisor));
  $("monthLabel").textContent = `${y}年${m}月`;
  $("todayLabel").textContent = today.replaceAll("-", "/");
}

function renderBudget() {
  const month = selectedMonth();
  const total = monthExpenses().reduce((s, x) => s + x.amount, 0);
  const budget = Number(budgets[month] || 0);

  syncBudgetInput();

  if (!budget) {
    $("budgetAmount").textContent = "未設定";
    $("budgetRemaining").textContent = "—";
    $("budgetRate").textContent = "—";
    $("budgetProgressBar").style.width = "0%";
    $("budgetProgressBar").style.background = "var(--accent)";
    $("budgetMessage").textContent = "この月の予算は未設定です。";
    return;
  }

  const remaining = budget - total;
  const rate = budget > 0 ? (total / budget) * 100 : 0;

  $("budgetAmount").textContent = formatYen(budget);
  $("budgetRemaining").textContent = formatYen(remaining);
  $("budgetRate").textContent = `${rate.toFixed(1)}%`;
  $("budgetProgressBar").style.width = `${Math.min(rate, 100)}%`;

  if (rate >= 100) {
    $("budgetProgressBar").style.background = "var(--danger)";
    $("budgetMessage").textContent = `予算を${formatYen(Math.abs(remaining))}超過しています。`;
  } else if (rate >= 80) {
    $("budgetProgressBar").style.background = "var(--warning)";
    $("budgetMessage").textContent = `予算の${rate.toFixed(1)}%を使用しています。残り${formatYen(remaining)}です。`;
  } else {
    $("budgetProgressBar").style.background = "var(--success)";
    $("budgetMessage").textContent = `残り${formatYen(remaining)}使えます。`;
  }
}

function syncBudgetInput() {
  const month = selectedMonth();
  $("budgetInput").value = budgets[month] || "";
}

function saveBudget() {
  const month = selectedMonth();
  const value = Number($("budgetInput").value || 0);
  if (value > 0) {
    budgets[month] = value;
  } else {
    delete budgets[month];
  }
  saveAll();
  renderBudget();
}

function monthCategorySpending() {
  const spending = {};
  monthExpenses().forEach(x => {
    spending[x.category] = (spending[x.category] || 0) + x.amount;
  });
  return spending;
}

function renderCategoryBudgets() {
  const month = selectedMonth();
  const monthBudgets = categoryBudgets[month] || {};
  const spending = monthCategorySpending();
  const list = $("categoryBudgetList");
  list.innerHTML = "";

  let totalBudget = 0;

  categories.forEach(category => {
    const budget = Number(monthBudgets[category] || 0);
    const spent = Number(spending[category] || 0);
    const remaining = budget ? budget - spent : null;
    const rate = budget ? (spent / budget) * 100 : null;
    totalBudget += budget;

    const row = document.createElement("div");
    row.className = "category-budget-row";
    if (rate !== null && rate >= 100) row.classList.add("over");
    else if (rate !== null && rate >= 80) row.classList.add("warning");

    row.innerHTML = `
      <div class="category-budget-name"><span class="badge">${escapeHtml(category)}</span></div>
      <label class="category-budget-input-label">
        <span>予算</span>
        <div class="money-input category-budget-input-wrap">
          <span>¥</span>
          <input type="number" class="category-budget-input" data-category="${escapeAttr(category)}" min="0" step="1000" value="${budget || ""}" placeholder="未設定" />
        </div>
      </label>
      <div class="category-budget-metric"><span>実績</span><strong>${formatYen(spent)}</strong></div>
      <div class="category-budget-metric"><span>残額</span><strong>${remaining === null ? "—" : formatYen(remaining)}</strong></div>
      <div class="category-budget-rate">
        <div class="category-budget-rate-head"><span>消化率</span><strong>${rate === null ? "—" : `${rate.toFixed(1)}%`}</strong></div>
        <div class="mini-progress"><div style="width:${rate === null ? 0 : Math.min(rate, 100)}%"></div></div>
      </div>
    `;
    list.appendChild(row);
  });

  $("categoryBudgetTotal").textContent = `予算合計 ${formatYen(totalBudget)}`;
}

function saveCategoryBudgets() {
  const month = selectedMonth();
  const next = {};
  document.querySelectorAll(".category-budget-input").forEach(input => {
    const value = Number(input.value || 0);
    if (value > 0) next[input.dataset.category] = value;
  });

  if (Object.keys(next).length) categoryBudgets[month] = next;
  else delete categoryBudgets[month];

  saveAll();
  renderCategoryBudgets();
}

function renderHistory() {
  const month = selectedMonth();
  const q = $("searchInput").value.trim().toLowerCase();
  const cat = $("filterCategory").value;

  const rows = expenses
    .filter(x => x.date.startsWith(month))
    .filter(x => !cat || x.category === cat)
    .filter(x => {
      if (!q) return true;
      return `${x.merchant} ${x.memo}`.toLowerCase().includes(q);
    })
    .sort((a, b) => (b.date + b.createdAt).localeCompare(a.date + a.createdAt));

  const tbody = $("historyBody");
  tbody.innerHTML = "";
  $("emptyState").style.display = rows.length ? "none" : "block";

  rows.forEach(x => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(x.date)}</td>
      <td><span class="badge">${escapeHtml(x.category)}</span></td>
      <td>${escapeHtml(x.merchant || "-")}</td>
      <td>${escapeHtml(x.memo || "-")}</td>
      <td class="right"><strong>${formatYen(x.amount)}</strong></td>
      <td class="right"><button class="delete-row" data-id="${x.id}">削除</button></td>
    `;
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll(".delete-row").forEach(btn => {
    btn.addEventListener("click", () => deleteExpense(btn.dataset.id));
  });
}

const centerTextPlugin = {
  id: "centerText",
  afterDraw(chart, args, options) {
    if (chart.config.type !== "doughnut") return;
    const { ctx, chartArea } = chart;
    if (!chartArea) return;
    const centerX = (chartArea.left + chartArea.right) / 2;
    const centerY = (chartArea.top + chartArea.bottom) / 2;
    ctx.save();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = getComputedStyle(document.body).getPropertyValue("--muted").trim() || "#788296";
    ctx.font = "600 12px sans-serif";
    ctx.fillText("合計", centerX, centerY - 12);
    ctx.fillStyle = getComputedStyle(document.body).getPropertyValue("--text").trim() || "#172033";
    ctx.font = "700 20px sans-serif";
    ctx.fillText(options.text || "¥0", centerX, centerY + 12);
    ctx.restore();
  }
};

Chart.register(centerTextPlugin);

function renderCharts() {
  const data = monthExpenses();
  const total = data.reduce((s, x) => s + x.amount, 0);

  const byCategory = {};
  data.forEach(x => byCategory[x.category] = (byCategory[x.category] || 0) + x.amount);

  const catLabels = Object.keys(byCategory);
  const catValues = Object.values(byCategory);

  if (categoryChart) categoryChart.destroy();
  categoryChart = new Chart($("categoryChart"), {
    type: "doughnut",
    data: {
      labels: catLabels.length ? catLabels : ["データなし"],
      datasets: [{
        data: catValues.length ? catValues : [1],
        borderWidth: 2,
        cutout: "68%"
      }]
    },
    options: {
      maintainAspectRatio: false,
      plugins: {
        legend: { position: "bottom" },
        centerText: { text: formatYen(total) },
        tooltip: {
          callbacks: {
            label: (ctx) => catValues.length ? `${ctx.label}: ${formatYen(ctx.raw)}` : "データなし"
          }
        }
      }
    }
  });

  const byDay = {};
  data.forEach(x => byDay[x.date] = (byDay[x.date] || 0) + x.amount);
  const days = Object.keys(byDay).sort();
  let running = 0;
  const cumulative = days.map(d => {
    running += byDay[d];
    return running;
  });

  if (dailyChart) dailyChart.destroy();
  dailyChart = new Chart($("dailyChart"), {
    data: {
      labels: days.map(d => d.slice(8)),
      datasets: [
        {
          type: "bar",
          label: "日別支出",
          data: days.map(d => byDay[d]),
          yAxisID: "y"
        },
        {
          type: "line",
          label: "月累計",
          data: cumulative,
          yAxisID: "y1",
          tension: 0.25,
          pointRadius: 2,
          pointHoverRadius: 4,
          borderWidth: 2,
          fill: false
        }
      ]
    },
    options: {
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      scales: {
        y: {
          beginAtZero: true,
          position: "left",
          title: { display: true, text: "日別支出" },
          ticks: {
            callback: (value) => `¥${Number(value).toLocaleString("ja-JP")}`
          }
        },
        y1: {
          beginAtZero: true,
          position: "right",
          title: { display: true, text: "月累計" },
          grid: { drawOnChartArea: false },
          ticks: {
            callback: (value) => `¥${Number(value).toLocaleString("ja-JP")}`
          }
        }
      },
      plugins: {
        legend: { position: "bottom" },
        tooltip: {
          callbacks: {
            label: (ctx) => `${ctx.dataset.label}: ${formatYen(ctx.raw)}`
          }
        }
      }
    }
  });
}

function renderCategoryOptions() {
  $("category").innerHTML = categories.map(c =>
    `<option value="${escapeAttr(c)}">${escapeHtml(c)}</option>`
  ).join("");

  $("filterCategory").innerHTML =
    `<option value="">すべてのカテゴリ</option>` +
    categories.map(c => `<option value="${escapeAttr(c)}">${escapeHtml(c)}</option>`).join("");
}

function renderCategoryChips() {
  const wrap = $("categoryChips");
  wrap.innerHTML = "";

  categories.forEach(c => {
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.innerHTML = `${escapeHtml(c)} <button title="削除" aria-label="${escapeAttr(c)}を削除">×</button>`;
    chip.querySelector("button").addEventListener("click", () => removeCategory(c));
    wrap.appendChild(chip);
  });
}

function addCategory() {
  const input = $("newCategory");
  const name = input.value.trim();
  if (!name || categories.includes(name)) return;
  categories.push(name);
  input.value = "";
  saveAll();
  renderCategoryOptions();
  renderCategoryChips();
  renderCategoryBudgets();
}

function removeCategory(name) {
  if (categories.length <= 1) return;
  if (expenses.some(x => x.category === name)) {
    alert("このカテゴリは支出履歴で使用中のため削除できません。");
    return;
  }
  categories = categories.filter(c => c !== name);
  Object.keys(categoryBudgets).forEach(month => {
    if (categoryBudgets[month] && name in categoryBudgets[month]) {
      delete categoryBudgets[month][name];
      if (!Object.keys(categoryBudgets[month]).length) delete categoryBudgets[month];
    }
  });
  saveAll();
  renderCategoryOptions();
  renderCategoryChips();
  renderCategoryBudgets();
}

function exportCsv() {
  const rows = monthExpenses().sort((a, b) => a.date.localeCompare(b.date));
  const headers = ["日付", "金額", "カテゴリ", "店名・用途", "メモ"];
  const csv = [
    headers,
    ...rows.map(x => [x.date, x.amount, x.category, x.merchant, x.memo])
  ].map(row => row.map(csvEscape).join(",")).join("\n");

  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `expenses-${selectedMonth()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function clearAll() {
  if (!confirm("すべての支出データを削除します。予算設定は残ります。元に戻せません。よろしいですか？")) return;
  expenses = [];
  saveAll();
  renderAll();
}

function toggleTheme() {
  document.body.classList.toggle("dark");
  localStorage.setItem(THEME_KEY, document.body.classList.contains("dark") ? "dark" : "light");
  renderCharts();
}

function renderAll() {
  renderSummary();
  renderBudget();
  renderCategoryBudgets();
  renderHistory();
  renderCharts();
}

function csvEscape(v) {
  const s = String(v ?? "");
  return `"${s.replaceAll('"', '""')}"`;
}

function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, s => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[s]));
}

function escapeAttr(str) {
  return escapeHtml(str);
}


function getCloudPayload() {
  return {
    version: 1,
    expenses,
    categories,
    budgets,
    categoryBudgets
  };
}

function applyCloudPayload(payload, updatedAt) {
  if (!payload || typeof payload !== "object") return;
  isApplyingCloud = true;
  try {
    expenses = Array.isArray(payload.expenses) ? payload.expenses : [];
    categories = Array.isArray(payload.categories) && payload.categories.length ? payload.categories : defaultCategories;
    budgets = payload.budgets && typeof payload.budgets === "object" ? payload.budgets : {};
    categoryBudgets = payload.categoryBudgets && typeof payload.categoryBudgets === "object" ? payload.categoryBudgets : {};
    saveAll({ preserveTimestamp: true, skipCloud: true });
    if (updatedAt) localStorage.setItem(LOCAL_UPDATED_KEY, String(new Date(updatedAt).getTime()));
    renderCategoryOptions();
    renderCategoryChips();
    renderAll();
  } finally {
    isApplyingCloud = false;
  }
}

function cloudConfigured() {
  const cfg = window.DAILY_SPEND_CONFIG || {};
  return Boolean(cfg.supabaseUrl && cfg.supabasePublishableKey && window.supabase?.createClient);
}

async function initCloud() {
  if (!cloudConfigured()) {
    setCloudStatus("local", "端末保存");
    $("cloudMessage").textContent = "Supabase未設定です。config.js を設定するとクラウド同期が有効になります。";
    updateCloudUI();
    return;
  }

  const cfg = window.DAILY_SPEND_CONFIG;
  cloudClient = window.supabase.createClient(cfg.supabaseUrl, cfg.supabasePublishableKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
  });

  const { data, error } = await cloudClient.auth.getSession();
  if (error) {
    setCloudMessage(error.message, true);
    return;
  }
  cloudSession = data.session;
  updateCloudUI();

  cloudClient.auth.onAuthStateChange((_event, session) => {
    cloudSession = session;
    updateCloudUI();
    if (session) setTimeout(() => reconcileCloud(), 0);
  });

  if (cloudSession) await reconcileCloud();
}

function updateCloudUI() {
  const configured = cloudConfigured();
  const signedIn = configured && cloudSession?.user;
  $("cloudAuthForm").hidden = Boolean(signedIn);
  $("cloudSignedIn").hidden = !signedIn;

  if (!configured) {
    $("cloudSignIn").disabled = true;
    $("cloudSignUp").disabled = true;
    $("footerStorageText").textContent = "データはこのブラウザ内に保存されます。";
    return;
  }

  $("cloudSignIn").disabled = false;
  $("cloudSignUp").disabled = false;

  if (signedIn) {
    $("cloudUser").textContent = cloudSession.user.email || cloudSession.user.id;
    $("footerStorageText").textContent = "データは端末内に保存し、ログイン中はSupabaseにも同期されます。";
    setCloudStatus("cloud", "クラウド同期");
  } else {
    $("footerStorageText").textContent = "データはこのブラウザ内に保存されます。";
    setCloudStatus("local", "端末保存");
  }
}

async function cloudSignIn() {
  if (!cloudClient) return setCloudMessage("先にconfig.jsでSupabaseを設定してください。", true);
  const email = $("cloudEmail").value.trim();
  const password = $("cloudPassword").value;
  if (!email || !password) return setCloudMessage("メールアドレスとパスワードを入力してください。", true);
  setCloudStatus("syncing", "ログイン中");
  const { data, error } = await cloudClient.auth.signInWithPassword({ email, password });
  if (error) {
    setCloudStatus("error", "同期エラー");
    return setCloudMessage(error.message, true);
  }
  cloudSession = data.session;
  updateCloudUI();
  setCloudMessage("ログインしました。データを同期します。", false);
  await reconcileCloud();
}

async function cloudSignUp() {
  if (!cloudClient) return setCloudMessage("先にconfig.jsでSupabaseを設定してください。", true);
  const email = $("cloudEmail").value.trim();
  const password = $("cloudPassword").value;
  if (!email || password.length < 6) return setCloudMessage("メールアドレスと6文字以上のパスワードを入力してください。", true);
  setCloudStatus("syncing", "登録中");
  const { data, error } = await cloudClient.auth.signUp({ email, password });
  if (error) {
    setCloudStatus("error", "同期エラー");
    return setCloudMessage(error.message, true);
  }
  cloudSession = data.session;
  updateCloudUI();
  if (data.session) {
    setCloudMessage("アカウントを作成しました。データを同期します。", false);
    await reconcileCloud();
  } else {
    setCloudStatus("local", "確認待ち");
    setCloudMessage("確認メールを送信しました。メール内のリンクから登録を完了してください。", false);
  }
}

async function cloudSignOut() {
  if (!cloudClient) return;
  await cloudClient.auth.signOut();
  cloudSession = null;
  updateCloudUI();
  setCloudMessage("ログアウトしました。端末内のデータは残っています。", false);
}

function scheduleCloudSync() {
  if (!cloudClient || !cloudSession?.user) return;
  clearTimeout(cloudSyncTimer);
  cloudSyncTimer = setTimeout(() => pushCloud(false), 900);
}

async function pushCloud(showMessage = false) {
  if (!cloudClient || !cloudSession?.user) {
    if (showMessage) setCloudMessage("クラウド同期にはログインが必要です。", true);
    return;
  }
  setCloudStatus("syncing", "同期中");
  const now = new Date().toISOString();
  const { error } = await cloudClient.from("daily_spend_data").upsert({
    user_id: cloudSession.user.id,
    payload: getCloudPayload(),
    updated_at: now
  }, { onConflict: "user_id" });

  if (error) {
    setCloudStatus("error", "同期エラー");
    setCloudMessage(`同期に失敗しました: ${error.message}`, true);
    return;
  }
  localStorage.setItem(LOCAL_UPDATED_KEY, String(new Date(now).getTime()));
  setCloudStatus("cloud", "同期済み");
  if (showMessage) setCloudMessage("現在の端末データをクラウドへ保存しました。", false);
}

async function fetchCloudRow() {
  if (!cloudClient || !cloudSession?.user) return null;
  const { data, error } = await cloudClient
    .from("daily_spend_data")
    .select("payload, updated_at")
    .eq("user_id", cloudSession.user.id)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function reconcileCloud() {
  if (!cloudClient || !cloudSession?.user) return;
  setCloudStatus("syncing", "同期確認中");
  try {
    const remote = await fetchCloudRow();
    if (!remote) {
      await pushCloud(false);
      setCloudMessage("この端末のデータを初回クラウド保存しました。", false);
      return;
    }
    const remoteTime = new Date(remote.updated_at).getTime();
    const localTime = Number(localStorage.getItem(LOCAL_UPDATED_KEY) || 0);
    if (remoteTime > localTime) {
      applyCloudPayload(remote.payload, remote.updated_at);
      setCloudStatus("cloud", "同期済み");
      setCloudMessage("クラウドの新しいデータをこの端末に反映しました。", false);
    } else if (localTime > remoteTime) {
      await pushCloud(false);
      setCloudMessage("この端末の新しいデータをクラウドへ反映しました。", false);
    } else {
      setCloudStatus("cloud", "同期済み");
      setCloudMessage("クラウドと同期済みです。", false);
    }
  } catch (error) {
    setCloudStatus("error", "同期エラー");
    setCloudMessage(`同期確認に失敗しました: ${error.message}`, true);
  }
}

async function restoreFromCloud() {
  if (!cloudClient || !cloudSession?.user) return setCloudMessage("ログインが必要です。", true);
  if (!confirm("クラウド上のデータで、この端末の現在データを置き換えます。よろしいですか？")) return;
  try {
    const remote = await fetchCloudRow();
    if (!remote) return setCloudMessage("クラウドに保存データがありません。", true);
    applyCloudPayload(remote.payload, remote.updated_at);
    setCloudStatus("cloud", "同期済み");
    setCloudMessage("クラウドデータを復元しました。", false);
  } catch (error) {
    setCloudStatus("error", "同期エラー");
    setCloudMessage(`復元に失敗しました: ${error.message}`, true);
  }
}

function setCloudStatus(kind, text) {
  const el = $("cloudStatus");
  if (!el) return;
  el.className = `cloud-status ${kind}`;
  el.textContent = text;
}

function setCloudMessage(text, isError) {
  const el = $("cloudMessage");
  if (!el) return;
  el.textContent = text;
  el.style.color = isError ? "var(--danger)" : "var(--muted)";
}

function initPWA() {
  window.addEventListener("beforeinstallprompt", event => {
    event.preventDefault();
    deferredInstallPrompt = event;
    $("installApp").hidden = false;
    refreshPWAStatus();
  });

  window.addEventListener("appinstalled", () => {
    deferredInstallPrompt = null;
    $("installApp").hidden = true;
    refreshPWAStatus();
  });

  if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }
  refreshPWAStatus();
}

function isStandalone() {
  return window.matchMedia?.("(display-mode: standalone)").matches || window.navigator.standalone === true;
}

function refreshPWAStatus() {
  if (isStandalone()) {
    $("pwaStatus").textContent = "インストール済み";
    $("installApp").hidden = true;
    $("installHelp").textContent = "ホーム画面から独立したアプリとして起動しています。";
    return;
  }

  if (location.protocol === "file:") {
    $("pwaStatus").textContent = "公開が必要";
    $("installHelp").textContent = "PWAとしてホーム画面に追加するには、HTTPSのWebサーバーへ公開してください。";
    return;
  }

  const isiOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  if (isiOS) {
    $("pwaStatus").textContent = "追加可能";
    $("installHelp").textContent = "Safariの共有ボタンから「ホーム画面に追加」を選んでください。";
  } else if (deferredInstallPrompt) {
    $("pwaStatus").textContent = "追加可能";
    $("installHelp").textContent = "「ホーム画面に追加」を押すと、アプリのように起動できます。";
  } else {
    $("pwaStatus").textContent = "ブラウザで利用中";
    $("installHelp").textContent = "対応ブラウザではメニューから「インストール」または「ホーム画面に追加」を選べます。";
  }
}

async function installPWA() {
  if (!deferredInstallPrompt) {
    refreshPWAStatus();
    return;
  }
  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
  $("installApp").hidden = true;
  refreshPWAStatus();
}

init();

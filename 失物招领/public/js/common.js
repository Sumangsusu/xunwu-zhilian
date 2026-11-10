// ==================== 寻物智联 公共脚本 ====================
// 多页面共享：API 客户端、账号系统、导航、渲染、详情弹窗

// app-base.js 提供统一站点基址；若某页面漏引，此处做同源兜底，避免整站脚本报错。
if (typeof window.apiUrl !== 'function') {
    window.APP_BASE = '/';
    window.API_BASE = '/';
    window.apiUrl = function (p) { return String(p == null ? '' : p); };
}

let currentUser = null;

// ---------------- API 客户端 ----------------
// 会话基于后端写入的 HttpOnly Cookie，前端不再存储令牌；fetch 携带 same-origin 凭据即可。
const api = {
    async request(method, url, body) {
        const headers = { 'Content-Type': 'application/json' };
        const resp = await fetch(apiUrl(url), {
            method,
            headers,
            credentials: 'same-origin',
            body: body ? JSON.stringify(body) : undefined
        });

        let data = null;
        try { data = await resp.json(); } catch (e) { data = null; }

        if (resp.status === 401) {
            currentUser = null;
            // 系统使用统一认证（CAS）时，直接跳转到学校登录页重新认证
            if (data && data.casLoginUrl) {
                window.location.href = data.casLoginUrl;
                return;
            }
            throw new Error((data && data.message) || '登录已失效，请重新登录');
        }
        if (!resp.ok) {
            throw new Error((data && data.message) || '请求失败，请稍后重试');
        }
        return data;
    },
    get(url) { return this.request('GET', url); },
    post(url, body) { return this.request('POST', url, body); },
    put(url, body) { return this.request('PUT', url, body); },
    patch(url, body) { return this.request('PATCH', url, body); }
};

// ---------------- 用户账号系统 ----------------
const UserDB = {
    async init() {
        try {
            const data = await api.get('/api/auth/me');
            if (!data || !data.success || !data.user) {
                currentUser = null;
                return false;
            }
            currentUser = data.user;
            return true;
        } catch (e) {
            currentUser = null;
            return false;
        }
    },

    async register({ username, password, phone }) {
        try {
            const data = await api.post('/api/auth/register', { username, password, phone });
            return { success: true, message: data.message || '注册成功' };
        } catch (e) {
            return { success: false, message: e.message };
        }
    },

    async login(username, password) {
        try {
            await api.post('/api/auth/login', { username, password });
            await this.init(); // 会话 Cookie 已由后端写入，刷新当前用户
            return { success: true };
        } catch (e) {
            return { success: false, message: e.message };
        }
    },

    async updateProfile(data) {
        try {
            const res = await api.put('/api/auth/profile', data);
            currentUser = res.user;
            return true;
        } catch (e) {
            alert(e.message);
            return false;
        }
    },

    logout() {
        fetch(apiUrl('/api/auth/logout'), { method: 'POST', credentials: 'same-origin' })
            .then(r => r.json())
            .then(d => {
                currentUser = null;
                if (d && d.casLogoutUrl) { window.location.href = d.casLogoutUrl; }
                else { window.location.href = 'login.html'; }
            })
            .catch(() => { window.location.href = 'login.html'; });
    },

    getCurrent() { return currentUser; },
    isLoggedIn() { return currentUser !== null; }
};

// ---------------- 物品数据库 ----------------
const DB = {
    async getAll() { const d = await api.get('/api/items'); return d.items; },
    async getLost() { const d = await api.get('/api/items?type=lost'); return d.items; },
    async getFound() { const d = await api.get('/api/items?type=found'); return d.items; },
    async getById(id) { const d = await api.get('/api/items/' + id); return d.item; },
    async add(item) { const d = await api.post('/api/items', item); return d.item; },
    async matchByFeatures(query) { const d = await api.post('/api/items/match', query); return d.items; },
    async getStats() { const d = await api.get('/api/items/stats'); return d.stats; },
    // 我发布的全部启事（含已撤销）
    async getMy() { const d = await api.get('/api/items/mine'); return d.items; },
    // 撤销(removed)/恢复(active) 自己的启事，管理员可操作任意启事
    async setStatus(id, status) { const d = await api.patch('/api/items/' + id + '/status', { status }); return d; }
};

// ---------------- 意见反馈 ----------------
const Feedback = {
    async submit(data) { return await api.post('/api/feedback', data); },
    async getMy() { const d = await api.get('/api/feedback/mine'); return d.feedback; }
};

// ---------------- 鉴权与导航 ----------------
// 页面加载时校验登录，未登录跳转到登录页（携带来源地址）
async function requireAuth() {
    const loggedIn = await UserDB.init();
    if (!loggedIn) {
        const next = location.pathname === '/login' ? '' : location.pathname;
        location.replace('login.html' + (next ? '?next=' + encodeURIComponent(next) : ''));
        return false;
    }
    const user = UserDB.getCurrent();
    const navUsername = document.getElementById('navUsername');
    const userArea = document.getElementById('userArea');
    if (navUsername) navUsername.textContent = user.username;
    if (userArea) userArea.classList.remove('hidden');
    updateNavAvatar(user);
    highlightNav();
    initMobileMenu();
    return true;
}

// 未登录的页面（如首页允许浏览时）仅初始化导航
async function softInitNav() {
    const loggedIn = await UserDB.init();
    if (loggedIn) {
        const user = UserDB.getCurrent();
        const navUsername = document.getElementById('navUsername');
        const userArea = document.getElementById('userArea');
        if (navUsername) navUsername.textContent = user.username;
        if (userArea) userArea.classList.remove('hidden');
        updateNavAvatar(user);
    }
    highlightNav();
    initMobileMenu();
}

// 导航栏当前页高亮
function highlightNav() {
    const page = document.body.dataset.page;
    if (!page) return;
    document.querySelectorAll('[data-nav]').forEach(a => {
        if (a.dataset.nav === page) {
            a.classList.add('text-primary', 'font-semibold');
        } else {
            a.classList.remove('text-primary', 'font-semibold');
        }
    });
}

function updateNavAvatar(user) {
    const avatarEl = document.getElementById('userAvatar');
    if (!avatarEl) return;
    if (user.avatar) {
        avatarEl.innerHTML = `<img src="${user.avatar}" class="avatar-img" alt="头像">`;
    } else {
        avatarEl.innerHTML = user.username.charAt(0).toUpperCase();
    }
}

function logout() {
    UserDB.logout();
    location.href = 'login.html';
}

function toggleUserMenu() {
    const menu = document.getElementById('userMenu');
    if (menu) menu.classList.toggle('hidden');
}

document.addEventListener('click', function (e) {
    const userMenu = document.getElementById('userMenu');
    const avatarBtn = document.querySelector('#userArea button');
    if (userMenu && avatarBtn && !userMenu.contains(e.target) && !avatarBtn.contains(e.target)) {
        userMenu.classList.add('hidden');
    }
});

function initMobileMenu() {
    const btn = document.getElementById('mobileMenuBtn');
    const menu = document.getElementById('mobileMenu');
    if (!btn || !menu) return;
    btn.addEventListener('click', () => menu.classList.toggle('hidden'));
}

// ---------------- 渲染函数 ----------------
// 图片安全渲染：仅 data: / /images/ / /api/ 视为有效图，否则灰色占位（保证图文匹配）
function itemImgHtml(item, cls) {
    const src = item.image;
    const valid = src && (src.startsWith('data:') || src.startsWith('/images/') || src.startsWith('/api/'));
    if (valid) return `<img src="${src}" alt="${item.title}" class="${cls}">`;
    const iconSize = cls.includes('w-12') || cls.includes('w-10') ? '1rem' : '2rem';
    return `<div class="${cls} img-placeholder"><i class="fa fa-image" style="font-size:${iconSize}"></i></div>`;
}

function createItemCard(item) {
    const badgeClass = item.type === 'lost' ? 'bg-red-100 text-red-600' : 'bg-green-100 text-green-600';
    const badgeText = item.type === 'lost' ? '寻物启事' : '失物招领';

    return `
        <div class="card-art card-hover cursor-pointer overflow-hidden rise-in" onclick="showItemDetail(${item.id})">
            <div class="relative h-48 overflow-hidden card-img-mask">
                ${itemImgHtml(item, "w-full h-full object-cover")}
                <span class="absolute top-3 left-3 px-2.5 py-1 text-xs font-medium rounded-full badge-glass ${badgeClass}">${badgeText}</span>
                ${item.hasQuiz ? `<span class="absolute top-3 right-3 px-2.5 py-1 text-xs font-medium rounded-full badge-glass bg-blue-100 text-blue-700"><i class="fa fa-shield mr-1"></i>需答题认领</span>` : ''}
            </div>
            <div class="p-4">
                <h3 class="font-semibold text-slate-800 mb-2 truncate">${item.title}</h3>
                <div class="space-y-1.5 text-sm text-slate-500">
                    <div class="flex items-center gap-2">
                        <i class="fa fa-map-marker w-4 text-slate-400"></i>
                        <span class="truncate">${item.location}</span>
                    </div>
                    <div class="flex items-center gap-2">
                        <i class="fa fa-clock-o w-4 text-slate-400"></i>
                        <span>${item.date}</span>
                    </div>
                </div>
            </div>
        </div>
    `;
}

// ---------------- 物品详情弹窗 ----------------
async function showItemDetail(id) {
    const item = await DB.getById(id);
    if (!item) return;
    renderItemDetail(item);
}

function renderItemDetail(item) {
    const user = UserDB.getCurrent();
    // 用户端：仅发布者本人可标记已找回/已认领或恢复；管理员请在管理后台操作任意启事
    const canManage = user && user.username === item.publisher;
    const resolved = item.status === 'resolved';
    const resolveLabel = item.type === 'lost' ? '已找回' : '已认领';
    const resolveAction = item.type === 'lost' ? '标记为已找回' : '标记为已认领';

    const badgeClass = item.type === 'lost' ? 'bg-red-100 text-red-600' : 'bg-green-100 text-green-600';
    const badgeText = item.type === 'lost' ? '寻物启事' : '失物招领';

    const statusBanner = resolved
        ? `<div class="mb-4 p-3 bg-emerald-50 border border-emerald-200 rounded-lg text-emerald-700 text-sm font-medium"><i class="fa fa-check-circle mr-1"></i>该启事已标记为「${resolveLabel}」</div>`
        : (item.status === 'removed'
            ? `<div class="mb-4 p-3 bg-slate-100 border border-slate-200 rounded-lg text-slate-500 text-sm font-medium"><i class="fa fa-ban mr-1"></i>该启事已撤销</div>`
            : '');

    document.getElementById('modalContent').innerHTML = `
        <div class="relative h-64">
            ${itemImgHtml(item, "w-full h-full object-cover")}
            <span class="absolute top-4 left-4 px-3 py-1 text-sm font-medium rounded-full badge-glass ${badgeClass}">${badgeText}</span>
        </div>
        <div class="p-6">
            <h3 class="text-xl font-bold text-slate-800 mb-4 font-display">${item.title}</h3>

            ${statusBanner}

            <div class="grid grid-cols-2 gap-4 mb-6">
                <div class="text-sm">
                    <span class="text-slate-500">物品分类</span>
                    <p class="font-medium text-slate-700 mt-0.5">${item.category}</p>
                </div>
                <div class="text-sm">
                    <span class="text-slate-500">主色调</span>
                    <p class="font-medium text-slate-700 mt-0.5">${item.color}</p>
                </div>
                <div class="text-sm">
                    <span class="text-slate-500">地点</span>
                    <p class="font-medium text-slate-700 mt-0.5">${item.location}</p>
                </div>
                <div class="text-sm">
                    <span class="text-slate-500">日期</span>
                    <p class="font-medium text-slate-700 mt-0.5">${item.date}</p>
                </div>
            </div>

            <div class="mb-6">
                <h4 class="text-sm font-medium text-slate-500 mb-2">详细描述</h4>
                <p class="text-slate-700 text-sm leading-relaxed">${item.description}</p>
            </div>

            ${item.reward ? `
            <div class="mb-6 p-3 bg-amber-50 border border-amber-200 rounded-lg">
                <div class="flex items-center gap-2 text-amber-700">
                    <i class="fa fa-gift"></i>
                    <span class="font-medium">酬谢：${item.reward}</span>
                </div>
            </div>
            ` : ''}

            <div class="p-4 bg-slate-50 rounded-xl">
                <div class="text-sm text-slate-500 mb-2">联系方式</div>
                <div class="font-semibold text-slate-800">${item.contact}</div>
                ${item.publisher ? `<div class="text-xs text-slate-400 mt-1">发布者：${item.publisher}</div>` : ''}
            </div>

            ${item.hasQuiz && item.contactMasked ? renderQuizSection(item) : ''}

            <div class="mt-6 space-y-3">
                ${canManage && !resolved && item.status !== 'removed' ? `
                <button class="w-full py-3 bg-secondary text-white rounded-xl font-medium hover:bg-secondary/90 transition-colors" onclick="markResolvedFromModal(${item.id})">
                    <i class="fa fa-check-circle mr-1"></i>${resolveAction}
                </button>` : ''}
                ${canManage && (resolved || item.status === 'removed') ? `
                <button class="w-full py-3 bg-primary text-white rounded-xl font-medium hover:bg-primary/90 transition-colors" onclick="restoreFromModal(${item.id})">
                    <i class="fa fa-rotate-left mr-1"></i>恢复上架
                </button>` : ''}
                <button class="w-full py-3 bg-slate-200 text-slate-700 rounded-xl font-medium hover:bg-slate-300 transition-colors" onclick="closeModal()">
                    我知道了
                </button>
            </div>
        </div>
    `;

    document.getElementById('itemModal').classList.remove('hidden');
    document.getElementById('itemModal').classList.add('flex');
    document.body.style.overflow = 'hidden';
}

// ---------------- 防冒领问答（认领前答题解锁完整联系方式） ----------------
function renderQuizSection(item) {
    const questionsHtml = (item.quiz || []).map((q, qi) => `
        <div class="mt-3">
            <div class="text-sm font-medium text-slate-700 mb-2">${qi + 1}. ${q.q}</div>
            <div class="space-y-1.5">
                ${q.options.map((opt, oi) => `
                <label class="flex items-center gap-2 px-3 py-2 rounded-lg border border-slate-200 bg-white cursor-pointer hover:border-primary transition-colors text-sm text-slate-700">
                    <input type="radio" name="quiz_${item.id}_${qi}" value="${oi}" class="accent-primary">
                    <span>${opt}</span>
                </label>`).join('')}
            </div>
        </div>
    `).join('');

    return `
        <div class="mt-4 p-4 bg-blue-50/70 border border-blue-200 rounded-xl" id="quizSection_${item.id}">
            <div class="flex items-start gap-2 text-sm text-blue-700 mb-1">
                <i class="fa fa-shield mt-0.5"></i>
                <div>
                    <span class="font-semibold">防冒领验证</span>
                    <p class="text-xs text-blue-600/80 mt-0.5">发布者设置了认领问答。全部答对后，上方隐藏的完整联系方式才会显示。</p>
                </div>
            </div>
            ${questionsHtml}
            <div class="mt-4 flex items-center gap-3">
                <button onclick="submitQuiz(${item.id})" class="px-5 py-2 bg-primary text-white rounded-lg text-sm font-medium hover:bg-primary/90 transition-colors">
                    <i class="fa fa-check mr-1"></i>提交答案
                </button>
                <span id="quizMsg_${item.id}" class="text-xs"></span>
            </div>
        </div>
    `;
}

async function submitQuiz(itemId) {
    const section = document.getElementById('quizSection_' + itemId);
    const msg = document.getElementById('quizMsg_' + itemId);
    if (!section) return;
    const item = await DB.getById(itemId);
    if (!item || !item.quiz) return;

    const answers = item.quiz.map((_, qi) => {
        const checked = section.querySelector(`input[name="quiz_${itemId}_${qi}"]:checked`);
        return checked ? Number(checked.value) : -1;
    });
    if (answers.some((a) => a < 0)) {
        if (msg) { msg.textContent = '请回答所有问题'; msg.className = 'text-xs text-amber-600'; }
        return;
    }

    try {
        const resp = await fetch(apiUrl('/api/items/' + itemId + '/verify'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ answers })
        });
        const data = await resp.json();
        if (data.correct) {
            // 答对：更新联系方式显示并移除答题区
            const contactBox = section.previousElementSibling;
            if (contactBox && contactBox.querySelector('.font-semibold')) {
                contactBox.querySelector('.font-semibold').textContent = data.contact;
            }
            section.innerHTML = `
                <div class="flex items-center gap-2 text-sm text-emerald-700 font-medium">
                    <i class="fa fa-check-circle"></i>验证通过！完整联系方式已显示在上方。
                </div>`;
        } else {
            if (msg) { msg.textContent = data.message || '答案不正确'; msg.className = 'text-xs text-red-500'; }
        }
    } catch (e) {
        if (msg) { msg.textContent = '验证失败，请稍后重试'; msg.className = 'text-xs text-red-500'; }
    }
}

async function markResolvedFromModal(id) {
    if (!confirm('确认将这条启事标记为已解决？标记后将下架，并计入找回/认领统计。')) return;
    try {
        await DB.setStatus(id, 'resolved');
        await afterItemChange();
        await showItemDetail(id);
    } catch (e) {
        alert(e.message || '操作失败，请重试');
    }
}

async function restoreFromModal(id) {
    if (!confirm('确认将这条启事恢复上架？')) return;
    try {
        await DB.setStatus(id, 'active');
        await afterItemChange();
        await showItemDetail(id);
    } catch (e) {
        alert(e.message || '操作失败，请重试');
    }
}

async function afterItemChange() {
    if (typeof window.refreshAfterItemChange === 'function') {
        try { await window.refreshAfterItemChange(); } catch (e) { /* 静默忽略 */ }
    }
}

function closeModal() {
    const modal = document.getElementById('itemModal');
    if (!modal) return;
    modal.classList.add('hidden');
    modal.classList.remove('flex');
    document.body.style.overflow = '';
}

// ESC 关闭弹窗
document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
        closeModal();
    }
});

// 物品详情弹窗公共结构（各页面在 body 末尾引入）
const MODAL_HTML = `
    <div id="itemModal" class="fixed inset-0 z-50 hidden items-center justify-center p-4">
        <div class="absolute inset-0 bg-black/60 backdrop-blur-sm" onclick="closeModal()"></div>
        <div class="relative modal-art max-w-lg w-full max-h-[90vh] overflow-y-auto fade-in">
            <button onclick="closeModal()" class="absolute top-4 right-4 w-8 h-8 bg-slate-100 rounded-full flex items-center justify-center hover:bg-slate-200 transition-colors z-10">
                <i class="fa fa-times text-slate-600"></i>
            </button>
            <div id="modalContent">
            </div>
        </div>
    </div>
`;

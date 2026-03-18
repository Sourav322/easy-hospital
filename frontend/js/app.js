// ====================================================
// Easy Hospital HMS - API Client
// ====================================================

const RAILWAY_BACKEND = 'https://web-production-b4bc9.up.railway.app';

const API_BASE = window.location.hostname === 'localhost'
  ? 'http://localhost:5000/api'
  : `${RAILWAY_BACKEND}/api`;

const api = {
    getToken: () => localStorage.getItem('ehms_token'),
    getUser: () => JSON.parse(localStorage.getItem('ehms_user') || 'null'),

    headers: () => ({
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${api.getToken()}`
    }),

    async request(method, endpoint, data = null) {
        try {
            const opts = {
                method,
                headers: api.headers()
            };
            if (data) opts.body = JSON.stringify(data);
            const res = await fetch(`${API_BASE}${endpoint}`, opts);
            const json = await res.json();
            if (res.status === 401) {
                api.logout();
                return null;
            }
            return json;
        } catch (e) {
            console.error(`API ${method} ${endpoint}:`, e);
            return { success: false, message: 'Network error' };
        }
    },

    get: (endpoint) => api.request('GET', endpoint),
    post: (endpoint, data) => api.request('POST', endpoint, data),
    put: (endpoint, data) => api.request('PUT', endpoint, data),
    delete: (endpoint) => api.request('DELETE', endpoint),

    logout() {
        localStorage.removeItem('ehms_token');
        localStorage.removeItem('ehms_user');
        window.location.href = '/index.html';
    },

    requireAuth() {
        if (!api.getToken()) {
            window.location.href = '/index.html';
        }
    }
};

// ====================================================
// SIDEBAR & LAYOUT
// ====================================================

function renderSidebar(activePage) {
    const user = api.getUser();
    if (!user) { api.logout(); return; }

    const role = user.role;
    const orgType = user.orgType || 'hospital';

    const allMenuItems = [
        { id: 'dashboard', label: 'Dashboard', icon: '⊞', href: 'dashboard.html', roles: ['*'] },
        { id: 'patients', label: 'Patients', icon: '👥', href: 'patients.html', roles: ['*'] },
        { id: 'doctors', label: 'Doctors', icon: '🩺', href: 'doctors.html', roles: ['super_admin', 'hospital_admin', 'receptionist'] },
        { id: 'appointments', label: 'Appointments', icon: '📅', href: 'appointments.html', roles: ['*'] },
        { id: 'opd', label: 'OPD', icon: '🏥', href: 'opd.html', roles: ['*'] },
        { id: 'ipd', label: 'IPD / Wards', icon: '🛏', href: 'ipd.html', roles: ['super_admin', 'hospital_admin', 'doctor', 'nurse'], orgTypes: ['hospital'] },
        { id: 'laboratory', label: 'Laboratory', icon: '🔬', href: 'laboratory.html', roles: ['*'] },
        { id: 'billing', label: 'Billing', icon: '💳', href: 'billing.html', roles: ['super_admin', 'hospital_admin', 'billing', 'receptionist'] },
        { id: 'staff', label: 'Staff', icon: '👤', href: 'staff.html', roles: ['super_admin', 'hospital_admin'] },
        { id: 'inventory', label: 'Inventory', icon: '📦', href: 'inventory.html', roles: ['super_admin', 'hospital_admin'], orgTypes: ['hospital'] },
        { id: 'reports', label: 'Reports', icon: '📊', href: 'reports.html', roles: ['super_admin', 'hospital_admin'] },
        { id: 'settings', label: 'Settings', icon: '⚙️', href: 'settings.html', roles: ['super_admin', 'hospital_admin'] },
    ];

    const menuItems = allMenuItems.filter(item => {
        const roleOk = item.roles.includes('*') || item.roles.includes(role);
        const orgOk = !item.orgTypes || item.orgTypes.includes(orgType);
        return roleOk && orgOk;
    });

    const sidebarHTML = `
        <aside id="sidebar" class="sidebar">
            <div class="sidebar-logo">
                <div class="logo-icon">🏥</div>
                <div class="logo-text">
                    <span class="logo-main">Easy</span>
                    <span class="logo-sub">Hospital</span>
                </div>
            </div>
            <div class="sidebar-hospital">
                <div class="hospital-name">${user.hospitalName || 'My Hospital'}</div>
                <div class="hospital-code">${user.hospCode || ''}</div>
            </div>
            <nav class="sidebar-nav">
                ${menuItems.map(item => `
                    <a href="${item.href}" class="nav-item ${activePage === item.id ? 'active' : ''}">
                        <span class="nav-icon">${item.icon}</span>
                        <span class="nav-label">${item.label}</span>
                    </a>
                `).join('')}
            </nav>
            <div class="sidebar-footer">
                <div class="user-info">
                    <div class="user-avatar">${user.name ? user.name.charAt(0).toUpperCase() : 'U'}</div>
                    <div class="user-details">
                        <div class="user-name">${user.name || 'User'}</div>
                        <div class="user-role">${formatRole(user.role)}</div>
                    </div>
                </div>
                <button class="logout-btn" onclick="api.logout()">⏻</button>
            </div>
        </aside>
        <div class="sidebar-overlay" id="sidebarOverlay" onclick="toggleSidebar()"></div>
    `;

    document.getElementById('sidebar-container').innerHTML = sidebarHTML;
}

function renderTopbar(title, subtitle = '') {
    const user = api.getUser();
    document.getElementById('topbar-container').innerHTML = `
        <header class="topbar">
            <div class="topbar-left">
                <button class="menu-toggle" onclick="toggleSidebar()">☰</button>
                <div class="page-title">
                    <h1>${title}</h1>
                    ${subtitle ? `<span class="page-subtitle">${subtitle}</span>` : ''}
                </div>
            </div>
            <div class="topbar-right">
                <div class="date-badge">
                    <span>📅</span>
                    <span>${new Date().toLocaleDateString('en-IN', {day:'numeric',month:'short',year:'numeric'})}</span>
                </div>
                <div class="user-chip">
                    <div class="chip-avatar">${user?.name?.charAt(0) || 'U'}</div>
                    <span>${user?.name || 'User'}</span>
                </div>
            </div>
        </header>
    `;
}

function toggleSidebar() {
    const sidebar = document.getElementById('sidebar');
    const overlay = document.getElementById('sidebarOverlay');
    sidebar?.classList.toggle('open');
    overlay?.classList.toggle('active');
}

function formatRole(role) {
    const roles = {
        super_admin: 'Super Admin',
        hospital_admin: 'Hospital Admin',
        doctor: 'Doctor',
        receptionist: 'Receptionist',
        nurse: 'Nurse',
        lab_tech: 'Lab Technician',
        billing: 'Billing',
        staff: 'Staff'
    };
    return roles[role] || role;
}

// ====================================================
// TOAST NOTIFICATIONS
// ====================================================

function showToast(message, type = 'success') {
    const toastContainer = document.getElementById('toast-container') || createToastContainer();
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    const icons = { success: '✅', error: '❌', warning: '⚠️', info: 'ℹ️' };
    toast.innerHTML = `<span>${icons[type] || '•'}</span><span>${message}</span>`;
    toastContainer.appendChild(toast);
    setTimeout(() => toast.classList.add('show'), 10);
    setTimeout(() => { toast.classList.remove('show'); setTimeout(() => toast.remove(), 300); }, 3500);
}

function createToastContainer() {
    const div = document.createElement('div');
    div.id = 'toast-container';
    div.style.cssText = 'position:fixed;bottom:24px;right:24px;z-index:9999;display:flex;flex-direction:column;gap:8px;';
    document.body.appendChild(div);
    return div;
}

// ====================================================
// MODAL HELPERS
// ====================================================

function openModal(modalId) {
    document.getElementById(modalId)?.classList.add('active');
    document.body.style.overflow = 'hidden';
}

function closeModal(modalId) {
    document.getElementById(modalId)?.classList.remove('active');
    document.body.style.overflow = '';
}

// ====================================================
// UTILITY
// ====================================================

function formatDate(date) {
    if (!date) return '-';
    return new Date(date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

function formatCurrency(amount) {
    return '₹' + parseFloat(amount || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 });
}

function formatStatus(status) {
    const map = {
        scheduled: { label: 'Scheduled', cls: 'badge-info' },
        confirmed: { label: 'Confirmed', cls: 'badge-primary' },
        'in-progress': { label: 'In Progress', cls: 'badge-warning' },
        completed: { label: 'Completed', cls: 'badge-success' },
        cancelled: { label: 'Cancelled', cls: 'badge-danger' },
        admitted: { label: 'Admitted', cls: 'badge-primary' },
        discharged: { label: 'Discharged', cls: 'badge-success' },
        pending: { label: 'Pending', cls: 'badge-warning' },
        paid: { label: 'Paid', cls: 'badge-success' },
        partial: { label: 'Partial', cls: 'badge-warning' },
        available: { label: 'Available', cls: 'badge-success' },
        occupied: { label: 'Occupied', cls: 'badge-danger' }
    };
    const s = map[status] || { label: status, cls: 'badge-secondary' };
    return `<span class="badge ${s.cls}">${s.label}</span>`;
}

function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
        clearTimeout(timeout);
        timeout = setTimeout(() => func(...args), wait);
    };
}

// Init: Check auth on protected pages
if (!window.location.pathname.includes('index.html') && window.location.pathname !== '/') {
    api.requireAuth();
}

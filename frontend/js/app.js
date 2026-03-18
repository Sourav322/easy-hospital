// ====================================================
// Easy Hospital HMS - API Client
// ====================================================

const API_BASE = window.location.hostname === 'localhost'
  ? 'http://localhost:5000/api'
  : 'https://web-production-b4bc9.up.railway.app/api';

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

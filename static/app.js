'use strict';

// === API Client ===

const API = {
  async get(path) {
    const res = await fetch(path);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `HTTP ${res.status}`);
    }
    return res.json();
  },

  async post(path, body) {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    return res.json();
  },

  getProjects() {
    return this.get('/api/projects');
  },

  getConfigs() {
    return this.get('/api/configs');
  },

  getSessions(projectRoot) {
    const params = projectRoot ? `?project=${encodeURIComponent(projectRoot)}` : '';
    return this.get('/api/sessions' + params);
  },

  getSession(bufferName) {
    return this.get('/api/sessions/' + encodeURIComponent(bufferName));
  },

  getStatus() {
    return this.get('/api/status');
  },

  createSession(projectRoot, configId) {
    return this.post('/api/sessions', {
      project_root: projectRoot,
      config_identifier: configId,
    });
  },

  sendMessage(bufferName, text) {
    return this.post(
      '/api/sessions/' + encodeURIComponent(bufferName) + '/message',
      { text }
    );
  },

  respondPermission(bufferName, toolCallId, optionId) {
    return this.post(
      '/api/sessions/' + encodeURIComponent(bufferName) + '/permission',
      { tool_call_id: toolCallId, option_id: optionId }
    );
  },

  cancelPermission(bufferName, toolCallId) {
    return this.post(
      '/api/sessions/' + encodeURIComponent(bufferName) + '/permission',
      { tool_call_id: toolCallId, cancelled: true }
    );
  },

  poll(bufferName) {
    return this.get('/api/sessions/' + encodeURIComponent(bufferName) + '/poll');
  },
};

// === Utility ===

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function formatCost(amount, currency) {
  if (!amount || amount === 0) return null;
  if (currency === 'USD') return `$${amount.toFixed(4)}`;
  return `${amount.toFixed(4)} ${currency || ''}`;
}

// === App State ===

const App = {
  currentView: null,
  pollTimer: null,
  lastContentLength: null,
  lastPermissionCount: null,
  lastBusy: null,
  userScrolledUp: false,
  configs: null,

  // === Initialization ===

  init() {
    window.addEventListener('hashchange', () => this.route());

    // Notification button
    const notifBtn = document.getElementById('notification-btn');
    if ('Notification' in window && 'serviceWorker' in navigator) {
      if (Notification.permission === 'default') {
        notifBtn.style.display = '';
        notifBtn.onclick = async () => {
          const perm = await Notification.requestPermission();
          if (perm === 'granted') {
            notifBtn.style.display = 'none';
          }
        };
      }
    }

    // Register service worker
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/static/sw.js').catch(() => {});
    }

    this.route();
  },

  // === Routing ===

  route() {
    this.saveDraft();
    this.stopPolling();
    this.currentView = null;
    this._currentSessionName = null;

    const hash = location.hash || '#/';

    if (hash === '#/' || hash === '#/projects') {
      this.showProjects();
    } else if (hash.startsWith('#/sessions')) {
      const params = new URLSearchParams(hash.split('?')[1] || '');
      this.showSessions(params.get('project'));
    } else if (hash.startsWith('#/session/')) {
      const bufferName = decodeURIComponent(hash.slice('#/session/'.length));
      this.showSession(bufferName);
    } else {
      this.showProjects();
    }
  },

  // === Projects View ===

  async showProjects() {
    this.currentView = 'projects';
    this.setBreadcrumb([]);
    const content = document.getElementById('app-content');
    content.innerHTML = '<div class="loading">Loading projects...</div>';

    try {
      const [projectsData, configsData] = await Promise.all([
        API.getProjects(),
        API.getConfigs(),
      ]);
      this.configs = configsData.configs;

      if (this.currentView !== 'projects') return;

      let html = `
        <div class="section-header">
          <span class="section-title">Projects</span>
          <a href="#/sessions" class="btn btn-sm">All Sessions</a>
        </div>
      `;

      if (projectsData.projects.length === 0) {
        html += `
          <div class="empty-state">
            <div class="empty-state-icon">&gt;_</div>
            <div>No projects found in Emacs project.el</div>
          </div>
        `;
      } else {
        html += '<div class="card-grid">';
        for (const project of projectsData.projects) {
          html += `
            <div class="card" onclick="location.hash='#/sessions?project=${encodeURIComponent(project.root)}'">
              <div class="card-title">${escapeHtml(project.name)}</div>
              <div class="card-subtitle">${escapeHtml(project.root)}</div>
              <div class="card-meta">
                <div class="config-dropdown">
                  <button class="btn btn-sm btn-primary" onclick="event.stopPropagation(); App.toggleConfigMenu(this, '${escapeHtml(project.root.replace(/'/g, "\\'"))}')">
                    + New Session
                  </button>
                </div>
                <a href="#/sessions?project=${encodeURIComponent(project.root)}" class="btn btn-sm" onclick="event.stopPropagation()">
                  View Sessions
                </a>
              </div>
            </div>
          `;
        }
        html += '</div>';
      }

      content.innerHTML = html;
    } catch (err) {
      content.innerHTML = `<div class="empty-state"><div>Error: ${escapeHtml(err.message)}</div></div>`;
    }
  },

  // === Config Menu ===

  toggleConfigMenu(button, projectRoot) {
    // Close any existing menus
    document.querySelectorAll('.config-menu').forEach(m => m.remove());

    const menu = document.createElement('div');
    menu.className = 'config-menu';

    if (!this.configs || this.configs.length === 0) {
      menu.innerHTML = '<div class="config-menu-item" style="color:var(--text-muted)">No configs available</div>';
    } else {
      for (const config of this.configs) {
        const item = document.createElement('button');
        item.className = 'config-menu-item';
        item.textContent = config.buffer_name || config.identifier;
        item.onclick = (e) => {
          e.stopPropagation();
          menu.remove();
          this.createSession(projectRoot, config.identifier);
        };
        menu.appendChild(item);
      }
    }

    // Append to body with fixed positioning to avoid overflow clipping
    document.body.appendChild(menu);
    const rect = button.getBoundingClientRect();
    const menuWidth = menu.offsetWidth;
    let left = rect.left;
    // If menu would overflow the right edge, align to button's right edge instead
    if (left + menuWidth > window.innerWidth) {
      left = rect.right - menuWidth;
    }
    // Clamp to viewport
    left = Math.max(4, Math.min(left, window.innerWidth - menuWidth - 4));
    menu.style.top = rect.bottom + 4 + 'px';
    menu.style.left = left + 'px';

    // Close on outside click
    const close = (e) => {
      if (!menu.contains(e.target)) {
        menu.remove();
        document.removeEventListener('click', close);
      }
    };
    setTimeout(() => document.addEventListener('click', close), 0);
  },

  async createSession(projectRoot, configId) {
    try {
      const result = await API.createSession(projectRoot, configId);
      location.hash = '#/session/' + encodeURIComponent(result.buffer_name);
    } catch (err) {
      alert('Failed to create session: ' + err.message);
    }
  },

  // === Sessions List View ===

  async showSessions(projectFilter) {
    this.currentView = 'sessions';
    const content = document.getElementById('app-content');
    content.innerHTML = '<div class="loading">Loading sessions...</div>';

    if (projectFilter) {
      const projectName = projectFilter.replace(/\/$/, '').split('/').pop();
      this.setBreadcrumb([
        { label: projectName, hash: '#/sessions?project=' + encodeURIComponent(projectFilter) },
      ]);
    } else {
      this.setBreadcrumb([{ label: 'All Sessions', hash: '#/sessions' }]);
    }

    try {
      const data = await API.getSessions(projectFilter);

      if (this.currentView !== 'sessions') return;

      const projectName = projectFilter
        ? projectFilter.replace(/\/$/, '').split('/').pop()
        : null;

      let html = `
        <div class="section-header">
          <span class="section-title">${projectName ? escapeHtml(projectName) + ' Sessions' : 'All Sessions'}</span>
          ${projectFilter && this.configs ? `
            <div class="config-dropdown">
              <button class="btn btn-sm btn-primary" onclick="App.toggleConfigMenu(this, '${escapeHtml(projectFilter.replace(/'/g, "\\'"))}')">
                + New Session
              </button>
            </div>
          ` : ''}
        </div>
      `;

      if (data.sessions.length === 0) {
        html += `
          <div class="empty-state">
            <div class="empty-state-icon">&gt;_</div>
            <div>No running sessions${projectName ? ' in ' + escapeHtml(projectName) : ''}</div>
          </div>
        `;
      } else {
        html += '<div class="card-grid">';
        for (const session of data.sessions) {
          const statusBadge = session.stuck
            ? '<span class="badge badge-stuck"><span class="pulse"></span> Needs Attention</span>'
            : session.busy
              ? '<span class="badge badge-busy"><span class="spinner"></span> Working</span>'
              : '<span class="badge badge-idle">Idle</span>';

          html += `
            <div class="card" onclick="location.hash='#/session/${encodeURIComponent(session.buffer_name)}'">
              <div class="card-title">${escapeHtml(session.agent_name || session.buffer_name)}</div>
              <div class="card-subtitle">${escapeHtml(session.project_name || '')}</div>
              <div class="card-meta">
                ${statusBadge}
                ${session.pending_permission_count > 0 ? `<span class="badge badge-stuck">${session.pending_permission_count} permission${session.pending_permission_count > 1 ? 's' : ''}</span>` : ''}
              </div>
            </div>
          `;
        }
        html += '</div>';
      }

      content.innerHTML = html;
    } catch (err) {
      content.innerHTML = `<div class="empty-state"><div>Error: ${escapeHtml(err.message)}</div></div>`;
    }
  },

  // === Session Detail (Chat) View ===

  async showSession(bufferName) {
    this.currentView = 'session';
    this._currentSessionName = bufferName;
    this.userScrolledUp = false;

    const content = document.getElementById('app-content');
    content.style.overflow = 'hidden';
    content.style.padding = '0';
    content.innerHTML = '<div class="loading" style="padding:16px">Loading session...</div>';

    const shortName = bufferName.replace(/^\*|\*$/g, '');
    this.setBreadcrumb([
      { label: 'Sessions', hash: '#/sessions' },
      { label: shortName, hash: '#/session/' + encodeURIComponent(bufferName) },
    ]);

    try {
      const data = await API.getSession(bufferName);
      if (this.currentView !== 'session') return;
      this.renderSession(bufferName, data);
      this.startPolling(bufferName);
    } catch (err) {
      content.innerHTML = `<div class="empty-state" style="padding:16px"><div>Error: ${escapeHtml(err.message)}</div></div>`;
    }
  },

  renderSession(bufferName, data) {
    const content = document.getElementById('app-content');

    // Build usage bar
    let usageHtml = '';
    if (data.usage) {
      const parts = [];
      if (data.usage.total_tokens) parts.push(`<span class="usage-item"><span class="usage-label">Tokens:</span> ${data.usage.total_tokens.toLocaleString()}</span>`);
      const cost = formatCost(data.usage.cost_amount, data.usage.cost_currency);
      if (cost) parts.push(`<span class="usage-item"><span class="usage-label">Cost:</span> ${cost}</span>`);
      if (parts.length) usageHtml = `<div class="usage-bar">${parts.join('')}</div>`;
    }

    // Build permissions HTML
    let permHtml = '';
    if (data.pending_permissions && data.pending_permissions.length > 0) {
      for (const perm of data.pending_permissions) {
        const optionsHtml = perm.options.map(opt => {
          const cls = opt.kind === 'reject_once' ? 'btn btn-sm btn-danger'
            : opt.kind === 'allow_always' ? 'btn btn-sm btn-warning'
              : 'btn btn-sm btn-primary';
          return `<button class="${cls}" onclick="App.respondPermission('${escapeHtml(bufferName.replace(/'/g, "\\'"))}', '${escapeHtml(perm.tool_call_id)}', '${escapeHtml(opt.option_id)}')">${escapeHtml(opt.name)}</button>`;
        }).join('');

        permHtml += `
          <div class="permission-card">
            <div class="permission-title">Permission Required</div>
            <div class="permission-detail">${escapeHtml(perm.title)}</div>
            <div class="permission-actions">${optionsHtml}</div>
          </div>
        `;
      }
    }

    const busyIndicator = data.busy
      ? '<span class="badge badge-busy" style="margin-left:auto"><span class="spinner"></span> Working</span>'
      : '';

    content.innerHTML = `
      <div class="chat-container">
        ${usageHtml}
        <div class="chat-content" id="chat-scroll">
          <pre class="chat-text" id="chat-text">${escapeHtml(data.content)}</pre>
          <div id="chat-permissions">${permHtml}</div>
        </div>
        <div class="chat-input-container">
          <textarea class="chat-input" id="chat-input" placeholder="Type a message..." rows="1"
                    ${data.busy ? 'disabled' : ''}></textarea>
          <button class="chat-send-btn" id="chat-send" ${data.busy ? 'disabled' : ''}
                  onclick="App.sendMessage('${escapeHtml(bufferName.replace(/'/g, "\\'"))}')">&#9654;</button>
          ${busyIndicator}
        </div>
      </div>
    `;

    // Auto-resize textarea and save draft on input
    const textarea = document.getElementById('chat-input');
    textarea.addEventListener('input', () => {
      textarea.style.height = 'auto';
      textarea.style.height = Math.min(textarea.scrollHeight, 120) + 'px';
      this.saveDraft();
    });

    // Restore any saved draft
    this.restoreDraft(bufferName);

    // Enter to send (Shift+Enter for newline)
    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (!textarea.disabled) {
          this.sendMessage(bufferName);
        }
      }
    });

    // Track scroll position
    const chatScroll = document.getElementById('chat-scroll');
    chatScroll.addEventListener('scroll', () => {
      const atBottom = chatScroll.scrollHeight - chatScroll.scrollTop - chatScroll.clientHeight < 50;
      this.userScrolledUp = !atBottom;
    });

    // Scroll to bottom
    if (!this.userScrolledUp) {
      chatScroll.scrollTop = chatScroll.scrollHeight;
    }
  },

  updateSessionContent(bufferName, data) {
    const chatText = document.getElementById('chat-text');
    const chatPermissions = document.getElementById('chat-permissions');
    const chatScroll = document.getElementById('chat-scroll');
    const chatInput = document.getElementById('chat-input');
    const chatSend = document.getElementById('chat-send');

    if (!chatText) return;

    chatText.textContent = data.content;

    // Update permissions
    let permHtml = '';
    if (data.pending_permissions && data.pending_permissions.length > 0) {
      for (const perm of data.pending_permissions) {
        const optionsHtml = perm.options.map(opt => {
          const cls = opt.kind === 'reject_once' ? 'btn btn-sm btn-danger'
            : opt.kind === 'allow_always' ? 'btn btn-sm btn-warning'
              : 'btn btn-sm btn-primary';
          return `<button class="${cls}" onclick="App.respondPermission('${escapeHtml(bufferName.replace(/'/g, "\\'"))}', '${escapeHtml(perm.tool_call_id)}', '${escapeHtml(opt.option_id)}')">${escapeHtml(opt.name)}</button>`;
        }).join('');

        permHtml += `
          <div class="permission-card">
            <div class="permission-title">Permission Required</div>
            <div class="permission-detail">${escapeHtml(perm.title)}</div>
            <div class="permission-actions">${optionsHtml}</div>
          </div>
        `;
      }
    }
    if (chatPermissions) chatPermissions.innerHTML = permHtml;

    // Update busy state
    if (chatInput) chatInput.disabled = data.busy;
    if (chatSend) chatSend.disabled = data.busy;

    // Update usage bar
    if (data.usage) {
      const usageBar = document.querySelector('.usage-bar');
      if (usageBar) {
        const parts = [];
        if (data.usage.total_tokens) parts.push(`<span class="usage-item"><span class="usage-label">Tokens:</span> ${data.usage.total_tokens.toLocaleString()}</span>`);
        const cost = formatCost(data.usage.cost_amount, data.usage.cost_currency);
        if (cost) parts.push(`<span class="usage-item"><span class="usage-label">Cost:</span> ${cost}</span>`);
        usageBar.innerHTML = parts.join('');
      }
    }

    // Auto-scroll if user hasn't scrolled up
    if (!this.userScrolledUp && chatScroll) {
      chatScroll.scrollTop = chatScroll.scrollHeight;
    }
  },

  // === Message Sending ===

  async sendMessage(bufferName) {
    const input = document.getElementById('chat-input');
    const text = input.value.trim();
    if (!text) return;

    input.value = '';
    input.style.height = 'auto';
    input.disabled = true;
    document.getElementById('chat-send').disabled = true;
    this.clearDraft(bufferName);

    try {
      await API.sendMessage(bufferName, text);
    } catch (err) {
      input.value = text;
      alert('Failed to send: ' + err.message);
    }
  },

  // === Permission Response ===

  async respondPermission(bufferName, toolCallId, optionId) {
    try {
      await API.respondPermission(bufferName, toolCallId, optionId);
      // Immediately refresh
      const data = await API.getSession(bufferName);
      this.updateSessionContent(bufferName, data);
    } catch (err) {
      alert('Failed: ' + err.message);
    }
  },

  // === Polling ===

  startPolling(bufferName) {
    this.lastContentLength = null;
    this.lastPermissionCount = null;
    this.lastBusy = null;

    this.pollTimer = setInterval(async () => {
      try {
        const status = await API.poll(bufferName);
        if (
          status.content_length !== this.lastContentLength ||
          status.pending_permission_count !== this.lastPermissionCount ||
          status.busy !== this.lastBusy
        ) {
          const data = await API.getSession(bufferName);
          this.updateSessionContent(bufferName, data);
          this.lastContentLength = status.content_length;
          this.lastPermissionCount = status.pending_permission_count;
          this.lastBusy = status.busy;
        }
      } catch (err) {
        // Silently ignore poll errors
      }
    }, 1500);
  },

  stopPolling() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    // Reset content area styles when leaving chat view
    const content = document.getElementById('app-content');
    if (content) {
      content.style.overflow = '';
      content.style.padding = '';
    }
  },

  // === Draft Persistence ===

  _draftKey(bufferName) {
    return 'draft:' + bufferName;
  },

  saveDraft() {
    const input = document.getElementById('chat-input');
    if (!input || !this._currentSessionName) return;
    const text = input.value;
    if (text) {
      sessionStorage.setItem(this._draftKey(this._currentSessionName), text);
    } else {
      sessionStorage.removeItem(this._draftKey(this._currentSessionName));
    }
  },

  restoreDraft(bufferName) {
    const input = document.getElementById('chat-input');
    if (!input) return;
    const draft = sessionStorage.getItem(this._draftKey(bufferName));
    if (draft) {
      input.value = draft;
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 120) + 'px';
    }
  },

  clearDraft(bufferName) {
    sessionStorage.removeItem(this._draftKey(bufferName));
  },

  // === Breadcrumb ===

  setBreadcrumb(items) {
    const nav = document.getElementById('breadcrumb');
    let html = '<a href="#/" class="brand">&gt;_ Agent Shell</a>';
    for (const item of items) {
      html += '<span class="sep">/</span>';
      html += `<a href="${item.hash}" class="current">${escapeHtml(item.label)}</a>`;
    }
    nav.innerHTML = html;
  },
};

// === Boot ===

document.addEventListener('DOMContentLoaded', () => App.init());

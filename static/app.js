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

function formatCompact(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(0) + 'm';
  if (n >= 1000) return (n / 1000).toFixed(0) + 'k';
  return n.toLocaleString();
}

function buildUsageItems(usage) {
  if (!usage) return [];
  const items = [];

  // Token breakdown (input/output are more useful than total)
  const tokenParts = [];
  if (usage.input_tokens) tokenParts.push(`${formatCompact(usage.input_tokens)} in`);
  if (usage.output_tokens) tokenParts.push(`${formatCompact(usage.output_tokens)} out`);
  if (usage.thought_tokens) tokenParts.push(`${formatCompact(usage.thought_tokens)} thought`);
  if (usage.cached_read_tokens) tokenParts.push(`${formatCompact(usage.cached_read_tokens)} cached`);
  if (tokenParts.length) {
    items.push(`<span class="usage-item"><span class="usage-label">Tokens:</span> ${tokenParts.join(' · ')}</span>`);
  }

  // Context window
  if (usage.context_size > 0) {
    const pct = ((usage.context_used || 0) / usage.context_size * 100).toFixed(1);
    items.push(`<span class="usage-item"><span class="usage-label">Context:</span> ${formatCompact(usage.context_used || 0)}/${formatCompact(usage.context_size)} (${pct}%)</span>`);
  }

  // Cost
  const cost = formatCost(usage.cost_amount, usage.cost_currency);
  if (cost) items.push(`<span class="usage-item"><span class="usage-label">Cost:</span> ${cost}</span>`);

  return items;
}

// === Markdown Renderer ===

function renderMarkdown(text) {
  if (!text) return '';
  // Split by fenced code blocks (```lang\n...\n```)
  const parts = text.split(/(```[\s\S]*?```)/g);
  let html = '';

  for (const part of parts) {
    if (part.startsWith('```')) {
      const match = part.match(/^```(\w*)\n?([\s\S]*?)```$/);
      if (match) {
        const lang = match[1];
        const code = escapeHtml(match[2].replace(/\n$/, ''));
        const langClass = lang ? ` class="language-${escapeHtml(lang)}"` : '';
        html += `<pre class="code-block"><code${langClass}>${code}</code></pre>`;
      } else {
        html += `<pre class="code-block"><code>${escapeHtml(part)}</code></pre>`;
      }
    } else {
      // Escape HTML first, then apply inline markdown
      let s = escapeHtml(part);
      // Bold
      s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
      // Inline code
      s = s.replace(/`([^`\n]+)`/g, '<code class="inline-code">$1</code>');
      // Italic (single *, avoiding ** and content within code)
      s = s.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<em>$1</em>');
      // Links
      s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
      // Headers (## through ######)
      s = s.replace(/^(#{1,6})\s+(.+)$/gm, (_, hashes, text) => {
        const level = Math.min(hashes.length, 6);
        return `<span class="md-heading md-h${level}">${text}</span>`;
      });
      // Horizontal rules
      s = s.replace(/^[-*_]{3,}\s*$/gm, '<hr class="md-hr">');
      html += s;
    }
  }
  return html;
}

// === Fragment Renderer ===

function renderFragments(fragments, bufferName) {
  if (!fragments || fragments.length === 0) return '';
  let html = '';

  for (const frag of fragments) {
    const body = frag.body || '';

    if (frag.type === 'text') {
      html += `<div class="frag frag-text"><pre class="frag-body-pre">${escapeHtml(body)}</pre></div>`;
      continue;
    }

    if (frag.type === 'user_message') {
      html += `<div class="frag frag-user"><div class="frag-body">${renderMarkdown(body)}</div></div>`;
      continue;
    }

    if (frag.type === 'agent_message') {
      html += `<div class="frag frag-agent"><div class="frag-body">${renderMarkdown(body)}</div></div>`;
      continue;
    }

    // Collapsible fragments (tool calls, thoughts, plans, etc.)
    if (frag.collapsible) {
      const isOpen = !frag.collapsed;
      const typeClass = `frag-${frag.type}`;
      const statusHtml = frag.status ? `<span class="frag-status">${escapeHtml(frag.status)}</span> ` : '';
      const labelHtml = frag.label ? escapeHtml(frag.label) : escapeHtml(frag.id);

      html += `
        <details class="frag frag-collapsible ${typeClass}" data-frag-id="${escapeHtml(frag.id)}"${isOpen ? ' open' : ''}>
          <summary class="frag-summary">
            ${statusHtml}<span class="frag-label">${labelHtml}</span>
          </summary>
          <div class="frag-body">${renderMarkdown(body)}</div>
        </details>
      `;
      continue;
    }

    // Non-collapsible fragments with labels (permissions, errors, etc.)
    if (frag.label || frag.status) {
      const typeClass = `frag-${frag.type}`;
      const statusHtml = frag.status ? `<span class="frag-status">${escapeHtml(frag.status)}</span> ` : '';
      const labelHtml = frag.label ? escapeHtml(frag.label) : '';

      html += `
        <div class="frag ${typeClass}">
          <div class="frag-header">${statusHtml}<span class="frag-label">${labelHtml}</span></div>
          <div class="frag-body">${renderMarkdown(body)}</div>
        </div>
      `;
      continue;
    }

    // Plain text fallback
    html += `<div class="frag"><div class="frag-body">${renderMarkdown(body)}</div></div>`;
  }

  return html;
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
      const [projectsData, configsData, sessionsData] = await Promise.all([
        API.getProjects(),
        API.getConfigs(),
        API.getSessions(),
      ]);
      this.configs = configsData.configs;

      if (this.currentView !== 'projects') return;

      // Group sessions by project root (normalize trailing slashes for matching)
      const normPath = p => p ? p.replace(/\/+$/, '') : '';
      const sessionsByProject = {};
      for (const session of (sessionsData.sessions || [])) {
        const root = normPath(session.project_root);
        if (!sessionsByProject[root]) sessionsByProject[root] = [];
        sessionsByProject[root].push(session);
      }

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
          const sessions = sessionsByProject[normPath(project.root)] || [];
          let sessionsHtml = '';
          if (sessions.length > 0) {
            sessionsHtml = '<div class="card-sessions">';
            for (const s of sessions) {
              sessionsHtml += `
                <a class="card-session-row" data-session="${escapeHtml(s.buffer_name)}" href="#/session/${encodeURIComponent(s.buffer_name)}" onclick="event.stopPropagation()">
                  <span class="card-session-name">${escapeHtml(s.agent_name || s.buffer_name)}</span>
                  <span class="session-badge">${this._renderSessionBadge(s)}</span>
                </a>
              `;
            }
            sessionsHtml += '</div>';
          }

          html += `
            <div class="card" onclick="location.hash='#/sessions?project=${encodeURIComponent(project.root)}'">
              <div class="card-title">${escapeHtml(project.name)}</div>
              <div class="card-subtitle">${escapeHtml(project.root)}</div>
              ${sessionsHtml}
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
      this.startListPolling();
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
    const menuHeight = menu.offsetHeight;
    let left = rect.left;
    // If menu would overflow the right edge, align to button's right edge instead
    if (left + menuWidth > window.innerWidth) {
      left = rect.right - menuWidth;
    }
    // Clamp to viewport
    left = Math.max(4, Math.min(left, window.innerWidth - menuWidth - 4));

    const spaceBelow = window.innerHeight - rect.bottom - 8;
    const spaceAbove = rect.top - 8;
    if (menuHeight > spaceBelow && spaceAbove > spaceBelow) {
      // Show above the button
      const maxH = Math.min(menuHeight, spaceAbove);
      menu.style.maxHeight = maxH + 'px';
      menu.style.bottom = (window.innerHeight - rect.top + 4) + 'px';
    } else {
      // Show below the button (default)
      menu.style.maxHeight = spaceBelow + 'px';
      menu.style.top = rect.bottom + 4 + 'px';
    }
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

  _renderSessionBadge(session) {
    return session.stuck
      ? '<span class="badge badge-stuck"><span class="pulse"></span> Needs Attention</span>'
      : session.busy
        ? '<span class="badge badge-busy"><span class="spinner"></span> Working</span>'
        : '<span class="badge badge-idle">Idle</span>';
  },

  async showSessions(projectFilter) {
    this.currentView = 'sessions';
    this._sessionsProjectFilter = projectFilter;
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
          html += `
            <div class="card" data-session="${escapeHtml(session.buffer_name)}" onclick="location.hash='#/session/${encodeURIComponent(session.buffer_name)}'">
              <div class="card-title">${escapeHtml(session.agent_name || session.buffer_name)}</div>
              <div class="card-subtitle">${escapeHtml(session.project_name || '')}</div>
              <div class="card-meta">
                <span class="session-badge">${this._renderSessionBadge(session)}</span>
                ${session.pending_permission_count > 0 ? `<span class="badge badge-stuck">${session.pending_permission_count} permission${session.pending_permission_count > 1 ? 's' : ''}</span>` : ''}
              </div>
            </div>
          `;
        }
        html += '</div>';
      }

      content.innerHTML = html;
      this.startListPolling();
    } catch (err) {
      content.innerHTML = `<div class="empty-state"><div>Error: ${escapeHtml(err.message)}</div></div>`;
    }
  },

  startListPolling() {
    this.pollTimer = setInterval(async () => {
      try {
        const data = await API.getStatus();
        if (this.currentView !== 'sessions' && this.currentView !== 'projects') return;
        for (const s of (data.sessions || [])) {
          document.querySelectorAll(`[data-session="${CSS.escape(s.buffer_name)}"] .session-badge`).forEach(el => {
            el.innerHTML = this._renderSessionBadge(s);
          });
        }
      } catch (err) {
        // ignore
      }
    }, 3000);
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
    const usageParts = buildUsageItems(data.usage);
    if (usageParts.length) usageHtml = `<div class="usage-bar">${usageParts.join('')}</div>`;

    // Build permissions HTML
    let permHtml = this._buildPermissionsHtml(data.pending_permissions, bufferName);

    // Render content: use fragments if available, fall back to plain text
    const hasFragments = data.fragments && data.fragments.length > 0;
    const contentHtml = hasFragments
      ? `<div class="chat-fragments" id="chat-text">${renderFragments(data.fragments, bufferName)}</div>`
      : `<pre class="chat-text" id="chat-text">${escapeHtml(data.content)}</pre>`;

    content.innerHTML = `
      <div class="chat-container">
        ${usageHtml}
        <div class="chat-content" id="chat-scroll">
          ${contentHtml}
          <div id="chat-permissions">${permHtml}</div>
        </div>
        <div class="chat-status-bar" id="chat-status"${data.busy ? '' : ' style="display:none"'}>
          <span class="badge badge-busy"><span class="spinner"></span> Working</span>
        </div>
        <div class="chat-input-container">
          <textarea class="chat-input" id="chat-input" placeholder="Type a message..." rows="1"
                    ${data.busy ? 'disabled' : ''}></textarea>
          <button class="chat-send-btn" id="chat-send" ${data.busy ? 'disabled' : ''}
                  onclick="App.sendMessage('${escapeHtml(bufferName.replace(/'/g, "\\'"))}')">&#9654;</button>
        </div>
      </div>
    `;

    // Syntax-highlight code blocks if highlight.js is loaded
    if (hasFragments && window.hljs) {
      content.querySelectorAll('pre.code-block code[class]').forEach(el => {
        window.hljs.highlightElement(el);
      });
    }

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

    const hasFragments = data.fragments && data.fragments.length > 0;

    if (hasFragments) {
      // Save collapse state of existing <details> elements
      const openState = {};
      chatText.querySelectorAll('details[data-frag-id]').forEach(el => {
        openState[el.dataset.fragId] = el.open;
      });

      // Re-render fragments
      chatText.innerHTML = renderFragments(data.fragments, bufferName);

      // Restore collapse state (user's manual toggles take priority)
      chatText.querySelectorAll('details[data-frag-id]').forEach(el => {
        if (el.dataset.fragId in openState) {
          el.open = openState[el.dataset.fragId];
        }
      });

      // Syntax-highlight new code blocks
      if (window.hljs) {
        chatText.querySelectorAll('pre.code-block code[class]:not(.hljs)').forEach(el => {
          window.hljs.highlightElement(el);
        });
      }
    } else {
      chatText.textContent = data.content;
    }

    // Update permissions
    const permHtml = this._buildPermissionsHtml(data.pending_permissions, bufferName);
    if (chatPermissions) chatPermissions.innerHTML = permHtml;

    // Update busy state
    if (chatInput) chatInput.disabled = data.busy;
    if (chatSend) chatSend.disabled = data.busy;
    const chatStatus = document.getElementById('chat-status');
    if (chatStatus) chatStatus.style.display = data.busy ? '' : 'none';

    // Update usage bar
    const usageBar = document.querySelector('.usage-bar');
    if (usageBar) {
      const parts = buildUsageItems(data.usage);
      usageBar.innerHTML = parts.join('');
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

  // === Permission Rendering ===

  _buildPermissionsHtml(permissions, bufferName) {
    if (!permissions || permissions.length === 0) return '';
    let html = '';
    const escBuf = escapeHtml(bufferName.replace(/'/g, "\\'"));

    for (const perm of permissions) {
      let optionsHtml;
      if (perm.options && perm.options.length > 0) {
        optionsHtml = perm.options.map(opt => {
          const cls = opt.kind === 'reject_once' ? 'btn btn-sm btn-danger'
            : opt.kind === 'allow_always' ? 'btn btn-sm btn-warning'
              : 'btn btn-sm btn-primary';
          return `<button class="${cls}" onclick="App.respondPermission('${escBuf}', '${escapeHtml(perm.tool_call_id)}', '${escapeHtml(opt.option_id)}')">${escapeHtml(opt.name)}</button>`;
        }).join('');
      } else {
        optionsHtml = '<span class="text-muted">Waiting for options...</span>';
      }

      html += `
        <div class="permission-card">
          <div class="permission-title">Permission Required</div>
          <div class="permission-detail">${escapeHtml(perm.title)}</div>
          <div class="permission-actions">${optionsHtml}</div>
        </div>
      `;
    }
    return html;
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
        const changed =
          status.content_length !== this.lastContentLength ||
          status.pending_permission_count !== this.lastPermissionCount ||
          status.busy !== this.lastBusy;
        // Also force refresh when busy/stuck — state changes rapidly
        const volatile = status.busy || status.stuck;
        if (changed || volatile) {
          this.lastContentLength = status.content_length;
          this.lastPermissionCount = status.pending_permission_count;
          this.lastBusy = status.busy;
          const data = await API.getSession(bufferName);
          this.updateSessionContent(bufferName, data);
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

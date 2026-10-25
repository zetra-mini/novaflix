/**
 * AdminApp - Lógica do Frontend do Painel Administrativo NovaFlix
 */

const AdminApp = {
  state: {
    token: localStorage.getItem('novaflix_adm_token') || null,
    user: JSON.parse(localStorage.getItem('novaflix_adm_user') || 'null'),
    currentScreen: 'dashboard',
    mirrorDomains: [],
    messagesPage: 1,
    messagesTotalPages: 1,
    pollTimer: null,
    logsAutoRefresh: true,
    logsRefreshTimer: null,
    logsSearchDebounce: null,
    cachedLogs: []
  },

  init() {
    if (this.state.token && this.state.user) {
      this.showApp();
    } else {
      this.showLogin();
    }
  },

  // =========================================================================
  // AUTENTICAÇÃO
  // =========================================================================
  async handleLogin(e) {
    if (e) e.preventDefault();
    const username = document.getElementById('login-username').value.trim();
    const password = document.getElementById('login-password').value;
    const errorEl = document.getElementById('login-error-alert');
    const errorText = document.getElementById('login-error-text');
    const submitBtn = document.getElementById('login-submit-btn');

    if (errorEl) errorEl.classList.add('hidden');
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Entrando...';
    }

    try {
      const res = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });
      const data = await res.json();

      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Credenciais inválidas');
      }

      this.state.token = data.token;
      this.state.user = data.user;
      localStorage.setItem('novaflix_adm_token', data.token);
      localStorage.setItem('novaflix_adm_user', JSON.stringify(data.user));

      this.showToast('Login realizado com sucesso!', 'success');
      this.showApp();
    } catch (err) {
      if (errorEl && errorText) {
        errorText.textContent = err.message;
        errorEl.classList.remove('hidden');
      }
    } finally {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.innerHTML = '<span>Entrar no Painel</span> <i class="fa-solid fa-arrow-right text-xs"></i>';
      }
    }
  },

  logout() {
    this.state.token = null;
    this.state.user = null;
    localStorage.removeItem('novaflix_adm_token');
    localStorage.removeItem('novaflix_adm_user');
    if (this.state.pollTimer) clearInterval(this.state.pollTimer);
    this.stopLogsAutoRefresh();
    this.showLogin();
    this.showToast('Sessão encerrada com segurança.', 'info');
  },

  showLogin() {
    document.getElementById('login-screen').classList.remove('hidden');
    document.getElementById('admin-layout').classList.add('hidden');
  },

  showApp() {
    document.getElementById('login-screen').classList.add('hidden');
    document.getElementById('admin-layout').classList.remove('hidden');

    if (this.state.user) {
      const nameEl = document.getElementById('sidebar-user-name');
      const roleEl = document.getElementById('sidebar-user-role');
      if (nameEl) nameEl.textContent = this.state.user.name || this.state.user.username;
      if (roleEl) roleEl.textContent = this.state.user.role === 'superadmin' ? 'Super Administrador' : 'Administrador';
    }

    this.showScreen(this.state.currentScreen || 'dashboard');

    this.apiRequest('/api/admin/payment-gateway').then(cfg => {
      this.updateGatewayStatusUI(cfg.isActive);
    }).catch(() => {});

    if (this.state.pollTimer) clearInterval(this.state.pollTimer);
    this.state.pollTimer = setInterval(() => {
      if (this.state.currentScreen === 'dashboard') {
        this.loadDashboardData(false);
      }
    }, 15000);
  },

  togglePasswordVisibility(inputId) {
    const el = document.getElementById(inputId);
    if (el) {
      el.type = el.type === 'password' ? 'text' : 'password';
    }
  },

  // =========================================================================
  // REQUISIÇÕES AUTENTICADAS
  // =========================================================================
  async apiRequest(endpoint, options = {}) {
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.state.token}`,
      ...(options.headers || {})
    };

    const res = await fetch(endpoint, { ...options, headers });
    if (res.status === 401) {
      this.logout();
      throw new Error('Sessão expirada. Faça login novamente.');
    }

    const contentType = res.headers.get('content-type') || '';
    let data;
    if (contentType.includes('application/json')) {
      data = await res.json();
    } else {
      const rawText = await res.text();
      const cleanText = rawText.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      throw new Error(cleanText.slice(0, 160) || `Resposta inesperada do servidor (HTTP ${res.status})`);
    }

    if (!res.ok) {
      throw new Error(data.error || `Erro HTTP ${res.status}`);
    }
    return data;
  },

  toggleSidebar(forceState) {
    const sidebar = document.getElementById('admin-sidebar');
    const backdrop = document.getElementById('admin-sidebar-backdrop');
    if (!sidebar) return;

    const isOpen = !sidebar.classList.contains('-translate-x-full');
    const shouldOpen = typeof forceState === 'boolean' ? forceState : !isOpen;

    if (shouldOpen) {
      sidebar.classList.remove('-translate-x-full');
      if (backdrop) backdrop.classList.remove('hidden');
    } else {
      sidebar.classList.add('-translate-x-full');
      if (backdrop) backdrop.classList.add('hidden');
    }
  },

  // =========================================================================
  // NAVEGAÇÃO DE TELAS
  // =========================================================================
  showScreen(screenId) {
    this.state.currentScreen = screenId;
    this.toggleSidebar(false);

    // Atualiza botões da sidebar
    document.querySelectorAll('.nav-item').forEach(btn => btn.classList.remove('active'));
    const activeBtn = document.getElementById(`nav-btn-${screenId}`);
    if (activeBtn) activeBtn.classList.add('active');

    // Esconde todas as seções e exibe a selecionada
    ['dashboard', 'domains', 'playlists', 'messages', 'settings', 'users', 'sessions', 'logs', 'payment-gateway', 'users-control'].forEach(id => {
      const el = document.getElementById(`screen-${id}`);
      if (el) {
        if (id === screenId) el.classList.remove('hidden');
        else el.classList.add('hidden');
      }
    });

    // Atualiza título da topbar
    const titles = {
      dashboard: { icon: 'fa-gauge-high', title: 'Dashboard Geral' },
      domains: { icon: 'fa-shield-halved', title: 'Anti-Queda & Gestão de Domínios' },
      playlists: { icon: 'fa-server', title: 'Gestão de Listas IPTV (Failover)' },
      messages: { icon: 'fa-envelope', title: 'Central de Feedback & SAC' },
      settings: { icon: 'fa-sliders', title: 'Alertas no Telegram & Segurança' },
      'payment-gateway': { icon: 'fa-credit-card', title: 'Configurações de Pagamento (Gateway)' },
      'users-control': { icon: 'fa-address-card', title: 'Controle de Usuários via UUID' },
      users: { icon: 'fa-users-gear', title: 'Gestão de Usuários Administradores' },
      sessions: { icon: 'fa-users-viewfinder', title: 'Monitoramento de Acessos em Tempo Real' },
      logs: { icon: 'fa-terminal', title: 'Logs do Sistema em Tempo Real' }
    };
    const cur = titles[screenId] || titles.dashboard;
    const titleEl = document.getElementById('screen-title');
    if (titleEl) {
      titleEl.innerHTML = `<i class="fa-solid ${cur.icon} text-brand-red text-sm"></i> <span>${cur.title}</span>`;
    }

    // Carrega dados da tela
    if (screenId === 'dashboard') this.loadDashboardData();
    else if (screenId === 'domains') this.loadDomainsData();
    else if (screenId === 'playlists') this.loadPlaylistsData();
    else if (screenId === 'messages') this.loadMessages(1);
    else if (screenId === 'settings') this.loadSettingsData();
    else if (screenId === 'payment-gateway') this.loadPaymentGatewayData();
    else if (screenId === 'users-control') this.loadUsersControlData();
    else if (screenId === 'users') this.loadUsersData();
    else if (screenId === 'sessions') this.loadSessionsData();
    else if (screenId === 'logs') {
      this.loadLogsData();
      this.startLogsAutoRefresh();
    }

    if (screenId !== 'logs') {
      this.stopLogsAutoRefresh();
    }
  },

  refreshCurrentScreen() {
    this.showScreen(this.state.currentScreen);
    this.showToast('Dados atualizados.', 'info');
  },

  // =========================================================================
  // TELA 1: DASHBOARD
  // =========================================================================
  async loadDashboardData(showLoading = true) {
    try {
      const data = await this.apiRequest('/api/admin/dashboard');

      // Domínio
      const domText = document.getElementById('dash-main-domain-text');
      const domBadge = document.getElementById('dash-domain-status-badge');
      const domLatency = document.getElementById('dash-domain-latency');

      if (domText) domText.textContent = data.mainDomain || window.location.origin;
      if (domBadge) {
        const isOnline = data.health?.mainDomain?.status === 'online';
        domBadge.className = `px-2 py-0.5 rounded-full text-[10px] font-bold ${isOnline ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' : 'bg-rose-500/20 text-rose-400 border border-rose-500/30'}`;
        domBadge.textContent = isOnline ? 'ONLINE' : 'OFFLINE';
      }
      if (domLatency) domLatency.textContent = (data.health?.mainDomain?.latency ? `${data.health.mainDomain.latency}ms` : '12ms');

      // Health checks de listas
      this.updateBadge('dash-p1-status', 'dash-p1-latency', data.health?.primary);
      this.updateBadge('dash-b1-status', 'dash-b1-latency', data.health?.backup1);
      this.updateBadge('dash-b2-status', 'dash-b2-latency', data.health?.backup2);

      // Contadores
      const cRec = document.getElementById('dash-count-reclamacoes');
      const cSug = document.getElementById('dash-count-sugestoes');
      const cTot = document.getElementById('dash-count-total');
      if (cRec) cRec.textContent = data.metrics?.reclamacoesHoje || 0;
      if (cSug) cSug.textContent = data.metrics?.sugestoesHoje || 0;
      if (cTot) cTot.textContent = data.metrics?.total || 0;

      // Sessões ativas
      try {
        const sessData = await this.apiRequest('/api/admin/sessions');
        const count = sessData.count || 0;
        const cSess = document.getElementById('dash-count-sessions');
        const navSess = document.getElementById('nav-sessions-count');
        if (cSess) cSess.textContent = count;
        if (navSess) navSess.textContent = count;
      } catch(e) {}

      // Badge unread na sidebar
      const sbBadge = document.getElementById('sidebar-unread-badge');
      if (sbBadge) {
        const unread = data.metrics?.unreadCount || 0;
        if (unread > 0) {
          sbBadge.textContent = unread;
          sbBadge.classList.remove('hidden');
        } else {
          sbBadge.classList.add('hidden');
        }
      }

      // Mensagens recentes
      const msgListEl = document.getElementById('dash-recent-messages-list');
      if (msgListEl && data.recentFeedbacks) {
        if (!data.recentFeedbacks.length) {
          msgListEl.innerHTML = '<div class="py-6 text-center text-xs text-slate-500">Nenhuma mensagem recebida ainda.</div>';
        } else {
          msgListEl.innerHTML = data.recentFeedbacks.map(f => `
            <div class="py-3 flex items-start justify-between gap-4">
              <div class="min-w-0 flex-1">
                <div class="flex items-center gap-2 mb-1">
                  ${this.getTipoBadgeHtml(f.tipo)}
                  <span class="text-[11px] text-slate-400">${this.formatDate(f.timestamp)}</span>
                  <span class="text-[10px] text-slate-500 font-mono">IP: ${this.escapeHtml(f.ip)}</span>
                </div>
                <p class="text-xs text-slate-200 line-clamp-2">${this.escapeHtml(f.mensagem)}</p>
              </div>
              <span class="text-[10px] px-2 py-0.5 rounded font-semibold flex-shrink-0 ${f.status === 'unread' ? 'bg-brand-red/20 text-brand-red' : 'bg-slate-800 text-slate-400'}">
                ${f.status === 'unread' ? 'Não Lido' : 'Lido'}
              </span>
            </div>
          `).join('');
        }
      }

      // Atualiza status do Git na dashboard
      this.loadGitStatus();
    } catch (e) {
      console.warn('Erro ao carregar dashboard:', e);
    }
  },

  updateBadge(statusId, latencyId, healthObj) {
    const sEl = document.getElementById(statusId);
    const lEl = document.getElementById(latencyId);
    if (!sEl || !lEl) return;

    if (!healthObj || healthObj.status === 'empty' || !healthObj.statusCode) {
      sEl.className = 'px-2 py-0.5 rounded-full text-[10px] font-bold bg-slate-800 text-slate-400';
      sEl.textContent = 'STANDBY / VAZIO';
      lEl.textContent = '-- ms';
      return;
    }

    if (healthObj.status === 'online') {
      sEl.className = 'px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-500/20 text-emerald-400 border border-emerald-500/30';
      sEl.textContent = `${healthObj.statusCode} OK`;
      lEl.textContent = `${healthObj.latency}ms`;
    } else {
      sEl.className = 'px-2 py-0.5 rounded-full text-[10px] font-bold bg-rose-500/20 text-rose-400 border border-rose-500/30';
      sEl.textContent = healthObj.statusCode ? `ERRO ${healthObj.statusCode}` : 'OFFLINE';
      lEl.textContent = healthObj.latency ? `${healthObj.latency}ms` : 'Timeout';
    }
  },

  async triggerHealthCheck() {
    const btn = document.getElementById('btn-health-check');
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Testando Links...';
    }
    try {
      this.showToast('Iniciando verificação de integridade dos links...', 'info');
      const res = await this.apiRequest('/api/admin/health-check', { method: 'POST' });
      this.showToast('Verificação concluída com sucesso!', 'success');
      this.loadDashboardData(false);
      if (this.state.currentScreen === 'playlists') {
        this.loadPlaylistsData();
      }
    } catch (e) {
      this.showToast('Erro no health check: ' + e.message, 'error');
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = '<i class="fa-solid fa-stethoscope"></i> <span>Testar Links Agora</span>';
      }
    }
  },

  // =========================================================================
  // TELA 2: DOMÍNIOS & ANTI-QUEDA
  // =========================================================================
  async loadDomainsData() {
    try {
      const data = await this.apiRequest('/api/admin/domains');
      let mainDomain = (data.mainDomain || '').trim();

      // Se for localhost ou vazio, e o admin está acessando por IP ou domínio real da VPS:
      const currentOrigin = (window.location.origin || '').trim();
      const isCurrentOriginReal = currentOrigin && !currentOrigin.includes('localhost') && !currentOrigin.includes('127.0.0.1');
      const isMainDomainLocal = !mainDomain || mainDomain.includes('localhost') || mainDomain.includes('127.0.0.1');

      if (isMainDomainLocal && isCurrentOriginReal) {
        mainDomain = currentOrigin;
        try {
          await this.apiRequest('/api/admin/domains', {
            method: 'POST',
            body: JSON.stringify({ mainDomain, mirrorDomains: data.mirrorDomains || [] })
          });
        } catch (err) {}
      }

      const input = document.getElementById('domain-main-input');
      if (input) input.value = mainDomain;
      this.state.mirrorDomains = data.mirrorDomains || [];
      this.renderMirrorDomainsTable();
      await this.loadAppsStatus(mainDomain);
    } catch (e) {
      this.showToast('Erro ao carregar domínios: ' + e.message, 'error');
    }
  },

  async autoDetectVPS() {
    const btn = document.getElementById('btn-autodetect-vps');
    if (btn) btn.innerHTML = '<i class="fa-solid fa-sync fa-spin"></i> <span>Detectando...</span>';

    try {
      let targetUrl = '';
      if (window.location.hostname && window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1') {
        targetUrl = window.location.origin;
      }

      const res = await this.apiRequest('/api/admin/detect-vps-ip');
      if (res && res.detectedUrl && (!targetUrl || targetUrl.includes('localhost'))) {
        targetUrl = res.detectedUrl;
      } else if (!targetUrl && res && res.publicIp) {
        targetUrl = `http://${res.publicIp}:3000`;
      }

      if (!targetUrl || targetUrl.includes('localhost')) {
        targetUrl = window.location.origin;
      }

      targetUrl = targetUrl.trim().replace(/\/+$/, '');

      const input = document.getElementById('domain-main-input');
      if (input) input.value = targetUrl;

      this.onDomainInputChange(targetUrl);
      await this.saveDomainSettings();

      this.showToast(`IP da VPS detectado e vinculado com sucesso: ${targetUrl}`, 'success', 5000);
    } catch (e) {
      this.showToast('Erro ao detectar IP da VPS: ' + e.message, 'error');
    } finally {
      if (btn) btn.innerHTML = '<i class="fa-solid fa-bolt text-amber-400"></i> <span>Puxar IP da VPS</span>';
    }
  },

  onDomainInputChange(val) {
    const raw = (val || window.location.origin).trim().replace(/\/+$/, '');
    const apkInput = document.getElementById('app-link-apk');
    const exeInput = document.getElementById('app-link-exe');
    const webInput = document.getElementById('app-link-web');
    const apkBtn = document.getElementById('app-download-btn-apk');
    const exeBtn = document.getElementById('app-download-btn-exe');
    const webBtn = document.getElementById('app-download-btn-web');

    if (apkInput) apkInput.value = `${raw}/download/NovaFlix.apk`;
    if (exeInput) exeInput.value = `${raw}/download/NovaFlix.exe`;
    if (webInput) webInput.value = raw;

    if (apkBtn) apkBtn.href = `${raw}/download/NovaFlix.apk`;
    if (exeBtn) exeBtn.href = `${raw}/download/NovaFlix.exe`;
    if (webBtn) webBtn.href = raw;
  },

  async loadAppsStatus(currentDomain) {
    try {
      const data = await this.apiRequest('/api/admin/apps-status');
      const base = (currentDomain || data.mainDomain || window.location.origin).trim().replace(/\/+$/, '');

      this.onDomainInputChange(base);

      const apkBadge = document.getElementById('app-status-badge-apk');
      const exeBadge = document.getElementById('app-status-badge-exe');

      if (apkBadge) {
        if (data.apps?.apk?.availableLocally) {
          apkBadge.className = 'px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-500/20 text-emerald-400 border border-emerald-500/30';
          apkBadge.innerHTML = `<i class="fa-solid fa-check"></i> Pronto na VPS (${data.apps.apk.sizeMb} MB)`;
        } else {
          apkBadge.className = 'px-2 py-0.5 rounded text-[10px] font-bold bg-amber-500/20 text-amber-300 border border-amber-500/30';
          apkBadge.innerHTML = `<i class="fa-solid fa-cloud-arrow-down"></i> Auto Fallback GitHub`;
        }
      }

      if (exeBadge) {
        if (data.apps?.exe?.availableLocally) {
          exeBadge.className = 'px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-500/20 text-emerald-400 border border-emerald-500/30';
          exeBadge.innerHTML = `<i class="fa-solid fa-check"></i> Pronto na VPS (${data.apps.exe.sizeMb} MB)`;
        } else {
          exeBadge.className = 'px-2 py-0.5 rounded text-[10px] font-bold bg-slate-800 text-slate-400 border border-slate-700';
          exeBadge.innerHTML = `<i class="fa-solid fa-clock"></i> Não compilado localmente`;
        }
      }

      const syncBadge = document.getElementById('app-config-sync-badge');
      if (syncBadge) {
        if (data.serverConfig && (data.serverConfig.serverUrl || data.serverConfig.serverIp)) {
          const cfgUrl = data.serverConfig.serverUrl || data.serverConfig.serverIp;
          syncBadge.className = 'px-2.5 py-1 rounded-lg bg-emerald-950/40 border border-emerald-500/30 text-[11px] font-mono text-emerald-300';
          syncBadge.innerHTML = `<i class="fa-solid fa-check text-emerald-400 mr-1"></i> Apps vinculados a: <strong class="text-white">${this.escapeHtml(cfgUrl)}</strong>`;
        } else {
          syncBadge.className = 'px-2.5 py-1 rounded-lg bg-amber-950/40 border border-amber-500/30 text-[11px] font-mono text-amber-300';
          syncBadge.innerHTML = `<i class="fa-solid fa-circle-exclamation text-amber-400 mr-1"></i> Apps sem IP fixo vinculado (usará fallback)`;
        }
      }
    } catch (e) {
      console.warn('Erro ao carregar status dos apps:', e);
    }
  },

  copyAppDownloadLink(inputId, btn) {
    const input = document.getElementById(inputId);
    if (!input) return;
    const text = input.value;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => {
        const orig = btn.innerHTML;
        btn.innerHTML = '<i class="fa-solid fa-check text-emerald-400"></i> Copiado!';
        btn.classList.add('bg-emerald-500/20', 'text-emerald-300');
        setTimeout(() => {
          btn.innerHTML = orig;
          btn.classList.remove('bg-emerald-500/20', 'text-emerald-300');
        }, 2000);
      }).catch(() => {
        input.select();
        document.execCommand('copy');
        this.showToast('Link copiado!', 'success');
      });
    } else {
      input.select();
      document.execCommand('copy');
      this.showToast('Link copiado!', 'success');
    }
  },

  renderMirrorDomainsTable() {
    const tbody = document.getElementById('mirror-domains-tbody');
    if (!tbody) return;

    if (!this.state.mirrorDomains.length) {
      tbody.innerHTML = '<tr><td colspan="3" class="py-6 text-center text-slate-500">Nenhum domínio de espelho cadastrado.</td></tr>';
      return;
    }

    tbody.innerHTML = this.state.mirrorDomains.map((url, idx) => `
      <tr class="hover:bg-white/5 transition">
        <td class="py-3 px-4 font-mono font-bold text-slate-400">#${idx + 1}</td>
        <td class="py-3 px-4">
          <input type="url" value="${this.escapeHtml(url)}" onchange="AdminApp.updateMirrorDomain(${idx}, this.value)"
            class="w-full px-3 py-1.5 bg-[#121212] border border-slate-800 rounded-lg text-white font-mono text-xs focus:outline-none focus:border-brand-red">
        </td>
        <td class="py-3 px-4 text-right">
          <button onclick="AdminApp.removeMirrorDomain(${idx})" class="text-slate-500 hover:text-rose-400 transition p-1.5" title="Excluir Espelho">
            <i class="fa-solid fa-trash-can"></i>
          </button>
        </td>
      </tr>
    `).join('');
  },

  addMirrorDomainRow() {
    this.state.mirrorDomains.push('https://novo-espelho.com');
    this.renderMirrorDomainsTable();
  },

  updateMirrorDomain(idx, val) {
    if (this.state.mirrorDomains[idx] !== undefined) {
      this.state.mirrorDomains[idx] = val.trim();
    }
  },

  removeMirrorDomain(idx) {
    this.state.mirrorDomains.splice(idx, 1);
    this.renderMirrorDomainsTable();
  },

  async saveDomainSettings() {
    const mainDomain = document.getElementById('domain-main-input').value.trim();
    const mirrorDomains = this.state.mirrorDomains.filter(d => d && d.trim().length > 0);

    try {
      await this.apiRequest('/api/admin/domains', {
        method: 'POST',
        body: JSON.stringify({ mainDomain, mirrorDomains })
      });
      this.showToast('Domínio e Aplicativos (.apk / .exe) vinculados com sucesso!', 'success');
      await this.loadDomainsData();
    } catch (e) {
      this.showToast('Falha ao salvar domínios: ' + e.message, 'error');
    }
  },

  // =========================================================================
  // TELA 3: GESTÃO DE LISTAS IPTV (FAILOVER & ROTEAMENTO HÍBRIDO)
  // =========================================================================
  async loadPlaylistsData() {
    try {
      const data = await this.apiRequest('/api/admin/playlists');
      if (!data) return;

      const pInput = document.getElementById('pl-primary-input');
      const b1Input = document.getElementById('pl-backup1-input');
      const b2Input = document.getElementById('pl-backup2-input');

      if (pInput) pInput.value = data.playlists?.primary || data.playlists?.vod_list_url || 'http://cdn888.ovh/get.php?username=Jm5Udq&password=BQ5TxN&type=m3u_plus&output=m3u8';
      if (b1Input) b1Input.value = data.playlists?.backup1 || '';
      if (b2Input) b2Input.value = data.playlists?.backup2 || '';

      const activeChoice = data.activePlaylist || 'primary';
      const radio = document.querySelector(`input[name="active_playlist_choice"][value="${activeChoice}"]`);
      if (radio) radio.checked = true;

      const pStatus = document.getElementById('pl-primary-status');
      const b1Status = document.getElementById('pl-backup1-status');
      const b2Status = document.getElementById('pl-backup2-status');

      const health = data.healthChecks || data.health || {};
      this.formatPlaylistStatusBadge(pStatus, health.primary);
      this.formatPlaylistStatusBadge(b1Status, health.backup1);
      this.formatPlaylistStatusBadge(b2Status, health.backup2);
    } catch (e) {
      console.warn('[Admin] Aviso ao carregar listas (não bloqueante):', e.message);
    }
  },

  formatPlaylistStatusBadge(el, healthObj) {
    if (!el) return;
    if (!healthObj || healthObj.status === 'empty' || !healthObj.statusCode) {
      el.className = 'px-2 py-0.5 rounded text-[10px] font-bold bg-slate-800 text-slate-400';
      el.textContent = 'Não Verificado';
      return;
    }
    if (healthObj.status === 'online') {
      el.className = 'px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-500/20 text-emerald-400 border border-emerald-500/30';
      el.textContent = `HTTP ${healthObj.statusCode} (${healthObj.latency}ms)`;
    } else {
      el.className = 'px-2 py-0.5 rounded text-[10px] font-bold bg-rose-500/20 text-rose-400 border border-rose-500/30';
      el.textContent = healthObj.statusCode ? `HTTP ${healthObj.statusCode}` : 'OFFLINE';
    }
  },

  async savePlaylists() {
    let primary = (document.getElementById('pl-primary-input')?.value || '').trim();
    const backup1 = (document.getElementById('pl-backup1-input')?.value || '').trim();
    const backup2 = (document.getElementById('pl-backup2-input')?.value || '').trim();
    const activePlaylist = document.querySelector('input[name="active_playlist_choice"]:checked')?.value || 'primary';

    if (!primary) {
      primary = 'http://cdn888.ovh/get.php?username=Jm5Udq&password=BQ5TxN&type=m3u_plus&output=m3u8';
      if (document.getElementById('pl-primary-input')) {
        document.getElementById('pl-primary-input').value = primary;
      }
    }

    // Garante que a lista principal utilize o formato HLS M3U8
    if (primary.includes('output=ts')) {
      primary = primary.replace('output=ts', 'output=m3u8');
    } else if (!primary.includes('output=m3u8')) {
      primary += (primary.includes('?') ? '&' : '?') + 'output=m3u8';
    }
    if (document.getElementById('pl-primary-input')) {
      document.getElementById('pl-primary-input').value = primary;
    }

    try {
      await this.apiRequest('/api/admin/playlists', {
        method: 'POST',
        body: JSON.stringify({
          primary,
          live_list_url: primary,
          vod_list_url: primary,
          backup1,
          backup2,
          activePlaylist
        })
      });
      this.showToast('Lista única HLS M3U8 salva com sucesso! Sincronização iniciada.', 'success');
      this.loadPlaylistsData();
    } catch (e) {
      console.error('[Admin] Erro ao salvar lista:', e);
      this.showToast('Falha ao salvar lista: ' + e.message, 'error');
    }
  },

  async runInfraSetup() {
    const domainInput = document.getElementById('infra-setup-domain-input');
    const portInput = document.getElementById('infra-setup-port-input');
    const terminalBox = document.getElementById('infra-terminal-box');
    const terminalConsole = document.getElementById('infra-terminal-console');
    const terminalStatus = document.getElementById('infra-terminal-status');
    const btn = document.getElementById('btn-run-infra-setup');
    const btnText = document.getElementById('btn-run-infra-setup-text');

    const domain = (domainInput?.value || '').trim();
    const port = parseInt(portInput?.value || '3000', 10);

    if (!domain) {
      this.showToast('Por favor, informe o domínio da aplicação antes de prosseguir.', 'error');
      domainInput?.focus();
      return;
    }

    if (btn) btn.disabled = true;
    if (btnText) btnText.textContent = 'Configurando Nginx + SSL...';
    if (terminalBox) terminalBox.classList.remove('hidden');
    if (terminalStatus) terminalStatus.textContent = 'Executando scripts/setup-infra.sh na VPS...';
    if (terminalConsole) terminalConsole.textContent = `[Iniciando] Conectando ao servidor para configurar ${domain}:${port}...\nInstalando Nginx, Certbot e emitindo certificado Let's Encrypt...\n`;

    try {
      const data = await this.apiRequest('/api/admin/setup-domain', {
        method: 'POST',
        body: JSON.stringify({ domain, port })
      });

      if (terminalConsole) {
        terminalConsole.textContent = (data.stdout || '') + '\n' + (data.stderr || '');
      }

      if (data.success) {
        if (terminalStatus) terminalStatus.textContent = 'Sucesso! Nginx e SSL configurados.';
        this.showToast('Infraestrutura Nginx e Certificado SSL Let\'s Encrypt configurados com sucesso!', 'success', 6000);
        const mainInput = document.getElementById('domain-main-input');
        if (mainInput) mainInput.value = `https://${domain}`;
      } else {
        if (terminalStatus) terminalStatus.textContent = 'Falha na configuração.';
        this.showToast('Falha na configuração: ' + (data.error || 'Verifique o log no console.'), 'error');
      }
    } catch (err) {
      if (terminalStatus) terminalStatus.textContent = 'Erro de comunicação.';
      if (terminalConsole) terminalConsole.textContent += `\nErro: ${err.message}`;
      this.showToast('Erro ao executar automação de infra: ' + err.message, 'error');
    } finally {
      if (btn) btn.disabled = false;
      if (btnText) btnText.textContent = 'Configurar Nginx + SSL Automático';
    }
  },

  async syncCatalogNow() {
    const btn = document.getElementById('btn-sync-catalog');
    const label = document.getElementById('btn-sync-catalog-text');
    if (btn) btn.disabled = true;
    if (label) label.textContent = 'Baixando e Reindexando...';

    this.showToast('Iniciando sincronização e failover em segundo plano...', 'info');

    try {
      const data = await this.apiRequest('/api/admin/playlists/sync', { method: 'POST' });
      if (data.success) {
        if (data.updated) {
          this.showToast(`Catálogo atualizado! ${data.totalMovies || 0} filmes, ${data.totalSeries || 0} séries e ${data.totalChannels || 0} canais.`, 'success');
        } else {
          this.showToast('Catálogo já está 100% atualizado com o provedor.', 'info');
        }
      } else {
        throw new Error(data.error || 'Falha ao sincronizar');
      }
    } catch (err) {
      this.showToast('Erro na sincronização: ' + err.message, 'error');
    } finally {
      if (btn) btn.disabled = false;
      if (label) label.textContent = 'Sincronizar Catálogo Agora';
    }
  },

  // =========================================================================
  // TELA 4: CENTRAL DE MENSAGENS (SAC)
  // =========================================================================
  async loadMessages(page = 1) {
    this.state.messagesPage = page;
    const tipo = document.getElementById('msg-filter-tipo')?.value || '';
    const search = document.getElementById('msg-search-input')?.value.trim() || '';

    try {
      const q = new URLSearchParams({ page, limit: 15, tipo, search }).toString();
      const data = await this.apiRequest(`/api/admin/feedback?${q}`);
      this.state.messagesTotalPages = data.totalPages || 1;

      const pageInfo = document.getElementById('messages-page-info');
      if (pageInfo) pageInfo.textContent = `Página ${data.page} de ${data.totalPages} (${data.total} mensagens)`;

      const tbody = document.getElementById('messages-tbody');
      if (!tbody) return;

      if (!data.items || !data.items.length) {
        tbody.innerHTML = '<tr><td colspan="6" class="py-8 text-center text-slate-500 text-xs">Nenhuma mensagem encontrada.</td></tr>';
        return;
      }

      tbody.innerHTML = data.items.map(m => `
        <tr class="hover:bg-white/5 transition ${m.status === 'unread' ? 'bg-brand-red/5 font-semibold' : ''}">
          <td class="py-3 px-4 text-slate-400 text-[11px] whitespace-nowrap">${this.formatDate(m.timestamp)}</td>
          <td class="py-3 px-4">${this.getTipoBadgeHtml(m.tipo)}</td>
          <td class="py-3 px-4 text-white">${this.escapeHtml(m.mensagem)}</td>
          <td class="py-3 px-4 font-mono text-[11px] text-slate-400">${this.escapeHtml(m.ip)}</td>
          <td class="py-3 px-4">
            <span class="text-[10px] px-2 py-0.5 rounded font-bold ${m.status === 'unread' ? 'bg-brand-red/20 text-brand-red' : 'bg-slate-800 text-slate-400'}">
              ${m.status === 'unread' ? 'Não Lido' : 'Lido'}
            </span>
          </td>
          <td class="py-3 px-4 text-right whitespace-nowrap">
            <button onclick="AdminApp.toggleMessageStatus('${m.id}', '${m.status === 'unread' ? 'read' : 'unread'}')" class="text-slate-400 hover:text-white transition p-1" title="${m.status === 'unread' ? 'Marcar como Lido' : 'Marcar como Não Lido'}">
              <i class="fa-solid ${m.status === 'unread' ? 'fa-envelope-open' : 'fa-envelope'}"></i>
            </button>
            <button onclick="AdminApp.deleteMessage('${m.id}')" class="text-slate-500 hover:text-rose-400 transition p-1 ml-1" title="Excluir Mensagem">
              <i class="fa-solid fa-trash-can"></i>
            </button>
          </td>
        </tr>
      `).join('');
    } catch (e) {
      this.showToast('Erro ao carregar mensagens: ' + e.message, 'error');
    }
  },

  changeMessagePage(delta) {
    const target = this.state.messagesPage + delta;
    if (target >= 1 && target <= this.state.messagesTotalPages) {
      this.loadMessages(target);
    }
  },

  async toggleMessageStatus(id, newStatus) {
    try {
      await this.apiRequest(`/api/admin/feedback/${id}`, {
        method: 'PUT',
        body: JSON.stringify({ status: newStatus })
      });
      this.loadMessages(this.state.messagesPage);
    } catch (e) {
      this.showToast('Erro: ' + e.message, 'error');
    }
  },

  async deleteMessage(id) {
    if (!confirm('Deseja excluir esta mensagem permanentemente?')) return;
    try {
      await this.apiRequest(`/api/admin/feedback/${id}`, { method: 'DELETE' });
      this.showToast('Mensagem excluída.', 'info');
      this.loadMessages(this.state.messagesPage);
    } catch (e) {
      this.showToast('Erro: ' + e.message, 'error');
    }
  },

  // =========================================================================
  // TELA 5: CONFIGURAÇÕES & ALERTAS
  // =========================================================================
  async loadSettingsData() {
    try {
      const data = await this.apiRequest('/api/admin/settings');
      
      const stMode = document.getElementById('settings-stream-mode');
      const stSync = document.getElementById('settings-sync-interval');
      const tgEnabled = document.getElementById('settings-telegram-enabled');
      const tgToken = document.getElementById('settings-telegram-token');
      const tgChat = document.getElementById('settings-telegram-chatid');
      const rlMax = document.getElementById('settings-ratelimit-max');
      const rlWin = document.getElementById('settings-ratelimit-window');
      const corsDom = document.getElementById('settings-cors-domains');

      if (stMode) stMode.value = data.streamMode || 'direct';
      if (stSync) stSync.value = data.syncInterval || '24h';
      if (tgEnabled) tgEnabled.checked = Boolean(data.telegram?.enabled);
      if (tgToken) tgToken.value = data.telegram?.botToken || '';
      if (tgChat) tgChat.value = data.telegram?.chatId || '';
      if (rlMax) rlMax.value = data.rateLimit?.maxRequests || 5;
      if (rlWin) rlWin.value = data.rateLimit?.windowMinutes || 10;
      if (corsDom) corsDom.value = data.corsAllowedDomains || '*';

      this.loadGitStatus();
    } catch (e) {
      this.showToast('Erro ao carregar configurações: ' + e.message, 'error');
    }
  },

  // =========================================================================
  // ATUALIZAÇÃO DO REPOSITÓRIO GITHUB VIA PAINEL ADM
  // =========================================================================
  async loadGitStatus() {
    try {
      const data = await this.apiRequest('/api/admin/system/git-status');
      if (data && data.success) {
        const commitShort = data.commit ? data.commit.substring(0, 8) : '--';
        const fullDesc = `${commitShort} - ${data.message || ''}`;

        const dashVer = document.getElementById('dash-git-version');
        const dashCom = document.getElementById('dash-git-commit');
        const setCom = document.getElementById('settings-git-commit');

        if (dashVer && data.version) dashVer.textContent = `v${data.version}`;
        if (dashCom) dashCom.textContent = commitShort;
        if (setCom) setCom.textContent = fullDesc;
      }
    } catch (e) {
      console.warn('[Admin] Não foi possível consultar status do Git:', e.message);
    }
  },

  async triggerGitUpdate() {
    if (!confirm('Deseja baixar e aplicar as atualizações mais recentes do repositório oficial no GitHub agora?')) {
      return;
    }

    const btnDash = document.getElementById('btn-git-update-dash');
    const btnSet = document.getElementById('btn-git-update-settings');
    const logBox = document.getElementById('git-update-log-box');

    const setButtonsLoading = (isLoading) => {
      [btnDash, btnSet].forEach(btn => {
        if (!btn) return;
        btn.disabled = isLoading;
        if (isLoading) {
          btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> <span>Atualizando do GitHub...</span>';
          btn.classList.add('opacity-75');
        } else {
          btn.innerHTML = '<i class="fa-brands fa-github text-sm"></i> <span>Atualizar Código do GitHub</span>';
          btn.classList.remove('opacity-75');
        }
      });
    };

    setButtonsLoading(true);
    this.showToast('Conectando ao GitHub para baixar atualizações...', 'info');

    try {
      const data = await this.apiRequest('/api/admin/system/git-update', {
        method: 'POST'
      });

      if (!data.success) {
        throw new Error(data.error || 'Falha ao atualizar repositório');
      }

      this.showToast('🎉 Código atualizado com sucesso a partir do GitHub!', 'success');

      if (logBox) {
        logBox.classList.remove('hidden');
        logBox.textContent = `[Git Output]\n${data.output || 'Repositório sincronizado com sucesso.'}\nÚltimo Commit: ${data.latestCommit || ''}`;
      }

      await this.loadGitStatus();
    } catch (err) {
      console.error('[Admin] Erro na atualização via Git:', err);
      this.showToast('Erro na atualização: ' + err.message, 'error');
      if (logBox) {
        logBox.classList.remove('hidden');
        logBox.textContent = `[Erro na Atualização]\n${err.message}`;
      }
    } finally {
      setButtonsLoading(false);
    }
  },

  async saveTechnicalSettings() {
    const streamMode = document.getElementById('settings-stream-mode')?.value || 'direct';
    const syncInterval = document.getElementById('settings-sync-interval')?.value || '24h';
    const telegram = {
      enabled: document.getElementById('settings-telegram-enabled').checked,
      botToken: document.getElementById('settings-telegram-token').value.trim(),
      chatId: document.getElementById('settings-telegram-chatid').value.trim()
    };
    const rateLimit = {
      maxRequests: parseInt(document.getElementById('settings-ratelimit-max').value, 10) || 5,
      windowMinutes: parseInt(document.getElementById('settings-ratelimit-window').value, 10) || 10
    };
    const corsAllowedDomains = document.getElementById('settings-cors-domains').value.trim() || '*';

    try {
      await this.apiRequest('/api/admin/settings', {
        method: 'POST',
        body: JSON.stringify({ streamMode, syncInterval, telegram, rateLimit, corsAllowedDomains })
      });
      this.showToast('Configurações salvas com sucesso!', 'success');
      this.loadSettingsData();
    } catch (e) {
      this.showToast('Erro ao salvar configurações: ' + e.message, 'error');
    }
  },

  // =========================================================================
  // TELA 6: GESTÃO DE USUÁRIOS ADMINISTRADORES
  // =========================================================================
  async loadUsersData() {
    try {
      const data = await this.apiRequest('/api/admin/users');
      const tbody = document.getElementById('users-tbody');
      if (tbody) {
        tbody.innerHTML = data.users.map(u => `
          <tr class="hover:bg-white/5 transition">
            <td class="py-3 px-4 font-mono font-bold text-white flex items-center gap-2">
              <i class="fa-solid fa-user-shield text-slate-500 text-xs"></i>
              <span>${this.escapeHtml(u.username)}</span>
            </td>
            <td class="py-3 px-4 text-slate-300">${this.escapeHtml(u.name || u.username)}</td>
            <td class="py-3 px-4">
              <span class="text-[10px] px-2 py-0.5 rounded font-bold ${u.role === 'superadmin' ? 'bg-brand-red/20 text-brand-red border border-brand-red/30' : 'bg-slate-800 text-slate-300'}">
                ${u.role === 'superadmin' ? 'Super Admin' : 'Admin'}
              </span>
            </td>
            <td class="py-3 px-4 text-slate-400 text-[11px]">${this.formatDate(u.createdAt)}</td>
            <td class="py-3 px-4 text-right">
              <button onclick="AdminApp.promptChangePassword('${u.id}', '${this.escapeHtml(u.username)}')" class="text-slate-400 hover:text-white transition p-1" title="Alterar Senha">
                <i class="fa-solid fa-key"></i>
              </button>
              ${data.users.length > 1 ? `
                <button onclick="AdminApp.deleteUser('${u.id}', '${this.escapeHtml(u.username)}')" class="text-slate-500 hover:text-rose-400 transition p-1 ml-1" title="Excluir Usuário">
                  <i class="fa-solid fa-trash-can"></i>
                </button>
              ` : ''}
            </td>
          </tr>
        `).join('');
      }

      if (this.state.user) {
        const myUserInput = document.getElementById('my-username-input');
        if (myUserInput) myUserInput.value = this.state.user.username;
      }
    } catch (e) {
      this.showToast('Erro ao listar usuários: ' + e.message, 'error');
    }
  },

  async updateMyProfile(e) {
    if (e) e.preventDefault();
    const username = document.getElementById('my-username-input').value.trim();
    const newPassword = document.getElementById('my-newpassword-input').value;

    try {
      const res = await this.apiRequest('/api/admin/users/me', {
        method: 'PUT',
        body: JSON.stringify({ username, newPassword })
      });
      this.state.user = res.user;
      localStorage.setItem('novaflix_adm_user', JSON.stringify(res.user));
      document.getElementById('my-newpassword-input').value = '';
      this.showToast('Credenciais atualizadas com sucesso!', 'success');
      this.loadUsersData();
    } catch (err) {
      this.showToast('Falha: ' + err.message, 'error');
    }
  },

  async addNewUser(e) {
    if (e) e.preventDefault();
    const username = document.getElementById('new-user-username').value.trim();
    const name = document.getElementById('new-user-name').value.trim();
    const password = document.getElementById('new-user-password').value;

    try {
      await this.apiRequest('/api/admin/users', {
        method: 'POST',
        body: JSON.stringify({ username, name, password, role: 'admin' })
      });
      document.getElementById('new-user-username').value = '';
      document.getElementById('new-user-name').value = '';
      document.getElementById('new-user-password').value = '';
      this.showToast(`Administrador "${username}" criado com sucesso!`, 'success');
      this.loadUsersData();
    } catch (err) {
      this.showToast('Falha ao criar usuário: ' + err.message, 'error');
    }
  },

  async promptChangePassword(userId, username) {
    const newPass = prompt(`Digite a nova senha para o usuário "${username}" (mínimo 6 caracteres):`);
    if (!newPass) return;
    if (newPass.length < 6) {
      alert('A senha deve ter no mínimo 6 caracteres.');
      return;
    }
    try {
      await this.apiRequest(`/api/admin/users/${userId}/password`, {
        method: 'PUT',
        body: JSON.stringify({ password: newPass })
      });
      this.showToast(`Senha de "${username}" atualizada com sucesso!`, 'success');
    } catch (e) {
      this.showToast('Erro: ' + e.message, 'error');
    }
  },

  async deleteUser(userId, username) {
    if (!confirm(`Tem certeza que deseja excluir o administrador "${username}"?`)) return;
    try {
      await this.apiRequest(`/api/admin/users/${userId}`, { method: 'DELETE' });
      this.showToast(`Usuário "${username}" excluído com sucesso.`, 'info');
      this.loadUsersData();
    } catch (e) {
      this.showToast('Erro: ' + e.message, 'error');
    }
  },

  // =========================================================================
  // AUXILIARES DE RENDERIZAÇÃO
  // =========================================================================
  getTipoBadgeHtml(tipo) {
    const t = String(tipo).toLowerCase();
    if (t === 'reclamacao') {
      return '<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-rose-500/20 text-rose-400 border border-rose-500/30">RECLAMAÇÃO</span>';
    } else if (t === 'sugestao') {
      return '<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-sky-500/20 text-sky-400 border border-sky-500/30">SUGESTÃO</span>';
    } else {
      return '<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-amber-500/20 text-amber-400 border border-amber-500/30">OBSERVAÇÃO</span>';
    }
  },

  formatDate(dateStr) {
    if (!dateStr) return '--';
    try {
      const d = new Date(dateStr);
      return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    } catch (e) {
      return dateStr;
    }
  },

  escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  },

  showToast(message, type = 'info') {
    let container = document.getElementById('toast-container');
    if (!container) {
      container = document.createElement('div');
      container.id = 'toast-container';
      container.className = 'fixed bottom-5 right-5 z-[99999] flex flex-col gap-2 pointer-events-none max-w-sm w-full px-4';
      document.body.appendChild(container);
    }

    const colors = {
      success: 'bg-emerald-600 text-white',
      error: 'bg-rose-600 text-white',
      info: 'bg-slate-800 text-white border border-slate-700'
    };
    const icons = {
      success: 'fa-check',
      error: 'fa-circle-exclamation',
      info: 'fa-info'
    };

    const toast = document.createElement('div');
    toast.className = `p-3.5 rounded-xl shadow-2xl text-xs font-semibold flex items-center gap-2.5 pointer-events-auto transition-all transform translate-y-4 opacity-0 ${colors[type] || colors.info}`;
    toast.innerHTML = `<i class="fa-solid ${icons[type] || icons.info}"></i> <span>${this.escapeHtml(message)}</span>`;

    container.appendChild(toast);
    requestAnimationFrame(() => {
      toast.classList.remove('translate-y-4', 'opacity-0');
    });

    setTimeout(() => {
      toast.classList.add('opacity-0', 'translate-y-4');
      setTimeout(() => toast.remove(), 300);
    }, 4000);
  },

  // =========================================================================
  // TELA 7: SESSÕES EM TEMPO REAL (USUÁRIOS ONLINE)
  // =========================================================================
  async loadSessionsData() {
    try {
      const data = await this.apiRequest('/api/admin/sessions');
      const sessions = data.sessions || [];

      // Atualiza badges
      const navCount = document.getElementById('nav-sessions-count');
      const dashCount = document.getElementById('dash-count-sessions');
      const totalCount = document.getElementById('sess-total-count');
      const liveCount = document.getElementById('sess-live-count');
      const vodCount = document.getElementById('sess-vod-count');
      const avgTime = document.getElementById('sess-avg-time');
      const tableCounter = document.getElementById('sess-table-counter');

      if (navCount) navCount.textContent = sessions.length;
      if (dashCount) dashCount.textContent = sessions.length;
      if (totalCount) totalCount.textContent = sessions.length;
      if (tableCounter) tableCounter.textContent = `${sessions.length} espectador${sessions.length !== 1 ? 'es' : ''} ativo${sessions.length !== 1 ? 's' : ''}`;

      const live = sessions.filter(s => s.itemType === 'live').length;
      const vod = sessions.filter(s => s.itemType === 'movie' || s.itemType === 'series').length;
      if (liveCount) liveCount.textContent = live;
      if (vodCount) vodCount.textContent = vod;

      if (avgTime && sessions.length > 0) {
        const totalSec = sessions.reduce((acc, s) => acc + (s.durationSeconds || 0), 0);
        const avgMin = Math.round(totalSec / sessions.length / 60);
        avgTime.textContent = avgMin > 60 ? `${Math.floor(avgMin / 60)}h ${avgMin % 60}m` : `${avgMin}m`;
      } else if (avgTime) {
        avgTime.textContent = '0m';
      }

      this.renderSessionsTable(sessions);
    } catch (e) {
      console.warn('Erro ao carregar sessões:', e);
    }
  },

  renderSessionsTable(sessions) {
    const tbody = document.getElementById('sessions-tbody');
    if (!tbody) return;

    if (!sessions.length) {
      tbody.innerHTML = '<tr><td colspan="7" class="py-12 text-center text-slate-500 text-xs">Nenhum espectador conectado no momento. Inicie uma reprodução no player para visualizar aqui em tempo real.</td></tr>';
      return;
    }

    tbody.innerHTML = sessions.map(sess => {
      const isLive = sess.itemType === 'live';
      const isVod = sess.itemType === 'movie' || sess.itemType === 'series';
      const statusBadge = isLive 
        ? '<span class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-500/20 text-emerald-400 border border-emerald-500/30"><span class="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span> AO VIVO</span>'
        : isVod
        ? '<span class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-bold bg-sky-500/20 text-sky-400 border border-sky-500/30"><i class="fa-solid fa-play text-[8px]"></i> REPRODUZINDO</span>'
        : '<span class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-bold bg-slate-800 text-slate-400 border border-slate-700">NAVEGANDO</span>';

      const durationStr = this.formatDuration(sess.durationSeconds || 0);
      const lastSeenStr = sess.lastSeenSeconds < 10 ? 'agora mesmo' : `há ${sess.lastSeenSeconds}s`;

      const prof = sess.profile || {};
      const genderBadge = prof.gender === 'Mulher' 
        ? '<span class="inline-flex items-center gap-1 text-rose-400 font-semibold text-[10px] px-1.5 py-0.2 rounded bg-rose-500/10 border border-rose-500/20"><i class="fa-solid fa-person-dress"></i> Mulher</span>'
        : prof.gender === 'Homem'
        ? '<span class="inline-flex items-center gap-1 text-sky-400 font-semibold text-[10px] px-1.5 py-0.2 rounded bg-sky-500/10 border border-sky-500/20"><i class="fa-solid fa-person"></i> Homem</span>'
        : '<span class="text-slate-500 text-[10px]">Não informado</span>';

      const adultBadge = prof.isAdultConfirmed
        ? `<span class="inline-flex items-center gap-1 text-emerald-400 font-bold text-[9px] px-1.5 py-0.5 rounded bg-emerald-500/10 border border-emerald-500/30" title="Maioridade confirmada${prof.adultConfirmedAt ? ' em ' + new Date(prof.adultConfirmedAt).toLocaleString('pt-BR') : ''}"><i class="fa-solid fa-shield-check"></i> +18 Liberado</span>`
        : '<span class="inline-flex items-center gap-1 text-slate-500 font-medium text-[9px] px-1.5 py-0.5 rounded bg-white/5 border border-slate-700/50" title="Não confirmou termo de maioridade"><i class="fa-solid fa-lock text-[8px]"></i> +18 Bloqueado</span>';

      const loc = sess.location || {};
      const locStr = (loc.city && loc.city !== 'Desconhecida')
        ? `${loc.city}${loc.region ? ' - ' + loc.region : ''}`
        : 'Rede Local';
      const ispStr = loc.isp ? `<div class="text-[10px] text-slate-500 truncate max-w-[150px]" title="${this.escapeHtml(loc.isp)}">${this.escapeHtml(loc.isp)}</div>` : '';

      return `
        <tr class="hover:bg-white/[0.02] transition">
          <td class="py-3 px-4">${statusBadge}</td>
          <td class="py-3 px-4">
            <div class="flex items-center gap-2.5">
              <div class="w-8 h-8 rounded-full bg-slate-800 text-white flex items-center justify-center text-xs font-bold border border-slate-700 shrink-0">
                ${prof.gender === 'Mulher' ? '<i class="fa-solid fa-person-dress text-rose-400"></i>' : (prof.gender === 'Homem' ? '<i class="fa-solid fa-person text-sky-400"></i>' : '<i class="fa-solid fa-user text-slate-400"></i>')}
              </div>
              <div>
                <div class="font-bold text-white text-xs">${this.escapeHtml(prof.name || 'Visitante')}</div>
                <div class="mt-0.5 flex items-center gap-1.5 flex-wrap">${genderBadge} ${adultBadge}</div>
              </div>
            </div>
          </td>
          <td class="py-3 px-4">
            <div class="text-slate-200 font-medium text-xs flex items-center gap-1.5">
              <i class="fa-solid fa-location-dot text-[10px] text-netflix-red"></i>
              <span>${this.escapeHtml(locStr)}</span>
            </div>
            ${ispStr}
          </td>
          <td class="py-3 px-4 font-mono text-white text-xs">
            <div class="flex items-center gap-1.5">
              <i class="fa-solid fa-lock text-[9px] text-emerald-400"></i>
              <span>${this.escapeHtml(sess.ip)}</span>
            </div>
            <div class="text-[10px] text-slate-400 font-sans mt-0.5">${this.escapeHtml(sess.device || 'Web')}</div>
          </td>
          <td class="py-3 px-4 font-semibold text-white max-w-xs truncate">
            ${this.escapeHtml(sess.currentTitle || 'Navegando no Catálogo')}
          </td>
          <td class="py-3 px-4 text-slate-300 font-mono text-[11px]">
            <div>${durationStr}</div>
            <div class="text-[10px] text-slate-500">${lastSeenStr}</div>
          </td>
          <td class="py-3 px-4 text-right">
            <div class="flex items-center justify-end gap-1.5">
              <button onclick="AdminApp.openRemoteControlModal('${sess.id}', '${this.escapeHtml(prof.name || sess.ip)}')" title="Comando Remoto & Enviar Conteúdo" class="px-2.5 py-1.5 rounded-lg bg-sky-950/40 hover:bg-sky-900/60 border border-sky-800/40 text-sky-400 text-[11px] font-semibold transition flex items-center gap-1.5 cursor-pointer">
                <i class="fa-solid fa-gamepad text-[10px]"></i>
                <span>Comando</span>
              </button>
              <button onclick="AdminApp.openSendMessageModal('${sess.id}', '${this.escapeHtml(prof.name || sess.ip)}')" title="Enviar Mensagem Criptografada" class="px-2.5 py-1.5 rounded-lg bg-emerald-950/40 hover:bg-emerald-900/60 border border-emerald-800/40 text-emerald-400 text-[11px] font-semibold transition flex items-center gap-1.5 cursor-pointer">
                <i class="fa-solid fa-message text-[10px]"></i>
                <span>Mensagem</span>
              </button>
              <button onclick="AdminApp.terminateSession('${sess.id}')" title="Desconectar Sessão" class="px-2 py-1.5 rounded-lg bg-rose-950/40 hover:bg-rose-900/60 border border-rose-800/40 text-rose-400 text-[11px] font-semibold transition cursor-pointer">
                <i class="fa-solid fa-power-off text-[10px]"></i>
              </button>
            </div>
          </td>
        </tr>
      `;
    }).join('');
  },

  openSendMessageModal(targetId, targetLabel) {
    const modal = document.getElementById('admin-send-msg-modal');
    if (!modal) return;
    document.getElementById('admin-send-msg-target-id').value = targetId || 'ALL';
    document.getElementById('admin-send-msg-recipient').textContent = `Destinatário: ${targetLabel || targetId}`;
    document.getElementById('admin-send-msg-text').value = '';
    modal.classList.remove('hidden');
  },

  closeSendMessageModal() {
    const modal = document.getElementById('admin-send-msg-modal');
    if (modal) modal.classList.add('hidden');
  },

  async submitSendMessage(e) {
    if (e) e.preventDefault();
    const targetSessionId = document.getElementById('admin-send-msg-target-id').value;
    const title = document.getElementById('admin-send-msg-title').value.trim();
    const type = document.getElementById('admin-send-msg-type').value;
    const text = document.getElementById('admin-send-msg-text').value.trim();
    const submitBtn = document.getElementById('admin-send-msg-submit-btn');

    if (!text) {
      this.showToast('Digite o conteúdo da mensagem.', 'error');
      return;
    }

    try {
      submitBtn.disabled = true;
      submitBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Criptografando...';

      const res = await this.apiRequest('/api/admin/sessions/message', {
        method: 'POST',
        body: JSON.stringify({ targetSessionId, title, type, text })
      });

      this.closeSendMessageModal();
      this.showToast(targetSessionId === 'ALL' 
        ? 'Mensagem criptografada transmitida para todos os usuários!' 
        : 'Mensagem criptografada enviada ao usuário com sucesso!', 'success');
    } catch (err) {
      this.showToast('Erro ao enviar mensagem: ' + err.message, 'error');
    } finally {
      submitBtn.disabled = false;
      submitBtn.innerHTML = '<span>Enviar Agora</span> <i class="fa-solid fa-paper-plane text-xs"></i>';
    }
  },

  formatDuration(seconds) {
    if (seconds < 60) return `${seconds}s`;
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    if (mins < 60) return `${mins}m ${secs}s`;
    const hours = Math.floor(mins / 60);
    const remMins = mins % 60;
    return `${hours}h ${remMins}m`;
  },

  async terminateSession(sessionId) {
    if (!confirm('Deseja realmente desconectar esta sessão do player?')) return;
    try {
      await this.apiRequest(`/api/admin/sessions/${sessionId}`, { method: 'DELETE' });
      this.showToast('Sessão desconectada com sucesso.', 'info');
      this.loadSessionsData();
    } catch (e) {
      this.showToast(e.message, 'error');
    }
  },

  // =========================================================================
  // CONTROLE REMOTO & TRANSMISSÃO DE CONTEÚDO (AES-256)
  // =========================================================================
  openRemoteControlModal(targetId, targetLabel) {
    const modal = document.getElementById('admin-remote-control-modal');
    if (!modal) return;
    document.getElementById('admin-remote-target-id').value = targetId || 'ALL';
    document.getElementById('admin-remote-recipient').textContent = `Alvo: ${targetLabel || targetId}`;
    this.clearSelectedRemoteItem();
    const searchInput = document.getElementById('remote-catalog-search-input');
    if (searchInput) searchInput.value = '';
    const urlInput = document.getElementById('remote-url-input');
    if (urlInput) urlInput.value = '';
    const urlTitleInput = document.getElementById('remote-url-title-input');
    if (urlTitleInput) urlTitleInput.value = '';

    const forceRadio = document.querySelector('input[name="remote_command_type"][value="force_play"]');
    if (forceRadio) forceRadio.checked = true;
    const catRadio = document.querySelector('input[name="remote_content_source"][value="catalog"]');
    if (catRadio) catRadio.checked = true;

    this.onRemoteActionTypeChange('force_play');
    this.onRemoteSourceChange('catalog');

    this._remoteActiveType = 'all';
    this.updateRemoteTabsUI('all');
    this.onRemoteCatalogSearch('', 'all');

    modal.classList.remove('hidden');
  },

  closeRemoteControlModal() {
    const modal = document.getElementById('admin-remote-control-modal');
    if (modal) modal.classList.add('hidden');
    this.clearSelectedRemoteItem();
  },

  setRemoteCatalogType(type) {
    this._remoteActiveType = type || 'all';
    this.updateRemoteTabsUI(this._remoteActiveType);
    const searchInput = document.getElementById('remote-catalog-search-input');
    const query = searchInput ? searchInput.value.trim() : '';
    this.onRemoteCatalogSearch(query, this._remoteActiveType);
  },

  updateRemoteTabsUI(activeType) {
    const tabs = document.querySelectorAll('.remote-cat-tab');
    tabs.forEach(t => {
      const type = t.getAttribute('data-remote-type') || '';
      const isAdultTab = type.startsWith('adult');
      if (type === activeType) {
        if (isAdultTab) {
          t.className = 'remote-cat-tab px-2.5 py-1.5 rounded-lg text-xs font-bold bg-rose-500/20 text-rose-300 border border-rose-500/50 transition shrink-0 cursor-pointer shadow-sm';
        } else {
          t.className = 'remote-cat-tab px-2.5 py-1.5 rounded-lg text-xs font-bold bg-white/20 text-white border border-white/30 transition shrink-0 cursor-pointer shadow-sm';
        }
      } else {
        if (isAdultTab) {
          t.className = 'remote-cat-tab px-2.5 py-1.5 rounded-lg text-xs font-medium text-rose-400 hover:text-rose-300 hover:bg-rose-500/10 transition shrink-0 cursor-pointer border border-rose-500/20';
        } else {
          t.className = 'remote-cat-tab px-2.5 py-1.5 rounded-lg text-xs font-medium text-slate-400 hover:text-white hover:bg-white/5 transition shrink-0 cursor-pointer border border-transparent';
        }
      }
    });
  },

  onRemoteActionTypeChange(actionType) {
    const customFields = document.getElementById('remote-popup-custom-fields');
    if (customFields) {
      if (actionType === 'interactive_popup') {
        customFields.classList.remove('hidden');
      } else {
        customFields.classList.add('hidden');
      }
    }
  },

  onRemoteSourceChange(source) {
    const catSec = document.getElementById('remote-catalog-section');
    const urlSec = document.getElementById('remote-url-section');
    if (source === 'url') {
      if (catSec) catSec.classList.add('hidden');
      if (urlSec) urlSec.classList.remove('hidden');
    } else {
      if (catSec) catSec.classList.remove('hidden');
      if (urlSec) urlSec.classList.add('hidden');
    }
  },

  onRemoteUrlInputChange(val) {
    const clean = (val || '').trim().toLowerCase();
    const typeSelect = document.getElementById('remote-url-link-type');
    const isVideo = clean.endsWith('.mp4') || clean.endsWith('.m3u8') || clean.endsWith('.ts') ||
                    clean.endsWith('.mkv') || clean.includes('output=') || clean.includes('/live/') ||
                    clean.includes('/movie/') || clean.includes('/series/');
    if (typeSelect && typeSelect.value === 'auto') {
      this.onRemoteLinkTypeChange(isVideo ? 'video' : 'web');
    }
  },

  onRemoteLinkTypeChange(type) {
    const modeBox = document.getElementById('remote-url-open-mode-box');
    if (modeBox) {
      if (type === 'video') {
        modeBox.classList.add('opacity-40', 'pointer-events-none');
      } else {
        modeBox.classList.remove('opacity-40', 'pointer-events-none');
      }
    }
  },

  onRemoteCatalogSearch(query, type) {
    if (this._remoteSearchTimer) clearTimeout(this._remoteSearchTimer);
    const activeType = type || this._remoteActiveType || 'all';

    this._remoteSearchTimer = setTimeout(async () => {
      try {
        const params = new URLSearchParams({
          q: (query || '').trim(),
          type: activeType,
          adult: '1',
          limit: '3000'
        });
        const res = await fetch(`/api/netflix/search?${params.toString()}`);
        const data = await res.json();
        const results = data.results || [];
        const totalAvail = data.totalAvailable || results.length;
        const totalM = data.totalMovies || 0;
        const totalS = data.totalSeries || 0;

        const hintEl = document.getElementById('remote-catalog-status-hint');
        if (hintEl) {
          if (totalM > 0 && totalS > 0) {
            hintEl.textContent = `${totalAvail.toLocaleString('pt-BR')} disponíveis (${totalM.toLocaleString('pt-BR')} Filmes • ${totalS.toLocaleString('pt-BR')} Séries)`;
          } else {
            hintEl.textContent = `${totalAvail.toLocaleString('pt-BR')} títulos disponíveis (1 clique para selecionar)`;
          }
        }

        this.renderRemoteSearchResults(results);
      } catch (err) {
        console.error('Erro na busca remota:', err);
      }
    }, query ? 250 : 0);
  },

  _buildRemoteItemRowHTML(item) {
    const isAdult = Boolean(item.isAdult);
    const isSeries = item.itemType === 'series';
    const isLive = item.itemType === 'live';

    const typeBadge = isLive ? 'CANAL' : (isSeries ? `SÉRIE${item.totalEpisodes ? ` (${item.totalEpisodes} ep)` : (item.totalSeasons ? ` (${item.totalSeasons}T)` : '')}` : 'FILME');
    const badgeColor = isLive
      ? 'text-emerald-400 bg-emerald-500/20 border-emerald-500/30'
      : (isSeries ? 'text-purple-400 bg-purple-500/20 border-purple-500/30' : 'text-sky-400 bg-sky-500/20 border-sky-500/30');

    const cover = item.cover || item.logo || item.backdrop || '/logo.png';
    const safeItem = encodeURIComponent(JSON.stringify(item));

    return `
      <div onclick="AdminApp.selectRemoteItem('${safeItem}')" class="p-2.5 hover:bg-white/10 flex items-center justify-between gap-3 cursor-pointer transition border-b border-slate-800/60 last:border-0">
        <div class="flex items-center gap-3 min-w-0">
          <img src="${cover}" loading="lazy" class="w-9 h-12 object-cover rounded shrink-0 bg-black/40 border border-slate-700/50" onerror="this.src='/logo.png'">
          <div class="min-w-0">
            <div class="font-bold text-white text-xs truncate">${this.escapeHtml(item.name || item.title)}</div>
            <div class="text-[11px] text-slate-400 truncate mt-0.5">${this.escapeHtml(item.group || '')}</div>
          </div>
        </div>
        <div class="flex items-center gap-1.5 shrink-0">
          ${isAdult ? '<span class="px-2 py-0.5 rounded text-[10px] font-black text-rose-300 bg-rose-500/30 border border-rose-500/50">🔞 +18</span>' : ''}
          <span class="px-2 py-0.5 rounded text-[10px] font-bold ${badgeColor} border">${typeBadge}</span>
        </div>
      </div>
    `;
  },

  renderRemoteSearchResults(results) {
    const container = document.getElementById('remote-search-results');
    if (!container) return;
    this._remoteAllSearchResults = results || [];
    this._remoteRenderedCount = 0;

    if (!results || !results.length) {
      container.innerHTML = `<div class="p-4 text-slate-500 text-center text-xs">Nenhum título encontrado nesta categoria ou termo pesquisado.</div>`;
      container.classList.remove('hidden');
      return;
    }

    container.scrollTop = 0;
    container.innerHTML = '';
    this.appendMoreRemoteResults(150);
    container.classList.remove('hidden');
  },

  appendMoreRemoteResults(batchSize = 150) {
    const container = document.getElementById('remote-search-results');
    const all = this._remoteAllSearchResults || [];
    const current = this._remoteRenderedCount || 0;
    if (!container || current >= all.length) return;

    const existingMoreBtn = document.getElementById('remote-load-more-row');
    if (existingMoreBtn) existingMoreBtn.remove();

    const nextSlice = all.slice(current, current + batchSize);
    const htmlChunk = nextSlice.map(item => this._buildRemoteItemRowHTML(item)).join('');
    container.insertAdjacentHTML('beforeend', htmlChunk);
    this._remoteRenderedCount = current + nextSlice.length;

    if (this._remoteRenderedCount < all.length) {
      const remaining = all.length - this._remoteRenderedCount;
      container.insertAdjacentHTML('beforeend', `
        <div id="remote-load-more-row" onclick="AdminApp.appendMoreRemoteResults(300)" class="p-2.5 text-center bg-white/5 hover:bg-white/10 text-emerald-400 font-bold text-xs cursor-pointer transition">
          <i class="fa-solid fa-angles-down mr-1"></i> Mostrar mais títulos (+${remaining.toLocaleString('pt-BR')} restantes de ${all.length.toLocaleString('pt-BR')})
        </div>
      `);
    }
  },

  onRemoteResultsScroll(el) {
    if (!el) return;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 180) {
      this.appendMoreRemoteResults(150);
    }
  },

  async selectRemoteItem(encodedItem) {
    try {
      const item = JSON.parse(decodeURIComponent(encodedItem));
      this._selectedRemoteItem = item;
      this._selectedRemoteSeriesData = null;
      const resultsContainer = document.getElementById('remote-search-results');
      if (resultsContainer) resultsContainer.classList.add('hidden');

      const card = document.getElementById('remote-selected-item-card');
      const img = document.getElementById('remote-selected-img');
      const name = document.getElementById('remote-selected-name');
      const grp = document.getElementById('remote-selected-group');
      const badge = document.getElementById('remote-selected-badge');
      const epPicker = document.getElementById('remote-series-episode-picker');

      if (img) img.src = item.cover || item.logo || item.backdrop || '/logo.png';
      if (name) name.textContent = item.name || item.title || '';
      if (grp) grp.textContent = item.group || '';
      if (badge) {
        if (item.isAdult) {
          badge.textContent = '🔞 ADULTO +18';
          badge.className = 'px-1.5 py-0.5 rounded text-[9px] font-black bg-rose-500/20 text-rose-300 border border-rose-500/40';
        } else {
          const isLive = item.itemType === 'live';
          const isSeries = item.itemType === 'series';
          badge.textContent = isLive ? 'CANAL AO VIVO' : (isSeries ? 'SÉRIE' : 'FILME');
          badge.className = isLive
            ? 'px-1.5 py-0.5 rounded text-[9px] font-bold bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
            : (isSeries
              ? 'px-1.5 py-0.5 rounded text-[9px] font-bold bg-purple-500/20 text-purple-400 border border-purple-500/30'
              : 'px-1.5 py-0.5 rounded text-[9px] font-bold bg-sky-500/20 text-sky-400 border border-sky-500/30');
        }
      }

      if (card) card.classList.remove('hidden');

      // Se for Série, carrega as temporadas e episódios para permitir escolha (padrão: T1:E1)
      if (item.itemType === 'series' && item.id) {
        if (epPicker) epPicker.classList.remove('hidden');
        try {
          const res = await fetch(`/api/netflix/series/${item.id}`);
          const sData = await res.json();
          if (sData && sData.seasons) {
            this._selectedRemoteSeriesData = sData;
            const seasonSelect = document.getElementById('remote-series-season-select');
            const seasonKeys = Object.keys(sData.seasons).map(Number).sort((a, b) => a - b);
            if (seasonSelect) {
              seasonSelect.innerHTML = seasonKeys.map(s => `<option value="${s}">Temporada ${s} (${sData.seasons[s].length} eps)</option>`).join('');
            }
            if (seasonKeys.length > 0) {
              this.onRemoteSeriesSeasonChange(seasonKeys[0]);
            }
          }
        } catch (err) {
          console.warn('Falha ao carregar temporadas da série no ADM:', err);
        }
      } else if (epPicker) {
        epPicker.classList.add('hidden');
      }
    } catch (e) {
      console.error('Erro ao selecionar item remoto:', e);
    }
  },

  onRemoteSeriesSeasonChange(seasonNum) {
    const sData = this._selectedRemoteSeriesData;
    if (!sData || !sData.seasons) return;
    const eps = sData.seasons[seasonNum] || [];
    const epSelect = document.getElementById('remote-series-episode-select');
    if (epSelect) {
      epSelect.innerHTML = eps.map((ep, idx) => `<option value="${idx}">Ep. ${ep.episode} - ${this.escapeHtml(ep.name || `Episódio ${ep.episode}`)}</option>`).join('');
    }
    if (eps.length > 0) {
      this.onRemoteSeriesEpisodeChange(0);
    }
  },

  onRemoteSeriesEpisodeChange(epIdx) {
    const sData = this._selectedRemoteSeriesData;
    const seasonSelect = document.getElementById('remote-series-season-select');
    if (!sData || !sData.seasons || !seasonSelect || !this._selectedRemoteItem) return;
    const seasonNum = Number(seasonSelect.value);
    const eps = sData.seasons[seasonNum] || [];
    const ep = eps[Number(epIdx)];
    if (ep) {
      this._selectedRemoteItem.firstEpisode = {
        name: ep.name || `Episódio ${ep.episode}`,
        season: ep.season || seasonNum,
        episode: ep.episode || 1,
        streamUrl: ep.streamUrl
      };
      this._selectedRemoteItem.streamUrl = ep.streamUrl;
    }
  },

  clearSelectedRemoteItem() {
    this._selectedRemoteItem = null;
    this._selectedRemoteSeriesData = null;
    const card = document.getElementById('remote-selected-item-card');
    if (card) card.classList.add('hidden');
    const epPicker = document.getElementById('remote-series-episode-picker');
    if (epPicker) epPicker.classList.add('hidden');
    const resultsContainer = document.getElementById('remote-search-results');
    if (resultsContainer) resultsContainer.classList.remove('hidden');
  },

  async submitRemoteCommand(e) {
    if (e) e.preventDefault();
    const targetSessionId = document.getElementById('admin-remote-target-id').value;
    const commandType = document.querySelector('input[name="remote_command_type"]:checked')?.value || 'force_play';
    const contentSource = document.querySelector('input[name="remote_content_source"]:checked')?.value || 'catalog';
    const urlInput = document.getElementById('remote-url-input');
    const url = urlInput ? urlInput.value.trim() : '';
    const urlTitleInput = document.getElementById('remote-url-title-input');
    const customUrlTitle = urlTitleInput ? urlTitleInput.value.trim() : '';

    if (contentSource === 'catalog' && !this._selectedRemoteItem) {
      this.showToast('Por favor, busque e selecione um canal, série, filme ou conteúdo adulto do catálogo.', 'error');
      return;
    }
    if (contentSource === 'url' && !url) {
      this.showToast('Por favor, informe a URL ou link direto da transmissão.', 'error');
      return;
    }

    const title = (contentSource === 'url' && customUrlTitle)
      ? customUrlTitle
      : (document.getElementById('remote-popup-title')?.value.trim() || 'Conteúdo Recomendado');
    const message = document.getElementById('remote-popup-msg')?.value.trim() || 'O administrador liberou este conteúdo exclusivo para você!';
    const buttonText = document.getElementById('remote-popup-btn-text')?.value.trim() || 'Assistir Agora';

    const linkType = document.getElementById('remote-url-link-type')?.value || 'auto';
    const openMode = document.getElementById('remote-url-open-mode')?.value || 'redirect';

    const submitBtn = document.getElementById('admin-remote-submit-btn');
    const origHtml = submitBtn ? submitBtn.innerHTML : '';
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin text-xs"></i> <span>Transmitindo...</span>';
    }

    try {
      await this.apiRequest('/api/admin/remote-command', {
        method: 'POST',
        body: JSON.stringify({
          targetSessionId,
          commandType,
          contentType: contentSource,
          item: this._selectedRemoteItem || null,
          url: url || null,
          title,
          message,
          buttonText,
          linkType,
          openMode
        })
      });

      this.showToast(targetSessionId === 'ALL'
        ? 'Comando remoto transmitido para todos os usuários com sucesso!'
        : 'Comando remoto enviado ao dispositivo com sucesso!', 'success');
      this.closeRemoteControlModal();
      this.loadSessionsData();
    } catch (err) {
      this.showToast(err.message, 'error');
    } finally {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.innerHTML = origHtml;
      }
    }
  },

  // =========================================================================
  // TELA 8: TERMINAL DE LOGS DO SISTEMA EM TEMPO REAL
  // =========================================================================
  async loadLogsData(showLoading = true) {
    const level = document.getElementById('log-level-filter')?.value || 'ALL';
    const category = document.getElementById('log-category-filter')?.value || 'ALL';
    const limit = document.getElementById('log-limit-select')?.value || '100';
    const search = document.getElementById('log-search-input')?.value?.trim() || '';

    try {
      const params = new URLSearchParams({ limit, level, category, search });
      const data = await this.apiRequest(`/api/admin/logs?${params.toString()}`);
      this.state.cachedLogs = data.logs || [];

      // Atualiza métricas
      if (data.metrics) {
        const elTotal = document.getElementById('log-stat-total');
        const elStreams = document.getElementById('log-stat-streams');
        const elWarnings = document.getElementById('log-stat-warnings');
        const elErrors = document.getElementById('log-stat-errors');
        if (elTotal) elTotal.textContent = data.metrics.totalEvents ?? 0;
        if (elStreams) elStreams.textContent = data.metrics.totalStreams ?? 0;
        if (elWarnings) elWarnings.textContent = data.metrics.totalWarnings ?? 0;
        if (elErrors) elErrors.textContent = data.metrics.totalErrors ?? 0;
      }

      const counter = document.getElementById('log-counter-indicator');
      if (counter) {
        counter.textContent = `${data.logs ? data.logs.length : 0} exibidos / ${data.total || 0} gravados`;
      }

      this.renderLogs(data.logs || []);
    } catch (err) {
      if (showLoading) {
        this.showToast(err.message, 'error');
      }
    }
  },

  filterLogsDebounced() {
    if (this.state.logsSearchDebounce) clearTimeout(this.state.logsSearchDebounce);
    this.state.logsSearchDebounce = setTimeout(() => {
      this.loadLogsData(false);
    }, 300);
  },

  renderLogs(logs) {
    const container = document.getElementById('log-console-content');
    if (!container) return;

    if (!logs.length) {
      container.innerHTML = `
        <div class="py-12 text-center text-slate-500 font-mono text-xs flex flex-col items-center justify-center gap-2">
          <i class="fa-solid fa-terminal text-2xl text-slate-600"></i>
          <span>Nenhum evento registrado no momento ou correspondente aos filtros.</span>
        </div>
      `;
      return;
    }

    const levelBadges = {
      STREAM: 'bg-emerald-950/80 text-emerald-400 border border-emerald-500/30',
      ERROR: 'bg-rose-950/80 text-rose-400 border border-rose-500/30',
      WARN: 'bg-amber-950/80 text-amber-400 border border-amber-500/30',
      AUTH: 'bg-indigo-950/80 text-indigo-400 border border-indigo-500/30',
      INFO: 'bg-slate-800 text-sky-400 border border-slate-700'
    };

    const levelIcons = {
      STREAM: 'fa-play text-[8px]',
      ERROR: 'fa-circle-exclamation text-[9px]',
      WARN: 'fa-triangle-exclamation text-[9px]',
      AUTH: 'fa-shield-halved text-[9px]',
      INFO: 'fa-circle-info text-[9px]'
    };

    container.innerHTML = logs.map(item => {
      const badgeStyle = levelBadges[item.level] || levelBadges.INFO;
      const icon = levelIcons[item.level] || levelIcons.INFO;
      const timeStr = item.timeFormatted || (item.timestamp ? item.timestamp.split('T')[1].slice(0, 8) : '--:--:--');

      return `
        <div class="flex items-start gap-2.5 py-1.5 px-2 rounded hover:bg-white/[0.04] transition font-mono text-[11px] leading-relaxed border-b border-white/[0.03]">
          <span class="text-slate-500 select-none shrink-0 font-medium">${timeStr}</span>
          <span class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-bold tracking-wider shrink-0 uppercase ${badgeStyle}">
            <i class="fa-solid ${icon}"></i>
            <span>${this.escapeHtml(item.level)}</span>
          </span>
          <span class="px-1.5 py-0.5 rounded text-[9px] font-medium tracking-wide bg-slate-800/90 text-slate-300 border border-slate-700/60 shrink-0">
            ${this.escapeHtml(item.category)}
          </span>
          ${item.ip ? `
            <span class="text-slate-400 shrink-0 font-mono text-[10px] bg-black/40 px-1.5 py-0.5 rounded border border-white/5 flex items-center gap-1">
              <i class="fa-solid fa-lock text-[8px] text-emerald-400"></i>
              ${this.escapeHtml(item.ip)}
            </span>
          ` : ''}
          <div class="text-slate-200 break-all flex-1">
            <span>${this.escapeHtml(item.message)}</span>
            ${item.details ? `<div class="text-slate-400 text-[10px] mt-0.5 opacity-80">${this.escapeHtml(item.details)}</div>` : ''}
          </div>
        </div>
      `;
    }).join('');
  },

  startLogsAutoRefresh() {
    this.stopLogsAutoRefresh();
    if (!this.state.logsAutoRefresh) return;
    this.state.logsRefreshTimer = setInterval(() => {
      if (this.state.currentScreen === 'logs') {
        this.loadLogsData(false);
      }
    }, 3000);
  },

  stopLogsAutoRefresh() {
    if (this.state.logsRefreshTimer) {
      clearInterval(this.state.logsRefreshTimer);
      this.state.logsRefreshTimer = null;
    }
  },

  toggleLogAutoRefresh() {
    this.state.logsAutoRefresh = !this.state.logsAutoRefresh;
    const btn = document.getElementById('btn-log-autorefresh');
    if (this.state.logsAutoRefresh) {
      if (btn) {
        btn.className = 'px-3 py-1.5 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 text-xs font-semibold hover:bg-emerald-500/20 transition flex items-center gap-1.5 cursor-pointer';
        btn.innerHTML = '<span class="w-2 h-2 rounded-full bg-emerald-400 animate-ping"></span><span id="log-autorefresh-label">Auto-Atualização (3s)</span>';
      }
      this.startLogsAutoRefresh();
      this.showToast('Atualização em tempo real ativada.', 'info');
    } else {
      this.stopLogsAutoRefresh();
      if (btn) {
        btn.className = 'px-3 py-1.5 rounded-xl bg-slate-800 border border-slate-700 text-slate-400 text-xs font-semibold hover:bg-slate-700 transition flex items-center gap-1.5 cursor-pointer';
        btn.innerHTML = '<span class="w-2 h-2 rounded-full bg-slate-500"></span><span id="log-autorefresh-label">Auto-Atualização (Pausada)</span>';
      }
      this.showToast('Atualização em tempo real pausada.', 'info');
    }
  },

  async clearLogs() {
    if (!confirm('Deseja realmente limpar o histórico de logs do sistema?')) return;
    try {
      await this.apiRequest('/api/admin/logs', { method: 'DELETE' });
      this.showToast('Terminal de logs limpo com sucesso.', 'success');
      this.loadLogsData();
    } catch (err) {
      this.showToast(err.message, 'error');
    }
  },

  exportLogs() {
    if (!this.state.cachedLogs || !this.state.cachedLogs.length) {
      this.showToast('Nenhum log disponível para exportar.', 'warning');
      return;
    }
    const lines = this.state.cachedLogs.map(l => 
      `[${l.timestamp}] [${l.level}] [${l.category}] [IP: ${l.ip || 'N/A'}] ${l.message} ${l.details ? '(' + l.details + ')' : ''}`
    );
    const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `novaflix-system-logs-${new Date().toISOString().slice(0, 10)}.log`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    this.showToast('Download do arquivo de logs concluído.', 'success');
  },

  // =========================================================================
  // CONFIGURAÇÕES DE PAGAMENTO (GATEWAY DE DOAÇÃO)
  // =========================================================================
  async loadPaymentGatewayData() {
    try {
      const data = await this.apiRequest('/api/admin/payment-gateway');
      const input = document.getElementById('input-payment-api-key');
      if (input) {
        input.value = data.apiKey || '';
      }

      this.updateGatewayStatusUI(data.isActive);
    } catch (err) {
      this.showToast('Erro ao carregar dados do gateway: ' + err.message, 'error');
    }
  },

  updateGatewayStatusUI(isActive) {
    const pill = document.getElementById('gateway-status-pill');
    const sidePill = document.getElementById('sidebar-gateway-pill');

    if (pill) {
      if (isActive) {
        pill.className = 'inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-emerald-500/20 text-emerald-400 border border-emerald-500/30';
        pill.innerHTML = '<span class="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span><span>GATEWAY ATIVO</span>';
      } else {
        pill.className = 'inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-slate-800 text-slate-400 border border-slate-700';
        pill.innerHTML = '<span class="w-1.5 h-1.5 rounded-full bg-slate-500"></span><span>DESLIGADO (100% GRÁTIS)</span>';
      }
    }

    if (sidePill) {
      if (isActive) {
        sidePill.className = 'px-2 py-0.5 rounded-full text-[9px] font-bold bg-emerald-500/20 text-emerald-400 border border-emerald-500/30';
        sidePill.textContent = 'ON';
      } else {
        sidePill.className = 'px-2 py-0.5 rounded-full text-[9px] font-bold bg-slate-800 text-slate-400 border border-slate-700';
        sidePill.textContent = 'OFF';
      }
    }
  },

  toggleApiKeyVisibility() {
    const input = document.getElementById('input-payment-api-key');
    const eye = document.getElementById('btn-api-key-eye');
    if (!input) return;
    if (input.type === 'password') {
      input.type = 'text';
      if (eye) eye.className = 'fa-solid fa-eye-slash';
    } else {
      input.type = 'password';
      if (eye) eye.className = 'fa-solid fa-eye';
    }
  },

  async savePaymentGateway(e) {
    if (e) e.preventDefault();
    const input = document.getElementById('input-payment-api-key');
    const apiKey = input ? input.value.trim() : '';

    try {
      const res = await this.apiRequest('/api/admin/payment-gateway', {
        method: 'POST',
        body: JSON.stringify({ apiKey })
      });

      this.updateGatewayStatusUI(res.isActive);
      if (res.isActive) {
        this.showToast('Gateway Ativado com sucesso! Motor de doação em execução.', 'success');
      } else {
        this.showToast('Gateway desativado. O aplicativo operará em modo 100% gratuito.', 'info');
      }
    } catch (err) {
      this.showToast('Erro ao salvar gateway: ' + err.message, 'error');
    }
  },

  async clearPaymentApiKey() {
    if (!confirm('Deseja desativar o Gateway de Pagamento? O app funcionará como player 100% gratuito sem doações.')) return;
    const input = document.getElementById('input-payment-api-key');
    if (input) input.value = '';
    await this.savePaymentGateway();
  },

  // =========================================================================
  // CONTROLE DE USUÁRIOS VIA UUID (GESTÃO INDIVIDUAL & OVERRIDES)
  // =========================================================================
  async loadUsersControlData() {
    try {
      const res = await this.apiRequest('/api/admin/users-control');
      this.state.cachedUsersControl = res.users || [];
      this.renderUsersControlTable(this.state.cachedUsersControl);
      
      const countPill = document.getElementById('nav-users-control-count');
      if (countPill) countPill.textContent = (res.users || []).length;
    } catch (err) {
      this.showToast('Erro ao carregar usuários: ' + err.message, 'error');
    }
  },

  filterUsersControlDebounced() {
    if (this._userFilterTimer) clearTimeout(this._userFilterTimer);
    this._userFilterTimer = setTimeout(() => {
      const q = (document.getElementById('users-control-search-input')?.value || '').toLowerCase().trim();
      if (!this.state.cachedUsersControl) return;
      if (!q) {
        this.renderUsersControlTable(this.state.cachedUsersControl);
        return;
      }
      const filtered = this.state.cachedUsersControl.filter(u => 
        (u.name && u.name.toLowerCase().includes(q)) ||
        (u.uuid && u.uuid.toLowerCase().includes(q)) ||
        (u.ip && u.ip.toLowerCase().includes(q)) ||
        (u.device && u.device.toLowerCase().includes(q))
      );
      this.renderUsersControlTable(filtered);
    }, 250);
  },

  renderUsersControlTable(users) {
    const tbody = document.getElementById('users-control-tbody');
    const counter = document.getElementById('users-control-counter');
    const statTotal = document.getElementById('ucontrol-stat-total');
    const statOnline = document.getElementById('ucontrol-stat-online');
    const statDonors = document.getElementById('ucontrol-stat-donors');
    const statOverrides = document.getElementById('ucontrol-stat-overrides');

    if (!tbody) return;

    const all = this.state.cachedUsersControl || [];
    const totalCount = all.length;
    const onlineCount = all.filter(u => u.isOnline).length;
    const donorsCount = all.filter(u => u.donationsCount > 0).length;
    const overridesCount = all.filter(u => u.overrides && (u.overrides.abolishDonation || u.overrides.forceDonation || u.overrides.customInitialValues || u.overrides.customRecurringValues)).length;

    if (statTotal) statTotal.textContent = totalCount;
    if (statOnline) statOnline.textContent = onlineCount;
    if (statDonors) statDonors.textContent = donorsCount;
    if (statOverrides) statOverrides.textContent = overridesCount;

    if (counter) counter.textContent = `${users.length} usuários listados`;

    if (!users || users.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="7" class="py-8 text-center text-slate-500">
            Nenhum usuário localizado. Conforme os espectadores utilizarem o aplicativo, seus UUIDs aparecerão aqui.
          </td>
        </tr>
      `;
      return;
    }

    tbody.innerHTML = users.map(u => {
      const isOnline = u.isOnline;
      const statusBadge = isOnline
        ? `<span class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-500/20 text-emerald-400 border border-emerald-500/30"><span class="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-ping"></span>Online</span>`
        : `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-slate-800 text-slate-500">Offline</span>`;

      const ov = u.overrides || {};
      const overrideBadges = [];
      if (ov.abolishDonation) {
        overrideBadges.push(`<span class="px-2 py-0.5 rounded bg-rose-500/20 text-rose-400 border border-rose-500/30 text-[10px] font-bold">🚫 Doação Abolida</span>`);
      }
      if (ov.forceDonation) {
        overrideBadges.push(`<span class="px-2 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30 text-[10px] font-bold">⚡ Doação Forçada</span>`);
      }
      if (ov.customInitialValues && ov.customInitialValues.length) {
        overrideBadges.push(`<span class="px-2 py-0.5 rounded bg-sky-500/20 text-sky-400 border border-sky-500/30 text-[10px] font-mono">1ª: R$${ov.customInitialValues.join(',')}</span>`);
      }
      if (ov.customRecurringValues && ov.customRecurringValues.length) {
        overrideBadges.push(`<span class="px-2 py-0.5 rounded bg-purple-500/20 text-purple-400 border border-purple-500/30 text-[10px] font-mono">Rec: R$${ov.customRecurringValues.join(',')}</span>`);
      }
      if (overrideBadges.length === 0) {
        overrideBadges.push(`<span class="text-slate-500 text-[11px]">Padrão Global</span>`);
      }

      const safeUuid = this.escapeHtml(u.uuid);
      const safeName = this.escapeHtml(u.name || 'Visitante');

      return `
        <tr class="hover:bg-white/[0.02] transition">
          <td class="py-3.5 px-4">${statusBadge}</td>
          <td class="py-3.5 px-4">
            <div class="font-bold text-white text-xs">${safeName}</div>
            <div class="text-[11px] text-slate-400">${this.escapeHtml(u.gender || 'Não informado')} • ${u.age ? u.age + ' anos' : 'Idade N/A'}</div>
          </td>
          <td class="py-3.5 px-4">
            <div class="flex items-center gap-1.5">
              <span class="font-mono text-xs text-purple-400 truncate max-w-[130px] sm:max-w-[180px]" title="${safeUuid}">${safeUuid}</span>
              <button onclick="AdminApp.copyToClipboard('${safeUuid}')" title="Copiar UUID" class="text-slate-500 hover:text-white p-1 text-xs">
                <i class="fa-regular fa-copy"></i>
              </button>
            </div>
          </td>
          <td class="py-3.5 px-4">
            <div class="text-slate-300 text-xs">${this.escapeHtml(u.device || 'Web')}</div>
            <div class="text-[11px] text-slate-500 font-mono">${this.escapeHtml(u.ip || '127.0.0.1')}</div>
          </td>
          <td class="py-3.5 px-4 text-center">
            <span class="px-2.5 py-1 rounded-full text-xs font-bold ${u.donationsCount > 0 ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30' : 'bg-slate-800 text-slate-400'}">
              ${u.donationsCount} doações
            </span>
          </td>
          <td class="py-3.5 px-4">
            <div class="flex flex-wrap gap-1 items-center">
              ${overrideBadges.join(' ')}
            </div>
          </td>
          <td class="py-3.5 px-4 text-right">
            <button onclick="AdminApp.openUserOverrideModal('${safeUuid}')" class="px-3 py-1.5 rounded-lg bg-purple-600/20 hover:bg-purple-600/30 border border-purple-500/40 text-purple-300 hover:text-white text-xs font-semibold transition flex items-center gap-1.5 ml-auto cursor-pointer">
              <i class="fa-solid fa-sliders text-xs"></i>
              <span>Overrides</span>
            </button>
          </td>
        </tr>
      `;
    }).join('');
  },

  openUserOverrideModal(uuid) {
    if (!this.state.cachedUsersControl) return;
    const user = this.state.cachedUsersControl.find(u => u.uuid === uuid);
    if (!user) return;

    const modal = document.getElementById('admin-user-override-modal');
    if (!modal) return;

    document.getElementById('override-input-uuid').value = user.uuid;
    document.getElementById('override-modal-user-name').textContent = user.name || 'Visitante';
    document.getElementById('override-modal-uuid').textContent = user.uuid;

    const ov = user.overrides || {};
    document.getElementById('override-check-abolish').checked = Boolean(ov.abolishDonation);
    document.getElementById('override-check-force').checked = Boolean(ov.forceDonation);
    document.getElementById('override-custom-initial').value = (ov.customInitialValues && ov.customInitialValues.length) ? ov.customInitialValues.join(', ') : '';
    document.getElementById('override-custom-recurring').value = (ov.customRecurringValues && ov.customRecurringValues.length) ? ov.customRecurringValues.join(', ') : '';

    modal.classList.remove('hidden');
  },

  closeUserOverrideModal() {
    const modal = document.getElementById('admin-user-override-modal');
    if (modal) modal.classList.add('hidden');
  },

  async saveUserOverride(e) {
    if (e) e.preventDefault();
    const uuid = document.getElementById('override-input-uuid').value;
    if (!uuid) return;

    const abolishDonation = document.getElementById('override-check-abolish').checked;
    const forceDonation = document.getElementById('override-check-force').checked;
    const customInitialValues = document.getElementById('override-custom-initial').value.trim();
    const customRecurringValues = document.getElementById('override-custom-recurring').value.trim();

    try {
      await this.apiRequest('/api/admin/users-control/override', {
        method: 'POST',
        body: JSON.stringify({
          uuid,
          abolishDonation,
          forceDonation,
          customInitialValues,
          customRecurringValues
        })
      });

      this.showToast('Sobreposições de usuário salvas com sucesso!', 'success');
      this.closeUserOverrideModal();
      this.loadUsersControlData();
    } catch (err) {
      this.showToast('Erro ao salvar sobreposições: ' + err.message, 'error');
    }
  },

  copyToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => {
        this.showToast('Copiado para a área de transferência!', 'info');
      }).catch(() => {});
    } else {
      const t = document.createElement('textarea');
      t.value = text;
      document.body.appendChild(t);
      t.select();
      document.execCommand('copy');
      document.body.removeChild(t);
      this.showToast('Copiado para a área de transferência!', 'info');
    }
  }
};

window.addEventListener('DOMContentLoaded', () => {
  AdminApp.init();
});

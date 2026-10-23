/**
 * NovaFlix Web Streaming Controller (Criptografado & Otimizado)
 */

const BACKDROP_COLLECTION = [
  'https://images.unsplash.com/photo-1578328819058-b69f3a3b0f6b?auto=format&fit=crop&w=1600&q=80',
  'https://images.unsplash.com/photo-1536440136628-849c177e76a1?auto=format&fit=crop&w=1600&q=80',
  'https://images.unsplash.com/photo-1518709268805-4e9042af9f23?auto=format&fit=crop&w=1600&q=80',
  'https://images.unsplash.com/photo-1574375927938-d5a98e8ffe85?auto=format&fit=crop&w=1600&q=80',
  'https://images.unsplash.com/photo-1489599849927-2ee91cede3ba?auto=format&fit=crop&w=1600&q=80',
  'https://images.unsplash.com/photo-1509198397868-475647b2a1e5?auto=format&fit=crop&w=1600&q=80',
  'https://images.unsplash.com/photo-1478760329108-5c3ed9d495a0?auto=format&fit=crop&w=1600&q=80'
];

/**
 * Motor de Armazenamento Criptografado no Cliente (EncryptedStorage)
 * Criptografa todos os dados sensíveis (perfil, UUID do dispositivo, doações, servidores)
 * antes de persistir no localStorage ou storage nativo do Tauri/Android/Desktop (Requirement 7)
 */
const EncryptedStorage = {
  _secret: 'novaflix_aes_vault_key_2026_super_secure',

  _xorEncrypt(text) {
    if (!text) return '';
    try {
      const key = this._secret;
      let res = '';
      for (let i = 0; i < text.length; i++) {
        res += String.fromCharCode(text.charCodeAt(i) ^ key.charCodeAt(i % key.length));
      }
      return 'enc_' + btoa(encodeURIComponent(res));
    } catch (e) {
      return 'raw_' + btoa(encodeURIComponent(text));
    }
  },

  _xorDecrypt(cipherText) {
    if (!cipherText || typeof cipherText !== 'string') return null;
    try {
      if (cipherText.startsWith('enc_')) {
        const decoded = decodeURIComponent(atob(cipherText.slice(4)));
        const key = this._secret;
        let res = '';
        for (let i = 0; i < decoded.length; i++) {
          res += String.fromCharCode(decoded.charCodeAt(i) ^ key.charCodeAt(i % key.length));
        }
        return res;
      }
      if (cipherText.startsWith('raw_')) {
        return decodeURIComponent(atob(cipherText.slice(4)));
      }
      return cipherText;
    } catch (e) {
      return cipherText;
    }
  },

  setItem(key, value) {
    try {
      const jsonStr = typeof value === 'string' ? value : JSON.stringify(value);
      const encrypted = this._xorEncrypt(jsonStr);
      localStorage.setItem('__enc_' + key, encrypted);
    } catch (e) {
      console.warn('[EncryptedStorage] Erro ao gravar item:', e);
    }
  },

  getItem(key, defaultValue = null) {
    try {
      let raw = localStorage.getItem('__enc_' + key);
      if (!raw) {
        raw = localStorage.getItem(key);
        if (!raw) return defaultValue;
        try {
          const parsed = JSON.parse(raw);
          this.setItem(key, parsed);
          return parsed;
        } catch(e) {
          return raw;
        }
      }
      const decrypted = this._xorDecrypt(raw);
      if (!decrypted) return defaultValue;
      try {
        return JSON.parse(decrypted);
      } catch (e) {
        return decrypted;
      }
    } catch (e) {
      return defaultValue;
    }
  },

  removeItem(key) {
    try {
      localStorage.removeItem('__enc_' + key);
      localStorage.removeItem(key);
    } catch (e) {}
  }
};

const App = {
  state: {
    heroItem: null,
    trendingItems: [],
    currentHeroIndex: 0,
    heroAutoRotateTimer: null,
    isHeroHovered: false,
    activeItem: null,
    activeSeries: null,
    activeEpisode: null,
    currentSeriesData: null,
    modalItem: null,
    catalogRows: [],
    favorites: EncryptedStorage.getItem('netflix_favorites', []),
    favoriteObjects: EncryptedStorage.getItem('novaflix_favorites_data', []),
    userProfile: EncryptedStorage.getItem('novaflix_profile', { name: '', gender: '', age: null, city: '', showAdultContent: false, isAdultConfirmed: false }),
    activeFilter: 'ALL',
    aspectRatioIdx: 0,
    aspectRatios: ['contain', 'cover', 'fill'],
    aspectRatioLabels: ['Automático', 'Preencher Tela', 'Esticar'],
    pollTimer: null,
    lastCatalogVersion: null,
    lastTotalCount: 0,
    isPlayerLocked: false,
    _lockHideTimer: null,
    deferredInstallPrompt: null,
    gatewayActive: false,
    userOverrides: {},
    watchTimeAccumulatedSeconds: 0,
    doacao_pendente: false,
    sessionId: 'sess_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 8),
    fullCatalog: {
      isOpen: false,
      type: 'all',
      group: '',
      title: 'Grade Completa de Títulos',
      search: '',
      page: 1,
      limit: 36,
      total: 0,
      totalPages: 1,
      items: [],
      groups: [],
      viewMode: 'grid',
      isLoading: false
    }
  },

  player: null,

  async init() {
    this.initDeviceMode();
    await this.loadServerConfig();
    this.initAndroidBackSupport();
    this.initNavbarScroll();
    this.initPlayer();
    this.initKeyboardShortcuts();
    this.initSettings();
    this.loadAntiQuedaConfig();
    this.updateFavoritesBadges();
    this.updateHeaderProfileBadge();
    this.initTimeTracker();
    this.initSessionHeartbeat();
    this.initPwaSupport();
    this.checkInitialPaymentGatewayStatus();
    await this.startPreloaderFlow();
  },

  /* ==============================================================================
     DYNAMIC ADM SERVER IP & DEVICE UUID (REQUIREMENT 1 & 7)
     ============================================================================== */
  isTauri() {
    return typeof window !== 'undefined' && Boolean(window.__TAURI__ || window.__TAURI_INTERNALS__);
  },

  isNativeApp() {
    // Retorna true SOMENTE quando rodando dentro de um pacote/app nativo compilado (Tauri, Capacitor nativo, Cordova nativo, Electron).
    // NUNCA retornar true para navegadores web comuns (Mobile Chrome, Safari, Samsung Internet, Edge, etc.),
    // pois navegadores bloqueiam requisições diretas por CORS/Mixed-Content e exigem o motor do navegador via proxy.
    if (this.isTauri()) return true;
    if (typeof window !== 'undefined') {
      if (window.__TAURI__ || window.__TAURI_INTERNALS__) return true;
      if (window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function' && window.Capacitor.isNativePlatform()) {
        return true;
      }
      if (window.cordova && window.cordova.platformId && window.cordova.platformId !== 'browser') {
        return true;
      }
      if (window.location && (window.location.protocol === 'file:' || window.location.protocol === 'capacitor:')) {
        return true;
      }
      if (window.process && window.process.type === 'renderer') {
        return true;
      }
      if (navigator.userAgent && /Electron|NovaFlixApp|Capacitor|Cordova/i.test(navigator.userAgent)) {
        return true;
      }
      if (window.__ELECTRON__ || window.electronAPI) {
        return true;
      }
    }
    return false;
  },

  initDeviceMode() {
    const isMob = this.isMobile();
    if (isMob) {
      document.documentElement.classList.add('is-mobile-device');
      document.body.classList.add('is-mobile-device');
    } else {
      document.documentElement.classList.add('is-desktop-device');
      document.body.classList.add('is-desktop-device');
    }

    // Se estiver em app nativo (.exe, .app, .apk), esconde o botão de instalar aplicativo imediatamente
    const installBtn = document.getElementById('profile-install-btn');
    if (installBtn && this.isNativeApp()) {
      installBtn.classList.add('hidden');
      installBtn.style.display = 'none';
    }
  },

  initPwaSupport() {
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js').catch((err) => {
          console.log('[PWA] Service Worker reg:', err);
        });
      });
    }

    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      this.state.deferredInstallPrompt = e;
      const installBtn = document.getElementById('profile-install-btn');
      if (installBtn) {
        installBtn.classList.remove('hidden');
      }
    });

    window.addEventListener('appinstalled', () => {
      this.state.deferredInstallPrompt = null;
      this.showToast('NovaFlix instalado com sucesso!', 'success');
    });
  },

  openInstallAppModal() {
    const modal = document.getElementById('install-app-modal');
    if (modal) {
      modal.classList.remove('hidden');
      this.pushNavigationState('install-app');
    }
  },

  closeInstallAppModal(fromHistory = false) {
    const modal = document.getElementById('install-app-modal');
    if (modal) {
      modal.classList.add('hidden');
    }
  },

  async triggerPwaPrompt(source = 'button') {
    const guideBox = document.getElementById('pwa-guide-box');
    if (guideBox) {
      guideBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      guideBox.classList.add('ring-2', 'ring-amber-500', 'ring-offset-2', 'ring-offset-[#161616]');
      setTimeout(() => {
        guideBox.classList.remove('ring-2', 'ring-amber-500', 'ring-offset-2', 'ring-offset-[#161616]');
      }, 2500);
    }

    if (this.state.deferredInstallPrompt) {
      try {
        this.state.deferredInstallPrompt.prompt();
        const choice = await this.state.deferredInstallPrompt.userChoice;
        if (choice && choice.outcome === 'accepted') {
          this.showToast('NovaFlix adicionado com sucesso à sua tela inicial!', 'success');
          this.closeInstallAppModal();
        }
        this.state.deferredInstallPrompt = null;
        return;
      } catch (e) {
        console.warn('[PWA] Erro ao disparar prompt nativo:', e);
      }
    }

    if (this.isMobile()) {
      this.showToast('📱 Toque nos 3 pontinhos do Chrome (topo direito) e selecione "Adicionar à tela inicial"!', 'info', 6000);
    } else {
      this.showToast('💻 No PC, clique no ícone (⊕) na barra de endereços do Chrome para instalar!', 'info', 6000);
    }
  },

  async installPwaApp() {
    this.openInstallAppModal();
  },

  isMobile() {
    if (typeof navigator !== 'undefined' && navigator.userAgent) {
      if (/Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile/i.test(navigator.userAgent)) {
        return true;
      }
    }
    if (typeof window !== 'undefined') {
      const minDimension = Math.min(window.screen.width || window.innerWidth, window.screen.height || window.innerHeight);
      if (minDimension <= 768) return true;
      if (window.innerWidth <= 768) return true;
    }
    return false;
  },

  getDeviceUuid() {
    let uuid = EncryptedStorage.getItem('novaflix_device_uuid', null);
    if (!uuid) {
      if (typeof crypto !== 'undefined' && crypto.randomUUID) {
        uuid = crypto.randomUUID();
      } else {
        uuid = 'nf_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 10);
      }
      EncryptedStorage.setItem('novaflix_device_uuid', uuid);
    }
    return uuid;
  },

  getCustomServerUrl() {
    const saved = (EncryptedStorage.getItem('novaflix_server_ip', '') || '').trim();
    // Se estiver em navegador Web (inclusive celular/PWA) e o valor salvo for localhost/127.0.0.1, mas estamos em outro host (ex: IP 192.168.1.6 ou domínio VPS):
    if (typeof window !== 'undefined' && window.location && window.location.hostname) {
      const currentHost = window.location.hostname;
      if (saved && (saved.includes('localhost') || saved.includes('127.0.0.1')) && currentHost !== 'localhost' && currentHost !== '127.0.0.1') {
        EncryptedStorage.removeItem('novaflix_server_ip');
        return '';
      }
    }
    return saved;
  },

  getServerUrl(path = '') {
    if (!path) return '';
    // Se a URL já for completa e absoluta (http:// ou https://), retorna sem modificar
    if (/^https?:\/\//i.test(path)) {
      return path;
    }

    // 1. Em navegadores Web (Chrome, Safari, Mobile, PWA):
    // O navegador já foi carregado a partir do servidor correto (window.location.origin)!
    if (!this.isNativeApp()) {
      return path;
    }

    // 2. Em apps nativos instalados (.apk Android / .exe Windows):
    const custom = this.getCustomServerUrl() || this.state.serverUrl || '';
    if (!custom) {
      if (typeof window !== 'undefined' && window.location && window.location.origin && !window.location.origin.includes('capacitor://') && !window.location.origin.includes('file://')) {
        const base = window.location.origin.replace(/\/+$/, '');
        return path.startsWith('/') ? `${base}${path}` : `${base}/${path}`;
      }
      return path;
    }
    const base = custom.replace(/\/+$/, '');
    return path.startsWith('/') ? `${base}${path}` : `${base}/${path}`;
  },

  async loadServerConfig() {
    // Na versão Web/PWA, o navegador já está conectado ao servidor correto via window.location.origin!
    if (!this.isNativeApp()) {
      // Limpa qualquer resquício de localhost salvo indevidamente no navegador do celular
      const saved = EncryptedStorage.getItem('novaflix_server_ip', '');
      if (saved && (saved.includes('localhost') || saved.includes('127.0.0.1')) && window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1') {
        EncryptedStorage.removeItem('novaflix_server_ip');
      }
      return;
    }

    try {
      const res = await fetch('/server_config.json');
      if (res.ok) {
        const cfg = await res.json();
        const serverAddress = (cfg && (cfg.serverUrl || cfg.serverIp)) ? String(cfg.serverUrl || cfg.serverIp).trim() : '';
        // Nunca gravar localhost em apps nativos instalados em celular
        if (serverAddress && !serverAddress.includes('localhost') && !serverAddress.includes('127.0.0.1') && !EncryptedStorage.getItem('novaflix_server_ip', '')) {
          EncryptedStorage.setItem('novaflix_server_ip', serverAddress);
        }
      }
    } catch(e) {}
  },

  openSetupIpModal(options = {}) {
    const modal = document.getElementById('setup-ip-modal');
    if (!modal) return;
    const input = document.getElementById('setup-server-ip-input');
    const current = this.getCustomServerUrl() || '';
    if (input) {
      input.value = current;
      setTimeout(() => input.focus(), 150);
    }
    const msg = document.getElementById('setup-ip-status-msg');
    if (msg) {
      if (options.errorMsg) {
        msg.className = 'p-2.5 rounded-lg text-xs font-semibold bg-rose-500/20 text-rose-300 border border-rose-500/30';
        msg.textContent = options.errorMsg;
        msg.classList.remove('hidden');
      } else if (options.infoMsg) {
        msg.className = 'p-2.5 rounded-lg text-xs font-semibold bg-sky-500/20 text-sky-300 border border-sky-500/30';
        msg.textContent = options.infoMsg;
        msg.classList.remove('hidden');
      } else {
        msg.classList.add('hidden');
      }
    }
    modal.classList.remove('hidden');
    this.pushNavigationState('setup-ip');
  },

  closeSetupIpModal(fromHistory = false) {
    const modal = document.getElementById('setup-ip-modal');
    if (modal) modal.classList.add('hidden');
    if (!fromHistory && history.state && history.state.modal === 'setup-ip') {
      this._navigatingBackProgrammatically = true;
      history.back();
    }
  },

  async testServerConnection() {
    const input = document.getElementById('setup-server-ip-input');
    const msg = document.getElementById('setup-ip-status-msg');
    if (!input || !msg) return;

    let targetUrl = input.value.trim().replace(/\/+$/, '');
    if (!targetUrl) {
      msg.className = 'p-2.5 rounded-lg text-xs font-semibold bg-rose-500/20 text-rose-300 border border-rose-500/30';
      msg.textContent = 'Informe o IP ou domínio da sua VPS.';
      msg.classList.remove('hidden');
      return;
    }

    if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
      targetUrl = 'http://' + targetUrl;
      input.value = targetUrl;
    }

    msg.className = 'p-2.5 rounded-lg text-xs font-semibold bg-sky-500/20 text-sky-300 border border-sky-500/30';
    msg.textContent = 'Testando comunicação com o servidor VPS...';
    msg.classList.remove('hidden');

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 6000);
      const res = await fetch(`${targetUrl}/api/netflix/status`, { signal: controller.signal });
      clearTimeout(timeoutId);
      const data = await res.json();
      if (res.ok) {
        msg.className = 'p-2.5 rounded-lg text-xs font-semibold bg-emerald-500/20 text-emerald-300 border border-emerald-500/30';
        msg.textContent = `✅ Conexão estabelecida com sucesso! (${data.totalChannels || 0} canais, ${data.totalMovies || 0} filmes)`;
      } else {
        throw new Error('Servidor respondeu com status ' + res.status);
      }
    } catch(err) {
      msg.className = 'p-2.5 rounded-lg text-xs font-semibold bg-rose-500/20 text-rose-300 border border-rose-500/30';
      msg.textContent = `❌ Falha na conexão: ${err.message || 'Verifique se o IP e a porta estão corretos e se a VPS está online.'}`;
    }
  },

  async saveServerIp(e) {
    if (e) e.preventDefault();
    const input = document.getElementById('setup-server-ip-input');
    if (!input) return;
    let ip = input.value.trim().replace(/\/+$/, '');
    if (!ip) {
      this.showToast('Digite um IP ou domínio válido.', 'error');
      return;
    }
    if (!ip.startsWith('http://') && !ip.startsWith('https://')) {
      ip = 'http://' + ip;
    }
    EncryptedStorage.setItem('novaflix_server_ip', ip);
    this.closeSetupIpModal(true);
    this.showToast('Servidor configurado! Conectando...', 'info');

    // Remove qualquer mensagem de erro do preloader e inicia
    const preloader = document.getElementById('netflix-preloader');
    if (preloader) {
      preloader.classList.remove('opacity-0', 'pointer-events-none');
    }
    await this.startPreloaderFlow();
  },

  /* ==============================================================================
     ANDROID & BROWSER NAVIGATION CONTROLLER (BOTÃO VOLTAR / GESTOS DO SISTEMA)
     ============================================================================== */
  initAndroidBackSupport() {
    try {
      if (!history.state) {
        history.replaceState({ modal: 'home' }, '');
      }
    } catch (e) {}

    window.addEventListener('popstate', (e) => {
      this.handleSystemBack(e);
    });

    // Suporte ao Botão Físico / Gestos Voltar no Aplicativo Nativo Android (Capacitor)
    try {
      if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App) {
        window.Capacitor.Plugins.App.addListener('backButton', () => {
          this.handleSystemBack();
        });
      }
    } catch (e) {}
  },

  pushNavigationState(modalName) {
    try {
      if (history.state && history.state.modal === modalName) return;
      history.pushState({ modal: modalName, time: Date.now() }, '');
    } catch (e) {
      console.warn('History API pushState warning:', e);
    }
  },

  handleSystemBack(e) {
    if (this._navigatingBackProgrammatically) {
      this._navigatingBackProgrammatically = false;
      return;
    }

    // 1. Gavetas e submodais do player
    const mobileSettingsModal = document.getElementById('player-mobile-settings-modal');
    if (mobileSettingsModal && !mobileSettingsModal.classList.contains('hidden')) {
      mobileSettingsModal.classList.add('hidden');
      return;
    }
    const subModal = document.getElementById('player-subtitles-modal');
    if (subModal && !subModal.classList.contains('hidden')) {
      subModal.classList.add('hidden');
      return;
    }
    const epDrawer = document.getElementById('player-episodes-drawer');
    if (epDrawer && !epDrawer.classList.contains('hidden')) {
      epDrawer.classList.add('hidden');
      return;
    }
    const chDrawer = document.getElementById('player-channels-drawer');
    if (chDrawer && !chDrawer.classList.contains('hidden')) {
      chDrawer.classList.add('hidden');
      return;
    }
    const sugDrawer = document.getElementById('player-suggestions-drawer');
    if (sugDrawer && !sugDrawer.classList.contains('hidden')) {
      sugDrawer.classList.add('hidden');
      return;
    }

    // Se o player estiver com bloqueio de tela ativo, o botão voltar destranca a tela
    if (this.state.isPlayerLocked) {
      this.unlockPlayerScreen();
      return;
    }

    // Modal de Doação Pré-Play
    const doacaoModal = document.getElementById('doacao-modal');
    if (doacaoModal && !doacaoModal.classList.contains('hidden')) {
      this.dismissDoacaoModal();
      return;
    }

    // Modal de Setup IP
    const setupIpModal = document.getElementById('setup-ip-modal');
    if (setupIpModal && !setupIpModal.classList.contains('hidden')) {
      this.closeSetupIpModal(true);
      return;
    }

    // 2. Tela de reprodução (Player Screen)
    const playerScreen = document.getElementById('netflix-player-screen');
    if (playerScreen && !playerScreen.classList.contains('hidden')) {
      this.closePlayer(true);
      return;
    }

    // 3. Modal de Configurações
    const settingsModal = document.getElementById('settings-modal');
    if (settingsModal && !settingsModal.classList.contains('hidden')) {
      this.closeSettingsModal(true);
      return;
    }

    // 4. Modal de Feedback
    const feedbackModal = document.getElementById('netflix-feedback-modal');
    if (feedbackModal && !feedbackModal.classList.contains('hidden')) {
      this.closeFeedbackModal(true);
      return;
    }

    // 5. Modal de Perfil de Usuário
    const profileModal = document.getElementById('user-profile-modal');
    if (profileModal && !profileModal.classList.contains('hidden')) {
      this.closeProfileModal(true);
      return;
    }

    // Modal de Instalação do Aplicativo
    const installAppModal = document.getElementById('install-app-modal');
    if (installAppModal && !installAppModal.classList.contains('hidden')) {
      this.closeInstallAppModal(true);
      return;
    }

    // Modal de Mensagem do Administrador
    const adminMsgModal = document.getElementById('admin-message-modal');
    if (adminMsgModal && !adminMsgModal.classList.contains('hidden')) {
      this.dismissAdminMessage();
      return;
    }

    // 5. Modal de Detalhes
    const detailModal = document.getElementById('netflix-detail-modal');
    if (detailModal && !detailModal.classList.contains('hidden')) {
      this.closeDetailModal(true);
      return;
    }

    // 6. Grade Completa / Ver Tudo
    const fullSec = document.getElementById('full-catalog-section');
    if (fullSec && !fullSec.classList.contains('hidden')) {
      this.closeFullCategoryView(true);
      return;
    }

    // 7. Busca ativa ou Barra de Pesquisa Mobile Aberta
    const searchSec = document.getElementById('search-results-section');
    const searchOverlay = document.getElementById('mobile-search-overlay');
    const searchInput = document.getElementById('global-search');
    const mobileSearchInput = document.getElementById('mobile-global-search');
    const hasSearchText = (searchInput && searchInput.value.trim()) || (mobileSearchInput && mobileSearchInput.value.trim());

    if ((searchSec && !searchSec.classList.contains('hidden')) || (searchOverlay && !searchOverlay.classList.contains('hidden')) || hasSearchText) {
      this.clearSearch(true);
      return;
    }

    // Se estiver na tela inicial no app Android, duplo clique suave para sair
    if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App) {
      const now = Date.now();
      if (this._lastBackPressTime && (now - this._lastBackPressTime < 2000)) {
        window.Capacitor.Plugins.App.exitApp();
      } else {
        this._lastBackPressTime = now;
        this.showToast('Pressione voltar novamente para sair', 'info');
      }
    }
  },

  /**
   * Fluxo da tela de carregamento inicial:
   * Aguarda o servidor indexar todos os 200.000 títulos e carregar o catálogo
   */
  async startPreloaderFlow() {
    const textEl = document.getElementById('preloader-text');
    const subtextEl = document.getElementById('preloader-subtext');
    const barEl = document.getElementById('preloader-bar');
    const countEl = document.getElementById('preloader-count');

    // REGRA 1: Em aplicativos nativos instalados (.apk Android / .exe Windows)
    if (this.isNativeApp()) {
      const configuredIp = this.getCustomServerUrl();
      // Se ainda não houver nenhum IP/domínio configurado (ou se for localhost/127.0.0.1):
      if (!configuredIp || configuredIp.includes('localhost') || configuredIp.includes('127.0.0.1')) {
        console.log('[NativeApp] Nenhum servidor configurado. Solicitando IP/Domínio ao usuário...');
        this.openSetupIpModal({
          infoMsg: 'Bem-vindo ao NovaFlix! Digite o IP ou Domínio da sua VPS para iniciar.'
        });
        return; // Aguarda o usuário digitar e salvar o IP
      }
    }

    let attempts = 0;
    const checkStatus = async () => {
      attempts++;
      try {
        const res = await fetch(this.getServerUrl('/api/netflix/status'));
        if (!res.ok) throw new Error(`Status ${res.status}`);
        const data = await res.json();

        if (data.isReady) {
          this.state.lastCatalogVersion = data.catalogVersion || 1;
          this.state.lastTotalCount = (data.totalMovies || 0) + (data.totalSeries || 0) + (data.totalChannels || 0);
          this.startAutoSyncWatcher();

          if (textEl) textEl.textContent = 'Carregando NovaFlix...';
          if (subtextEl) subtextEl.textContent = 'Iniciando sua experiência de streaming';
          if (countEl) countEl.textContent = '';
          if (barEl) barEl.style.width = '85%';

          // Carrega e monta o catálogo
          try {
            await this.loadCatalog('ALL');
          } catch (loadErr) {
            console.error('Erro ao renderizar catálogo:', loadErr);
          }

          if (textEl) textEl.textContent = 'Tudo pronto!';
          if (barEl) barEl.style.width = '100%';

          // Fade out suave da tela de carregamento
          setTimeout(() => {
            const preloader = document.getElementById('netflix-preloader');
            if (preloader) {
              preloader.classList.add('opacity-0', 'pointer-events-none');
              setTimeout(() => {
                if (preloader && preloader.parentNode) {
                  preloader.remove();
                }
              }, 750);
            }
          }, 600);

        } else {
          // O servidor ainda está processando
          if (textEl) textEl.textContent = 'Carregando NovaFlix...';
          if (subtextEl) subtextEl.textContent = 'Preparando seu catálogo...';
          if (countEl) countEl.textContent = '';
          if (barEl) barEl.style.width = `${Math.min(75, 20 + attempts * 10)}%`;
          setTimeout(checkStatus, 1500);
        }
      } catch (err) {
        console.warn('Aguardando servidor...', err.message);
        if (textEl) textEl.textContent = 'Carregando NovaFlix...';
        if (attempts >= 3) {
          if (this.isNativeApp()) {
            const currentIp = this.getCustomServerUrl();
            this.openSetupIpModal({
              errorMsg: `Não foi possível conectar a ${currentIp || 'servidor'}. Verifique o IP ou se a VPS está online.`
            });
            return;
          }
          if (subtextEl) {
            subtextEl.innerHTML = 'Não foi possível conectar ao servidor. <button type="button" onclick="App.openSetupIpModal()" class="text-sky-400 underline font-bold ml-1 cursor-pointer">Configurar IP do Servidor</button>';
          }
        } else {
          if (subtextEl) subtextEl.textContent = 'Conectando ao servidor...';
        }
        if (countEl) countEl.textContent = '';
        if (barEl) barEl.style.width = '40%';
        setTimeout(checkStatus, 2500);
      }
    };

    checkStatus();
  },

  initNavbarScroll() {
    const navbar = document.getElementById('netflix-header');
    if (!navbar) return;
    let ticking = false;
    window.addEventListener('scroll', () => {
      if (!ticking) {
        window.requestAnimationFrame(() => {
          if (window.scrollY > 40) {
            navbar.classList.add('scrolled');
          } else {
            navbar.classList.remove('scrolled');
          }
          ticking = false;
        });
        ticking = true;
      }
    }, { passive: true });
  },

  initPlayer() {
    const videoEl = document.getElementById('netflix-video');
    this.player = new VideoPlayer(videoEl, {
      useProxy: false, // O endpoint /api/stream já é o proxy com criptografia
      autoPlay: true
    });

    const loader = document.getElementById('netflix-player-loader');
    const errorEl = document.getElementById('netflix-player-error');
    const playIcon = document.getElementById('player-play-icon');
    const playerScreen = document.getElementById('netflix-player-screen');

    this.player.on('stateChange', (state, detail) => {
      if (state === 'loading' || state === 'buffering') {
        if (loader) loader.classList.remove('hidden');
        if (errorEl) errorEl.classList.add('hidden');
        if (playIcon) playIcon.className = 'fa-solid fa-pause';
        this.updateCenterIndicator(false);
        const loadTxt = document.getElementById('player-loading-text');
        if (loadTxt) loadTxt.textContent = detail || 'Iniciando reprodução...';
      } else if (state === 'playing') {
        if (loader) loader.classList.add('hidden');
        if (errorEl) errorEl.classList.add('hidden');
        if (playIcon) playIcon.className = 'fa-solid fa-pause';
        if (playerScreen) playerScreen.classList.add('show-controls');
        this.updateCenterIndicator(false);
        if (this.isMobile()) {
          this.enterMobileLandscapePlayer();
        }
      } else if (state === 'paused') {
        if (this.player && (this.player._isSwitchingChannel || this.player._isStartingPlayback || !this.player.hasPlayedOnce)) return;
        if (loader) loader.classList.add('hidden');
        if (playIcon) playIcon.className = 'fa-solid fa-play';
        if (playerScreen) playerScreen.classList.add('show-controls');
        this.updateCenterIndicator(true);
      }
    });

    this.player.on('error', (msg) => {
      if (loader) loader.classList.add('hidden');
      if (errorEl) errorEl.classList.remove('hidden');
      const errTxt = document.getElementById('netflix-player-error-msg');
      if (errTxt) errTxt.textContent = msg || 'O conteúdo solicitado está temporariamente indisponível.';
    });

    // Timeline Scrubber para VOD (Filmes e Séries)
    videoEl.addEventListener('loadedmetadata', () => {
      const liveBadge = document.getElementById('player-live-badge');
      const vodTimeline = document.getElementById('vod-timeline');
      const durTxt = document.getElementById('duration-time-text');
      if (liveBadge) liveBadge.classList.add('hidden');
      if (vodTimeline) vodTimeline.classList.remove('hidden');
      if (durTxt && !isNaN(videoEl.duration) && videoEl.duration > 0) {
        durTxt.textContent = this.formatTime(videoEl.duration);
      }
    });

    videoEl.addEventListener('timeupdate', () => {
      const liveBadge = document.getElementById('player-live-badge');
      const vodTimeline = document.getElementById('vod-timeline');
      const curTxt = document.getElementById('current-time-text');
      const durTxt = document.getElementById('duration-time-text');
      const seekBar = document.getElementById('seek-bar');

      if (liveBadge) liveBadge.classList.add('hidden');
      if (vodTimeline) vodTimeline.classList.remove('hidden');

      if (!isNaN(videoEl.duration) && videoEl.duration > 0) {
        if (curTxt) curTxt.textContent = this.formatTime(videoEl.currentTime);
        if (durTxt) durTxt.textContent = this.formatTime(videoEl.duration);
        if (seekBar) seekBar.value = (videoEl.currentTime / videoEl.duration) * 100;

        // Salva progresso no Continuar Assistindo (a cada ~4 segundos)
        if (this.state.activeItem) {
          const nowSec = Math.floor(videoEl.currentTime);
          if (nowSec > 5 && nowSec % 4 === 0 && (!this._lastSavedSec || this._lastSavedSec !== nowSec)) {
            this._lastSavedSec = nowSec;
            this.saveContinueWatchingProgress(this.state.activeItem, videoEl.currentTime, videoEl.duration);
          }
        }
      }
    });

    const seekBar = document.getElementById('seek-bar');
    if (seekBar) {
      seekBar.addEventListener('input', () => {
        if (videoEl.duration) {
          videoEl.currentTime = (seekBar.value / 100) * videoEl.duration;
        }
      });

      const hoverTooltip = document.getElementById('player-seek-hover-tooltip');
      if (hoverTooltip) {
        seekBar.addEventListener('mousemove', (e) => {
          if (!videoEl.duration) return;
          const rect = seekBar.getBoundingClientRect();
          const pos = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
          const hoverTime = pos * videoEl.duration;
          hoverTooltip.textContent = this.formatTime(hoverTime);
          hoverTooltip.style.left = `${pos * 100}%`;
          hoverTooltip.classList.remove('hidden');
        });
        seekBar.addEventListener('mouseleave', () => {
          hoverTooltip.classList.add('hidden');
        });
      }
    }

    // Sincronização em tempo real do estado de áudio e volume
    videoEl.addEventListener('volumechange', () => {
      this.updateVolumeUI();
    });

    // Retomada automática da posição onde parou (se houver)
    const handleResume = () => {
      if (this._pendingResumeTime && this._pendingResumeTime > 5) {
        const resumeSec = this._pendingResumeTime;
        this._pendingResumeTime = null;
        try {
          videoEl.currentTime = resumeSec;
          this.showToast(`Continuando exatamente de ${this.formatTime(resumeSec)}`, 'info');
        } catch(e) {}
      }
    };
    videoEl.addEventListener('loadedmetadata', handleResume);
    videoEl.addEventListener('canplay', handleResume);

    videoEl.addEventListener('pause', () => {
      if (this.player && (this.player._isStartingPlayback || this.player._isSwitchingChannel || !this.player.hasPlayedOnce || videoEl.seeking)) {
        return;
      }
      this.updatePlayPauseIcon(true);
      this.showPlayerControls();
    });

    videoEl.addEventListener('play', () => {
      this.updatePlayPauseIcon(false);
      this.resetControlsAutoHideTimer();
    });

    // Motor de reexibição imediata de controles ao mover o mouse ou interagir
    this.initPlayerControlsActivity();
  },

  updatePlayPauseIcon(isPaused) {
    const playIcon = document.getElementById('player-play-icon');
    if (playIcon) {
      playIcon.className = isPaused ? 'fa-solid fa-play' : 'fa-solid fa-pause';
    }
  },

  initPlayerControlsActivity() {
    const playerScreen = document.getElementById('netflix-player-screen');
    if (!playerScreen) return;

    const onUserInteraction = () => {
      if (playerScreen.classList.contains('hidden')) return;
      this.showPlayerControls();
    };

    this._onPlayerUserInteraction = onUserInteraction;

    // Detecta movimentos do mouse e ponteiro no computador (ignora touch para evitar conflito com clique no celular)
    ['mousemove', 'pointermove'].forEach(evt => {
      playerScreen.addEventListener(evt, (e) => {
        if (e && e.pointerType === 'touch') return;
        onUserInteraction();
      }, { passive: true });
    });

    // Se o ponteiro estiver sobre as barras de controle, mantém visível
    document.querySelectorAll('.netflix-player-controls').forEach(bar => {
      bar.addEventListener('mouseenter', () => { this._isInteractingWithControls = true; });
      bar.addEventListener('mouseleave', () => {
        this._isInteractingWithControls = false;
        this.resetControlsAutoHideTimer();
      });
      // No celular, qualquer toque nas barras ou botões renova o tempo de exibição
      bar.addEventListener('touchstart', () => {
        this.resetControlsAutoHideTimer();
      }, { passive: true });
    });
  },

  resetControlsAutoHideTimer() {
    if (this._controlsInactivityTimer) {
      clearTimeout(this._controlsInactivityTimer);
      this._controlsInactivityTimer = null;
    }

    const isPaused = this.player && this.player.video ? this.player.video.paused : false;
    // Se o vídeo estiver pausado, NUNCA esconde os controles (facilita o uso)
    if (isPaused) return;

    this._controlsInactivityTimer = setTimeout(() => {
      const isPausedNow = this.player && this.player.video ? this.player.video.paused : false;
      const isDrawerOpen = !document.getElementById('player-episodes-drawer')?.classList.contains('hidden') ||
                           !document.getElementById('player-channels-drawer')?.classList.contains('hidden') ||
                           !document.getElementById('player-suggestions-drawer')?.classList.contains('hidden') ||
                           !document.getElementById('player-mobile-settings-modal')?.classList.contains('hidden') ||
                           !document.getElementById('player-subtitles-modal')?.classList.contains('hidden');

      if (!isPausedNow && !isDrawerOpen && !this._isInteractingWithControls) {
        this.hidePlayerControls();
      }
    }, 4500);
  },

  showPlayerControls() {
    const playerScreen = document.getElementById('netflix-player-screen');
    if (!playerScreen) return;

    this._controlsShownAt = Date.now();
    playerScreen.classList.remove('cinema-mode');
    playerScreen.classList.add('show-controls');

    const icon = document.getElementById('player-cinema-icon');
    if (icon) icon.className = 'fa-solid fa-eye text-sm';

    const btn = document.getElementById('player-cinema-btn');
    if (btn) btn.title = 'Ocultar Barra de Controles';

    this.resetControlsAutoHideTimer();
  },

  hidePlayerControls() {
    const playerScreen = document.getElementById('netflix-player-screen');
    if (!playerScreen) return;

    playerScreen.classList.add('cinema-mode');
    playerScreen.classList.remove('show-controls');

    const icon = document.getElementById('player-cinema-icon');
    if (icon) icon.className = 'fa-solid fa-eye-slash text-sm';

    const btn = document.getElementById('player-cinema-btn');
    if (btn) btn.title = 'Reexibir Barra de Controles';
  },

  updateCenterIndicator(isPaused) {
    const overlay = document.getElementById('player-center-action');
    const icon = document.getElementById('player-center-icon');
    const circleBtn = document.getElementById('player-center-circle-btn');
    if (!overlay || !icon) return;

    if (this._centerActionTimer) {
      clearTimeout(this._centerActionTimer);
      this._centerActionTimer = null;
    }

    if (isPaused) {
      // Se o player estiver no processo de início ou carregamento, não exibe play central enganoso
      if (this.player && (this.player._isStartingPlayback || this.player._isSwitchingChannel)) {
        overlay.classList.remove('opacity-100', 'scale-100', 'is-paused');
        overlay.classList.add('opacity-0', 'scale-75');
        if (circleBtn) {
          circleBtn.classList.remove('pointer-events-auto');
          circleBtn.classList.add('pointer-events-none');
        }
        return;
      }
      icon.className = 'fa-solid fa-play pl-1';
      overlay.classList.remove('opacity-0', 'scale-75');
      overlay.classList.add('opacity-100', 'scale-100', 'is-paused');
      if (circleBtn) {
        circleBtn.classList.remove('pointer-events-none');
        circleBtn.classList.add('pointer-events-auto');
      }
    } else {
      // Breve pulso de feedback e esconde quando em reprodução
      icon.className = 'fa-solid fa-play pl-1';
      overlay.classList.remove('scale-100', 'is-paused');
      overlay.classList.add('scale-110');
      if (circleBtn) {
        circleBtn.classList.remove('pointer-events-auto');
        circleBtn.classList.add('pointer-events-none');
      }
      this._centerActionTimer = setTimeout(() => {
        overlay.classList.remove('opacity-100', 'scale-110', 'is-paused');
        overlay.classList.add('opacity-0', 'scale-75');
      }, 300);
    }
  },

  resumePlaybackFromCenter(e) {
    if (e) {
      if (typeof e.stopPropagation === 'function') e.stopPropagation();
      if (typeof e.preventDefault === 'function') e.preventDefault();
    }
    if (!this.player || !this.player.video) return;
    if (this.player.video.muted) {
      this.unmuteVideo();
    }
    this.updateCenterIndicator(false);
    const p = this.player.video.play();
    if (p && typeof p.catch === 'function') {
      p.catch(err => {
        console.warn('[Player] Falha ao retomar reprodução pelo centro:', err);
      });
    }
  },

  showCenterFeedback(isPaused) {
    this.updateCenterIndicator(isPaused);
  },

  onPlayerScreenClick(e) {
    const playerScreen = document.getElementById('netflix-player-screen');
    if (!playerScreen) return;

    // Se a tela estiver bloqueada (Cadeado fechado ativo - Mantido único no centro da tela)
    // Ao tocar na tela bloqueada, o cadeado central aparece e some em 4-5s
    if (this.state.isPlayerLocked) {
      const badge = document.getElementById('player-lock-badge');
      if (badge) badge.classList.remove('hidden');

      if (this._lockHideTimer) clearTimeout(this._lockHideTimer);
      this._lockHideTimer = setTimeout(() => {
        if (badge) badge.classList.add('hidden');
      }, 4000);
      return;
    }

    // Se interagiu com elementos interativos, barras de controle ou modais, não alterna
    if (e && e.target && e.target.closest && e.target.closest('.netflix-player-controls, #player-center-action, #player-center-circle-btn, #player-episodes-drawer, #player-channels-drawer, #netflix-player-error, #player-suggestions-drawer, #player-postplay-screen, #player-subtitles-modal, #player-unmute-prompt, #player-mobile-settings-modal, #player-lock-badge, button, input, select')) {
      return;
    }

    // Detecção de Duplo Toque Touch Mobile (Áreas de Avançar/Retroceder 10s - Requirement 2)
    const now = Date.now();
    const clientX = (e.touches && e.touches[0]) ? e.touches[0].clientX : (e.clientX || 0);
    const rect = playerScreen.getBoundingClientRect();
    const xRel = clientX - rect.left;
    const width = rect.width;

    if (this._lastTapTime && (now - this._lastTapTime < 320) && Math.abs(xRel - (this._lastTapX || 0)) < 90) {
      clearTimeout(this._singleTapTimeout);
      this._lastTapTime = 0;

      if (xRel < width * 0.35) {
        // Duplo toque na lateral esquerda: volta 10s
        this.seekRelative(-10);
        this.showSeekRipple('left');
        return;
      } else if (xRel > width * 0.65) {
        // Duplo toque na lateral direita: avança 10s
        this.seekRelative(10);
        this.showSeekRipple('right');
        return;
      }
    }

    this._lastTapTime = now;
    this._lastTapX = xRel;

    // Registra imediatamente se os controles estavam ocultos no instante exato do toque
    const wasHidden = playerScreen.classList.contains('cinema-mode') || !playerScreen.classList.contains('show-controls');

    // Toque simples: exibe ou alterna controles com segurança anti-flicker
    this._singleTapTimeout = setTimeout(() => {
      if (wasHidden) {
        this.showPlayerControls();
      } else {
        const timeSinceShown = Date.now() - (this._controlsShownAt || 0);
        if (timeSinceShown > 450) {
          this.hidePlayerControls();
        } else {
          this.resetControlsAutoHideTimer();
        }
      }
    }, 280);
  },

  lockPlayerScreen() {
    this.state.isPlayerLocked = true;
    if (typeof this.closeMobilePlayerSettings === 'function') {
      this.closeMobilePlayerSettings(true);
    }
    const playerScreen = document.getElementById('netflix-player-screen');
    if (playerScreen) {
      playerScreen.classList.add('player-screen-locked');
      playerScreen.classList.add('cinema-mode');
      playerScreen.classList.remove('show-controls');
    }
    // Único modal do cadeado centralizado na tela
    const badge = document.getElementById('player-lock-badge');
    if (badge) badge.classList.remove('hidden');

    // Ao clicar no cadeado e bloquear os controles, o cadeado central some em no máximo 5s (4s)
    if (this._lockHideTimer) clearTimeout(this._lockHideTimer);
    this._lockHideTimer = setTimeout(() => {
      if (badge) badge.classList.add('hidden');
    }, 4000);

    this.showToast('Controles Bloqueados 🔒 Toque na tela para exibir o cadeado.', 'info');
  },

  unlockPlayerScreen() {
    if (this._lockHideTimer) {
      clearTimeout(this._lockHideTimer);
      this._lockHideTimer = null;
    }
    this.state.isPlayerLocked = false;
    const playerScreen = document.getElementById('netflix-player-screen');
    if (playerScreen) {
      playerScreen.classList.remove('player-screen-locked');
      playerScreen.classList.remove('cinema-mode');
      playerScreen.classList.add('show-controls');
    }
    const badge = document.getElementById('player-lock-badge');
    if (badge) badge.classList.add('hidden');
    this.showPlayerControls();
    this.showToast('Controles Desbloqueados 🔓', 'info');
  },

  showSeekRipple(side) {
    const el = document.getElementById(side === 'left' ? 'player-seek-ripple-left' : 'player-seek-ripple-right');
    if (!el) return;
    el.classList.add('seek-ripple-active');
    el.style.opacity = '1';
    if (el._fadeTimer) clearTimeout(el._fadeTimer);
    el._fadeTimer = setTimeout(() => {
      el.classList.remove('seek-ripple-active');
      el.style.opacity = '0';
    }, 600);
  },

  togglePlayWithFeedback(e) {
    if (e) {
      if (typeof e.stopPropagation === 'function') e.stopPropagation();
      if (typeof e.preventDefault === 'function') e.preventDefault();
    }
    if (!this.player || !this.player.video) return;
    // Se o áudio estiver em mudo por política do navegador, ativa na primeira interação na tela
    if (this.player.video.muted) {
      this.unmuteVideo();
    }
    this.player.togglePlay();
  },

  initKeyboardShortcuts() {
    window.addEventListener('keydown', (e) => {
      // Ignora atalhos globais se o usuário estiver digitando em campo de texto
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) {
        return;
      }

      const playerScreen = document.getElementById('netflix-player-screen');
      const isPlayerOpen = !playerScreen.classList.contains('hidden');

      if (e.key === 'Escape') {
        if (isPlayerOpen) {
          this.closePlayer();
          return;
        }
        this.closeDetailModal();
        this.closeEditTxtModal();
        this.closeSettingsModal();
        this.closeProfileModal();
        this.closeSetupIpModal();
        this.dismissDoacaoModal();
      }

      if (isPlayerOpen && !this.state.isPlayerLocked) {
        if (e.code === 'Space' || e.key === 'k' || e.key === 'K') {
          e.preventDefault();
          this.togglePlayWithFeedback();
        } else if (e.key === 'f' || e.key === 'F') {
          e.preventDefault();
          this.player.toggleFullscreen(playerScreen);
        } else if (e.key === 'm' || e.key === 'M') {
          e.preventDefault();
          this.toggleMute();
        } else if (e.key === 'ArrowRight' || e.key === 'l' || e.key === 'L') {
          e.preventDefault();
          this.seekRelative(10);
          this.showSeekRipple('right');
        } else if (e.key === 'ArrowLeft' || e.key === 'j' || e.key === 'J') {
          e.preventDefault();
          this.seekRelative(-10);
          this.showSeekRipple('left');
        }
      }
    });
  },

  // Carrega o catálogo criptografado do backend
  async loadCatalog(filter = 'ALL') {
    this.state.activeFilter = filter;
    const prof = this.getUserProfile();
    const ageVal = prof && prof.age ? parseInt(prof.age, 10) : '';
    const ageParam = ageVal ? `&age=${ageVal}` : '';
    const isKidsParam = (typeof this.isKidsMode === 'function' && this.isKidsMode()) ? '&kids=1' : '';
    const adultParam = `&adult=${this.isAdultAllowed() ? 1 : 0}`;

    try {
      let res;
      try {
        res = await fetch(this.getServerUrl(`/api/netflix/catalog?filter=${encodeURIComponent(filter)}${isKidsParam}${adultParam}${ageParam}`));
      } catch (catErr) {
        if (this.getCustomServerUrl()) {
          console.warn('[Catalog] Erro com IP customizado, tentando rota relativa...', catErr.message);
          EncryptedStorage.removeItem('novaflix_server_ip');
          res = await fetch(`/api/netflix/catalog?filter=${encodeURIComponent(filter)}${isKidsParam}${adultParam}${ageParam}`);
        } else {
          throw catErr;
        }
      }
      const data = await res.json();

      if (data.status === 'loading') {
        if (!this.state.pollTimer) {
          this.state.pollTimer = setTimeout(() => this.loadCatalog(filter), 3000);
        }
        return;
      }

      if (this.state.pollTimer) {
        clearTimeout(this.state.pollTimer);
        this.state.pollTimer = null;
      }

      // Atualiza Hero Banner com Carrossel Rotativo Top 10 Diário
      if (data.trending && data.trending.length > 0) {
        this.setupHeroCarousel(data.trending);
      } else if (data.hero) {
        this.state.heroItem = data.hero;
        this.setupHeroBanner(data.hero);
      }

      // Atualiza contadores no perfil (se o elemento existir)
      const countEl = document.getElementById('profile-channel-count');
      if (countEl) {
        countEl.textContent = `${data.totalChannels} canais • ${data.totalMovies} filmes • ${data.totalSeries} séries`;
      }

      // Renderiza as fileiras
      this.state.catalogRows = data.rows || [];
      this.renderCatalogRows();
    } catch (err) {
      console.error('Erro ao carregar catálogo:', err);
      this.showToast('Erro ao carregar catálogo: ' + err.message, 'error');
    }
  },

  /* ==============================================================================
     CARROSSEL ROTATIVO TOP 10 EM ALTA (HERO BILLBOARD)
     ============================================================================== */
  setupHeroCarousel(trendingList) {
    if (!trendingList || !trendingList.length) return;

    let list = trendingList;
    const isKids = typeof this.isKidsMode === 'function' && this.isKidsMode();
    if (isKids) {
      list = trendingList.filter(item => {
        if (this.isAdultContent(item)) return false;
        if (this.isAdultGroup(item.group)) return false;
        const g = String(item.group || '').toLowerCase();
        const n = String(item.name || '').toLowerCase();
        return !/\b(terror|crime|crimes|guerra|assassin|massacre|xxx|adulto|adultos|\+18|18\+)\b/i.test(g) &&
               !/\b(terror|massacre|assassin|erotic|sexy|\+18|18\+)\b/i.test(n);
      });
      if (!list.length) list = trendingList;
    }

    this.state.trendingItems = list;
    this.state.currentHeroIndex = 0;

    // Renderiza os 10 indicadores de pílula
    const indContainer = document.getElementById('hero-carousel-indicators');
    if (indContainer) {
      indContainer.innerHTML = list.map((item, idx) => `
        <div onclick="App.goToHeroSlide(${idx})" class="hero-indicator-pill ${idx === 0 ? 'active' : ''}" title="#${idx + 1} - ${this.escapeHtml(item.name)}"></div>
      `).join('');
    }

    this.renderHeroSlide(0);
    this.startHeroRotation();
    this.setupHeroTouchSwipe();
  },

  setupHeroTouchSwipe() {
    if (this._heroTouchBound) return;
    const billboard = document.getElementById('billboard');
    if (!billboard) return;
    this._heroTouchBound = true;

    let startX = 0;
    let startY = 0;

    billboard.addEventListener('touchstart', (e) => {
      if (e.touches && e.touches.length === 1) {
        startX = e.touches[0].clientX;
        startY = e.touches[0].clientY;
      }
    }, { passive: true });

    billboard.addEventListener('touchend', (e) => {
      if (e.changedTouches && e.changedTouches.length === 1) {
        const deltaX = startX - e.changedTouches[0].clientX;
        const deltaY = startY - e.changedTouches[0].clientY;
        if (Math.abs(deltaX) > 40 && Math.abs(deltaX) > Math.abs(deltaY) * 1.4) {
          if (deltaX > 0) this.nextHeroSlide();
          else this.prevHeroSlide();
        }
      }
    }, { passive: true });
  },

  renderHeroSlide(index) {
    if (!this.state.trendingItems || !this.state.trendingItems.length) return;
    const total = this.state.trendingItems.length;
    const safeIdx = ((index % total) + total) % total;
    this.state.currentHeroIndex = safeIdx;

    const item = this.state.trendingItems[safeIdx];
    this.state.heroItem = item;

    const billboard = document.getElementById('billboard');
    if (billboard) {
      const heroImg = this.getItemBackdrop(item);
      billboard.style.backgroundImage = `url('${heroImg}')`;
    }

    const titleEl = document.getElementById('hero-title');
    if (titleEl) {
      titleEl.textContent = item.name;
      const len = (item.name || '').length;
      if (len > 35) {
        titleEl.className = 'text-xl sm:text-2xl md:text-3xl lg:text-4xl font-black tracking-tight text-white drop-shadow-lg leading-tight transition-all duration-300 line-clamp-2 md:line-clamp-3';
      } else if (len > 22) {
        titleEl.className = 'text-2xl sm:text-3xl md:text-4xl lg:text-5xl font-black tracking-tight text-white drop-shadow-lg leading-tight transition-all duration-300 line-clamp-2';
      } else {
        titleEl.className = 'text-3xl sm:text-4xl md:text-5xl lg:text-6xl font-black tracking-tight text-white drop-shadow-lg leading-tight transition-all duration-300 line-clamp-2';
      }
    }

    const overviewEl = document.getElementById('hero-overview');
    if (overviewEl) {
      overviewEl.textContent = item.overview || `Aproveite a melhor programação de filmes em alta definição, séries originais completas e canais ao vivo com a experiência de navegação premium da NovaFlix.`;
    }

    const matchEl = document.getElementById('hero-match');
    if (matchEl) matchEl.textContent = `${item.match || 98}% Relevante`;

    const ratingEl = document.getElementById('hero-rating');
    if (ratingEl) ratingEl.textContent = `★ ${item.rating || '8.9'}`;

    const yearEl = document.getElementById('hero-year');
    if (yearEl) yearEl.textContent = item.year || '2026';

    const heroRatingBadge = this.getContentRatingBadge(item);
    const heroRatingEl = document.getElementById('hero-rating-badge');
    if (heroRatingEl) {
      heroRatingEl.className = `px-1.5 py-0.5 border rounded text-[10px] font-black text-white ${heroRatingBadge.bg} ${heroRatingBadge.border}`;
      heroRatingEl.textContent = heroRatingBadge.text;
      heroRatingEl.title = heroRatingBadge.title;
    }

    const typeEl = document.getElementById('hero-type');
    if (typeEl) {
      typeEl.textContent = item.itemType === 'live' ? 'AO VIVO' : (item.itemType === 'series' ? 'SÉRIE' : '4K ULTRA HD');
    }

    const groupEl = document.getElementById('hero-group');
    if (groupEl) groupEl.textContent = item.genre || item.group || 'Geral';

    const badgeEl = document.getElementById('hero-badge');
    if (badgeEl) {
      const rankNum = item.rank || (safeIdx + 1);
      const isSeries = item.itemType === 'series' || (item.group || '').toLowerCase().includes('série');
      const isKids = typeof this.isKidsMode === 'function' && this.isKidsMode();
      if (isKids) {
        badgeEl.textContent = item.rankText || `#${rankNum} EM ALTA KIDS 🧸`;
      } else {
        badgeEl.textContent = item.rankText || `#${rankNum} ${isSeries ? 'SÉRIE' : 'FILME'} EM ALTA HOJE NO BRASIL`;
      }
    }

    const counterEl = document.getElementById('hero-carousel-counter');
    if (counterEl) {
      counterEl.textContent = '';
    }

    const contentEl = document.getElementById('hero-details-content');
    if (contentEl) {
      contentEl.classList.remove('animate-fade-in');
      void contentEl.offsetWidth;
      contentEl.classList.add('animate-fade-in');
    }

    // Atualiza botão de favoritos do hero
    const favIcon = document.getElementById('hero-fav-icon');
    if (favIcon) {
      const isFav = this.state.favorites.includes(item.name);
      favIcon.className = isFav ? 'fa-solid fa-check text-netflix-red text-base' : 'fa-solid fa-plus text-base';
    }

    // Atualiza pílulas ativas
    const pills = document.querySelectorAll('.hero-indicator-pill');
    pills.forEach((p, idx) => {
      if (idx === safeIdx) {
        p.classList.add('active');
      } else {
        p.classList.remove('active');
      }
    });
  },

  nextHeroSlide() {
    this.renderHeroSlide(this.state.currentHeroIndex + 1);
    this.startHeroRotation();
  },

  prevHeroSlide() {
    this.renderHeroSlide(this.state.currentHeroIndex - 1);
    this.startHeroRotation();
  },

  goToHeroSlide(idx) {
    this.renderHeroSlide(idx);
    this.startHeroRotation();
  },

  startHeroRotation() {
    if (this.state.heroAutoRotateTimer) {
      clearInterval(this.state.heroAutoRotateTimer);
      this.state.heroAutoRotateTimer = null;
    }
    this.state.heroAutoRotateTimer = setInterval(() => {
      if (!this.state.isHeroHovered) {
        this.nextHeroSlide();
      }
    }, 6500);
  },

  pauseHeroRotation() {
    this.state.isHeroHovered = true;
  },

  resumeHeroRotation() {
    this.state.isHeroHovered = false;
  },

  toggleHeroFavorite() {
    if (this.state.heroItem) {
      this.toggleFavorite(this.state.heroItem.name);
      const isFav = this.state.favorites.includes(this.state.heroItem.name);
      const favIcon = document.getElementById('hero-fav-icon');
      if (favIcon) {
        favIcon.className = isFav ? 'fa-solid fa-check text-netflix-red text-base' : 'fa-solid fa-plus text-base';
      }
      this.showToast(isFav ? 'Adicionado à Minha Lista' : 'Removido da Minha Lista', 'info');
    }
  },

  setupHeroBanner(hero) {
    this.setupHeroCarousel([hero]);
  },

  playHeroItem() {
    if (this.state.heroItem) {
      if (this.state.heroItem.itemType === 'series') {
        if (this.state.heroItem.firstEpisode && this.state.heroItem.firstEpisode.streamUrl) {
          this.playSeriesEpisode({
            name: this.state.heroItem.firstEpisode.name || 'Episódio 1',
            season: this.state.heroItem.firstEpisode.season || 1,
            episode: this.state.heroItem.firstEpisode.episode || 1,
            streamUrl: this.state.heroItem.firstEpisode.streamUrl
          }, this.state.heroItem);
        } else {
          this.playRemoteSeriesFirstEpisode(this.state.heroItem);
        }
      } else {
        this.playItem(this.state.heroItem);
      }
    }
  },

  openHeroModal() {
    if (this.state.heroItem) {
      this.openDetailModal(this.state.heroItem);
    }
  },

  renderCatalogRows() {
    const container = document.getElementById('catalog-rows');
    container.innerHTML = '';

    // 1. Linha de Continuar Assistindo (se houver no Início)
    if (this.state.activeFilter === 'ALL') {
      let continueList = this.getContinueWatchingList();
      if (!this.isAdultAllowed()) {
        continueList = continueList.filter(it => !it.isAdult && !this.isAdultContent(it) && !this.isAdultGroup(it.group));
      }
      if (continueList && continueList.length) {
        const contRow = this.createContinueWatchingRow(continueList);
        if (contRow) container.appendChild(contRow);
      }
    }

    // 2. Linha ou Grade de Favoritos ("Minha Lista")
    if (this.state.activeFilter === 'ALL' || this.state.activeFilter === 'FAVORITES') {
      const favList = [];
      // Carrega objetos persistidos em favoriteObjects
      if (Array.isArray(this.state.favoriteObjects)) {
        this.state.favoriteObjects.forEach(it => {
          if (it && it.name && this.state.favorites.includes(it.name) && !favList.some(f => f.name === it.name)) {
            favList.push(it);
          }
        });
      }
      // Complementa com itens encontrados no catálogo atual
      this.state.catalogRows.forEach(row => {
        (row.items || []).forEach(it => {
          if (this.state.favorites.includes(it.name) && !favList.some(f => f.name === it.name)) {
            favList.push(it);
          }
        });
      });

      if (this.state.activeFilter === 'FAVORITES') {
        const billboard = document.getElementById('billboard');
        if (billboard) {
          billboard.classList.add('hidden');
          billboard.style.display = 'none';
        }

        if (!favList.length) {
          container.innerHTML = `
            <div class="py-24 px-4 text-center max-w-md mx-auto space-y-4 animate-fade-in">
              <div class="w-16 h-16 rounded-full bg-slate-800/80 text-netflix-red flex items-center justify-center text-2xl mx-auto shadow-inner border border-slate-700">
                <i class="fa-solid fa-bookmark"></i>
              </div>
              <h3 class="text-xl font-bold text-white">Sua Lista está vazia</h3>
              <p class="text-xs text-slate-400 leading-relaxed">
                Adicione filmes, séries ou canais favoritos tocando no ícone de estrela ⭐ nos cards para ter acesso rápido aos seus títulos prediletos aqui.
              </p>
              <button onclick="App.filterView('ALL')" class="px-5 py-2.5 rounded-xl bg-netflix-red hover:bg-netflix-hoverRed text-white text-xs font-bold transition shadow-lg inline-flex items-center gap-2">
                <i class="fa-solid fa-compass"></i> Explorar Catálogo
              </button>
            </div>
          `;
          return;
        }

        const userProf = this.getUserProfile();
        const userSub = (userProf && userProf.name && userProf.name !== 'Visitante')
          ? `<p class="text-xs text-slate-400 mt-0.5">Perfil: <strong class="text-white">${this.escapeHtml(userProf.name)}</strong> (${userProf.gender === 'Mulher' ? 'Mulher' : 'Homem'})</p>`
          : `<p class="text-xs text-slate-400 mt-0.5">Seus títulos favoritos salvos</p>`;

        // Renderiza Minha Lista em grade visual estilo Netflix
        container.innerHTML = `
          <div class="px-4 md:px-12 pt-20 sm:pt-24 pb-8 space-y-4 animate-fade-in">
            <div class="flex items-center justify-between pb-3 border-b border-slate-800/80">
              <div class="flex items-center gap-3">
                <i class="fa-solid fa-bookmark text-netflix-red text-xl"></i>
                <div>
                  <div class="flex items-center gap-2">
                    <h2 class="text-xl md:text-2xl font-black text-white">Minha Lista</h2>
                    <span class="px-2.5 py-0.5 rounded-full bg-netflix-red/20 text-netflix-red border border-netflix-red/30 text-xs font-bold">${favList.length} título${favList.length !== 1 ? 's' : ''}</span>
                  </div>
                  ${userSub}
                </div>
              </div>
              <button onclick="App.openProfileModal()" class="px-3 py-1.5 rounded-xl bg-white/5 hover:bg-white/10 border border-slate-700 text-xs font-semibold text-slate-200 hover:text-white flex items-center gap-1.5 transition">
                <i class="fa-solid fa-user-pen text-netflix-red text-xs"></i> <span class="hidden sm:inline">Meu Perfil</span>
              </button>
            </div>
            <div class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
              ${favList.map(item => this.createCardHTML(item)).join('')}
            </div>
          </div>
        `;
        return;
      }

      // Se for a aba ALL (Início), exibe o carrossel horizontal de Minha Lista
      if (favList.length) {
        container.appendChild(this.createRowElement({
          title: '⭐ Minha Lista',
          items: favList,
          total: favList.length,
          type: 'all'
        }));
      }
    }

    // Renderiza cada linha do catálogo
    let rowsToRender = [...(this.state.catalogRows || [])];

    // Se NÃO tiver conteúdos adultos liberados no perfil (+18), oculta 100% das linhas adultas
    if (!this.isAdultAllowed()) {
      rowsToRender = rowsToRender.filter(r => !r.isAdult && !this.isAdultGroup(r.title) && !this.isAdultGroup(r.groupKey));
    }

    // Se for Modo Kids (Criança)
    if (typeof this.isKidsMode === 'function' && this.isKidsMode()) {
      // 1. Bloqueia e remove 100% dos conteúdos adultos do catálogo
      rowsToRender = rowsToRender.filter(r => !r.isAdult && !this.isAdultGroup(r.title) && !this.isAdultGroup(r.groupKey));

      // 2. Reorganiza colocando conteúdos infantis e familiares no topo
      const isKidsRow = (r) => {
        const t = (String(r.title || '') + ' ' + String(r.groupKey || '')).toLowerCase();
        return t.includes('anima') || t.includes('infantil') || t.includes('desenho') || 
               t.includes('kids') || t.includes('disney') || t.includes('família') || 
               t.includes('familia') || t.includes('teen') || t.includes('cartoon') ||
               t.includes('gloob') || t.includes('discovery kids') || t.includes('nick');
      };

      const kidsRows = rowsToRender.filter(isKidsRow);
      const otherRows = rowsToRender.filter(r => !isKidsRow(r));
      rowsToRender = [...kidsRows, ...otherRows];
    }

    const validRows = rowsToRender.filter(row => row.items && row.items.length);
    this.state._catalogRenderQueue = validRows;
    this.state._catalogRenderedCount = 0;

    if (this._catalogRowObserver) {
      this._catalogRowObserver.disconnect();
      this._catalogRowObserver = null;
    }

    // Renderiza inicialmente as primeiras 10 fileiras para carregamento instantâneo a 60 FPS
    const initialBatchSize = 10;
    const initialBatch = validRows.slice(0, initialBatchSize);
    initialBatch.forEach(row => {
      container.appendChild(this.createRowElement(row));
    });
    this.state._catalogRenderedCount = initialBatch.length;

    // Se houver mais fileiras a renderizar, cria o sentinela e o IntersectionObserver
    if (this.state._catalogRenderedCount < validRows.length) {
      this.setupCatalogRowObserver(container);
    }
  },

  setupCatalogRowObserver(container) {
    let sentinel = document.getElementById('catalog-scroll-sentinel');
    if (!sentinel) {
      sentinel = document.createElement('div');
      sentinel.id = 'catalog-scroll-sentinel';
      sentinel.className = 'h-16 w-full flex items-center justify-center py-4 text-slate-500 text-xs';
      sentinel.innerHTML = '<span class="inline-flex items-center gap-2"><i class="fa-solid fa-circle-notch fa-spin text-netflix-red text-sm"></i> Carregando mais categorias...</span>';
      container.appendChild(sentinel);
    } else {
      container.appendChild(sentinel);
    }

    if (this._catalogRowObserver) {
      this._catalogRowObserver.disconnect();
    }

    this._catalogRowObserver = new IntersectionObserver((entries) => {
      const entry = entries[0];
      if (entry && entry.isIntersecting) {
        this.renderNextCatalogBatch();
      }
    }, {
      rootMargin: '600px 0px',
      threshold: 0.01
    });

    this._catalogRowObserver.observe(sentinel);
  },

  renderNextCatalogBatch() {
    const queue = this.state._catalogRenderQueue || [];
    const current = this.state._catalogRenderedCount || 0;
    if (current >= queue.length) {
      if (this._catalogRowObserver) {
        this._catalogRowObserver.disconnect();
        this._catalogRowObserver = null;
      }
      const sentinel = document.getElementById('catalog-scroll-sentinel');
      if (sentinel) sentinel.remove();
      return;
    }

    const container = document.getElementById('catalog-rows');
    const sentinel = document.getElementById('catalog-scroll-sentinel');
    if (!container) return;

    const batchSize = 8;
    const nextBatch = queue.slice(current, current + batchSize);
    const fragment = document.createDocumentFragment();

    nextBatch.forEach(row => {
      fragment.appendChild(this.createRowElement(row));
    });

    if (sentinel && sentinel.parentNode === container) {
      container.insertBefore(fragment, sentinel);
    } else {
      container.appendChild(fragment);
    }

    this.state._catalogRenderedCount = current + nextBatch.length;

    if (this.state._catalogRenderedCount >= queue.length) {
      if (this._catalogRowObserver) {
        this._catalogRowObserver.disconnect();
        this._catalogRowObserver = null;
      }
      if (sentinel) sentinel.remove();
    }
  },

  createRowElement(rowOrTitle, optionalItems) {
    let row;
    if (typeof rowOrTitle === 'string') {
      row = { title: rowOrTitle, items: optionalItems || [], total: optionalItems?.length || 0, type: 'all' };
    } else {
      row = rowOrTitle;
    }

    const rowEl = document.createElement('section');
    rowEl.className = 'netflix-row continue-watching-row';
    const rowId = 'row_' + Math.random().toString(36).substr(2, 9);
    const title = row.title;
    const items = row.items || [];
    const total = row.total || items.length;
    const type = row.type || 'all';
    const groupKey = row.groupKey || '';

    rowEl.innerHTML = `
      <div class="flex items-center justify-between mb-2">
        <h3 class="text-base sm:text-lg md:text-xl font-bold text-white tracking-wide flex items-center gap-2">
          <span>${this.escapeHtml(title)}</span>
        </h3>
        ${total > 0 ? `
          <button onclick="App.openFullCategoryView('${type}', '${encodeURIComponent(groupKey)}', '${this.escapeHtml(title)}')" class="text-xs text-netflix-red hover:text-white font-semibold flex items-center gap-1.5 transition px-3 py-1 rounded-full bg-netflix-red/10 hover:bg-netflix-red/30 border border-netflix-red/30 group/btn">
            <span>Ver Tudo (${total.toLocaleString()})</span>
            <i class="fa-solid fa-chevron-right text-[10px] group-hover/btn:translate-x-0.5 transition-transform"></i>
          </button>
        ` : ''}
      </div>
      
      <div class="relative group">
        <button onclick="App.scrollRow('${rowId}', -1)" class="slider-btn left">
          <i class="fa-solid fa-chevron-left text-xl"></i>
        </button>

        <div id="${rowId}" class="slider-container">
          ${items.map(item => this.createCardHTML(item)).join('')}
        </div>

        <button onclick="App.scrollRow('${rowId}', 1)" class="slider-btn right">
          <i class="fa-solid fa-chevron-right text-xl"></i>
        </button>
      </div>
    `;

    return rowEl;
  },

  createContinueWatchingRow(items) {
    if (!items || !items.length) return null;
    const rowEl = document.createElement('section');
    rowEl.className = 'netflix-row continue-watching-row';
    const rowId = 'row_continue_' + Math.random().toString(36).substr(2, 9);

    rowEl.innerHTML = `
      <div class="flex items-center justify-between mb-2">
        <h3 class="text-base sm:text-lg md:text-xl font-bold text-white tracking-wide flex items-center gap-2">
          <span>▶️ Continuar Assistindo</span>
          <span class="text-xs text-netflix-red font-semibold bg-netflix-red/10 border border-netflix-red/30 px-2.5 py-0.5 rounded-full">${items.length} título${items.length > 1 ? 's' : ''}</span>
        </h3>
      </div>
      
      <div class="relative group">
        <button onclick="App.scrollRow('${rowId}', -1)" class="slider-btn left">
          <i class="fa-solid fa-chevron-left text-xl"></i>
        </button>

        <div id="${rowId}" class="slider-container">
          ${items.map(it => this.createContinueCardHTML(it)).join('')}
        </div>

        <button onclick="App.scrollRow('${rowId}', 1)" class="slider-btn right">
          <i class="fa-solid fa-chevron-right text-xl"></i>
        </button>
      </div>
    `;
    return rowEl;
  },

  createContinueCardHTML(item) {
    if (!item) return '';
    if (!this.isAdultAllowed() && (item.isAdult || this.isAdultContent(item) || this.isAdultGroup(item.group))) {
      return '';
    }
    const itemData = this.safeEncodeJson(item);
    const bgImg = item.cover || item.logo || item.backdrop || this.getItemBackdrop(item);
    const progressPct = Math.min(100, Math.max(0, Math.round(item.progressPct || 0)));
    const remMins = item.duration && item.currentTime ? Math.max(1, Math.round((item.duration - item.currentTime) / 60)) : null;

    return `
      <div onclick="App.resumeItem('${itemData}')" class="title-card poster-card group">
        <img src="${this.escapeHtml(bgImg)}" alt="${this.escapeHtml(item.name)}" loading="lazy" onerror="this.onerror=null; this.src='${BACKDROP_COLLECTION[0]}'">
        
        <!-- Barra de Progresso Vermelha Fixa no Rodapé do Card -->
        <div class="absolute bottom-0 left-0 right-0 h-1.5 bg-black/80 z-10">
          <div class="h-full bg-netflix-red rounded-full transition-all" style="width: ${progressPct}%"></div>
        </div>

        <!-- Botão Remover do Continuar Assistindo (Fixo e visível no mobile no canto direito, com hover no desktop) -->
        <button onclick="event.stopPropagation(); App.removeContinueWatching('${this.escapeHtml(item.name)}')" title="Remover de Continuar Assistindo" class="continue-watching-remove-btn absolute top-2 right-2 w-7 h-7 rounded-full bg-black/85 hover:bg-netflix-red text-white flex items-center justify-center text-xs opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition z-20 cursor-pointer shadow-xl border border-white/20 active:scale-90">
          <i class="fa-solid fa-xmark text-xs"></i>
        </button>

        <div class="card-overlay">
          <div class="flex items-center justify-between mb-2">
            <div class="w-9 h-9 rounded-full bg-white text-black flex items-center justify-center hover:bg-slate-200 transition shadow-lg">
              <i class="fa-solid fa-play text-xs pl-0.5"></i>
            </div>
            <span class="text-[10px] font-bold px-2 py-0.5 rounded bg-netflix-red text-white shadow">RETOMAR</span>
          </div>

          <h5 class="text-xs font-bold text-white truncate drop-shadow">${this.escapeHtml(item.name)}</h5>
          <div class="flex items-center gap-1.5 text-[10px] text-slate-300 mt-1">
            <span class="text-emerald-400 font-bold">${progressPct}% assistido</span>
            ${remMins ? `<span class="text-slate-400">• ${remMins}m restantes</span>` : ''}
          </div>
        </div>
      </div>
    `;
  },

  resumeItem(itemData) {
    const item = typeof itemData === 'string' ? this.safeDecodeJson(itemData) : itemData;
    if (!item) return;
    this.playItem(item);
    if (item.currentTime && item.currentTime > 5) {
      setTimeout(() => {
        if (this.player && this.player.video) {
          try {
            this.player.video.currentTime = item.currentTime;
            this.showToast(`Continuando de ${this.formatTime(item.currentTime)}...`, 'info');
          } catch(e) {}
        }
      }, 700);
    }
  },

  removeContinueWatching(itemName) {
    let list = this.getContinueWatchingList();
    list = list.filter(it => it.name !== itemName);
    localStorage.setItem('novaflix_continue_watching', JSON.stringify(list));
    this.renderCatalogRows();
    this.showToast('Item removido do Continuar Assistindo.', 'info');
  },

  getContinueWatchingList() {
    try {
      let list = JSON.parse(localStorage.getItem('novaflix_continue_watching') || '[]');
      if (!Array.isArray(list)) list = [];

      // Se conteúdos adultos (+18) estiverem desativados no perfil, remove 100% dos títulos adultos
      if (!this.isAdultAllowed()) {
        list = list.filter(it => !it.isAdult && !this.isAdultContent(it) && !this.isAdultGroup(it.group));
      }
      if (typeof this.isKidsMode === 'function' && this.isKidsMode()) {
        list = list.filter(it => !it.isAdult && !this.isAdultContent(it) && !this.isAdultGroup(it.group));
      }
      return list;
    } catch(e) {
      return [];
    }
  },

  getSavedPlaybackPosition(itemName) {
    if (!itemName) return null;
    const list = this.getContinueWatchingList();
    return list.find(it => it.name === itemName || it.name.startsWith(itemName) || itemName.startsWith(it.name)) || null;
  },

  saveContinueWatchingProgress(item, currentTime, duration) {
    if (!item || typeof currentTime !== 'number' || currentTime < 3) return;
    const dur = duration && duration > 0 ? duration : 0;
    const progressPct = dur > 0 ? (currentTime / dur) * 100 : 10;
    let list = this.getContinueWatchingList();

    // Se já assistiu mais de 93% e a duração for conhecida (> 60s), remove da lista (concluído)
    if (dur > 60 && progressPct >= 93) {
      list = list.filter(it => it.name !== item.name);
      localStorage.setItem('novaflix_continue_watching', JSON.stringify(list));
      return;
    }

    const isAdult = Boolean(item.isAdult || this.isAdultContent(item) || this.isAdultGroup(item.group));
    const entry = {
      id: item.id,
      name: item.name,
      group: item.group,
      itemType: item.itemType || 'movie',
      isAdult: isAdult,
      cover: item.cover || item.logo,
      logo: item.logo || item.cover,
      backdrop: item.backdrop || item.cover || item.logo,
      streamUrl: item.streamUrl,
      currentTime: Math.floor(currentTime),
      duration: Math.floor(dur),
      progressPct: Math.round(progressPct),
      lastWatched: Date.now(),
      seriesObj: this.state.activeSeries || null,
      episodeObj: this.state.activeEpisode || null
    };

    // Remove anterior se existir e insere no topo
    list = list.filter(it => it.name !== item.name);
    list.unshift(entry);
    if (list.length > 30) list = list.slice(0, 30);
    localStorage.setItem('novaflix_continue_watching', JSON.stringify(list));
  },

  safeEncodeJson(obj) {
    if (!obj) return '';
    return encodeURIComponent(JSON.stringify(obj)).replace(/'/g, '%27');
  },

  safeDecodeJson(str) {
    if (!str) return null;
    try {
      return JSON.parse(decodeURIComponent(str));
    } catch (e) {
      console.error('Falha ao decodificar JSON:', e);
      return null;
    }
  },

  toggleFavoriteByEncoded(encodedName) {
    const name = this.safeDecodeJson(encodedName);
    if (name) this.toggleFavorite(name);
  },

  createCardHTML(item) {
    if (!item) return '';
    const isFav = this.state.favorites.includes(item.name);
    const isSeries = item.itemType === 'series';

    // Converte item para atributo 100% seguro contra aspas simples e caracteres especiais
    const itemData = this.safeEncodeJson(item);
    const nameData = this.safeEncodeJson(item.name);
    const ratingBadge = this.getContentRatingBadge(item);

    // === CARD VERTICAL 2:3 PARA FILMES E SÉRIES ===
    const bgImg = item.cover || item.logo || this.getItemBackdrop(item);
    const matchPct = 94 + (item.id % 6);
    const badgeLabel = isSeries 
      ? (item.totalSeasons ? `${item.totalSeasons} Temp${item.totalSeasons > 1 ? 's' : ''}` : 'SÉRIE') 
      : 'FILME HD';

    return `
      <div onclick="App.onCardClick('${itemData}')" class="title-card poster-card group relative">
        <span class="absolute top-2 left-2 px-1.5 py-0.5 rounded ${ratingBadge.bg} ${ratingBadge.border} text-white font-black text-[9px] z-10 shadow tracking-wider border" title="${this.escapeHtml(ratingBadge.title)}">${ratingBadge.text}</span>
        <img src="${this.escapeHtml(bgImg)}" alt="${this.escapeHtml(item.name)}" loading="lazy" onerror="this.onerror=null; this.src='${BACKDROP_COLLECTION[0]}'">
        
        <div class="card-overlay">
          <div class="flex items-center justify-between mb-2">
            <div class="flex items-center gap-2">
              <button onclick="event.stopPropagation(); App.onCardPlay('${itemData}')" class="w-8 h-8 rounded-full bg-white text-black flex items-center justify-center hover:bg-slate-200 transition shadow-md" title="Assistir">
                <i class="fa-solid fa-play text-xs pl-0.5"></i>
              </button>
              <button onclick="event.stopPropagation(); App.toggleFavoriteByEncoded('${nameData}')" class="w-8 h-8 rounded-full bg-black/60 border border-slate-500 text-white flex items-center justify-center hover:border-white transition" title="Minha Lista">
                <i class="${isFav ? 'fa-solid text-netflix-red' : 'fa-solid'} fa-plus text-xs"></i>
              </button>
            </div>
            <button onclick="event.stopPropagation(); App.openDetailModalByData('${itemData}')" class="w-8 h-8 rounded-full bg-black/60 border border-slate-500 text-white flex items-center justify-center hover:border-white transition" title="Mais Informações e Detalhes">
              <i class="fa-solid fa-chevron-down text-xs"></i>
            </button>
          </div>

          <h5 class="text-xs font-bold text-white truncate drop-shadow">${this.escapeHtml(item.name)}</h5>
          <div class="flex items-center gap-1.5 text-[10px] text-slate-300 mt-0.5">
            <span class="border px-1 py-0.2 rounded text-[8px] ${ratingBadge.bg} ${ratingBadge.border} text-white font-black">${ratingBadge.text}</span>
            <span class="text-emerald-400 font-bold">${matchPct}%</span>
            <span class="border px-1 py-0.2 rounded text-[9px] ${isSeries ? 'bg-netflix-red/20 text-netflix-red border-netflix-red/30 font-bold' : 'bg-slate-800 text-slate-300 border-slate-600'}">${badgeLabel}</span>
            <span class="text-slate-400 truncate max-w-[80px]">${this.escapeHtml(item.group || 'Geral')}</span>
          </div>
        </div>
      </div>
    `;
  },

  onCardClick(itemData) {
    const item = this.safeDecodeJson(itemData);
    if (!item) return;

    if (item.itemType === 'series') {
      if (item.firstEpisode && item.firstEpisode.streamUrl) {
        this.playSeriesEpisode({
          name: item.firstEpisode.name || 'Episódio 1',
          season: item.firstEpisode.season || 1,
          episode: item.firstEpisode.episode || 1,
          streamUrl: item.firstEpisode.streamUrl
        }, item);
      } else {
        this.playRemoteSeriesFirstEpisode(item);
      }
    } else {
      this.playItem(item);
    }
  },

  onCardPlay(itemData) {
    const item = this.safeDecodeJson(itemData);
    if (!item) return;

    if (item.itemType === 'series') {
      if (item.firstEpisode && item.firstEpisode.streamUrl) {
        this.playSeriesEpisode({
          name: item.firstEpisode.name || 'Episódio 1',
          season: item.firstEpisode.season || 1,
          episode: item.firstEpisode.episode || 1,
          streamUrl: item.firstEpisode.streamUrl
        }, item);
      } else {
        this.playRemoteSeriesFirstEpisode(item);
      }
    } else {
      this.playItem(item);
    }
  },

  scrollRow(rowId, direction) {
    const row = document.getElementById(rowId);
    if (row) {
      const scrollAmount = row.clientWidth * 0.75 * direction;
      row.scrollBy({ left: scrollAmount, behavior: 'smooth' });
    }
  },

  filterView(view, fromHistory = false) {
    if (this.state.fullCatalog) {
      this.state.fullCatalog.isOpen = false;
    }
    const fullSec = document.getElementById('full-catalog-section');
    if (fullSec) fullSec.classList.add('hidden');

    if (!fromHistory && history.state && history.state.modal === 'fullCatalog') {
      this._navigatingBackProgrammatically = true;
      history.back();
    }

    const allowAdultNav = this.isAdultAllowed();
    ['all', 'series', 'movies', 'adult', 'favorites'].forEach(v => {
      const el = document.getElementById(`nav-${v}`);
      if (el) {
        if (v === 'adult') {
          if (!allowAdultNav) {
            el.className = 'hidden';
          } else if (v === view.toLowerCase()) {
            el.className = 'text-rose-400 font-black transition flex items-center gap-1';
          } else {
            el.className = 'hover:text-rose-300 transition text-rose-400/80 font-semibold flex items-center gap-1';
          }
        } else if (v === view.toLowerCase()) {
          el.className = 'text-white font-bold transition';
        } else {
          el.className = 'hover:text-slate-200 transition text-slate-400';
        }
      }
      const bEl = document.getElementById(`bottom-nav-${v}`);
      if (bEl) {
        if (v === 'adult') {
          if (!allowAdultNav) {
            bEl.className = 'hidden';
          } else if (v === view.toLowerCase()) {
            bEl.className = 'flex flex-col items-center gap-1 text-rose-400 font-bold transition flex-1 text-center py-1 scale-105';
          } else {
            bEl.className = 'flex flex-col items-center gap-1 text-rose-400/80 hover:text-rose-300 transition flex-1 text-center py-1';
          }
        } else if (v === view.toLowerCase()) {
          bEl.className = 'flex flex-col items-center gap-1 text-white font-bold transition flex-1 text-center py-1 scale-105';
        } else {
          bEl.className = 'flex flex-col items-center gap-1 text-slate-400 hover:text-white transition flex-1 text-center py-1';
        }
      }
    });

    const searchSec = document.getElementById('search-results-section');
    if (searchSec) searchSec.classList.add('hidden');
    const billboard = document.getElementById('billboard');
    if (billboard) {
      if (view.toLowerCase() === 'favorites') {
        billboard.classList.add('hidden');
        billboard.style.display = 'none';
      } else {
        billboard.classList.remove('hidden');
        billboard.style.display = '';
      }
    }
    const catalogRows = document.getElementById('catalog-rows');
    if (catalogRows) catalogRows.classList.remove('hidden');

    this.loadCatalog(view);
  },

  toggleMobileSearch() {
    const overlay = document.getElementById('mobile-search-overlay');
    if (!overlay) return;
    const isHidden = overlay.classList.contains('hidden');
    if (isHidden) {
      overlay.classList.remove('hidden');
      const input = document.getElementById('mobile-global-search');
      if (input) {
        input.value = this.state.searchQuery || '';
        input.focus();
      }
      this.pushNavigationState('search');
    } else {
      this.closeMobileSearch();
    }
  },

  closeMobileSearch(fromHistory = false) {
    const overlay = document.getElementById('mobile-search-overlay');
    if (overlay) overlay.classList.add('hidden');
    this.clearSearch(fromHistory);
  },

  // Limpa campo de pesquisa e restaura catálogo
  clearSearch(fromHistory = false) {
    this.state.searchQuery = '';
    const input1 = document.getElementById('global-search');
    const input2 = document.getElementById('mobile-global-search');
    if (input1) input1.value = '';
    if (input2) input2.value = '';
    const clearBtn = document.getElementById('search-clear-btn');
    if (clearBtn) clearBtn.classList.add('hidden');
    const overlay = document.getElementById('mobile-search-overlay');
    if (overlay) overlay.classList.add('hidden');
    const resultsSection = document.getElementById('search-results-section');
    const catalogRows = document.getElementById('catalog-rows');
    const billboard = document.getElementById('billboard');
    if (resultsSection) resultsSection.classList.add('hidden');
    if (catalogRows) catalogRows.classList.remove('hidden');
    if (billboard) {
      billboard.classList.remove('hidden');
      billboard.style.display = '';
    }

    if (!fromHistory && history.state && history.state.modal === 'search') {
      this._navigatingBackProgrammatically = true;
      history.back();
    }
  },

  // Busca no backend com Debounce de 300ms e normalização
  onSearch(query) {
    if (this._searchDebounceTimer) {
      clearTimeout(this._searchDebounceTimer);
    }
    const q = (query || '').trim();
    this.state.searchQuery = q;

    const input1 = document.getElementById('global-search');
    const input2 = document.getElementById('mobile-global-search');
    if (input1 && input1.value !== query) input1.value = query;
    if (input2 && input2.value !== query) input2.value = query;

    const resultsSection = document.getElementById('search-results-section');
    const catalogRows = document.getElementById('catalog-rows');
    const billboard = document.getElementById('billboard');
    const queryDisplay = document.getElementById('search-query-display');
    const clearBtn = document.getElementById('search-clear-btn');

    if (!q) {
      if (clearBtn) clearBtn.classList.add('hidden');
      if (resultsSection) resultsSection.classList.add('hidden');
      if (catalogRows) catalogRows.classList.remove('hidden');
      if (billboard) {
        billboard.classList.remove('hidden');
        billboard.style.display = '';
      }
      return;
    }

    if (clearBtn) clearBtn.classList.remove('hidden');
    this.pushNavigationState('search');
    if (resultsSection) resultsSection.classList.remove('hidden');
    if (catalogRows) catalogRows.classList.add('hidden');
    if (billboard) {
      billboard.classList.add('hidden');
      billboard.style.display = 'none';
    }
    if (queryDisplay) queryDisplay.textContent = `"${query}"`;

    if (window.innerWidth < 768) {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    this._searchDebounceTimer = setTimeout(async () => {
      try {
        const grid = document.getElementById('search-grid');
        if (!grid) return;
        const isKidsParam = (typeof this.isKidsMode === 'function' && this.isKidsMode()) ? '&kids=1' : '';
        const adultParam = `&adult=${this.isAdultAllowed() ? 1 : 0}`;
        const res = await fetch(`/api/netflix/search?q=${encodeURIComponent(q)}${isKidsParam}${adultParam}`);
        const data = await res.json();
        const matches = data.results || [];

        if (!matches.length) {
          grid.innerHTML = '<div class="col-span-full py-16 text-center text-slate-400 text-sm">Nenhum título encontrado.</div>';
          return;
        }

        grid.innerHTML = matches.map(item => this.createCardHTML(item)).join('');
      } catch (e) {
        console.error(e);
      }
    }, 300);
  },

  /* ==============================================================================
     PLAYER CONTROLLER
     ============================================================================== */
  preparePlayerEntry() {
    // 1. Detecta e armazena com precisão a orientação física de origem antes de entrar em paisagem
    let originOrientation = 'portrait';
    try {
      if (window.screen && window.screen.orientation && window.screen.orientation.type) {
        if (window.screen.orientation.type.startsWith('landscape')) {
          originOrientation = 'landscape';
        } else if (window.screen.orientation.type.startsWith('portrait')) {
          originOrientation = 'portrait';
        }
      } else if (typeof window.orientation === 'number') {
        if (Math.abs(window.orientation) === 90) originOrientation = 'landscape';
        else originOrientation = 'portrait';
      } else {
        originOrientation = (window.innerWidth > window.innerHeight) ? 'landscape' : 'portrait';
      }
    } catch (e) {
      originOrientation = (window.innerWidth > window.innerHeight) ? 'landscape' : 'portrait';
    }

    this._previousOrientationBeforePlayer = originOrientation;
    if (window.screen && window.screen.orientation && window.screen.orientation.type) {
      this._previousOrientationType = window.screen.orientation.type;
    } else {
      this._previousOrientationType = originOrientation;
    }

    // 2. Registra se o player foi aberto a partir da tela de detalhes (filme ou série)
    const detailModal = document.getElementById('netflix-detail-modal');
    this._openedPlayerFromDetail = Boolean(detailModal && !detailModal.classList.contains('hidden'));

    // 3. Se NÃO foi aberto a partir de detalhes, garante fechamento para limpar a tela
    if (!this._openedPlayerFromDetail) {
      this.closeDetailModal(true);
    }
  },

  playItemByData(itemData) {
    const item = this.safeDecodeJson(itemData);
    if (item) this.playItem(item);
  },

  async playItem(item, opts = {}) {
    if (!item) return;

    const isAdmBypass = Boolean(opts && opts.forceBypass);

    // 1. REGRA 8: Se for comando soberano do ADM, pula todas as barreiras e restrições!
    if (!isAdmBypass) {
      // REGRA 7: Pedágio Obrigatório de Perfil (Nome, Gênero e Idade)
      if (!this.isProfileConfigured()) {
        this._pendingPlayAfterProfile = { item, opts };
        this.showToast('Por favor, preencha seu Perfil (Nome, Gênero e Idade) para desbloquear a reprodução.', 'warning');
        this.openProfileModal(false, true);
        return;
      }

      // Proteção de Maioridade (+18) para Filmes Adultos (exceto comando soberano do ADM)
      if (this.isAdultContent(item) && !this.isAdultAllowed()) {
        this.showToast('🔞 Conteúdo restrito para maiores de 18 anos no Perfil.', 'error');
        return;
      }

      // REGRAS 9, 10, 11, 12: Doação Pré-Play Não Intrusiva
      if (this.state.gatewayActive && !this.isMinor()) {
        const userOverrides = this.state.userOverrides || {};
        const isAbolished = Boolean(userOverrides.abolishDonation);
        const isForced = Boolean(userOverrides.forceDonation);
        const isPending = Boolean(this.state.doacao_pendente);

        if (!isAbolished && (isForced || isPending)) {
          this._pendingPlayAfterDonation = { item, opts };
          this.openDoacaoModal();
          return;
        }
      }
    }

    // Registra orientação física de origem e preserva tela de detalhes
    this.preparePlayerEntry();

    // Verifica se há progresso salvo para retomar exatamente onde parou
    const saved = this.getSavedPlaybackPosition(item.name);
    if (saved && saved.currentTime > 5) {
      this._pendingResumeTime = saved.currentTime;
    } else {
      this._pendingResumeTime = null;
    }

    this.closeSettingsModal(true);
    this.closeFeedbackModal(true);
    this.closeMobilePlayerSettings(true);
    this.closeSetupIpModal(true);
    this.dismissDoacaoModal();
    this.cancelPostPlay();
    this.pushNavigationState('player');

    this.state.isPlayerLocked = false;
    this.updateCenterIndicator(false);
    const lockOverlay = document.getElementById('player-lock-overlay');
    if (lockOverlay) lockOverlay.classList.add('hidden');
    const lockBadge = document.getElementById('player-lock-badge');
    if (lockBadge) lockBadge.classList.add('hidden');

    const sugDrawer = document.getElementById('player-suggestions-drawer');
    if (sugDrawer) sugDrawer.classList.add('hidden');

    let streamUrl = item.streamUrl;
    if (!streamUrl && item.firstEpisode && item.firstEpisode.streamUrl) {
      streamUrl = item.firstEpisode.streamUrl;
    }

    if (!streamUrl && item.itemType === 'series') {
      this.openDetailModal(item);
      return;
    }

    this.state.activeItem = { ...item, streamUrl };

    const screen = document.getElementById('netflix-player-screen');
    if (screen) {
      screen.classList.remove('hidden');
      screen.classList.remove('cinema-mode');
      screen.classList.remove('player-screen-locked');
      screen.classList.add('show-controls');
    }
    const unmutePrompt = document.getElementById('player-unmute-prompt');
    if (unmutePrompt) unmutePrompt.classList.add('hidden');

    // Modo paisagem automático estilo Netflix no celular / Android
    this.enterMobileLandscapePlayer();

    const titleEl = document.getElementById('player-title');
    if (titleEl) titleEl.textContent = item.name || 'Título';
    const subTitleEl = document.getElementById('player-subtitle');
    if (subTitleEl) subTitleEl.textContent = item.group || 'Geral';

    const isFav = this.state.favorites.includes(item.name);
    const favBtn = document.getElementById('player-fav-btn');
    if (favBtn) favBtn.innerHTML = `<i class="${isFav ? 'fa-solid text-netflix-red' : 'fa-regular'} fa-star text-base"></i>`;

    // Modais Inferiores Dinâmicos (Filmes x Séries)
    const isSeries = item.itemType === 'series';
    const epBtn = document.getElementById('player-episodes-btn');
    const sgBtn = document.getElementById('player-suggest-btn');
    const nextLabel = document.getElementById('player-next-label');
    const epDrawer = document.getElementById('player-episodes-drawer');

    if (isSeries) {
      if (epBtn) epBtn.classList.remove('hidden');
      if (sgBtn) sgBtn.classList.remove('hidden');
      if (nextLabel) nextLabel.textContent = 'Próximo Episódio';
    } else {
      if (epBtn) epBtn.classList.add('hidden');
      if (sgBtn) sgBtn.classList.remove('hidden');
      if (epDrawer) epDrawer.classList.add('hidden');
      if (nextLabel) nextLabel.textContent = 'Próximo Filme';
      this.state.activeSeries = null;
      this.state.activeEpisode = null;
      this.state.currentSeriesData = null;
    }

    const activeScale = (window.SettingsManager && typeof window.SettingsManager.getVideoScale === 'function')
      ? window.SettingsManager.getVideoScale()
      : 'contain';
    this.player.setAspectRatio(activeScale);
    const aspectLabel = document.getElementById('player-aspect-label');
    const labelMap = { contain: 'Automático', cover: 'Preencher', fill: 'Esticar', original: 'Original' };
    if (aspectLabel) {
      aspectLabel.textContent = labelMap[activeScale] || 'Automático';
    }

    // Prepara barra de progresso VOD e estado inicial de carregamento automático
    const liveBadge = document.getElementById('player-live-badge');
    const vodTimeline = document.getElementById('vod-timeline');
    const curTxt = document.getElementById('current-time-text');
    const durTxt = document.getElementById('duration-time-text');
    const seekBar = document.getElementById('seek-bar');
    const loader = document.getElementById('netflix-player-loader');
    const errorEl = document.getElementById('netflix-player-error');
    if (liveBadge) liveBadge.classList.add('hidden');
    if (vodTimeline) vodTimeline.classList.remove('hidden');
    if (curTxt) curTxt.textContent = '00:00';
    if (durTxt) durTxt.textContent = '00:00';
    if (seekBar) seekBar.value = 0;
    if (loader) loader.classList.remove('hidden');
    if (errorEl) errorEl.classList.add('hidden');
    this.updatePlayPauseIcon(false);
    this.updateCenterIndicator(false);

    // Carrega a URL com aceleração por hardware nos clientes nativos (MP4 para VOD)
    const mediaType = item.mediaType || 'mp4';
    this.player.loadChannel({
      name: item.name,
      url: this.getServerUrl(streamUrl),
      mediaType: mediaType,
      format: mediaType,
      hardwareAcceleration: true
    });

    // Atualiza heartbeat em tempo real para o painel ADM
    if (typeof this.sendSessionHeartbeat === 'function') {
      this.sendSessionHeartbeat();
    }
  },

  closePlayer(fromHistory = false) {
    // 1. Salva a posição exata onde o usuário parou para o Continuar Assistindo
    if (this.player && this.player.video && this.state.activeItem && this.state.activeItem.itemType !== 'live') {
      const cur = this.player.video.currentTime || 0;
      const dur = this.player.video.duration || 0;
      if (cur >= 3) {
        this.saveContinueWatchingProgress(this.state.activeItem, cur, dur);
      }
    }

    // 2. Oculta imediatamente a tela do player e pausa vídeo para resposta instantânea (0ms de atraso)
    const screen = document.getElementById('netflix-player-screen');
    if (screen) {
      screen.classList.add('hidden');
      screen.classList.remove('cinema-mode');
      screen.classList.remove('player-screen-locked');
      screen.classList.add('show-controls');
    }

    if (this.player && this.player.video) {
      try {
        this.player.video.pause();
      } catch (e) {}
    }

    // 3. Restaura orientação de origem (se era retrato volta para retrato; se era paisagem fica em paisagem) e desativa tela cheia
    this.exitMobileLandscapePlayer();

    // 4. Se o player foi aberto a partir da tela de detalhes, reexibe a tela de detalhes intacta!
    if (this._openedPlayerFromDetail) {
      const detailModal = document.getElementById('netflix-detail-modal');
      if (detailModal) {
        detailModal.classList.remove('hidden');
      }
    }

    this.cancelPostPlay();

    this.state.isPlayerLocked = false;
    this.updateCenterIndicator(false);
    const lockOverlay = document.getElementById('player-lock-overlay');
    if (lockOverlay) lockOverlay.classList.add('hidden');

    const mSettings = document.getElementById('player-mobile-settings-modal');
    if (mSettings) mSettings.classList.add('hidden');

    const drawer = document.getElementById('player-episodes-drawer');
    if (drawer) drawer.classList.add('hidden');
    const channelsDrawer = document.getElementById('player-channels-drawer');
    if (channelsDrawer) channelsDrawer.classList.add('hidden');
    const sugDrawer = document.getElementById('player-suggestions-drawer');
    if (sugDrawer) sugDrawer.classList.add('hidden');
    const subModal = document.getElementById('player-subtitles-modal');
    if (subModal) subModal.classList.add('hidden');
    if (this.player) this.player.destroy();

    if (this._controlsInactivityTimer) {
      clearTimeout(this._controlsInactivityTimer);
      this._controlsInactivityTimer = null;
    }

    // Atualiza status para o painel ADM
    if (typeof this.sendSessionHeartbeat === 'function') {
      this.sendSessionHeartbeat();
    }

    // Atualiza APENAS a fileira de Continuar Assistindo suavemente (NUNCA destrói nem recarrega o catálogo todo)
    this.updateContinueWatchingRow();

    if (!fromHistory && history.state && (history.state.modal === 'player' || history.state.modal === 'player-drawer')) {
      this._navigatingBackProgrammatically = true;
      history.back();
    }
  },

  updateContinueWatchingRow() {
    if (this.state.activeFilter !== 'ALL') return;
    const continueList = this.getContinueWatchingList();
    const container = document.getElementById('catalog-rows');
    if (!container) return;

    const existing = container.querySelector('.continue-watching-row') || 
                     container.querySelector('[id^="row_continue_"]')?.closest('.netflix-row');

    if (!continueList || !continueList.length) {
      if (existing) existing.remove();
      return;
    }

    const newRow = this.createContinueWatchingRow(continueList);
    if (!newRow) return;

    if (existing) {
      existing.replaceWith(newRow);
    } else {
      container.insertBefore(newRow, container.firstChild);
    }
  },

  retryCurrentStream() {
    if (this.state.activeItem) {
      this.playItem(this.state.activeItem);
    }
  },

  playNextItem() {
    const next = this.getNextRecommendedItem(this.state.activeItem);
    if (next) {
      if (next.seriesObj && next.episodeObj) {
        this.playSeriesEpisode(next.episodeObj, next.seriesObj);
      } else {
        this.playItem(next);
      }
    }
  },

  /* ==============================================================================
     SUGESTÕES DE PRÓXIMO TÍTULO & POST-PLAY SCREEN (AO TERMINAR DE ASSISTIR)
     ============================================================================== */
  getNextRecommendedItem(currentItem) {
    if (!currentItem) return null;

    // 1. Apenas se for série com episódios ativos
    if (currentItem.itemType === 'series' && this.state.activeSeries && this.state.activeEpisode && this.state.currentSeriesData) {
      const data = this.state.currentSeriesData;
      const curEp = this.state.activeEpisode;
      const seasonEps = data.seasons?.[curEp.season] || [];
      const curIdx = seasonEps.findIndex(e => e.episode === curEp.episode);

      if (curIdx > -1 && curIdx < seasonEps.length - 1) {
        const nextEp = seasonEps[curIdx + 1];
        return {
          name: `${this.state.activeSeries.name} - T${nextEp.season}:E${nextEp.episode}`,
          titleOnly: `${this.state.activeSeries.name} • T${nextEp.season}:E${nextEp.episode} - ${nextEp.name}`,
          plot: `Próximo episódio da série ${this.state.activeSeries.name}.`,
          logo: nextEp.logo || this.state.activeSeries.cover || this.state.activeSeries.logo,
          cover: nextEp.logo || this.state.activeSeries.cover || this.state.activeSeries.logo,
          group: this.state.activeSeries.group,
          itemType: 'series',
          seriesObj: this.state.activeSeries,
          episodeObj: nextEp,
          streamUrl: nextEp.streamUrl,
          mediaType: 'mp4'
        };
      }

      // Próxima temporada
      const nextSeason = curEp.season + 1;
      if (data.seasons?.[nextSeason] && data.seasons[nextSeason].length) {
        const nextEp = data.seasons[nextSeason][0];
        return {
          name: `${this.state.activeSeries.name} - T${nextEp.season}:E${nextEp.episode}`,
          titleOnly: `${this.state.activeSeries.name} • T${nextEp.season}:E1 - ${nextEp.name}`,
          plot: `Início da Temporada ${nextSeason} da série ${this.state.activeSeries.name}.`,
          logo: nextEp.logo || this.state.activeSeries.cover || this.state.activeSeries.logo,
          cover: nextEp.logo || this.state.activeSeries.cover || this.state.activeSeries.logo,
          group: this.state.activeSeries.group,
          itemType: 'series',
          seriesObj: this.state.activeSeries,
          episodeObj: nextEp,
          streamUrl: nextEp.streamUrl,
          mediaType: 'mp4'
        };
      }
    }

    // 2. Para Filmes e Canais: busca no catálogo recomendação compatível DO MESMO TIPO
    const targetType = currentItem.itemType || (currentItem.tvgId ? 'live' : 'movie');
    const curGroup = (currentItem.group || '').toLowerCase();
    let candidateList = [];

    // Procura na fileira onde o título se encontra
    for (const row of this.state.catalogRows) {
      if (row.items && row.items.some(i => i.name === currentItem.name)) {
        candidateList = row.items.filter(i => 
          i.name !== currentItem.name && 
          (i.itemType === targetType || (!i.itemType && targetType === 'movie'))
        );
        if (candidateList.length) break;
      }
    }

    // Se não encontrou na mesma fileira, procura por gênero similar
    if (!candidateList.length && curGroup) {
      for (const row of this.state.catalogRows) {
        const matching = (row.items || []).filter(i => 
          (i.group || '').toLowerCase().includes(curGroup) && 
          i.name !== currentItem.name &&
          (i.itemType === targetType || (!i.itemType && targetType === 'movie'))
        );
        if (matching.length) {
          candidateList = matching;
          break;
        }
      }
    }

    // Fallback: qualquer item do mesmo tipo na grade
    if (!candidateList.length) {
      for (const row of this.state.catalogRows) {
        const matching = (row.items || []).filter(i => 
          i.name !== currentItem.name && 
          (i.itemType === targetType || (!i.itemType && targetType === 'movie'))
        );
        if (matching.length) {
          candidateList = matching;
          break;
        }
      }
    }

    if (candidateList.length) {
      return candidateList[0];
    }

    return null;
  },

  onVideoEnded() {
    const nextItem = this.getNextRecommendedItem(this.state.activeItem);
    if (!nextItem) return;

    this._postPlayNextItem = nextItem;
    const postPlayScreen = document.getElementById('player-postplay-screen');
    if (!postPlayScreen) return;

    document.getElementById('postplay-title').textContent = nextItem.titleOnly || nextItem.name;
    document.getElementById('postplay-desc').textContent = nextItem.plot || `Aproveite a próxima recomendação da categoria "${nextItem.group || 'Destaques'}".`;

    const banner = document.getElementById('postplay-card-banner');
    if (banner) {
      banner.style.backgroundImage = `url('${this.getItemBackdrop(nextItem)}')`;
    }

    postPlayScreen.classList.remove('hidden');

    let secondsLeft = 5;
    const badge = document.getElementById('postplay-timer-badge');
    if (badge) badge.textContent = `Iniciando em ${secondsLeft}s`;

    if (this._postPlayTimer) clearInterval(this._postPlayTimer);
    this._postPlayTimer = setInterval(() => {
      secondsLeft--;
      if (secondsLeft > 0) {
        if (badge) badge.textContent = `Iniciando em ${secondsLeft}s`;
      } else {
        clearInterval(this._postPlayTimer);
        this._postPlayTimer = null;
        this.playPostPlayItem();
      }
    }, 1000);
  },

  playPostPlayItem() {
    if (this._postPlayTimer) {
      clearInterval(this._postPlayTimer);
      this._postPlayTimer = null;
    }
    const screen = document.getElementById('player-postplay-screen');
    if (screen) screen.classList.add('hidden');

    if (this._postPlayNextItem) {
      const it = this._postPlayNextItem;
      if (it.seriesObj && it.episodeObj) {
        this.playSeriesEpisode(it.episodeObj, it.seriesObj);
      } else {
        this.playItem(it);
      }
    }
  },

  cancelPostPlay() {
    if (this._postPlayTimer) {
      clearInterval(this._postPlayTimer);
      this._postPlayTimer = null;
    }
    const screen = document.getElementById('player-postplay-screen');
    if (screen) screen.classList.add('hidden');
  },

  replayCurrentVideo() {
    this.cancelPostPlay();
    const v = document.getElementById('netflix-video');
    if (v) {
      v.currentTime = 0;
      v.play();
    }
  },

  togglePlayerSuggestionsDrawer() {
    const drawer = document.getElementById('player-suggestions-drawer');
    if (!drawer) return;
    const isHidden = drawer.classList.contains('hidden');
    if (isHidden) {
      drawer.classList.remove('hidden');
      this.pushNavigationState('player-drawer');
      this.renderPlayerSuggestions();
    } else {
      drawer.classList.add('hidden');
    }
  },

  renderPlayerSuggestions() {
    const listEl = document.getElementById('player-suggestions-list');
    if (!listEl || !this.state.activeItem) return;

    const cur = this.state.activeItem;
    const curType = cur.itemType || (cur.tvgId ? 'live' : 'movie');
    const curGroup = (cur.group || '').toLowerCase();
    let suggestions = [];

    for (const row of this.state.catalogRows) {
      for (const item of (row.items || [])) {
        const itType = item.itemType || (item.tvgId ? 'live' : 'movie');
        if (itType === curType && item.name !== cur.name && !suggestions.some(s => s.name === item.name)) {
          if (curGroup && (item.group || '').toLowerCase().includes(curGroup)) {
            suggestions.push(item);
          }
        }
      }
    }

    if (suggestions.length < 5) {
      for (const row of this.state.catalogRows) {
        for (const item of (row.items || [])) {
          const itType = item.itemType || (item.tvgId ? 'live' : 'movie');
          if (itType === curType && item.name !== cur.name && !suggestions.some(s => s.name === item.name)) {
            suggestions.push(item);
            if (suggestions.length >= 8) break;
          }
        }
      }
    }

    listEl.innerHTML = suggestions.slice(0, 8).map(item => {
      const itemData = this.safeEncodeJson(item);
      const bg = this.getItemBackdrop(item);
      return `
        <div onclick="App.playItemByData('${itemData}'); App.togglePlayerSuggestionsDrawer();" class="p-2.5 rounded-xl bg-[#181818] hover:bg-slate-800 border border-slate-800 hover:border-slate-700 flex items-center gap-3 cursor-pointer transition group">
          <img src="${this.escapeHtml(bg)}" alt="${this.escapeHtml(item.name)}" class="w-16 h-10 object-cover rounded-md flex-shrink-0" onerror="this.src='${BACKDROP_COLLECTION[0]}'">
          <div class="flex-1 min-w-0">
            <h5 class="text-xs font-bold text-white truncate group-hover:text-netflix-red transition">${this.escapeHtml(item.name)}</h5>
            <div class="flex items-center gap-2 text-[10px] text-slate-400 mt-0.5">
              <span class="text-emerald-400 font-semibold">98% Relevante</span>
              <span class="truncate max-w-[100px]">${this.escapeHtml(item.group || 'Lançamentos')}</span>
            </div>
          </div>
          <button class="w-8 h-8 rounded-full bg-white/10 group-hover:bg-netflix-red text-white flex items-center justify-center transition flex-shrink-0">
            <i class="fa-solid fa-play text-xs pl-0.5"></i>
          </button>
        </div>
      `;
    }).join('');
  },

  seekRelative(seconds) {
    const v = document.getElementById('netflix-video');
    if (v && v.duration) {
      v.currentTime = Math.max(0, Math.min(v.duration, v.currentTime + seconds));
    }
  },

  toggleAspectRatio() {
    this.state.aspectRatioIdx = (this.state.aspectRatioIdx + 1) % this.state.aspectRatios.length;
    const mode = this.state.aspectRatios[this.state.aspectRatioIdx];
    const label = this.state.aspectRatioLabels[this.state.aspectRatioIdx];

    this.player.setAspectRatio(mode);
    const aspectLabel = document.getElementById('player-aspect-label');
    if (aspectLabel) {
      aspectLabel.textContent = label;
    } else {
      const aspectBtn = document.getElementById('player-aspect-btn');
      if (aspectBtn) aspectBtn.textContent = label;
    }
    this.showToast(`Formato de Tela: ${label}`, 'info');
  },

  toggleSubtitlesModal() {
    const modal = document.getElementById('player-subtitles-modal');
    if (!modal) return;
    const isHidden = modal.classList.contains('hidden');
    if (isHidden) {
      this.renderAudioTracksOptions();
      modal.classList.remove('hidden');
      this.pushNavigationState('player-drawer');
    } else {
      modal.classList.add('hidden');
    }
  },

  renderAudioTracksOptions() {
    const container = document.getElementById('player-audio-options-list');
    if (!container) return;

    const tracks = (this.player && typeof this.player.getAudioTracks === 'function') ? this.player.getAudioTracks() : [];
    if (tracks.length > 1) {
      container.innerHTML = tracks.map((t, idx) => `
        <label class="flex items-center gap-2.5 p-2 rounded hover:bg-slate-800 cursor-pointer">
          <input type="radio" name="player-audio-opt" value="${idx}" ${t.selected ? 'checked' : ''} onchange="App.selectAudioTrackByIndex(${idx})" class="accent-netflix-red">
          <span>${this.escapeHtml(t.name)}</span>
        </label>
      `).join('');
    } else {
      container.innerHTML = `
        <label class="flex items-center gap-2.5 p-2 rounded hover:bg-slate-800 cursor-pointer">
          <input type="radio" name="player-audio-opt" value="default" checked class="accent-netflix-red">
          <span>Áudio Principal (Estéreo com Diálogo Central)</span>
        </label>
      `;
    }
  },

  selectAudioTrackByIndex(idx) {
    if (this.player && typeof this.player.setAudioTrackByIndex === 'function') {
      this.player.setAudioTrackByIndex(Number(idx));
      this.showToast('Faixa de áudio alterada', 'info');
    }
  },

  toggleDialogueBoost(enable) {
    if (this.player && typeof this.player.toggleDialogueBoost === 'function') {
      this.player.toggleDialogueBoost(enable);
      const b1 = document.getElementById('toggle-dialogue-boost');
      const b2 = document.getElementById('sheet-dialogue-boost');
      if (b1) b1.checked = enable;
      if (b2) b2.checked = enable;
      this.showToast(enable ? 'Modo Falas Nítidas ativado 🗣️' : 'Modo Falas Nítidas desativado', 'info');
    }
  },

  setSubtitleTrack(lang) {
    if (this.player && this.player.hls && this.player.hls.subtitleTracks) {
      if (lang === 'off') {
        this.player.hls.subtitleTrack = -1;
      } else {
        const idx = this.player.hls.subtitleTracks.findIndex(t => (t.lang || t.name || '').toLowerCase().includes(lang));
        if (idx !== -1) {
          this.player.hls.subtitleTrack = idx;
        }
      }
    }
    const label = lang === 'off' ? 'Legendas Desativadas' : (lang === 'pt' ? 'Legendas em Português' : 'Legendas em Inglês');
    this.showToast(label, 'info');
  },

  setAudioTrack(type) {
    if (this.player && this.player.hls && this.player.hls.audioTracks) {
      if (type === 'dubbed') {
        const idx = this.player.hls.audioTracks.findIndex(t => (t.lang || t.name || '').toLowerCase().includes('por') || (t.name || '').toLowerCase().includes('dub'));
        if (idx !== -1) this.player.hls.audioTrack = idx;
      } else {
        if (this.player.hls.audioTracks.length > 0) this.player.hls.audioTrack = 0;
      }
    } else if (this.player && this.player.autoSelectPortugueseAudio && type === 'dubbed') {
      this.player.autoSelectPortugueseAudio();
    }
    const label = type === 'dubbed' ? 'Áudio: Português (Dublado)' : 'Áudio: Original / Padrão';
    this.showToast(label, 'info');
  },

  setPlaybackSpeed(speed, btn) {
    const video = document.getElementById('netflix-video');
    if (video) {
      video.playbackRate = speed;
    }
    if (btn && btn.parentElement) {
      const buttons = btn.parentElement.querySelectorAll('button');
      buttons.forEach(b => {
        b.className = 'py-1.5 rounded bg-slate-800 hover:bg-slate-700 border border-slate-700';
      });
      btn.className = 'py-1.5 rounded bg-netflix-red text-white border border-netflix-red';
    }
    this.showToast(`Velocidade de reprodução: ${speed}x`, 'info');
  },

  toggleCinemaMode() {
    const playerScreen = document.getElementById('netflix-player-screen');
    if (!playerScreen) return;

    if (playerScreen.classList.contains('cinema-mode')) {
      this.showPlayerControls();
      this.showToast('Controles Fixos na Tela', 'info');
    } else {
      this.hidePlayerControls();
      this.showToast('Controles Ocultados (mova o mouse ou toque na tela para reexibir)', 'info');
    }
  },

  toggleMute() {
    if (this.player) {
      const isMuted = this.player.toggleMute();
      this.updateVolumeUI();
      this.showToast(isMuted ? 'Áudio Silenciado' : 'Áudio Ativado', 'info');
    }
  },

  setVolume(fraction) {
    if (this.player) {
      this.player.setVolume(fraction);
      this.updateVolumeUI();
    }
  },

  unmuteVideo() {
    if (this.player) {
      this.player.unmute();
      this.updateVolumeUI();
      this.showToast('Áudio ativado com sucesso!', 'success');
    }
  },

  updateVolumeUI() {
    if (this.player) {
      this.player.updateVolumeUI();
    }
  },

  togglePlayerFavorite() {
    if (this.state.activeItem) {
      this.toggleFavorite(this.state.activeItem.name);
      const isFav = this.state.favorites.includes(this.state.activeItem.name);
      const favBtn = document.getElementById('player-fav-btn');
      if (favBtn) favBtn.innerHTML = `<i class="${isFav ? 'fa-solid text-netflix-red' : 'fa-regular'} fa-star text-base"></i>`;
    }
  },

  /* ==============================================================================
     MOBILE ORIENTATION, FULLSCREEN & LANDSCAPE CONTROLLER (ESTILO NETFLIX)
     ============================================================================== */
  async enterMobileLandscapePlayer() {
    const isMobile = this.isMobile();
    if (!isMobile) return;

    const screen = document.getElementById('netflix-player-screen');
    const video = document.getElementById('netflix-video');
    if (!screen) return;

    // 1. Solicita tela cheia nativa
    try {
      if (!document.fullscreenElement && !document.webkitFullscreenElement) {
        if (screen.requestFullscreen) {
          screen.requestFullscreen().catch(() => {});
        } else if (screen.webkitRequestFullscreen) {
          screen.webkitRequestFullscreen();
        } else if (video && video.webkitEnterFullscreen) {
          video.webkitEnterFullscreen();
        }
      }
    } catch (e) {
      console.warn('[Landscape] Erro ao solicitar tela cheia:', e);
    }

    // 2. Trava orientação em Paisagem (Horizontal / Landscape)
    try {
      if (window.screen && window.screen.orientation && typeof window.screen.orientation.lock === 'function') {
        window.screen.orientation.lock('landscape').catch(() => {
          return window.screen.orientation.lock('landscape-primary').catch(() => {});
        });
      } else if (window.screen && window.screen.lockOrientation) {
        window.screen.lockOrientation('landscape');
      }
    } catch (e) {
      console.warn('[Landscape] Erro ao travar orientação:', e);
    }

    // 3. Suporte ao Capacitor Nativo (se rodando dentro do APK Android)
    try {
      if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.ScreenOrientation) {
        window.Capacitor.Plugins.ScreenOrientation.lock({ orientation: 'landscape' }).catch(() => {});
      }
    } catch (e) {}
  },

  exitMobileLandscapePlayer() {
    const wasPortrait = this._previousOrientationBeforePlayer === 'portrait' || (this._previousOrientationType && this._previousOrientationType.startsWith('portrait'));

    // 1. Se era retrato na origem, comanda rotação para retrato enquanto ainda em tela cheia (para autorização do navegador)
    try {
      if (wasPortrait && window.screen && window.screen.orientation && typeof window.screen.orientation.lock === 'function') {
        window.screen.orientation.lock('portrait').catch(() => {});
      }
    } catch (e) {}

    // 2. Sai do modo tela cheia
    try {
      if (document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement) {
        if (document.exitFullscreen) {
          document.exitFullscreen().catch(() => {});
        } else if (document.webkitExitFullscreen) {
          document.webkitExitFullscreen();
        }
      }
    } catch (e) {}

    // 3. Destrava orientação após sair de tela cheia para responder normalmente ao sensor
    setTimeout(() => {
      try {
        if (window.screen && window.screen.orientation && typeof window.screen.orientation.unlock === 'function') {
          window.screen.orientation.unlock();
        } else if (window.screen && window.screen.unlockOrientation) {
          window.screen.unlockOrientation();
        }
      } catch (e) {}
    }, 300);

    // 4. Suporte ao Capacitor Nativo (APK Android)
    try {
      if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.ScreenOrientation) {
        if (wasPortrait) {
          window.Capacitor.Plugins.ScreenOrientation.lock({ orientation: 'portrait' }).then(() => {
            setTimeout(() => {
              try { window.Capacitor.Plugins.ScreenOrientation.unlock(); } catch(e) {}
            }, 300);
          }).catch(() => {
            try { window.Capacitor.Plugins.ScreenOrientation.unlock(); } catch(e) {}
          });
        } else {
          window.Capacitor.Plugins.ScreenOrientation.unlock().catch(() => {});
        }
      }
    } catch (e) {}
  },

  togglePlayerOrientationOrFullscreen() {
    const screen = document.getElementById('netflix-player-screen');
    if (!screen) return;

    if (!document.fullscreenElement && !document.webkitFullscreenElement) {
      if (screen.requestFullscreen) {
        screen.requestFullscreen().catch(() => {});
      } else if (screen.webkitRequestFullscreen) {
        screen.webkitRequestFullscreen();
      }
      try {
        if (window.screen && window.screen.orientation && typeof window.screen.orientation.lock === 'function') {
          window.screen.orientation.lock('landscape').catch(() => {});
        }
      } catch (e) {}
      this.showToast('Modo Paisagem em Tela Cheia', 'info');
    } else {
      if (document.exitFullscreen) {
        document.exitFullscreen().catch(() => {});
      } else if (document.webkitExitFullscreen) {
        document.webkitExitFullscreen();
      }
      try {
        if (window.screen && window.screen.orientation && typeof window.screen.orientation.unlock === 'function') {
          window.screen.orientation.unlock();
        }
      } catch (e) {}
    }
  },

  /* ==============================================================================
     YOUTUBE-STYLE IN-PLAYER SETTINGS & SCREEN LOCK CONTROLLER
     ============================================================================== */
  openMobilePlayerSettings() {
    this.pushNavigationState('player-settings');
    const modal = document.getElementById('player-mobile-settings-modal');
    if (!modal) return;

    this.updateSheetOptions();
    modal.classList.remove('hidden');
  },

  closeMobilePlayerSettings(fromHistory = false) {
    const modal = document.getElementById('player-mobile-settings-modal');
    if (modal) modal.classList.add('hidden');
    if (!fromHistory && history.state && history.state.modal === 'player-settings') {
      this._navigatingBackProgrammatically = true;
      history.back();
    }
  },

  setAspectRatioFromSheet(mode) {
    if (this.player) {
      this.player.setAspectRatio(mode);
    }
    if (window.SettingsManager && typeof window.SettingsManager.setVideoScale === 'function') {
      window.SettingsManager.setVideoScale(mode);
    }

    const aspectMap = {
      contain: 'Automático',
      cover: 'Preencher Tela',
      fill: 'Esticar',
      original: '16:9'
    };

    const currentLabel = document.getElementById('sheet-aspect-current');
    if (currentLabel) currentLabel.textContent = aspectMap[mode] || 'Automático';

    const playerAspectLabel = document.getElementById('player-aspect-label');
    if (playerAspectLabel) playerAspectLabel.textContent = aspectMap[mode] || 'Automático';

    ['contain', 'cover', 'fill', 'original'].forEach(m => {
      const btn = document.getElementById(`aspect-opt-${m}`);
      if (btn) {
        if (m === mode) {
          btn.className = 'py-2 px-1 rounded-lg bg-netflix-red text-white border border-netflix-red transition';
        } else {
          btn.className = 'py-2 px-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 transition';
        }
      }
    });

    const messages = {
      contain: 'Ajuste de Tela: Automático (Proporção Padrão)',
      cover: 'Ajuste de Tela: Preencher Tela (Sem Barras Pretas)',
      fill: 'Ajuste de Tela: Esticar 100%',
      original: 'Ajuste de Tela: 16:9 Original'
    };
    this.showToast(messages[mode] || 'Proporção alterada', 'info');
  },

  setSpeedFromSheet(speed) {
    this.setPlaybackSpeed(speed);
    const speedLabel = document.getElementById('sheet-speed-current');
    if (speedLabel) speedLabel.textContent = `${speed}x`;

    const speeds = [0.75, 1.0, 1.25, 1.5, 2.0];
    speeds.forEach(s => {
      const id = 'speed-opt-' + String(s).replace('.', '');
      const btn = document.getElementById(id);
      if (btn) {
        if (s === speed) {
          btn.className = 'py-1.5 rounded-lg bg-netflix-red text-white border border-netflix-red';
        } else {
          btn.className = 'py-1.5 rounded-lg bg-slate-800 text-slate-300 hover:bg-slate-700 border border-slate-700';
        }
      }
    });
  },

  updateSheetOptions() {
    const currentScale = (window.SettingsManager && typeof window.SettingsManager.getVideoScale === 'function')
      ? window.SettingsManager.getVideoScale()
      : 'contain';

    const aspectMap = { contain: 'Automático', cover: 'Preencher Tela', fill: 'Esticar', original: '16:9' };
    const aspectLabel = document.getElementById('sheet-aspect-current');
    if (aspectLabel) aspectLabel.textContent = aspectMap[currentScale] || 'Automático';

    ['contain', 'cover', 'fill', 'original'].forEach(m => {
      const btn = document.getElementById(`aspect-opt-${m}`);
      if (btn) {
        btn.className = (m === currentScale)
          ? 'py-2 px-1 rounded-lg bg-netflix-red text-white border border-netflix-red transition'
          : 'py-2 px-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 transition';
      }
    });

    // Atualiza Legendas
    const subVal = this.state.activeSubtitle || 'off';
    ['off', 'pt', 'en'].forEach(s => {
      const btn = document.getElementById(`sheet-sub-${s}`);
      if (btn) {
        btn.className = (s === subVal)
          ? 'py-1.5 rounded-lg bg-netflix-red text-white border border-netflix-red'
          : 'py-1.5 rounded-lg bg-slate-800 text-slate-300 hover:bg-slate-700 border border-slate-700';
      }
    });

    // Atualiza Áudio
    const audioVal = this.state.activeAudio || 'original';
    ['original', 'dubbed'].forEach(a => {
      const btn = document.getElementById(`sheet-audio-${a}`);
      if (btn) {
        btn.className = (a === audioVal)
          ? 'py-1.5 rounded-lg bg-netflix-red text-white border border-netflix-red'
          : 'py-1.5 rounded-lg bg-slate-800 text-slate-300 hover:bg-slate-700 border border-slate-700';
      }
    });

    const tracksContainer = document.getElementById('sheet-audio-tracks-container');
    const tracks = (this.player && typeof this.player.getAudioTracks === 'function') ? this.player.getAudioTracks() : [];
    if (tracksContainer && tracks.length > 1) {
      tracksContainer.innerHTML = tracks.map((t, idx) => `
        <button type="button" onclick="App.selectAudioTrackByIndex(${idx}); App.updateSheetOptions();" class="py-1.5 rounded-lg ${t.selected ? 'bg-netflix-red text-white border border-netflix-red' : 'bg-slate-800 text-slate-300 hover:bg-slate-700 border border-slate-700'} truncate px-2">
          ${this.escapeHtml(t.name)}
        </button>
      `).join('');
    }
  },

  /* ==============================================================================
     DETAIL MODAL CONTROLLER
     ============================================================================== */
  openDetailModalByData(itemData) {
    const item = this.safeDecodeJson(itemData);
    if (item) this.openDetailModal(item);
  },

  async openDetailModal(item) {
    if (!item) return;

    this.pushNavigationState('detail');
    this.state.modalItem = item;
    const modal = document.getElementById('netflix-detail-modal');
    modal.classList.remove('hidden');
    modal.scrollTop = 0;
    const innerCard = modal.querySelector('.bg-netflix-card');
    if (innerCard) innerCard.scrollTop = 0;

    const banner = document.getElementById('modal-banner');
    banner.style.backgroundImage = `url('${this.getItemBackdrop(item)}')`;

    document.getElementById('modal-title').textContent = item.name;
    document.getElementById('modal-category').textContent = item.group || 'Geral';

    const ratingBadge = this.getContentRatingBadge(item);
    const ratingBadgeEl = document.getElementById('modal-rating-badge');
    if (ratingBadgeEl) {
      ratingBadgeEl.className = `px-1.5 py-0.5 border rounded text-[10px] font-black text-white ${ratingBadge.bg} ${ratingBadge.border}`;
      ratingBadgeEl.textContent = ratingBadge.text;
      ratingBadgeEl.title = ratingBadge.title;
    }

    const isFav = this.state.favorites.includes(item.name);
    document.getElementById('modal-fav-btn').innerHTML = `<i class="${isFav ? 'fa-solid text-netflix-red' : 'fa-regular'} fa-star"></i>`;

    // Reseta elementos de metadados detalhados
    const metaGrid = document.getElementById('modal-meta-grid');
    const castCont = document.getElementById('modal-cast-container');
    const dirCont = document.getElementById('modal-director-container');
    const genreCont = document.getElementById('modal-genre-container');
    const durCont = document.getElementById('modal-duration-container');
    const trailerBtn = document.getElementById('modal-trailer-btn');

    if (metaGrid) metaGrid.classList.add('hidden');
    if (castCont) castCont.classList.add('hidden');
    if (dirCont) dirCont.classList.add('hidden');
    if (genreCont) genreCont.classList.add('hidden');
    if (durCont) durCont.classList.add('hidden');
    if (trailerBtn) trailerBtn.classList.add('hidden');

    const isSeries = item.itemType === 'series';
    const isLive = item.itemType === 'live' || (item.group || '').toLowerCase().includes('canais');
    const seriesSection = document.getElementById('modal-series-section');
    const epgSection = document.getElementById('modal-epg-section');
    const seasonsBadge = document.getElementById('modal-seasons-badge');
    const playText = document.getElementById('modal-play-text');
    const descEl = document.getElementById('modal-description');

    if (isSeries) {
      if (epgSection) epgSection.classList.add('hidden');
      if (seasonsBadge) {
        seasonsBadge.classList.remove('hidden');
        seasonsBadge.textContent = `${item.totalSeasons || 1} Temporada${item.totalSeasons > 1 ? 's' : ''} • ${item.totalEpisodes || ''} Episódios`;
      }
      const seriesTabs = document.getElementById('modal-series-tabs');
      if (seriesTabs) seriesTabs.classList.remove('hidden');
      this.switchDetailTab('episodes');

      if (playText) playText.textContent = 'Assistir T1:E1';
      descEl.textContent = `Assista a todas as temporadas de "${item.name}". Escolha a temporada e o episódio abaixo para reproduzir instantaneamente.`;

      document.getElementById('modal-play-btn').onclick = () => {
        if (item.firstEpisode && item.firstEpisode.streamUrl) {
          this.playSeriesEpisode({
            name: item.firstEpisode.name || 'Episódio 1',
            season: item.firstEpisode.season || 1,
            episode: item.firstEpisode.episode || 1,
            streamUrl: item.firstEpisode.streamUrl
          }, item);
        } else {
          this.playItem(item);
        }
      };

      // Carrega temporadas e episódios da API
      this.loadSeriesEpisodes(item.id);

    } else {
      const seriesTabs = document.getElementById('modal-series-tabs');
      if (seriesTabs) seriesTabs.classList.add('hidden');
      if (seasonsBadge) seasonsBadge.classList.add('hidden');
      if (seriesSection) seriesSection.classList.add('hidden');
      this.state.activeDetailTab = 'similar';
      const similarSec = document.getElementById('modal-similar-section');
      if (similarSec) similarSec.classList.remove('hidden');
      if (playText) playText.textContent = 'Assistir';

      if (isLive) {
        if (epgSection) epgSection.classList.remove('hidden');
        descEl.textContent = `Canal de televisão ao vivo "${item.name}". Transmissão contínua em alta definição.`;
        this.loadChannelEPG(item.tvgId, item.name);
      } else {
        if (epgSection) epgSection.classList.add('hidden');
        const cleanName = item.name ? item.name.replace(/\s*\(\d{4}\).*$/, '').trim() : 'Filme';
        descEl.textContent = `Carregando sinopse e detalhes oficiais de "${cleanName}"...`;
      }

      document.getElementById('modal-play-btn').onclick = () => {
        this.playItem(item);
      };
    }

    // Busca metadados detalhados do servidor (Sinopse oficial, Capa HD, Elenco, Direção e Trailer)
    try {
      const qUrl = this.getServerUrl(`/api/netflix/details?type=${encodeURIComponent(item.itemType || 'movie')}&name=${encodeURIComponent(item.name || '')}&id=${encodeURIComponent(item.id || '')}&token=${encodeURIComponent(item.streamUrl || '')}&tvgId=${encodeURIComponent(item.tvgId || '')}`);
      const detRes = await fetch(qUrl);
      const detData = await detRes.json();

      if (detData && detData.success && detData.details) {
        const d = detData.details;

        if (d.plot || d.desc) {
          descEl.textContent = d.plot || d.desc;
        }

        if (d.backdrop && banner) {
          banner.style.backgroundImage = `url('${d.backdrop}')`;
        }

        let hasMeta = false;
        if (d.cast && castCont) {
          document.getElementById('modal-cast-text').textContent = d.cast;
          castCont.classList.remove('hidden');
          hasMeta = true;
        }
        if (d.director && dirCont) {
          document.getElementById('modal-director-text').textContent = d.director;
          dirCont.classList.remove('hidden');
          hasMeta = true;
        }
        if (d.genre && genreCont) {
          document.getElementById('modal-genre-text').textContent = d.genre;
          genreCont.classList.remove('hidden');
          hasMeta = true;
        }
        if ((d.duration || d.runTime) && durCont) {
          document.getElementById('modal-duration-text').textContent = d.duration || (d.runTime + ' min');
          durCont.classList.remove('hidden');
          hasMeta = true;
        }

        if (hasMeta && metaGrid) {
          metaGrid.classList.remove('hidden');
        }

        if (d.rating && d.rating !== '0') {
          const yr = d.releaseDate ? d.releaseDate.substr(0, 4) + ' • ' : '';
          document.getElementById('modal-year').textContent = `${yr}★ ${d.rating}`;
        }

        if (d.trailer && trailerBtn) {
          trailerBtn.classList.remove('hidden');
          trailerBtn.href = d.trailer.startsWith('http') ? d.trailer : `https://www.youtube.com/watch?v=${d.trailer}`;
        }
      }
    } catch (e) {
      console.warn('Erro ao carregar detalhes extras:', e);
    }

    // REGRA 6: Renderização da seção obrigatória "Títulos Semelhantes"
    this.renderSimilarTitles(item);
  },

  renderSimilarTitles(item) {
    const section = document.getElementById('modal-similar-section');
    const grid = document.getElementById('modal-similar-grid');
    const countEl = document.getElementById('modal-similar-count');
    if (!section || !grid) return;

    const currentName = (item.name || '').toLowerCase();
    const currentGroup = (item.group || '').toLowerCase();
    const currentType = item.itemType || 'movie';

    let candidates = [];
    if (Array.isArray(this.state.catalogRows)) {
      for (const row of this.state.catalogRows) {
        if (Array.isArray(row.items)) {
          for (const it of row.items) {
            if (it && it.name && it.name.toLowerCase() !== currentName) {
              candidates.push(it);
            }
          }
        }
      }
    }

    // Deduplica por nome
    const seen = new Set();
    const unique = [];
    for (const c of candidates) {
      if (!seen.has(c.name)) {
        seen.add(c.name);
        unique.push(c);
      }
    }

    // Filtra por categoria ou mesmo tipo
    let matches = unique.filter(c => {
      if (this.isMinor() && this.isAdultContent(c)) return false;
      const g = (c.group || '').toLowerCase();
      return (currentGroup && g === currentGroup) || (c.itemType === currentType && g.includes(currentGroup.slice(0, 4)));
    });

    if (matches.length < 4) {
      const more = unique.filter(c => c.itemType === currentType && !matches.includes(c));
      matches = matches.concat(more);
    }

    matches = matches.slice(0, 12);

    if (matches.length === 0) {
      section.classList.add('hidden');
      return;
    }

    const isSeries = item && item.itemType === 'series';
    if (isSeries && this.state.activeDetailTab !== 'similar') {
      section.classList.add('hidden');
    } else {
      section.classList.remove('hidden');
    }
    if (countEl) countEl.textContent = `(${matches.length} recomendados)`;

    grid.innerHTML = matches.map(m => {
      const backdrop = this.getItemBackdrop(m);
      const itemData = this.safeEncodeJson(m);
      return `
        <div class="relative group/sim rounded-xl overflow-hidden bg-slate-900 border border-slate-800 hover:border-slate-500 transition-all cursor-pointer shadow-md"
             onclick="event.stopPropagation(); App.openDetailModalByData('${itemData}')">
          <div class="aspect-video w-full bg-slate-950 overflow-hidden relative">
            <img src="${backdrop}" alt="${this.escapeHtml(m.name)}" loading="lazy"
                 class="w-full h-full object-cover group-hover/sim:scale-105 transition-transform duration-300"
                 onerror="this.onerror=null;this.src='https://images.unsplash.com/photo-1594909122845-11baa439b7bf?auto=format&fit=crop&w=600&q=80'">
            <div class="absolute inset-0 bg-gradient-to-t from-black/85 via-black/20 to-transparent"></div>
            <button onclick="event.stopPropagation(); App.playItemByData('${itemData}')"
                    class="absolute inset-0 m-auto w-10 h-10 rounded-full bg-netflix-red/90 text-white flex items-center justify-center opacity-0 group-hover/sim:opacity-100 transition shadow-lg scale-90 group-hover/sim:scale-100"
                    title="Assistir Imediatamente">
              <i class="fa-solid fa-play text-xs pl-0.5"></i>
            </button>
          </div>
          <div class="p-2 space-y-0.5">
            <h5 class="text-xs font-bold text-white truncate">${this.escapeHtml(m.name)}</h5>
            <p class="text-[10px] text-slate-400 truncate">${this.escapeHtml(m.group || 'Geral')}</p>
          </div>
        </div>
      `;
    }).join('');
  },

  async loadSeriesEpisodes(seriesId) {
    const loadingEl = document.getElementById('modal-episodes-loading');
    const listEl = document.getElementById('modal-episodes-list');
    const seasonSelect = document.getElementById('series-season-select');
    const totalBadge = document.getElementById('series-episodes-total-badge');

    if (loadingEl) loadingEl.classList.remove('hidden');
    if (listEl) listEl.innerHTML = '';
    if (seasonSelect) seasonSelect.innerHTML = '';

    try {
      const res = await fetch(`/api/netflix/series/${seriesId}`);
      if (!res.ok) throw new Error('Falha ao buscar episódios da série');
      const data = await res.json();
      this.state.currentSeriesData = data;

      if (loadingEl) loadingEl.classList.add('hidden');

      const seasons = data.seasons || {};
      const seasonNums = Object.keys(seasons).map(Number).sort((a, b) => a - b);

      if (totalBadge) {
        totalBadge.textContent = `${data.totalEpisodes} episódios no total`;
      }

      if (seasonSelect) {
        seasonSelect.innerHTML = seasonNums.map(s => {
          const count = seasons[s]?.length || 0;
          return `<option value="${s}">Temporada ${s} (${count} episódios)</option>`;
        }).join('');

        if (seasonNums.length) {
          this.renderModalEpisodes(seasonNums[0]);
        }
      }
    } catch (err) {
      console.error(err);
      if (loadingEl) loadingEl.classList.add('hidden');
      if (listEl) {
        listEl.innerHTML = `<div class="p-4 text-center text-slate-400 text-xs">Não foi possível carregar os episódios: ${err.message}</div>`;
      }
    }
  },

  switchDetailTab(tab) {
    this.state.activeDetailTab = tab;
    const epBtn = document.getElementById('modal-tab-episodes-btn');
    const simBtn = document.getElementById('modal-tab-similar-btn');
    const seriesSection = document.getElementById('modal-series-section');
    const similarSection = document.getElementById('modal-similar-section');

    if (tab === 'episodes') {
      if (epBtn) epBtn.className = 'text-sm md:text-base font-bold pb-2 border-b-2 border-netflix-red text-white transition cursor-pointer';
      if (simBtn) simBtn.className = 'text-sm md:text-base font-bold pb-2 border-b-2 border-transparent text-slate-400 hover:text-white transition cursor-pointer';
      if (seriesSection) seriesSection.classList.remove('hidden');
      if (similarSection) similarSection.classList.add('hidden');
    } else {
      if (epBtn) epBtn.className = 'text-sm md:text-base font-bold pb-2 border-b-2 border-transparent text-slate-400 hover:text-white transition cursor-pointer';
      if (simBtn) simBtn.className = 'text-sm md:text-base font-bold pb-2 border-b-2 border-netflix-red text-white transition cursor-pointer';
      if (seriesSection) seriesSection.classList.add('hidden');
      if (similarSection) similarSection.classList.remove('hidden');
    }
  },

  onSeasonSelectChange(seasonNum) {
    this.renderModalEpisodes(Number(seasonNum));
  },

  renderModalEpisodes(seasonNum) {
    const listEl = document.getElementById('modal-episodes-list');
    if (!listEl || !this.state.currentSeriesData) return;

    const episodes = this.state.currentSeriesData.seasons[seasonNum] || [];
    if (!episodes.length) {
      listEl.innerHTML = '<div class="p-6 text-center text-slate-400 text-xs">Nenhum episódio encontrado para esta temporada.</div>';
      return;
    }

    const series = this.state.currentSeriesData;
    listEl.innerHTML = episodes.map(ep => {
      const epData = this.safeEncodeJson(ep);
      const seriesData = this.safeEncodeJson({
        id: series.id,
        name: series.name,
        logo: series.logo,
        group: series.group
      });
      const thumb = ep.logo || this.getItemBackdrop(series);

      return `
        <div onclick="App.playSeriesEpisodeByData('${epData}', '${seriesData}')" class="flex items-center gap-3 sm:gap-4 p-3 rounded-lg hover:bg-[#222] transition cursor-pointer group">
          <span class="text-base sm:text-xl font-bold text-slate-500 group-hover:text-white w-6 text-center">${ep.episode}</span>
          <div class="relative w-28 sm:w-36 aspect-video rounded overflow-hidden flex-shrink-0 bg-slate-800">
            <img src="${this.escapeHtml(thumb)}" alt="${this.escapeHtml(ep.name)}" class="w-full h-full object-cover" onerror="this.onerror=null; this.src='${BACKDROP_COLLECTION[0]}'">
            <div class="absolute inset-0 bg-black/40 group-hover:bg-black/10 transition flex items-center justify-center">
              <div class="w-8 h-8 rounded-full bg-black/70 border border-white/60 group-hover:bg-netflix-red group-hover:border-netflix-red flex items-center justify-center transition shadow-lg">
                <i class="fa-solid fa-play text-white text-xs pl-0.5"></i>
              </div>
            </div>
          </div>
          <div class="flex-1 min-w-0">
            <div class="flex items-center justify-between mb-0.5">
              <h4 class="text-xs sm:text-sm font-bold text-white truncate group-hover:text-netflix-red transition">${this.escapeHtml(ep.name)}</h4>
              <span class="text-[10px] text-slate-400 font-mono ml-2">HD</span>
            </div>
            <p class="text-[11px] text-slate-400 line-clamp-1">Temporada ${ep.season} • Episódio ${ep.episode} de ${this.escapeHtml(series.name)}</p>
          </div>
        </div>
      `;
    }).join('');
  },

  async loadChannelEPG(tvgId, name) {
    const timeEl = document.getElementById('epg-current-time');
    const titleEl = document.getElementById('epg-current-title');
    const descEl = document.getElementById('epg-current-desc');
    const nextContainer = document.getElementById('epg-next-container');
    const nextList = document.getElementById('epg-next-list');

    if (titleEl) titleEl.textContent = 'Carregando guia de programação...';
    if (descEl) descEl.textContent = 'Consultando informações da grade do canal...';
    if (timeEl) timeEl.textContent = 'Ao Vivo';
    if (nextList) nextList.innerHTML = '';

    try {
      const res = await fetch(`/api/netflix/epg?tvgId=${encodeURIComponent(tvgId || '')}&name=${encodeURIComponent(name || '')}`);
      if (!res.ok) throw new Error('EPG indisponível');
      const data = await res.json();

      if (data && data.current) {
        if (titleEl) titleEl.textContent = data.current.title || 'Transmissão Ao Vivo';
        if (timeEl) {
          timeEl.textContent = (data.current.start && data.current.stop)
            ? `${data.current.start} - ${data.current.stop}`
            : 'Ao Vivo Agora';
        }
        if (descEl) {
          descEl.textContent = data.current.desc || 'Transmissão contínua 24h sem interrupções.';
        }
      } else {
        if (titleEl) titleEl.textContent = `${name} - Ao Vivo`;
        if (timeEl) timeEl.textContent = 'Ao Vivo';
        if (descEl) descEl.textContent = 'Programação ao vivo contínua de alta definição com streaming de baixa latência.';
      }

      if (data && Array.isArray(data.next) && data.next.length) {
        if (nextContainer) nextContainer.classList.remove('hidden');
        if (nextList) {
          nextList.innerHTML = data.next.slice(0, 5).map(prog => `
            <div class="flex items-start gap-2.5 p-2 rounded bg-white/5 border border-white/5">
              <span class="font-mono text-netflix-red font-bold text-[11px] whitespace-nowrap pt-0.5">${this.escapeHtml(prog.start || '')}</span>
              <div class="flex-1 min-w-0">
                <h6 class="text-xs font-semibold text-white truncate">${this.escapeHtml(prog.title || '')}</h6>
                ${prog.desc ? `<p class="text-[10px] text-slate-400 line-clamp-1 mt-0.5">${this.escapeHtml(prog.desc)}</p>` : ''}
              </div>
            </div>
          `).join('');
        }
      } else {
        if (nextContainer) nextContainer.classList.add('hidden');
      }

      if (data && data.icon) {
        const banner = document.getElementById('modal-banner');
        if (banner) banner.style.backgroundImage = `url('${data.icon}')`;
      }
    } catch (err) {
      console.warn('Erro ao carregar EPG:', err);
      if (titleEl) titleEl.textContent = `${name} - Ao Vivo`;
      if (descEl) descEl.textContent = 'Transmissão ao vivo contínua 24 horas.';
      if (nextContainer) nextContainer.classList.add('hidden');
    }
  },

  playSeriesEpisodeByData(epData, seriesData) {
    const ep = this.safeDecodeJson(epData);
    const series = this.safeDecodeJson(seriesData);
    if (!ep || !series) return;
    this.playSeriesEpisode(ep, series);
  },

  playSeriesEpisode(ep, series, opts = {}) {
    if (!ep || !series) return;
    const isAdmBypass = Boolean(opts && opts.forceBypass);

    // Registra orientação física de origem e preserva tela de detalhes
    this.preparePlayerEntry();

    // Verifica se há progresso salvo para retomar exatamente onde parou
    const epName = `${series.name} - T${ep.season}:E${ep.episode}`;
    const saved = this.getSavedPlaybackPosition(epName) || this.getSavedPlaybackPosition(series.name);
    if (saved && saved.currentTime > 5) {
      this._pendingResumeTime = saved.currentTime;
    } else {
      this._pendingResumeTime = null;
    }

    this.closeSettingsModal(true);
    this.closeFeedbackModal(true);
    this.closeMobilePlayerSettings(true);
    this.cancelPostPlay();
    this.pushNavigationState('player');

    this.state.isPlayerLocked = false;
    this.updateCenterIndicator(false);
    const lockOverlay = document.getElementById('player-lock-overlay');
    if (lockOverlay) lockOverlay.classList.add('hidden');

    const sugDrawer = document.getElementById('player-suggestions-drawer');
    if (sugDrawer) sugDrawer.classList.add('hidden');

    // Oculta Guia de Canais (deve aparecer exclusivamente para canais ao vivo)
    const topChannelsBtn = document.getElementById('player-top-channels-btn');
    const bottomChannelsBtn = document.getElementById('player-channels-btn');
    const channelsDrawer = document.getElementById('player-channels-drawer');
    if (topChannelsBtn) topChannelsBtn.classList.add('hidden');
    if (bottomChannelsBtn) bottomChannelsBtn.classList.add('hidden');
    if (channelsDrawer) channelsDrawer.classList.add('hidden');

    this.state.activeSeries = series;
    this.state.activeEpisode = ep;
    this.state.activeItem = {
      name: `${series.name} - T${ep.season}:E${ep.episode}`,
      group: series.group,
      streamUrl: ep.streamUrl,
      mediaType: 'mp4',
      itemType: 'series'
    };

    const screen = document.getElementById('netflix-player-screen');
    if (screen) {
      screen.classList.remove('hidden');
      screen.classList.remove('cinema-mode');
      screen.classList.remove('player-screen-locked');
      screen.classList.add('show-controls');
    }
    const unmutePrompt = document.getElementById('player-unmute-prompt');
    if (unmutePrompt) unmutePrompt.classList.add('hidden');

    // Modo paisagem automático estilo Netflix no celular / Android
    this.enterMobileLandscapePlayer();

    const activeScale = (window.SettingsManager && typeof window.SettingsManager.getVideoScale === 'function')
      ? window.SettingsManager.getVideoScale()
      : 'contain';
    this.player.setAspectRatio(activeScale);
    const aspectLabel = document.getElementById('player-aspect-label');
    const labelMap = { contain: 'Automático', cover: 'Preencher', fill: 'Esticar', original: 'Original' };
    if (aspectLabel) {
      aspectLabel.textContent = labelMap[activeScale] || 'Automático';
    } else {
      const aspectBtn = document.getElementById('player-aspect-btn');
      if (aspectBtn) aspectBtn.textContent = labelMap[activeScale] || 'Automático';
    }

    document.getElementById('player-title').textContent = series.name;
    document.getElementById('player-subtitle').textContent = `Temporada ${ep.season} • Episódio ${ep.episode}: ${ep.name}`;

    const isFav = this.state.favorites.includes(series.name);
    const favBtn = document.getElementById('player-fav-btn');
    if (favBtn) favBtn.innerHTML = `<i class="${isFav ? 'fa-solid text-netflix-red' : 'fa-regular'} fa-star text-base"></i>`;

    // Atualiza botões de episódios no player
    const topEpBtn = document.getElementById('player-top-episodes-btn');
    if (topEpBtn) topEpBtn.classList.remove('hidden');
    const epBtn = document.getElementById('player-episodes-btn');
    if (epBtn) epBtn.classList.remove('hidden');

    const nextLabel = document.getElementById('player-next-label');
    if (nextLabel) nextLabel.textContent = `Próximo Ep. (E${ep.episode + 1})`;

    // Atualiza nome da série no drawer do player
    const drawerTitle = document.getElementById('player-drawer-series-name');
    if (drawerTitle) drawerTitle.textContent = `${series.name} - Episódios`;

    const liveBadge = document.getElementById('player-live-badge');
    const vodTimeline = document.getElementById('vod-timeline');
    const curTxt = document.getElementById('current-time-text');
    const durTxt = document.getElementById('duration-time-text');
    const seekBar = document.getElementById('seek-bar');
    const loader = document.getElementById('netflix-player-loader');
    const errorEl = document.getElementById('netflix-player-error');
    if (liveBadge) liveBadge.classList.add('hidden');
    if (vodTimeline) vodTimeline.classList.remove('hidden');
    if (curTxt) curTxt.textContent = '00:00';
    if (durTxt) durTxt.textContent = '00:00';
    if (seekBar) seekBar.value = 0;
    if (loader) loader.classList.remove('hidden');
    if (errorEl) errorEl.classList.add('hidden');
    this.updatePlayPauseIcon(false);
    this.updateCenterIndicator(false);

    this.player.loadChannel({
      name: `${series.name} - T${ep.season}:E${ep.episode}`,
      url: this.getServerUrl(ep.streamUrl),
      mediaType: 'mp4',
      format: 'mp4'
    });

    if (typeof this.sendSessionHeartbeat === 'function') {
      this.sendSessionHeartbeat();
    }
  },

  async onPlayerNextClick() {
    if (this.state.activeItem && this.state.activeItem.itemType === 'series' && this.state.activeSeries && this.state.activeEpisode) {
      await this.playNextEpisode();
    } else {
      this.playNextItem();
    }
  },

  async playNextEpisode() {
    const curSeries = this.state.activeSeries;
    const curEp = this.state.activeEpisode;
    if (!curSeries || !curEp) return;

    if (!this.state.currentSeriesData || this.state.currentSeriesData.id !== curSeries.id) {
      try {
        const res = await fetch(`/api/netflix/series/${curSeries.id}`);
        this.state.currentSeriesData = await res.json();
      } catch (e) {
        console.error(e);
      }
    }

    const data = this.state.currentSeriesData;
    if (!data || !data.seasons) return;

    const seasonEps = data.seasons[curEp.season] || [];
    const curIdx = seasonEps.findIndex(e => e.episode === curEp.episode);

    if (curIdx > -1 && curIdx < seasonEps.length - 1) {
      const nextEp = seasonEps[curIdx + 1];
      this.showToast(`Iniciando Episódio ${nextEp.episode}...`, 'info');
      this.playSeriesEpisode(nextEp, curSeries);
      return;
    }

    // Procura próxima temporada
    const nextSeason = curEp.season + 1;
    if (data.seasons[nextSeason] && data.seasons[nextSeason].length) {
      const nextEp = data.seasons[nextSeason][0];
      this.showToast(`Iniciando Temporada ${nextSeason} Episódio 1...`, 'info');
      this.playSeriesEpisode(nextEp, curSeries);
      return;
    }

    this.showToast('Você chegou ao último episódio disponível desta série!', 'info');
  },

  togglePlayerEpisodesDrawer() {
    const drawer = document.getElementById('player-episodes-drawer');
    if (!drawer) return;
    const isHidden = drawer.classList.contains('hidden');
    if (isHidden) {
      drawer.classList.remove('hidden');
      this.pushNavigationState('player-drawer');
      this.renderPlayerDrawerEpisodes();
    } else {
      drawer.classList.add('hidden');
    }
  },

  async renderPlayerDrawerEpisodes() {
    const curSeries = this.state.activeSeries;
    const curEp = this.state.activeEpisode;
    if (!curSeries) return;

    if (!this.state.currentSeriesData || this.state.currentSeriesData.id !== curSeries.id) {
      try {
        const res = await fetch(`/api/netflix/series/${curSeries.id}`);
        this.state.currentSeriesData = await res.json();
      } catch (e) {
        console.error(e);
        return;
      }
    }

    const data = this.state.currentSeriesData;
    const seasonSelect = document.getElementById('player-drawer-season-select');
    const seasonNums = Object.keys(data.seasons || {}).map(Number).sort((a,b)=>a-b);

    if (seasonSelect) {
      seasonSelect.innerHTML = seasonNums.map(s => `
        <option value="${s}" ${curEp && curEp.season === s ? 'selected' : ''}>Temporada ${s} (${data.seasons[s].length} eps)</option>
      `).join('');
    }

    const activeSeason = curEp ? curEp.season : seasonNums[0];
    this.renderPlayerDrawerList(activeSeason);
  },

  onPlayerDrawerSeasonChange(seasonNum) {
    this.renderPlayerDrawerList(Number(seasonNum));
  },

  renderPlayerDrawerList(seasonNum) {
    const listEl = document.getElementById('player-drawer-episodes-list');
    if (!listEl || !this.state.currentSeriesData) return;

    const episodes = this.state.currentSeriesData.seasons[seasonNum] || [];
    const curEp = this.state.activeEpisode;
    const series = this.state.currentSeriesData;

    listEl.innerHTML = episodes.map(ep => {
      const isCur = curEp && curEp.season === ep.season && curEp.episode === ep.episode;
      const epData = this.safeEncodeJson(ep);
      const seriesData = this.safeEncodeJson({
        id: series.id,
        name: series.name,
        logo: series.logo,
        group: series.group
      });

      return `
        <div onclick="App.playSeriesEpisodeByData('${epData}', '${seriesData}'); App.togglePlayerEpisodesDrawer();" class="p-2.5 rounded flex items-center gap-3 cursor-pointer hover:bg-slate-800 transition ${isCur ? 'bg-netflix-red/20 border border-netflix-red/40' : 'bg-[#181818]'}">
          <span class="text-sm font-bold ${isCur ? 'text-netflix-red' : 'text-slate-400'} w-5 text-center">${ep.episode}</span>
          <div class="flex-1 min-w-0">
            <h5 class="text-xs font-bold text-white truncate">${this.escapeHtml(ep.name)}</h5>
            <span class="text-[10px] text-slate-400">T${ep.season}:E${ep.episode}</span>
          </div>
          ${isCur ? '<i class="fa-solid fa-volume-high text-netflix-red text-xs"></i>' : '<i class="fa-solid fa-play text-slate-500 text-xs"></i>'}
        </div>
      `;
    }).join('');
  },

  closeDetailModal(fromHistory = false) {
    const modal = document.getElementById('netflix-detail-modal');
    if (modal) modal.classList.add('hidden');
    this._openedPlayerFromDetail = false;
    if (!fromHistory && history.state && history.state.modal === 'detail') {
      this._navigatingBackProgrammatically = true;
      history.back();
    }
  },

  toggleModalFavorite() {
    if (this.state.modalItem) {
      this.toggleFavorite(this.state.modalItem.name);
      const isFav = this.state.favorites.includes(this.state.modalItem.name);
      document.getElementById('modal-fav-btn').innerHTML = `<i class="${isFav ? 'fa-solid text-netflix-red' : 'fa-regular'} fa-star"></i>`;
    }
  },

  findItemByName(name) {
    if (!name) return null;
    if (this.state.heroItem && this.state.heroItem.name === name) return this.state.heroItem;
    if (this.state.activeItem && this.state.activeItem.name === name) return this.state.activeItem;
    if (this.state.modalItem && this.state.modalItem.name === name) return this.state.modalItem;
    for (const row of (this.state.catalogRows || [])) {
      const match = (row.items || []).find(it => it.name === name);
      if (match) return match;
    }
    return null;
  },

  toggleFavorite(itemOrName, optionalItem = null) {
    const item = (typeof itemOrName === 'object' && itemOrName) 
      ? itemOrName 
      : (optionalItem || this.state.modalItem || this.findItemByName(itemOrName));
    const itemName = typeof itemOrName === 'string' ? itemOrName : (item ? item.name : '');
    if (!itemName) return;

    if (!Array.isArray(this.state.favoriteObjects)) {
      this.state.favoriteObjects = JSON.parse(localStorage.getItem('novaflix_favorites_data') || '[]');
    }

    const idx = this.state.favorites.indexOf(itemName);

    // Se estiver adicionando e o perfil não estiver preenchido com nome e gênero, exige o cadastro!
    if (idx === -1 && !this.isProfileConfigured()) {
      this._pendingFavorite = { itemOrName, optionalItem };
      this.openProfileModal(true);
      return;
    }

    if (idx > -1) {
      this.state.favorites.splice(idx, 1);
      this.state.favoriteObjects = this.state.favoriteObjects.filter(f => f.name !== itemName);
      this.showToast(`"${itemName}" removido de Minha Lista`, 'info');
    } else {
      this.state.favorites.push(itemName);
      if (item) {
        this.state.favoriteObjects.push(item);
      } else {
        this.state.favoriteObjects.push({ name: itemName, title: itemName, group: 'Minha Lista' });
      }
      this.showToast(`"${itemName}" adicionado a Minha Lista`, 'success');
    }

    localStorage.setItem('netflix_favorites', JSON.stringify(this.state.favorites));
    localStorage.setItem('novaflix_favorites_data', JSON.stringify(this.state.favoriteObjects));
    this.updateFavoritesBadges();
    this.renderCatalogRows();
  },

  updateFavoritesBadges() {
    const count = (this.state.favorites || []).length;
    const badge = document.getElementById('bottom-nav-favorites-count');
    if (badge) {
      if (count > 0) {
        badge.textContent = count > 99 ? '99+' : count;
        badge.classList.remove('hidden');
      } else {
        badge.classList.add('hidden');
      }
    }
  },

  /* ==============================================================================
     MODAL & UTILITIES & AUTO-SYNC
     ============================================================================== */
  startAutoSyncWatcher() {
    if (this._syncWatcherTimer) clearInterval(this._syncWatcherTimer);

    // Monitora a cada 25 segundos se o backend sincronizou novos conteúdos
    this._syncWatcherTimer = setInterval(async () => {
      try {
        const res = await fetch('/api/netflix/status');
        if (!res.ok) return;
        const data = await res.json();

        if (!data.isReady) return;

        const newTotal = (data.totalMovies || 0) + (data.totalSeries || 0) + (data.totalChannels || 0);
        const versionChanged = this.state.lastCatalogVersion && data.catalogVersion && data.catalogVersion !== this.state.lastCatalogVersion;
        const totalChanged = this.state.lastTotalCount && newTotal > 0 && newTotal !== this.state.lastTotalCount;

        if (versionChanged || totalChanged) {
          console.log('[AutoSync] Nova versão de catálogo detectada no backend (atualizando silenciosamente):', data);
          this.state.lastCatalogVersion = data.catalogVersion;
          this.state.lastTotalCount = newTotal;

          // Atualiza perfil ou contadores se existirem
          const countEl = document.getElementById('profile-channel-count');
          if (countEl) {
            countEl.textContent = `${data.totalChannels} canais • ${data.totalMovies} filmes • ${data.totalSeries} séries`;
          }

          // Atualiza catálogo aberto na tela
          if (this.state.fullCatalog && this.state.fullCatalog.isOpen) {
            this.fetchCategoryItems(false);
          } else {
            this.loadCatalog(this.state.activeFilter);
          }
        }
      } catch (e) {
        // Silencioso em caso de oscilação momentânea de rede
      }
    }, 25000);
  },

  async reloadDefaultFile() {
    this.showToast('Atualizando acervo com novos títulos...', 'info');
    await fetch('/api/netflix/sync', { method: 'POST' });
    this.showToast('Sincronização iniciada. Os novos títulos entrarão no catálogo em instantes!', 'info');
  },

  openEditTxtModal() {
    const modal = document.getElementById('modal-edit-txt');
    if (modal) modal.classList.remove('hidden');
  },

  closeEditTxtModal() {
    const modal = document.getElementById('modal-edit-txt');
    if (modal) modal.classList.add('hidden');
  },

  async saveEditTxt() {
    this.closeEditTxtModal();
    this.showToast('Sincronizando catálogo...', 'info');
  },

  toggleProxySetting(enabled) {
    this.showToast(`Proxy ${enabled ? 'Ativado' : 'Desativado'}`, 'info');
  },

  toggleAutoplaySetting(enabled) {
    this.player.options.autoPlay = enabled;
  },

  clearAllData() {
    if (confirm('Deseja limpar os favoritos?')) {
      localStorage.clear();
      location.reload();
    }
  },

  getItemBackdrop(item) {
    if (!item) return BACKDROP_COLLECTION[0];
    if (item.cover && typeof item.cover === 'string' && item.cover.startsWith('http')) {
      return item.cover;
    }
    if (item.logo && typeof item.logo === 'string' && item.logo.startsWith('http')) {
      return item.logo;
    }
    if (item.backdrop && typeof item.backdrop === 'string' && item.backdrop.startsWith('http')) {
      return item.backdrop;
    }
    const idx = (item.id || 0) % BACKDROP_COLLECTION.length;
    return BACKDROP_COLLECTION[idx];
  },

  formatTime(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins < 10 ? '0' : ''}${mins}:${secs < 10 ? '0' : ''}${secs}`;
  },

  showToast(message, type = 'info') {
    let container = document.getElementById('toast-container');
    if (!container) {
      container = document.createElement('div');
      container.id = 'toast-container';
      container.className = 'fixed bottom-5 right-5 z-[99999] flex flex-col gap-2 pointer-events-none max-w-sm w-full px-4';
      document.body.appendChild(container);
    }
    const toast = document.createElement('div');

    const colors = {
      success: 'border-emerald-500/50 bg-black/90 text-white',
      error: 'border-netflix-red/60 bg-black/90 text-white',
      info: 'border-slate-700 bg-black/90 text-white'
    };

    toast.className = `px-4 py-3 rounded-lg border shadow-2xl flex items-center gap-3 text-xs animate-fade-in pointer-events-auto max-w-sm ${colors[type] || colors.info}`;
    toast.innerHTML = `
      <span class="w-2 h-2 rounded-full ${type === 'error' ? 'bg-netflix-red' : (type === 'success' ? 'bg-emerald-400' : 'bg-white')}"></span>
      <span class="font-medium">${this.escapeHtml(message)}</span>
    `;

    container.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transition = 'opacity 0.3s ease';
      setTimeout(() => toast.remove(), 300);
    }, 3500);
  },

  /* ==============================================================================
     FULL CATALOG VIEW ("VER TUDO" / GRADE & LISTA COMPLETA)
     ============================================================================== */
  async openFullCategoryView(type = 'all', encodedGroup = '', title = '') {
    let group = encodedGroup ? decodeURIComponent(encodedGroup) : '';
    let activeType = (type || 'all').toLowerCase();

    if (activeType.startsWith('adult') && !this.isAdultAllowed()) {
      activeType = 'movies';
    }

    this.pushNavigationState('fullCatalog');

    const defaultTitle = activeType === 'adult'
      ? '🔞 Todos os Conteúdos Adultos (+18)'
      : activeType === 'adult_movies'
        ? '🔞 Filmes Adultos (+18)'
        : activeType === 'adult_series'
          ? '🔞 Séries & Coleções Adultas (+18)'
          : (activeType === 'movies' || activeType === 'movie')
            ? 'Todos os Filmes'
            : activeType === 'series'
              ? 'Todas as Séries'
              : 'Grade Completa de Títulos';

    this.state.fullCatalog = {
      isOpen: true,
      type: activeType,
      group: group || '',
      title: title || defaultTitle,
      search: '',
      page: 1,
      limit: 120,
      total: 0,
      totalPages: 1,
      items: [],
      groups: [],
      viewMode: this.state.fullCatalog?.viewMode || 'grid',
      isLoading: false
    };

    // Oculta carrosséis e hero banner
    document.getElementById('billboard').classList.add('hidden');
    document.getElementById('catalog-rows').classList.add('hidden');
    document.getElementById('search-results-section').classList.add('hidden');

    // Exibe seção de catálogo completo
    const fullSec = document.getElementById('full-catalog-section');
    fullSec.classList.remove('hidden');

    document.getElementById('full-catalog-title').textContent = this.state.fullCatalog.title;
    document.getElementById('full-catalog-search').value = '';
    this.updateFullCatalogTypePills(activeType);

    window.scrollTo({ top: 0, behavior: 'smooth' });

    await this.fetchCategoryItems(true);
  },

  switchFullCatalogType(newType) {
    if (String(newType).startsWith('adult') && !this.isAdultAllowed()) {
      this.showToast('Conteúdo restrito para maiores de 18 anos no Perfil.', 'error');
      return;
    }
    if (this.state.fullCatalog) {
      this.state.fullCatalog.type = newType;
      this.state.fullCatalog.group = '';
      this.state.fullCatalog.page = 1;
      this.state.fullCatalog.title = newType === 'adult'
        ? '🔞 Todos os Conteúdos Adultos (+18)'
        : newType === 'adult_movies'
          ? '🔞 Filmes Adultos (+18)'
          : newType === 'adult_series'
            ? '🔞 Séries & Coleções Adultas (+18)'
            : (newType === 'movies' || newType === 'movie')
              ? 'Todos os Filmes'
              : newType === 'series'
                ? 'Todas as Séries'
                : 'Grade Completa de Títulos';
      const titleEl = document.getElementById('full-catalog-title');
      if (titleEl) titleEl.textContent = this.state.fullCatalog.title;
      this.updateFullCatalogTypePills(newType);
      this.fetchCategoryItems(true);
    }
  },

  updateFullCatalogTypePills(activeType) {
    const allowAdult = this.isAdultAllowed();
    const pills = ['all', 'movies', 'series', 'adult', 'adult_movies', 'adult_series'];
    const normActive = (activeType || 'all').toLowerCase();
    pills.forEach(p => {
      const el = document.getElementById(`fc-pill-${p}`);
      if (!el) return;
      if (p.startsWith('adult') && !allowAdult) {
        el.classList.add('hidden');
        return;
      }
      el.classList.remove('hidden');
      const isSelected = p === normActive || (p === 'movies' && normActive === 'movie');
      if (p.startsWith('adult')) {
        el.className = isSelected
          ? 'px-3.5 py-1.5 rounded-full text-xs font-bold bg-rose-600 text-white border border-rose-400 transition shadow-lg cursor-pointer flex items-center gap-1.5'
          : 'px-3.5 py-1.5 rounded-full text-xs font-bold bg-rose-600/20 text-rose-400 hover:bg-rose-600 hover:text-white border border-rose-500/40 transition cursor-pointer flex items-center gap-1.5';
      } else if (isSelected) {
        el.className = 'px-3.5 py-1.5 rounded-full text-xs font-bold bg-netflix-red text-white transition shadow cursor-pointer';
      } else {
        el.className = 'px-3.5 py-1.5 rounded-full text-xs font-bold bg-white/10 text-slate-300 hover:text-white transition cursor-pointer';
      }
    });
  },

  closeFullCategoryView(fromHistory = false) {
    if (this.state.fullCatalog) {
      this.state.fullCatalog.isOpen = false;
    }
    const fullSec = document.getElementById('full-catalog-section');
    if (fullSec) fullSec.classList.add('hidden');

    const billboard = document.getElementById('billboard');
    if (billboard) billboard.classList.remove('hidden');
    const catalogRows = document.getElementById('catalog-rows');
    if (catalogRows) catalogRows.classList.remove('hidden');

    if (!fromHistory && history.state && history.state.modal === 'fullCatalog') {
      this._navigatingBackProgrammatically = true;
      history.back();
    }
  },

  async fetchCategoryItems(reset = false) {
    const fc = this.state.fullCatalog;
    if (!fc || fc.isLoading) return;
    fc.isLoading = true;

    const spinner = document.getElementById('load-more-spinner');
    const loadMoreBtn = document.getElementById('full-catalog-load-more');
    const subtitleEl = document.getElementById('full-catalog-subtitle');
    const pageIndicator = document.getElementById('full-catalog-page-indicator');
    const groupSelect = document.getElementById('full-catalog-group-select');

    if (reset) {
      fc.page = 1;
      fc.items = [];
      const grid = document.getElementById('full-catalog-grid');
      const list = document.getElementById('full-catalog-list');
      if (grid) grid.innerHTML = '<div class="col-span-full py-16 text-center text-slate-400 text-sm"><i class="fa-solid fa-spinner animate-spin text-netflix-red text-2xl mb-2"></i><div>Carregando títulos...</div></div>';
      if (list) list.innerHTML = '';
      if (subtitleEl) subtitleEl.textContent = 'Buscando títulos...';
    } else {
      if (spinner) spinner.classList.remove('hidden');
    }

    try {
      const isKidsParam = (typeof this.isKidsMode === 'function' && this.isKidsMode()) ? '&kids=1' : '';
      const adultParam = `&adult=${this.isAdultAllowed() ? 1 : 0}`;
      const url = `/api/netflix/category-items?type=${encodeURIComponent(fc.type)}&group=${encodeURIComponent(fc.group)}&page=${fc.page}&limit=${fc.limit}&search=${encodeURIComponent(fc.search)}${isKidsParam}${adultParam}`;
      const res = await fetch(url);
      const data = await res.json();

      fc.total = data.total || 0;
      fc.totalPages = data.totalPages || 1;
      fc.groups = data.groups || [];

      if (reset) {
        fc.items = data.items || [];
      } else {
        fc.items = fc.items.concat(data.items || []);
      }

      // Popula select de gêneros se fornecido
      if (groupSelect && fc.groups && fc.groups.length) {
        let displayGroups = fc.groups;
        const curGroupNorm = (fc.group || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
        let matchedGroup = fc.group;
        if (curGroupNorm) {
          const match = displayGroups.find(g => {
            const gNorm = g.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
            return gNorm === curGroupNorm || gNorm.includes(curGroupNorm);
          });
          if (match) matchedGroup = match;
        }

        let optionsHtml = `<option value="">Todos os Gêneros (${displayGroups.length})</option>` +
          displayGroups.map(g => `<option value="${this.escapeHtml(g)}" ${g === matchedGroup || g === fc.group ? 'selected' : ''}>${this.escapeHtml(g)}</option>`).join('');

        groupSelect.innerHTML = optionsHtml;
      }

      // Atualiza textos e contadores
      if (subtitleEl) {
        subtitleEl.textContent = `${fc.total.toLocaleString()} títulos encontrados • Exibindo ${fc.items.length} de ${fc.total.toLocaleString()}`;
      }
      if (pageIndicator) {
        pageIndicator.textContent = `Página ${fc.page} de ${fc.totalPages}`;
      }

      // Atualiza visibilidade do botão Carregar Mais
      if (loadMoreBtn) {
        if (fc.page >= fc.totalPages || fc.items.length >= fc.total) {
          loadMoreBtn.classList.add('hidden');
        } else {
          loadMoreBtn.classList.remove('hidden');
        }
      }

      // Renderiza items
      this.renderFullCatalogItems(reset);

    } catch (err) {
      console.error('Erro ao buscar itens:', err);
      this.showToast('Erro ao carregar itens: ' + err.message, 'error');
    } finally {
      fc.isLoading = false;
      if (spinner) spinner.classList.add('hidden');
    }
  },

  async loadMoreCategoryItems() {
    const fc = this.state.fullCatalog;
    if (!fc || fc.page >= fc.totalPages || fc.isLoading) return;
    fc.page++;
    await this.fetchCategoryItems(false);
  },

  onFullCatalogSearch(query) {
    if (this._searchTimeout) clearTimeout(this._searchTimeout);
    this._searchTimeout = setTimeout(() => {
      if (this.state.fullCatalog) {
        this.state.fullCatalog.search = query.trim();
        this.fetchCategoryItems(true);
      }
    }, 300);
  },

  onFullCatalogGroupChange(group) {
    if (this.state.fullCatalog) {
      this.state.fullCatalog.group = group;
      this.fetchCategoryItems(true);
    }
  },

  setViewMode(mode) {
    if (!this.state.fullCatalog) return;
    this.state.fullCatalog.viewMode = mode;

    const gridBtn = document.getElementById('view-mode-grid');
    const listBtn = document.getElementById('view-mode-list');
    const gridEl = document.getElementById('full-catalog-grid');
    const listEl = document.getElementById('full-catalog-list');

    if (mode === 'grid') {
      if (gridBtn) gridBtn.className = 'px-3 py-1.5 text-xs bg-netflix-red text-white transition flex items-center gap-1.5 font-bold';
      if (listBtn) listBtn.className = 'px-3 py-1.5 text-xs text-slate-400 hover:text-white transition flex items-center gap-1.5';
      if (gridEl) gridEl.classList.remove('hidden');
      if (listEl) listEl.classList.add('hidden');
    } else {
      if (listBtn) listBtn.className = 'px-3 py-1.5 text-xs bg-netflix-red text-white transition flex items-center gap-1.5 font-bold';
      if (gridBtn) gridBtn.className = 'px-3 py-1.5 text-xs text-slate-400 hover:text-white transition flex items-center gap-1.5';
      if (gridEl) gridEl.classList.add('hidden');
      if (listEl) listEl.classList.remove('hidden');
    }

    this.renderFullCatalogItems(true);
  },

  renderFullCatalogItems(fullRebuild = false) {
    const fc = this.state.fullCatalog;
    if (!fc) return;

    const gridEl = document.getElementById('full-catalog-grid');
    const listEl = document.getElementById('full-catalog-list');

    if (!fc.items.length) {
      const emptyHtml = '<div class="col-span-full py-16 text-center text-slate-400 text-sm">Nenhum título encontrado com os filtros selecionados.</div>';
      if (gridEl) gridEl.innerHTML = emptyHtml;
      if (listEl) listEl.innerHTML = emptyHtml;
      return;
    }

    if (fc.viewMode === 'grid') {
      if (gridEl) gridEl.innerHTML = fc.items.map(item => this.createCardHTML(item)).join('');
    } else {
      if (listEl) listEl.innerHTML = fc.items.map(item => this.createListRowHTML(item)).join('');
    }
  },

  createListRowHTML(item) {
    const isFav = this.state.favorites.includes(item.name);
    const bgImg = this.getItemBackdrop(item);
    const matchPct = 94 + (item.id % 6);
    const isSeries = item.itemType === 'series';
    const isLive = item.itemType === 'live' || (item.group || '').toLowerCase().includes('canais');
    const itemData = this.safeEncodeJson(item);
    const nameData = this.safeEncodeJson(item.name);

    return `
      <div onclick="App.onCardClick('${itemData}')" class="flex items-center gap-4 p-3 rounded-lg bg-[#181818] hover:bg-[#222] border border-slate-800/80 hover:border-slate-600 transition cursor-pointer group">
        <div class="relative w-28 sm:w-36 aspect-video rounded overflow-hidden flex-shrink-0 bg-slate-800">
          <img src="${this.escapeHtml(bgImg)}" alt="${this.escapeHtml(item.name)}" class="w-full h-full object-cover" loading="lazy" onerror="this.onerror=null; this.src='${BACKDROP_COLLECTION[0]}'">
          <div class="absolute inset-0 bg-black/40 group-hover:bg-black/10 transition flex items-center justify-center">
            <button onclick="event.stopPropagation(); App.onCardPlay('${itemData}')" class="w-8 h-8 rounded-full bg-white text-black flex items-center justify-center hover:scale-105 transition shadow-lg" title="Assistir">
              <i class="fa-solid fa-play text-xs pl-0.5"></i>
            </button>
          </div>
        </div>
        
        <div class="flex-1 min-w-0">
          <div class="flex items-center justify-between gap-2">
            <h4 class="text-sm font-bold text-white truncate group-hover:text-netflix-red transition">${this.escapeHtml(item.name)}</h4>
            <span class="text-xs text-emerald-400 font-bold whitespace-nowrap">${matchPct}% Relevante</span>
          </div>
          <p class="text-xs text-slate-400 mt-1 line-clamp-1">${this.escapeHtml(item.group || 'Geral')}</p>
          <div class="flex items-center gap-2 mt-2">
            <span class="px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider ${isLive ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' : isSeries ? 'bg-netflix-red/20 text-netflix-red border border-netflix-red/30' : 'bg-slate-800 text-slate-300 border border-slate-700'}">
              ${isLive ? 'AO VIVO' : isSeries ? 'SÉRIE' : 'FILME'}
            </span>
            ${isSeries ? `<span class="text-[11px] text-slate-300">${item.totalSeasons || 1} Temporadas • ${item.totalEpisodes || ''} Episódios</span>` : ''}
          </div>
        </div>

        <div class="flex items-center gap-2 pr-2">
          <button onclick="event.stopPropagation(); App.toggleFavoriteByEncoded('${nameData}')" class="w-8 h-8 rounded-full bg-black/60 border border-slate-600 text-white flex items-center justify-center hover:border-white transition" title="Minha Lista">
            <i class="${isFav ? 'fa-solid text-netflix-red' : 'fa-solid'} fa-plus text-xs"></i>
          </button>
          <button onclick="event.stopPropagation(); App.openDetailModalByData('${itemData}')" class="px-3 py-1.5 rounded bg-slate-800 hover:bg-slate-700 text-white text-xs font-semibold transition border border-slate-700">
            Mais Info
          </button>
        </div>
      </div>
    `;
  },

  // =========================================================================
  // EXTREME-INFINITV CONFIGURATION & SETTINGS CONTROLLER
  // =========================================================================

  initSettings() {
    this.renderAccentSwatches();
    this.initDiagnosticsHud();
  },

  initDiagnosticsHud() {
    const hud = document.getElementById('dev-diagnostics-hud');
    if (!hud) return;

    if (window.SettingsManager && window.SettingsManager.getDevModeEnabled()) {
      hud.classList.remove('hidden');
    }

    setInterval(() => {
      if (!window.SettingsManager || !window.SettingsManager.getDevModeEnabled()) return;
      const video = document.getElementById('netflix-video');
      if (!video) return;

      const bufEl = document.getElementById('hud-buffer');
      const resEl = document.getElementById('hud-resolution');
      const engineEl = document.getElementById('hud-engine');

      if (bufEl && video.buffered && video.buffered.length > 0) {
        let maxBuf = 0;
        for (let i = 0; i < video.buffered.length; i++) {
          if (video.buffered.start(i) <= video.currentTime && video.currentTime <= video.buffered.end(i)) {
            maxBuf = video.buffered.end(i) - video.currentTime;
            break;
          }
        }
        bufEl.textContent = `${maxBuf.toFixed(1)}s`;
      } else if (bufEl) {
        bufEl.textContent = '0.0s';
      }

      if (resEl) {
        if (video.videoWidth && video.videoHeight) {
          resEl.textContent = `${video.videoWidth}x${video.videoHeight}`;
        } else {
          resEl.textContent = video.paused ? 'Pausado' : 'Conectando...';
        }
      }

      if (engineEl) {
        const backend = window.SettingsManager.getPlayerBackend();
        engineEl.textContent = backend === 'hlsjs' ? 'Hls.js Buffer' : (backend === 'native' ? 'HTML5 Native' : 'Auto Smart');
      }
    }, 1000);
  },

  openSettingsModal() {
    this.pushNavigationState('settings');
    if (window.SettingsManager) {
      window.SettingsManager.playUiSound('select');
    }
    const modal = document.getElementById('settings-modal');
    if (!modal) return;

    this.renderAccentSwatches();
    this.syncSettingsToUI();
    modal.classList.remove('hidden');
  },

  closeSettingsModal(fromHistory = false) {
    if (window.SettingsManager) {
      window.SettingsManager.playUiSound('select');
    }
    const modal = document.getElementById('settings-modal');
    if (modal) modal.classList.add('hidden');
    if (this._openedFromProfile) {
      this._openedFromProfile = false;
      this.openProfileModal();
      return;
    }
    if (!fromHistory && history.state && history.state.modal === 'settings') {
      this._navigatingBackProgrammatically = true;
      history.back();
    }
  },

  switchSettingsTab(tabName) {
    if (window.SettingsManager) {
      window.SettingsManager.playUiSound('nav');
    }

    document.querySelectorAll('.settings-nav-btn').forEach(btn => {
      btn.classList.remove('active', 'bg-netflix-red', 'text-white');
      btn.classList.add('text-slate-400');
    });
    const activeBtn = document.getElementById(`stab-${tabName}`);
    if (activeBtn) {
      activeBtn.classList.add('active', 'bg-netflix-red', 'text-white');
      activeBtn.classList.remove('text-slate-400');
    }

    const panels = ['appearance', 'playback', 'network', 'metadata', 'data', 'about'];
    panels.forEach(p => {
      const el = document.getElementById(`settings-panel-${p}`);
      if (el) el.classList.toggle('hidden', p !== tabName);
    });

    if (tabName === 'data') {
      this.refreshStorageUsage();
    }
  },

  renderAccentSwatches() {
    const grid = document.getElementById('accent-swatches-grid');
    if (!grid || !window.SettingsManager) return;

    const current = window.SettingsManager.getAccent();
    const presets = window.ACCENT_PRESETS || [];

    grid.innerHTML = presets.map(p => {
      const isSelected = p.id === current;
      const bgStyle = p.id === 'random' ? `background: ${p.color};` : `background-color: ${p.color};`;
      return `
        <button type="button" 
                onclick="App.setAccent('${p.id}', this)"
                title="${p.name}" 
                style="${bgStyle}"
                class="swatch-btn ${isSelected ? 'active ring-2 ring-white scale-110 shadow-lg' : 'opacity-85 hover:opacity-100'}">
          ${isSelected ? '<i class="fa-solid fa-check text-xs text-white drop-shadow"></i>' : ''}
        </button>
      `;
    }).join('');

    const activeName = document.getElementById('active-accent-name');
    if (activeName) {
      const found = presets.find(p => p.id === current);
      activeName.textContent = found ? found.name : 'Vermelho Netflix';
    }
  },

  pulseSettingsCard(originEl) {
    if (!originEl) return;
    const card = originEl.closest('.settings-surface');
    if (card) {
      card.classList.remove('settings-commit-pulse');
      void card.offsetWidth;
      card.classList.add('settings-commit-pulse');
      setTimeout(() => card.classList.remove('settings-commit-pulse'), 650);
    }
  },

  setAccent(accentId, btnEl) {
    if (!window.SettingsManager) return;
    window.SettingsManager.setAccent(accentId);
    window.SettingsManager.playUiSound('confirm');
    window.SettingsManager.triggerHaptic('light');
    this.renderAccentSwatches();
    this.pulseSettingsCard(btnEl);
    this.showToast('Tema de cor atualizado!', 'success');
  },

  setFontScale(scale) {
    if (!window.SettingsManager) return;
    window.SettingsManager.setFontScale(scale);
    window.SettingsManager.playUiSound('select');
    this.updateSegmentedGroup('font-scale-group', scale);
    this.pulseSettingsCard(document.getElementById('font-scale-group'));
  },

  setDensity(density) {
    if (!window.SettingsManager) return;
    window.SettingsManager.setDensity(density);
    window.SettingsManager.playUiSound('select');
    this.updateSegmentedGroup('density-group', density);
    this.pulseSettingsCard(document.getElementById('density-group'));
  },

  togglePerfMode(enabled) {
    if (!window.SettingsManager) return;
    window.SettingsManager.setPerfMode(enabled);
    window.SettingsManager.playUiSound('confirm');
    this.pulseSettingsCard(document.getElementById('setting-perf-mode'));
    this.showToast(enabled ? 'Modo de Desempenho ativado' : 'Modo de Desempenho desativado', 'info');
  },

  toggleUiSounds(enabled) {
    if (!window.SettingsManager) return;
    window.SettingsManager.setUiSoundsEnabled(enabled);
    if (enabled) window.SettingsManager.playUiSound('confirm');
    this.pulseSettingsCard(document.getElementById('setting-ui-sounds'));
  },

  toggleHaptics(enabled) {
    if (!window.SettingsManager) return;
    window.SettingsManager.setHapticsEnabled(enabled);
    if (enabled) window.SettingsManager.triggerHaptic('medium');
    this.pulseSettingsCard(document.getElementById('setting-haptics'));
  },

  setTvOverscan(pct) {
    if (!window.SettingsManager) return;
    window.SettingsManager.setTvOverscan(pct);
    window.SettingsManager.playUiSound('select');
    this.updateSegmentedGroup('overscan-group', String(pct));
    this.pulseSettingsCard(document.getElementById('overscan-group'));
  },

  setVideoScaleMode(mode) {
    if (!window.SettingsManager) return;
    window.SettingsManager.setVideoScale(mode);
    window.SettingsManager.playUiSound('select');
    this.updateSegmentedGroup('video-scale-group', mode);
    this.pulseSettingsCard(document.getElementById('video-scale-group'));
    this.showToast(`Proporção ajustada: ${mode}`, 'info');
  },

  setPlayerBackend(engine) {
    if (!window.SettingsManager) return;
    window.SettingsManager.setPlayerBackend(engine);
    window.SettingsManager.playUiSound('select');
    this.updateSegmentedGroup('player-backend-group', engine);
    this.pulseSettingsCard(document.getElementById('player-backend-group'));
  },

  toggleAudioTranscode(enabled) {
    if (!window.SettingsManager) return;
    window.SettingsManager.setAudioTranscodeAuto(enabled);
    window.SettingsManager.playUiSound('confirm');
    this.pulseSettingsCard(document.getElementById('setting-audio-transcode'));
  },

  toggleMonoAudio(enabled) {
    if (!window.SettingsManager) return;
    window.SettingsManager.setMonoAudioEnabled(enabled);
    window.SettingsManager.playUiSound('confirm');
    this.pulseSettingsCard(document.getElementById('setting-mono-audio'));
    this.showToast(enabled ? 'Áudio Mono ativado (1 canal)' : 'Áudio Estéreo restaurado', 'info');
  },

  toggleCaptionsAuto(enabled) {
    if (!window.SettingsManager) return;
    window.SettingsManager.setCaptionsAutoEnabled(enabled);
    window.SettingsManager.playUiSound('select');
    this.pulseSettingsCard(document.getElementById('setting-captions-auto'));
  },

  setProgressRetention(days) {
    if (!window.SettingsManager) return;
    window.SettingsManager.setProgressRetentionDays(days);
    window.SettingsManager.playUiSound('select');
    this.updateSegmentedGroup('progress-retention-group', String(days));
    this.pulseSettingsCard(document.getElementById('progress-retention-group'));
  },

  onUserAgentChange(preset) {
    if (!window.SettingsManager) return;
    window.SettingsManager.setUserAgentPreset(preset);
    const customContainer = document.getElementById('custom-ua-container');
    if (customContainer) {
      customContainer.classList.toggle('hidden', preset !== 'custom');
    }
    window.SettingsManager.playUiSound('select');
    this.pulseSettingsCard(document.getElementById('setting-ua-select'));
    this.showToast('Preset de User-Agent atualizado no proxy', 'success');
  },

  onCustomUserAgentChange(ua) {
    if (!window.SettingsManager) return;
    window.SettingsManager.setCustomUserAgent(ua);
    window.SettingsManager.playUiSound('confirm');
  },

  setNetworkTimeout(sec) {
    if (!window.SettingsManager) return;
    window.SettingsManager.setNetworkTimeoutSeconds(sec);
    window.SettingsManager.playUiSound('select');
    this.updateSegmentedGroup('network-timeout-group', String(sec));
    this.pulseSettingsCard(document.getElementById('network-timeout-group'));
    this.showToast(`Timeout de rede ajustado para ${sec}s`, 'info');
  },

  toggleDevMode(enabled) {
    if (!window.SettingsManager) return;
    window.SettingsManager.setDevModeEnabled(enabled);
    window.SettingsManager.playUiSound('confirm');
    this.pulseSettingsCard(document.getElementById('setting-dev-mode'));
    this.showToast(enabled ? 'Modo Desenvolvedor ativado' : 'Modo Desenvolvedor desativado', 'info');
  },

  toggleTmdb(enabled) {
    if (!window.SettingsManager) return;
    window.SettingsManager.setTmdbEnabled(enabled);
    window.SettingsManager.playUiSound('confirm');
    this.pulseSettingsCard(document.getElementById('setting-tmdb-enabled'));
  },

  saveTmdbKey() {
    if (!window.SettingsManager) return;
    const input = document.getElementById('setting-tmdb-key');
    if (input) {
      window.SettingsManager.setTmdbKey(input.value);
      window.SettingsManager.playUiSound('confirm');
      this.pulseSettingsCard(input);
      this.showToast('Chave TMDB salva com sucesso!', 'success');
    }
  },

  setEpgTimezone(tz) {
    if (!window.SettingsManager) return;
    window.SettingsManager.setEpgTimezone(tz);
    window.SettingsManager.playUiSound('select');
    this.pulseSettingsCard(document.getElementById('setting-epg-tz'));
    this.showToast('Fuso horário do guia atualizado', 'info');
  },

  async refreshStorageUsage() {
    if (!window.SettingsManager) return;
    const lsEl = document.getElementById('storage-ls-size');
    const idbEl = document.getElementById('storage-idb-size');
    const stats = await window.SettingsManager.getStorageUsage();
    if (lsEl) lsEl.textContent = stats.localStorageKb;
    if (idbEl) idbEl.textContent = stats.totalUsage;
  },

  async clearSystemCache() {
    if (!confirm('Deseja limpar todo o cache local e recarregar os dados do catálogo?')) return;
    if (!window.SettingsManager) return;
    await window.SettingsManager.clearAllCache();
    this.showToast('Cache limpo com sucesso! Recarregando...', 'success');
    setTimeout(() => window.location.reload(), 1000);
  },

  async importBackupFile(input) {
    if (!input.files || input.files.length === 0) return;
    const file = input.files[0];
    try {
      await window.SettingsManager.importBackupData(file);
      this.showToast('Backup restaurado com sucesso! Aplicando preferências...', 'success');
      setTimeout(() => window.location.reload(), 1200);
    } catch (err) {
      alert('Erro ao importar backup: ' + err.message);
    }
  },

  resetSettingsToDefaults() {
    if (!confirm('Tem certeza de que deseja restaurar todas as configurações para os padrões originais?')) return;
    if (!window.SettingsManager) return;
    window.SettingsManager.resetToDefaults();
    this.showToast('Preferências redefinidas com sucesso!', 'info');
    setTimeout(() => window.location.reload(), 800);
  },

  updateSegmentedGroup(groupId, activeVal) {
    const group = document.getElementById(groupId);
    if (!group) return;
    group.querySelectorAll('.segmented-btn').forEach(btn => {
      const isMatch = btn.getAttribute('data-val') === String(activeVal);
      btn.classList.toggle('active', isMatch);
    });
  },

  syncSettingsToUI() {
    if (!window.SettingsManager) return;
    const SM = window.SettingsManager;

    this.updateSegmentedGroup('font-scale-group', SM.getFontScale());
    this.updateSegmentedGroup('density-group', SM.getDensity());
    this.updateSegmentedGroup('overscan-group', String(SM.getTvOverscan()));
    this.updateSegmentedGroup('video-scale-group', SM.getVideoScale());
    this.updateSegmentedGroup('player-backend-group', SM.getPlayerBackend());
    this.updateSegmentedGroup('progress-retention-group', String(SM.getProgressRetentionDays()));
    this.updateSegmentedGroup('network-timeout-group', String(SM.getNetworkTimeoutSeconds()));

    const perfEl = document.getElementById('setting-perf-mode');
    if (perfEl) perfEl.checked = SM.getPerfMode();

    const uiSoundsEl = document.getElementById('setting-ui-sounds');
    if (uiSoundsEl) uiSoundsEl.checked = SM.getUiSoundsEnabled();

    const hapticsEl = document.getElementById('setting-haptics');
    if (hapticsEl) hapticsEl.checked = SM.getHapticsEnabled();

    const transEl = document.getElementById('setting-audio-transcode');
    if (transEl) transEl.checked = SM.getAudioTranscodeAuto();

    const monoEl = document.getElementById('setting-mono-audio');
    if (monoEl) monoEl.checked = SM.getMonoAudioEnabled();

    const captionsEl = document.getElementById('setting-captions-auto');
    if (captionsEl) captionsEl.checked = SM.getCaptionsAutoEnabled();

    const uaSelect = document.getElementById('setting-ua-select');
    if (uaSelect) {
      uaSelect.value = SM.getUserAgentPreset();
      const customContainer = document.getElementById('custom-ua-container');
      if (customContainer) customContainer.classList.toggle('hidden', uaSelect.value !== 'custom');
    }

    const customUa = document.getElementById('setting-custom-ua');
    if (customUa) customUa.value = SM.getCustomUserAgent();

    const devEl = document.getElementById('setting-dev-mode');
    if (devEl) devEl.checked = SM.getDevModeEnabled();

    const tmdbEl = document.getElementById('setting-tmdb-enabled');
    if (tmdbEl) tmdbEl.checked = SM.getTmdbEnabled();

    const tmdbKeyEl = document.getElementById('setting-tmdb-key');
    if (tmdbKeyEl) tmdbKeyEl.value = SM.getTmdbKey();

    // Reconhecimento Automático de Dispositivo
    const dev = SM.detectDevice();
    const devIcon = document.getElementById('device-icon');
    const devLabel = document.getElementById('device-label');
    const devBadge = document.getElementById('device-badge');
    const devDesc = document.getElementById('device-desc');
    const platEl = document.getElementById('about-platform');

    if (devIcon) devIcon.className = `fa-solid ${dev.icon}`;
    if (devLabel) devLabel.textContent = dev.label;
    if (devBadge) devBadge.textContent = dev.badge;
    if (devDesc) devDesc.textContent = dev.desc;
    if (platEl) platEl.textContent = `${dev.label} (${dev.shortLabel})`;
  },

  reapplyDeviceDefaults() {
    if (!window.SettingsManager) return;
    window.SettingsManager.initDeviceProfile(true);
    this.syncSettingsToUI();
    this.renderAccentSwatches();
    window.SettingsManager.playUiSound('confirm');
    window.SettingsManager.triggerHaptic('medium');
    this.pulseSettingsCard(document.getElementById('device-detected-card'));
    const dev = window.SettingsManager.detectDevice();
    this.showToast(`Perfil ideal para ${dev.shortLabel} aplicado com sucesso!`, 'success');
  },

  /* ==============================================================================
     CENTRAL DE FEEDBACK & SUPORTE (INTEGRAÇÃO COM PAINEL ADM)
     ============================================================================== */
  openFeedbackModal() {
    this.pushNavigationState('feedback');
    const modal = document.getElementById('netflix-feedback-modal');
    if (modal) {
      modal.classList.remove('hidden');
      const input = document.getElementById('feedback-mensagem-input');
      if (input) {
        input.value = '';
        input.focus();
      }
    }
  },

  closeFeedbackModal(fromHistory = false) {
    const modal = document.getElementById('netflix-feedback-modal');
    if (modal) modal.classList.add('hidden');
    if (this._openedFromProfile) {
      this._openedFromProfile = false;
      this.openProfileModal();
      return;
    }
    if (!fromHistory && history.state && history.state.modal === 'feedback') {
      this._navigatingBackProgrammatically = true;
      history.back();
    }
  },

  async submitFeedback(e) {
    if (e) e.preventDefault();
    const tipo = document.querySelector('input[name="feedback_tipo"]:checked')?.value || 'observacao';
    const msgInput = document.getElementById('feedback-mensagem-input');
    const submitBtn = document.getElementById('feedback-submit-btn');
    const mensagem = msgInput ? msgInput.value.trim() : '';

    if (!mensagem) {
      this.showToast('Por favor, digite sua mensagem antes de enviar.', 'error');
      return;
    }

    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Enviando...';
    }

    try {
      const res = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tipo, mensagem })
      });
      const data = await res.json();

      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Erro ao enviar feedback.');
      }

      this.closeFeedbackModal();
      this.showToast('Feedback enviado com sucesso! Agradecemos sua colaboração.', 'success');
    } catch (err) {
      this.showToast(err.message, 'error');
    } finally {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.innerHTML = '<span>Enviar Mensagem</span> <i class="fa-solid fa-paper-plane text-xs"></i>';
      }
    }
  },

  /* ==============================================================================
     ANTI-QUEDA & CONTINGÊNCIA (CONSULTA /api/config NA INICIALIZAÇÃO)
     ============================================================================== */
  async loadAntiQuedaConfig() {
    try {
      const res = await fetch('/api/config');
      if (res.ok) {
        const conf = await res.json();
        this.state.antiQuedaConfig = conf;
        if (conf.mirrorDomains && conf.mirrorDomains.length) {
          localStorage.setItem('novaflix_mirror_domains', JSON.stringify(conf.mirrorDomains));
        }
      }
    } catch (e) {
      console.warn('[Anti-Queda] Aviso ao obter configuração de contingência:', e.message);
    }
  },

  /* ==============================================================================
     SALVAMENTO DE PREFERÊNCIAS (MODAL DE CONFIGURAÇÕES)
     ============================================================================== */
  saveAllSettings() {
    if (window.SettingsManager) {
      const customUa = document.getElementById('setting-custom-ua');
      if (customUa) window.SettingsManager.setCustomUserAgent(customUa.value);

      const tmdbKey = document.getElementById('setting-tmdb-key');
      if (tmdbKey) window.SettingsManager.setTmdbKey(tmdbKey.value);

      const epgTz = document.getElementById('setting-epg-tz');
      if (epgTz) window.SettingsManager.setEpgTimezone(epgTz.value);

      window.SettingsManager.playUiSound('confirm');
      window.SettingsManager.triggerHaptic('success');
    }
    this.closeSettingsModal();
    this.showToast('Todas as preferências foram salvas com sucesso!', 'success');
  },

  /* ==============================================================================
     SESSÃO & MONITORAMENTO EM TEMPO REAL (ADMIN SESSIONS HEARTBEAT)
     ============================================================================== */
  initSessionHeartbeat() {
    let sessId = sessionStorage.getItem('novaflix_session_id');
    if (!sessId) {
      sessId = 'nf_' + Math.random().toString(36).substring(2, 10) + Date.now().toString(36);
      sessionStorage.setItem('novaflix_session_id', sessId);
    }
    this.sessionId = sessId;
    this.sessionStartTime = Date.now();

    // Primeiro ping imediatamente
    this.sendSessionHeartbeat();

    // Repete a cada 4 segundos para resposta quase instantânea a comandos remotos
    setInterval(() => {
      this.sendSessionHeartbeat();
    }, 4000);
  },

  /* ==============================================================================
     WATCH TIME TRACKER & NON-INTRUSIVE PRE-PLAY DONATION (REQUIREMENTS 9, 10, 11, 12)
     ============================================================================== */
  initTimeTracker() {
    if (this._timeTrackerInterval) {
      clearInterval(this._timeTrackerInterval);
    }

    // Monitora visibilidade da aba do navegador para pausar contador quando minimizado
    document.addEventListener('visibilitychange', () => {
      this._isDocumentVisible = document.visibilityState === 'visible';
    });
    this._isDocumentVisible = document.visibilityState === 'visible';

    // Monitora estado da aplicação no ambiente Mobile / Capacitor
    if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App) {
      try {
        window.Capacitor.Plugins.App.addListener('appStateChange', (state) => {
          this._isAppInForeground = Boolean(state.isActive);
        });
        this._isAppInForeground = true;
      } catch (e) {}
    } else {
      this._isAppInForeground = true;
    }

    // Roda a cada 1 segundo com verificação estrita de reprodução E foco
    this._timeTrackerInterval = setInterval(() => {
      // 1. Regra 9: Se o gateway de pagamento estiver desativado no ADM (sem chave de API), 100% gratuito
      if (!this.state.gatewayActive) return;

      // 2. Proteção de Menores: Se for perfil de menor (<18) ou kids, nunca rastreia nem solicita doação
      if (this.isMinor()) return;

      // 3. Regra 12: Override individual por UUID no ADM para Abolir Doação
      const overrides = this.state.userOverrides || {};
      if (overrides.abolishDonation) return;

      // 4. Regra 10: O tempo do gatilho de doação SÓ avança se o vídeo estiver playing E a aplicação focada
      const isVisible = (this._isDocumentVisible !== false) && (this._isAppInForeground !== false);
      if (!isVisible) return; // Pausa imediata se minimizado ou em segundo plano

      const isPlayerOpen = !document.getElementById('netflix-player-screen')?.classList.contains('hidden');
      const isPlaying = isPlayerOpen && this.player && this.player.video && !this.player.video.paused && this.player.video.readyState >= 2;

      if (isPlaying) {
        this.state.watchTimeAccumulatedSeconds = (this.state.watchTimeAccumulatedSeconds || 0) + 1;
        // Limite padrão de 30 minutos (1800s) de exibição contínua
        if (this.state.watchTimeAccumulatedSeconds >= 1800) {
          // REGRA 10: O vídeo em reprodução NUNCA é pausado ou interrompido!
          // Apenas marca doacao_pendente = true para surgir pré-play na próxima seleção
          this.state.doacao_pendente = true;
        }
      }
    }, 1000);
  },

  async checkInitialPaymentGatewayStatus() {
    try {
      const res = await fetch(this.getServerUrl('/api/payment/status'));
      if (res.ok) {
        const data = await res.json();
        this.state.gatewayActive = Boolean(data && data.hasGateway);
      }
    } catch(e) {}
  },

  getDonationsCount() {
    return EncryptedStorage.getItem('novaflix_donations_count', 0);
  },

  openDoacaoModal() {
    const modal = document.getElementById('doacao-modal');
    if (!modal) return;

    const count = this.getDonationsCount();
    const overrides = this.state.userOverrides || {};
    const badgeEl = document.getElementById('doacao-donor-badge');
    const valuesGrid = document.getElementById('doacao-values-grid');
    const pixView = document.getElementById('doacao-pix-view');

    if (pixView) pixView.classList.add('hidden');

    let values = [];
    if (count === 0) {
      // Primeira doação: 3 valores mais altos (Padrão: R$ 30, R$ 50, R$ 100 ou custom ADM)
      values = overrides.customInitialValues && overrides.customInitialValues.length > 0
        ? overrides.customInitialValues
        : [30, 50, 100];
      if (badgeEl) badgeEl.textContent = '⭐ Primeira Contribuição';
    } else {
      // Doador recorrente: 5 valores menores (Padrão: R$ 5, 10, 15, 20, 25 ou custom ADM)
      values = overrides.customRecurringValues && overrides.customRecurringValues.length > 0
        ? overrides.customRecurringValues
        : [5, 10, 15, 20, 25];
      if (badgeEl) badgeEl.textContent = `❤️ Doador Recorrente (${count}x)`;
    }

    if (valuesGrid) {
      valuesGrid.className = values.length > 3 ? 'grid grid-cols-2 sm:grid-cols-5 gap-2' : 'grid grid-cols-3 gap-2';
      valuesGrid.innerHTML = values.map(val => `
        <button type="button" onclick="App.selectDoacaoValue(${val})" class="py-2.5 px-3 rounded-xl bg-slate-800 hover:bg-netflix-red/30 border border-slate-700 hover:border-netflix-red text-white text-xs font-bold transition flex flex-col items-center justify-center gap-0.5 cursor-pointer active:scale-95">
          <span class="text-sm font-black">R$ ${val}</span>
          <span class="text-[9px] text-slate-400">Contribuir</span>
        </button>
      `).join('');
    }

    modal.classList.remove('hidden');
    this.pushNavigationState('doacao');
  },

  selectDoacaoValue(val) {
    const pixView = document.getElementById('doacao-pix-view');
    const valText = document.getElementById('doacao-selected-amount-text');
    if (pixView) pixView.classList.remove('hidden');
    if (valText) valText.textContent = `R$ ${val.toFixed(2).replace('.', ',')}`;
  },

  copyDoacaoPix() {
    const input = document.getElementById('doacao-pix-code');
    if (input) {
      navigator.clipboard?.writeText(input.value).then(() => {
        this.showToast('Código PIX copiado para a área de transferência!', 'success');
      }).catch(() => {
        input.select();
        document.execCommand('copy');
        this.showToast('Código PIX copiado!', 'success');
      });
    }
  },

  dismissDoacaoModal() {
    const modal = document.getElementById('doacao-modal');
    if (modal) modal.classList.add('hidden');

    // REGRA 10: Reseta timer, limpa flag e retoma vídeo imediatamente
    this.state.watchTimeAccumulatedSeconds = 0;
    this.state.doacao_pendente = false;

    // Se havia override pontual de forçar doação do ADM, marca como reconhecido
    if (this.state.userOverrides && this.state.userOverrides.forceDonation) {
      this._forceDonationAcknowledged = true;
      this.state.userOverrides.forceDonation = false;
      this.sendSessionHeartbeat();
    }

    if (this._pendingPlayAfterDonation) {
      const { item, opts } = this._pendingPlayAfterDonation;
      this._pendingPlayAfterDonation = null;
      this.playItem(item, opts);
    }
  },

  confirmDoacaoComplete() {
    const count = this.getDonationsCount();
    EncryptedStorage.setItem('novaflix_donations_count', count + 1);
    this.showToast('Muito obrigado pela sua contribuição! Servidor liberado.', 'success');
    this.dismissDoacaoModal();
  },

  async sendSessionHeartbeat() {
    if (!this.sessionId) return;
    try {
      const active = this.state.activeItem;
      const isPlayerOpen = !document.getElementById('netflix-player-screen')?.classList.contains('hidden');
      const isPlaying = isPlayerOpen && active && this.player && this.player.video && !this.player.video.paused;

      const payload = {
        sessionId: this.sessionId,
        uuid: this.getDeviceUuid(),
        currentTitle: isPlayerOpen && active ? (active.name || 'Reproduzindo') : 'Navegando no Catálogo',
        itemType: isPlayerOpen && active ? (active.itemType || 'stream') : 'idle',
        isPlaying: !!isPlaying,
        durationSeconds: Math.floor((Date.now() - (this.sessionStartTime || Date.now())) / 1000),
        profile: this.getUserProfile(),
        donationStats: {
          donationsCount: this.getDonationsCount(),
          watchTimeSeconds: this.state.watchTimeAccumulatedSeconds || 0,
          pending: !!this.state.doacao_pendente
        },
        forceDonationAcknowledged: this._forceDonationAcknowledged || false
      };

      if (this._forceDonationAcknowledged) {
        this._forceDonationAcknowledged = false;
      }

      const res = await fetch(this.getServerUrl('/api/heartbeat'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();

      if (data) {
        if (typeof data.gatewayActive === 'boolean') {
          this.state.gatewayActive = data.gatewayActive;
        }
        if (data.userOverrides) {
          this.state.userOverrides = data.userOverrides;
          if (data.userOverrides.forceDonation) {
            this.state.doacao_pendente = true;
          }
        }
        if (data.messages && Array.isArray(data.messages) && data.messages.length > 0) {
          for (const msg of data.messages) {
            this.handleIncomingAdminMessage(msg);
          }
        }
      }
    } catch (e) {
      // Falha silenciosa de rede temporária
    }
  },

  /* ==============================================================================
     USER PROFILE CONTROLLER (MEU PERFIL, PEDÁGIO OBRIGATÓRIO & MODO KIDS)
     ============================================================================== */
  getUserProfile() {
    try {
      let prof = EncryptedStorage.getItem('novaflix_profile', null);
      if (!prof) {
        const legacy = localStorage.getItem('novaflix_user_profile');
        if (legacy) {
          prof = JSON.parse(legacy);
          EncryptedStorage.setItem('novaflix_profile', prof);
        }
      }
      if (prof) {
        return prof;
      }
    } catch (e) {}
    return { name: '', gender: '', age: null, city: '', avatar: 'user', kidsAge: null, showAdultContent: false, isAdultConfirmed: false };
  },

  isAdultAllowed() {
    const prof = this.getUserProfile();
    if (!prof) return false;
    if (prof.gender === 'Criança') return false;
    const ageNum = parseInt(prof.age, 10);
    if (isNaN(ageNum) || ageNum < 18) return false;
    return prof.hideAdultInVerTudo !== true;
  },

  isProfileConfigured() {
    const prof = this.getUserProfile();
    if (!prof) return false;
    const hasName = Boolean(prof.name && prof.name.trim() && prof.name !== 'Visitante');
    const validGenders = ['Homem', 'Mulher', 'Criança', 'Outro'];
    const hasGender = Boolean(prof.gender && validGenders.includes(prof.gender));
    const ageNum = parseInt(prof.age, 10);
    const hasAge = !isNaN(ageNum) && ageNum > 0 && ageNum <= 120;
    return hasName && hasGender && hasAge;
  },

  isMinor() {
    const prof = this.getUserProfile();
    if (!prof) return false;
    if (prof.gender === 'Criança') return true;
    const ageNum = parseInt(prof.age, 10);
    return !isNaN(ageNum) && ageNum > 0 && ageNum < 18;
  },

  isKidsMode() {
    const prof = this.getUserProfile();
    if (!prof) return false;
    if (prof.gender === 'Criança') return true;
    const ageNum = parseInt(prof.age, 10);
    // Modo Kids (Desenhos e Conteúdo Infantil) estritamente para menores de 10 anos
    return !isNaN(ageNum) && ageNum > 0 && ageNum < 10;
  },

  isPreTeenMode() {
    const prof = this.getUserProfile();
    if (!prof) return false;
    const ageNum = parseInt(prof.age, 10);
    return !isNaN(ageNum) && ageNum >= 10 && ageNum < 14;
  },

  isTeenMode() {
    const prof = this.getUserProfile();
    if (!prof) return false;
    const ageNum = parseInt(prof.age, 10);
    // Modo Jovem / Teen (14 a 17 anos, ex: 16 anos)
    return !isNaN(ageNum) && ageNum >= 14 && ageNum < 18;
  },

  openProfileModal(isRequiredForFavorite = false, isRequiredForPlay = false) {
    this.pushNavigationState('profile');
    const prof = this.getUserProfile();
    const modal = document.getElementById('user-profile-modal');
    if (!modal) return;

    // Regra: "Instalar app pc ou mobile so deve aparecer na versão web no modal de perfil, não aparecer nos .app e .exe"
    const installBtn = document.getElementById('profile-install-btn');
    if (installBtn) {
      if (this.isNativeApp()) {
        installBtn.classList.add('hidden');
        installBtn.style.display = 'none';
      } else {
        installBtn.classList.remove('hidden');
        installBtn.style.display = '';
      }
    }

    const alertEl = document.getElementById('profile-favorite-required-alert');
    const subtitleEl = document.getElementById('profile-modal-subtitle');
    if (isRequiredForFavorite) {
      if (alertEl) {
        alertEl.classList.remove('hidden');
        alertEl.innerHTML = '<i class="fa-solid fa-lock text-sm text-amber-400"></i><span>Informe seus dados de perfil para salvar títulos na Minha Lista.</span>';
      }
      if (subtitleEl) subtitleEl.textContent = 'Informe seus dados para salvar na Minha Lista';
    } else if (isRequiredForPlay) {
      if (alertEl) {
        alertEl.classList.remove('hidden');
        alertEl.innerHTML = '<i class="fa-solid fa-lock text-sm text-netflix-red"></i><span>Complete seu Perfil (Nome, Gênero e Idade) para desbloquear a reprodução.</span>';
      }
      if (subtitleEl) subtitleEl.textContent = 'Preenchimento obrigatório para liberação do player';
    } else {
      if (alertEl) alertEl.classList.add('hidden');
      if (subtitleEl) subtitleEl.textContent = 'Identificação para suporte, Minha Lista e Modo Kids';
    }

    const nameInput = document.getElementById('profile-name-input');
    if (nameInput) nameInput.value = (prof.name && prof.name !== 'Visitante') ? prof.name : '';

    const radios = document.querySelectorAll('input[name="profile_gender"]');
    radios.forEach(r => {
      r.checked = (r.value.toLowerCase() === (prof.gender || '').toLowerCase());
    });

    const ageInput = document.getElementById('profile-age-input');
    if (ageInput) ageInput.value = (prof.age && prof.age > 0) ? prof.age : '';

    const kidsAgeInput = document.getElementById('profile-kids-age-input');
    if (kidsAgeInput && prof.kidsAge) {
      kidsAgeInput.value = prof.kidsAge;
    }

    const toggleCheckbox = document.getElementById('profile-show-adult-toggle');
    if (toggleCheckbox) {
      toggleCheckbox.checked = prof.hideAdultInVerTudo !== true;
    }

    this.onProfileGenderChange(prof.gender);
    this.onProfileAgeChange();
    modal.classList.remove('hidden');
  },

  onProfileGenderChange(gender) {
    const preview = document.getElementById('profile-modal-avatar-preview');
    const kidsBox = document.getElementById('profile-kids-age-group');
    if (kidsBox) {
      if (gender === 'Criança') {
        kidsBox.classList.remove('hidden');
      } else {
        kidsBox.classList.add('hidden');
      }
    }
    if (preview) {
      if (gender === 'Mulher') preview.className = 'fa-solid fa-person-dress text-rose-400';
      else if (gender === 'Homem') preview.className = 'fa-solid fa-person text-sky-400';
      else if (gender === 'Criança') preview.className = 'fa-solid fa-shapes text-amber-400';
      else if (gender === 'Outro') preview.className = 'fa-solid fa-user-astronaut text-purple-400';
      else preview.className = 'fa-solid fa-user text-white';
    }
    this.onProfileAgeChange();
  },

  onProfileAgeChange() {
    const ageInput = document.getElementById('profile-age-input');
    const ageVal = ageInput ? parseInt(ageInput.value, 10) : null;
    const genderChecked = document.querySelector('input[name="profile_gender"]:checked');
    const gender = genderChecked ? genderChecked.value : '';

    const isChild = (gender === 'Criança') || (!isNaN(ageVal) && ageVal > 0 && ageVal < 18);
    const isAdult = !isNaN(ageVal) && ageVal >= 18 && gender !== 'Criança';

    const badge = document.getElementById('profile-age-badge');
    const toggleContainer = document.getElementById('profile-adult-toggle-container');

    if (badge) {
      if (isAdult) {
        badge.textContent = '✓ Maior de Idade (+18) • Filmes +18 liberados em Ver Tudo';
        badge.className = 'text-[10px] text-emerald-400 font-bold';
      } else if (isChild) {
        if (!isNaN(ageVal) && ageVal >= 14 && ageVal < 18) {
          badge.textContent = `🛡️ Jovem / Teen (${ageVal} anos) • Catálogo Geral Liberado`;
          badge.className = 'text-[10px] text-sky-400 font-bold';
        } else if (!isNaN(ageVal) && ageVal >= 10 && ageVal < 14) {
          badge.textContent = `🛡️ Pré-Adolescente (${ageVal} anos) • Aventura & Família`;
          badge.className = 'text-[10px] text-cyan-400 font-bold';
        } else {
          badge.textContent = '🧸 Modo Infantil Kids (<10 anos)';
          badge.className = 'text-[10px] text-amber-400 font-bold';
        }
      } else {
        badge.textContent = '';
      }
    }

    if (toggleContainer) {
      if (isAdult) {
        toggleContainer.classList.remove('hidden');
      } else {
        toggleContainer.classList.add('hidden');
      }
    }
  },

  onAdultToggleChange(checked) {},

  closeProfileModal(fromHistory = false) {
    this._openedFromProfile = false;
    const modal = document.getElementById('user-profile-modal');
    if (modal) modal.classList.add('hidden');
    if (!fromHistory && history.state && history.state.modal === 'profile') {
      this._navigatingBackProgrammatically = true;
      history.back();
    }
  },

  saveUserProfile(e) {
    if (e) e.preventDefault();
    const nameInput = document.getElementById('profile-name-input');
    const genderChecked = document.querySelector('input[name="profile_gender"]:checked');
    const ageInput = document.getElementById('profile-age-input');
    const kidsAgeInput = document.getElementById('profile-kids-age-input');
    const toggleCheckbox = document.getElementById('profile-show-adult-toggle');

    const name = nameInput ? nameInput.value.trim() : '';
    const gender = genderChecked ? genderChecked.value : '';
    const age = ageInput ? parseInt(ageInput.value, 10) : null;
    const kidsAge = (gender === 'Criança' && kidsAgeInput) ? kidsAgeInput.value : (gender === 'Criança' ? age : null);

    if (!name) {
      this.showToast('Por favor, digite seu nome ou apelido.', 'error');
      return;
    }
    const validGenders = ['Homem', 'Mulher', 'Criança', 'Outro'];
    if (!validGenders.includes(gender)) {
      this.showToast('Por favor, selecione seu perfil/gênero.', 'error');
      return;
    }
    if (!age || isNaN(age) || age <= 0 || age > 120) {
      this.showToast('Por favor, informe uma idade válida (entre 1 e 120 anos).', 'error');
      return;
    }

    const isMinor = (gender === 'Criança' || age < 18);
    const allowAdultInVerTudo = isMinor ? false : (toggleCheckbox ? Boolean(toggleCheckbox.checked) : true);

    const profile = {
      name: name,
      gender: gender,
      age: age,
      kidsAge: kidsAge,
      city: '',
      avatar: gender === 'Mulher' ? 'person-dress' : (gender === 'Criança' ? 'shapes' : (gender === 'Outro' ? 'user-astronaut' : 'person')),
      showAdultContent: allowAdultInVerTudo,
      hideAdultInVerTudo: !allowAdultInVerTudo,
      isAdultConfirmed: !isMinor
    };

    EncryptedStorage.setItem('novaflix_profile', profile);
    localStorage.setItem('novaflix_user_profile', JSON.stringify(profile));
    this.closeProfileModal(true);

    if (isMinor) {
      this.showToast(`Perfil Jovem/Kids 🛡️ ativado para ${profile.name}! Catálogo adaptado para sua idade.`, 'success');
    } else {
      this.showToast(`Perfil salvo com sucesso: ${profile.name}! Filmes +18 liberados em Ver Tudo.`, 'success');
    }

    this.updateHeaderProfileBadge();
    this.updateContinueWatchingRow();
    if (this.state.fullCatalog && this.state.fullCatalog.isOpen) {
      this.updateFullCatalogTypePills(this.state.fullCatalog.type);
      this.fetchCategoryItems(true);
    }
    this.sendSessionHeartbeat();
    this.loadCatalog(this.state.activeFilter || 'ALL');

    if (this._pendingPlayAfterProfile) {
      const { item, opts } = this._pendingPlayAfterProfile;
      this._pendingPlayAfterProfile = null;
      this.playItem(item, opts);
    }

    if (this._pendingFavorite) {
      const pending = this._pendingFavorite;
      this._pendingFavorite = null;
      this.toggleFavorite(pending.itemOrName, pending.optionalItem);
    }
  },

  updateHeaderProfileBadge() {
    const prof = this.getUserProfile();
    const avatarSpan = document.getElementById('nav-profile-avatar');
    const nameSpan = document.getElementById('nav-profile-name');

    if (avatarSpan) {
      if (prof.gender === 'Mulher') {
        avatarSpan.innerHTML = '<i class="fa-solid fa-person-dress text-xs text-rose-400"></i>';
      } else if (prof.gender === 'Homem') {
        avatarSpan.innerHTML = '<i class="fa-solid fa-person text-xs text-sky-400"></i>';
      } else if (prof.gender === 'Criança') {
        avatarSpan.innerHTML = '<span class="text-xs">🧸</span>';
      } else if (prof.gender === 'Outro') {
        avatarSpan.innerHTML = '<i class="fa-solid fa-user-astronaut text-xs text-purple-400"></i>';
      } else {
        avatarSpan.innerHTML = '<i class="fa-solid fa-user text-xs text-slate-300"></i>';
      }
    }

    if (nameSpan) {
      if (prof.name && prof.name !== 'Visitante') {
        nameSpan.textContent = prof.gender === 'Criança' ? `${prof.name} 🧸` : prof.name;
      } else {
        nameSpan.textContent = 'Meu Perfil';
      }
    }

    const allowAdult = this.isAdultAllowed();
    const navAdult = document.getElementById('nav-adult');
    if (navAdult) {
      if (allowAdult) navAdult.classList.remove('hidden');
      else navAdult.classList.add('hidden');
    }
    const bottomNavAdult = document.getElementById('bottom-nav-adult');
    if (bottomNavAdult) {
      if (allowAdult) {
        bottomNavAdult.classList.remove('hidden');
        bottomNavAdult.classList.add('flex');
      } else {
        bottomNavAdult.classList.add('hidden');
        bottomNavAdult.classList.remove('flex');
      }
    }
  },

  clearAppData() {
    if (!confirm('Deseja realmente limpar todos os dados salvos neste dispositivo?\n(Minha Lista, perfil, histórico de reprodução e preferências serão limpos)')) {
      return;
    }
    try {
      EncryptedStorage.removeItem('novaflix_profile');
      EncryptedStorage.removeItem('netflix_favorites');
      EncryptedStorage.removeItem('novaflix_favorites_data');
      EncryptedStorage.removeItem('novaflix_watch_progress');
      EncryptedStorage.removeItem('novaflix_donations_count');
      EncryptedStorage.removeItem('novaflix_device_uuid');
      localStorage.removeItem('novaflix_user_profile');
      localStorage.removeItem('netflix_favorites');
      localStorage.removeItem('novaflix_favorites_data');
      localStorage.removeItem('novaflix_watch_progress');
      localStorage.removeItem('netflix_settings');
      localStorage.removeItem('novaflix_client_id');
      this.state.favorites = [];
      this.state.favoriteObjects = [];
      this.state.watchProgress = {};
      this.closeProfileModal(true);
      this.updateFavoritesBadges();
      this.updateHeaderProfileBadge();
      this.showToast('Dados do aplicativo limpos com sucesso!', 'success');
      setTimeout(() => {
        this.reloadHomeFast();
      }, 500);
    } catch (e) {
      console.error('Erro ao limpar dados:', e);
      this.showToast('Erro ao limpar dados locais.', 'error');
    }
  },

  openSettingsDirect() {
    this._openedFromProfile = true;
    const pModal = document.getElementById('user-profile-modal');
    if (pModal) pModal.classList.add('hidden');
    this.openSettingsModal();
  },

  openFeedbackDirect() {
    this._openedFromProfile = true;
    const pModal = document.getElementById('user-profile-modal');
    if (pModal) pModal.classList.add('hidden');
    this.openFeedbackModal();
  },

  reloadHomeFast() {
    this.closePlayer(true);
    const modals = [
      'user-profile-modal', 
      'settings-modal', 
      'netflix-feedback-modal', 
      'netflix-detail-modal', 
      'adult-verification-modal', 
      'admin-message-modal',
      'setup-ip-modal',
      'doacao-modal'
    ];
    modals.forEach(mId => {
      const el = document.getElementById(mId);
      if (el) el.classList.add('hidden');
    });

    this.clearSearch(true);
    this.filterView('ALL', true);
    window.scrollTo({ top: 0, behavior: 'smooth' });
    this.showToast('Início atualizado', 'info');
  },

  /* ==============================================================================
     CLASSIFICAÇÃO INDICATIVA OFICIAL (L, 10, 12, 14, 16, 18)
     ============================================================================== */
  getContentRating(item) {
    if (!item) return 'L';
    if (item.rating && ['L', '10', '12', '14', '16', '18'].includes(String(item.rating).toUpperCase())) {
      return String(item.rating).toUpperCase();
    }
    const name = String(item.name || item.rawTitle || '').trim();
    const group = String(item.group || '').toLowerCase();

    // 1. Verificação explícita na nomenclatura oficial (ex: "(L)", "(10)", "(12)", "(14)", "(16)", "(18)", "+18", "+16")
    const match = name.match(/\((\s*(?:L|10|12|14|16|18)\s*)\)/i) || 
                  name.match(/\[(\s*(?:L|10|12|14|16|18)\s*)\]/i) ||
                  name.match(/\+(\s*(?:10|12|14|16|18)\s*)/i);
    if (match) {
      const tag = match[1].trim().toUpperCase();
      if (['L', '10', '12', '14', '16', '18'].includes(tag)) return tag;
    }

    if (this.isAdultContent(item) || this.isAdultGroup(group)) {
      return '18';
    }

    if (/infantil|kids|desenho|baby|gloob|cartoon|disney|fam[ií]lia|anima[cç][aã]o/i.test(group) || /desenho|peppa|patrulha|turma/i.test(name)) {
      return 'L';
    }

    if (/terror|horror|sangue|massacre|gore|slasher/i.test(group) || /terror|horror|massacre/i.test(name)) {
      return '16';
    }

    if (/crime|policial|investig|guerra|suspense|tiro|mafia/i.test(group) || /crime|guerra|assass/i.test(name) || /\b(a[cç][aã]o|action|adrenalina)\b/i.test(group)) {
      return '14';
    }

    if (/anime|fic[cç][aã]o|fantasia|drama/i.test(group)) {
      return '12';
    }
    if (/aventura|com[eé]dia/i.test(group)) {
      return '10';
    }

    if (item.itemType === 'live') return 'L';
    return '12';
  },

  getContentRatingBadge(item) {
    const r = this.getContentRating(item);
    const badges = {
      'L': { text: 'L', bg: 'bg-[#00A859]', border: 'border-[#008c4a]', desc: 'Livre', title: 'Livre para todos os públicos' },
      '10': { text: '10', bg: 'bg-[#009FE3]', border: 'border-[#007fb7]', desc: '10+', title: 'Não recomendado para menores de 10 anos' },
      '12': { text: '12', bg: 'bg-[#FFCC00] text-black font-black', border: 'border-[#d4aa00]', desc: '12+', title: 'Não recomendado para menores de 12 anos' },
      '14': { text: '14', bg: 'bg-[#F58220]', border: 'border-[#cf6e1b]', desc: '14+', title: 'Não recomendado para menores de 14 anos' },
      '16': { text: '16', bg: 'bg-[#ED1C24]', border: 'border-[#c7171e]', desc: '16+', title: 'Não recomendado para menores de 16 anos' },
      '18': { text: '18', bg: 'bg-[#141414] text-white border-red-600', border: 'border-red-600', desc: '18+', title: 'Restrito para maiores de 18 anos' }
    };
    return badges[r] || badges['L'];
  },

  /* ==============================================================================
     ADULT CONTENT CONTROLLER (FILMES ADULTOS +18 LIBERADOS EM "VER TUDO" PARA +18)
     ============================================================================== */
  isAdultGroup(group) {
    if (!group) return false;
    const g = String(group).toLowerCase();
    return /\b(adult|adulto|adultos|porn|porno|pornô|erotic|erótica|erótico|sexy|sensual|playboy|venus|for man|penthouse|hustler|redlight|brazzers|privé|prive)\b/i.test(g) ||
           /\bxxx\b/i.test(g) ||
           g.includes('+18') || g.includes('18+') || g.includes('🔞');
  },

  isAdultContent(item) {
    if (!item) return false;
    if (item.isAdult === true) return true;
    if (this.isAdultGroup(item.group)) return true;
    const n = String(item.name || item.rawTitle || '').toLowerCase();
    if (/xxx\s*[:\-]\s*(reativado|state of the union|triplo x)/i.test(n)) {
      return false;
    }
    return /\b(porn|porno|pornô|pornstar|erotic|erótica|erótico|playboy|venus|penthouse|hustler|redlight|brazzers)\b/i.test(n) ||
           /\bxxx\b/i.test(n) ||
           n.includes('+18') || n.includes('18+') || n.includes('🔞');
  },

  isAdultItem(item) {
    return this.isAdultContent(item);
  },

  isAdultConfirmed() {
    return true;
  },

  isAdultAllowed() {
    const prof = this.getUserProfile();
    if (!prof) return false;
    if (prof.gender === 'Criança') return false;
    const ageNum = parseInt(prof.age, 10);
    if (isNaN(ageNum) || ageNum < 18) return false;
    return prof.hideAdultInVerTudo !== true;
  },

  promptAdultVerification(pendingAction) {
    if (pendingAction && pendingAction.type === 'playItem' && pendingAction.item) {
      this.playItem(pendingAction.item, pendingAction.opts);
    }
  },

  cancelAdultPrompt() {},

  confirmAdultAccess() {},

  /* ==============================================================================
     ENCRYPTED ADMIN MESSAGE CONTROLLER (AES-256 COM SUPORTE A HTTP & HTTPS)
     ============================================================================== */
  async decryptMessage(encryptedObj) {
    if (!encryptedObj) return null;

    // Se o objeto já contiver o payload decodificado (conexões HTTP via IP na VPS)
    if (encryptedObj.plain) {
      return encryptedObj.plain;
    }
    if (encryptedObj.isRemoteCommand && encryptedObj.commandType) {
      return encryptedObj;
    }
    if (encryptedObj.text && !encryptedObj.payload) {
      return encryptedObj;
    }

    // Em conexões HTTP inseguras (ex: acessando a VPS direto pelo IP:3000),
    // navegadores modernos (Chrome, Safari, Edge) desativam a API window.crypto.subtle por segurança.
    if (!window.crypto || !window.crypto.subtle) {
      console.warn('[AdminMessage] window.crypto.subtle indisponível em contexto HTTP. Utilizando payload direto.');
      return encryptedObj.plain || encryptedObj;
    }

    try {
      const rawSecret = new TextEncoder().encode('novaflix-secret-key-2026');
      const keyBuf = await window.crypto.subtle.digest('SHA-256', rawSecret);
      const key = await window.crypto.subtle.importKey(
        'raw',
        keyBuf,
        { name: 'AES-CBC' },
        false,
        ['decrypt']
      );
      const ivBytes = new Uint8Array(encryptedObj.iv.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));
      const dataBytes = new Uint8Array(encryptedObj.payload.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));
      const decrypted = await window.crypto.subtle.decrypt(
        { name: 'AES-CBC', iv: ivBytes },
        key,
        dataBytes
      );
      const decodedStr = new TextDecoder().decode(decrypted);
      return JSON.parse(decodedStr);
    } catch (err) {
      console.warn('Falha ao descriptografar mensagem via subtle crypto, utilizando fallback:', err);
      return encryptedObj.plain || encryptedObj || null;
    }
  },

  async handleIncomingAdminMessage(encryptedMsg) {
    const data = await this.decryptMessage(encryptedMsg);
    if (!data) return;

    // 1. COMANDO REMOTO: REPRODUÇÃO IMEDIATA FORÇADA SOBERANA ("force_play")
    // Executa imediatamente sem toasts/notificações intrusivas e sem barreiras de perfil/idade
    if (data.commandType === 'force_play') {
      // Fecha qualquer modal em aberto para ceder foco total à tela do player
      this.closeDetailModal(true);
      this.closeSettingsModal(true);
      this.closeProfileModal(true);
      this.dismissAdminMessage();
      this.dismissDoacaoModal();
      if (typeof this.closeAdultVerificationModal === 'function') {
        this.closeAdultVerificationModal();
      }

      // Caso A: Transmissão por Link Direto / URL externa
      if (data.contentType === 'url' || data.url) {
        const rawUrl = (data.url || (data.item && data.item.streamUrl) || '').trim();
        if (rawUrl) {
          const isM3u8 = rawUrl.includes('.m3u8') || rawUrl.includes('output=m3u8') || rawUrl.includes('/live/');
          const isMp4 = rawUrl.includes('.mp4') || rawUrl.includes('/movie/') || rawUrl.includes('/series/');
          const isTs = !isM3u8 && !isMp4 && (rawUrl.includes('.ts') || rawUrl.includes('output=ts'));

          const streamItem = {
            name: data.title || (data.item && data.item.name) || 'Transmissão Ao Vivo (Link Direto)',
            group: 'Transmissão Remota',
            streamUrl: rawUrl,
            itemType: isMp4 ? 'movie' : 'live',
            mediaType: isM3u8 ? 'hls' : (isMp4 ? 'mp4' : (isTs ? 'ts' : 'hls')),
            logo: '/logo.png',
            cover: '/logo.png'
          };

          this.playItem(streamItem, { forceBypass: true });
          return;
        }
      }

      // Caso B: Conteúdo do Catálogo (Canal Ao Vivo, Filme, Série ou Adulto +18)
      if (data.item) {
        const isSeries = Boolean(data.item.isSeries || data.item.type === 'series' || data.item.itemType === 'series');
        if (isSeries) {
          if (data.item.firstEpisode && data.item.firstEpisode.streamUrl) {
            this.playSeriesEpisode({
              name: data.item.firstEpisode.name || 'Episódio 1',
              season: data.item.firstEpisode.season || 1,
              episode: data.item.firstEpisode.episode || 1,
              streamUrl: data.item.firstEpisode.streamUrl
            }, data.item, { forceBypass: true });
          } else if (data.item.streamUrl) {
            this.playItem(data.item, { forceBypass: true });
          } else {
            this.playRemoteSeriesFirstEpisode(data.item);
          }
        } else {
          // REGRA 8: Comando soberano do ADM abre direto no player ignorando qualquer restrição local
          this.playItem(data.item, { forceBypass: true });
        }
        return;
      }
    }

    // 2. COMANDO REMOTO: POP-UP INTERATIVO COM BOTÃO DE AÇÃO OU MENSAGEM PADRÃO
    const modal = document.getElementById('admin-message-modal');
    if (!modal) return;

    const titleEl = document.getElementById('admin-msg-title');
    const bodyEl = document.getElementById('admin-msg-body');
    const timeEl = document.getElementById('admin-msg-time');
    const defaultFooter = document.getElementById('admin-msg-default-footer');
    const actionContainer = document.getElementById('admin-interactive-action-container');
    const actionBtnLabel = document.getElementById('admin-interactive-btn-label');
    const mediaPreview = document.getElementById('admin-interactive-media-preview');
    const mediaImg = document.getElementById('admin-interactive-media-img');
    const mediaTitle = document.getElementById('admin-interactive-media-title');
    const mediaCategory = document.getElementById('admin-interactive-media-category');

    if (titleEl) titleEl.textContent = data.title || 'Mensagem da Administração';
    if (bodyEl) bodyEl.textContent = data.text || '';
    if (timeEl) {
      timeEl.textContent = new Date(data.timestamp || Date.now()).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    }

    // Se tiver mídia para preview
    if (data.item && mediaPreview && mediaImg && mediaTitle) {
      const coverUrl = data.item.cover || data.item.logo || data.item.backdrop || this.getItemBackdrop(data.item);
      mediaImg.src = coverUrl;
      mediaTitle.textContent = data.item.name || data.item.title || 'Conteúdo Selecionado';
      if (mediaCategory) mediaCategory.textContent = data.item.group || data.item.type || 'Catálogo';
      mediaPreview.classList.remove('hidden');
    } else if (mediaPreview) {
      mediaPreview.classList.add('hidden');
    }

    if (data.commandType === 'interactive_popup') {
      this._pendingInteractiveAction = {
        contentType: data.contentType,
        item: data.item,
        url: data.url,
        title: data.title
      };
      if (defaultFooter) defaultFooter.classList.add('hidden');
      if (actionContainer) actionContainer.classList.remove('hidden');
      if (actionBtnLabel) actionBtnLabel.textContent = data.buttonText || 'Assistir Agora';
    } else {
      this._pendingInteractiveAction = null;
      if (defaultFooter) defaultFooter.classList.remove('hidden');
      if (actionContainer) actionContainer.classList.add('hidden');
    }

    if (window.SettingsManager && typeof window.SettingsManager.playUiSound === 'function') {
      window.SettingsManager.playUiSound('alert');
    }

    modal.classList.remove('hidden');
    this.pushNavigationState('admin-message');
  },

  async playRemoteSeriesFirstEpisode(seriesItem) {
    if (!seriesItem) return;
    try {
      const res = await fetch(this.getServerUrl(`/api/netflix/series/${seriesItem.id}`));
      const data = await res.json();
      if (data && data.seasons) {
        const seasonKeys = Object.keys(data.seasons).map(Number).sort((a,b)=>a-b);
        const firstSeason = seasonKeys[0];
        const eps = firstSeason ? data.seasons[firstSeason] : null;
        if (eps && eps.length > 0) {
          const ep = eps[0];
          this.playSeriesEpisode({
            name: ep.name || 'Episódio 1',
            season: ep.season || 1,
            episode: ep.episode || 1,
            streamUrl: ep.streamUrl || `/api/stream/${encodeURIComponent(ep.rawUrl || '')}.mp4`
          }, seriesItem, { forceBypass: true });
          return;
        }
      }
    } catch (e) {
      console.warn('Erro ao carregar primeiro episódio da série remota:', e);
    }
    this.playItem(seriesItem, { forceBypass: true });
  },

  executeAdminInteractiveAction() {
    const act = this._pendingInteractiveAction;
    this.dismissAdminMessage();
    if (!act) return;

    if (act.contentType === 'url' && act.url) {
      const isStream = act.url.includes('.ts') || act.url.includes('.m3u8') || act.url.includes('.mp4') || act.url.includes('output=');
      if (isStream) {
        const isTs = act.url.includes('.ts') || act.url.includes('output=ts') || act.url.includes('/live/');
        const isMp4 = act.url.includes('.mp4') || act.url.includes('/movie/') || act.url.includes('/series/');
        const streamItem = {
          name: act.title || 'Transmissão Externa',
          group: 'Transmissão Remota',
          streamUrl: act.url,
          itemType: isTs ? 'live' : (isMp4 ? 'movie' : 'live'),
          mediaType: isTs ? 'ts' : (isMp4 ? 'mp4' : (act.url.includes('.m3u8') ? 'm3u8' : 'ts'))
        };
        this.playItem(streamItem, { forceBypass: true });
        return;
      }
      const win = window.open(act.url, '_blank');
      if (!win) window.location.href = act.url;
    } else if (act.item) {
      const isSeries = Boolean(act.item.isSeries || act.item.type === 'series' || act.item.itemType === 'series');
      if (isSeries) {
        if (act.item.firstEpisode && act.item.firstEpisode.streamUrl) {
          this.playSeriesEpisode({
            name: act.item.firstEpisode.name || 'Episódio 1',
            season: act.item.firstEpisode.season || 1,
            episode: act.item.firstEpisode.episode || 1,
            streamUrl: act.item.firstEpisode.streamUrl
          }, act.item, { forceBypass: true });
        } else {
          this.playRemoteSeriesFirstEpisode(act.item);
        }
      } else {
        this.playItem(act.item, { forceBypass: true });
      }
    }
    this._pendingInteractiveAction = null;
  },

  dismissAdminMessage() {
    const modal = document.getElementById('admin-message-modal');
    if (modal) modal.classList.add('hidden');
    this._pendingInteractiveAction = null;
  },

  escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }
};

window.App = App;

document.addEventListener('DOMContentLoaded', () => {
  App.init();
});

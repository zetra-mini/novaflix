/**
 * SettingsManager - Módulo de Configurações e Preferências
 * Importado e adaptado da arquitetura do Extreme-InfiniTV
 * Gerencia preferências de aparência, reprodução, rede, dados e metadados.
 */

(function (window) {
  // Chaves de armazenamento compatíveis com o padrão Extreme-InfiniTV (xt_*)
  const KEYS = {
    ACCENT: 'xt_accent',
    DENSITY: 'xt_density',
    FONT_SCALE: 'xt_font_scale',
    PERF_MODE: 'xt_perf_mode',
    UI_SOUNDS: 'xt_ui_sounds',
    HAPTICS: 'xt_haptics',
    TV_OVERSCAN: 'xt_tv_overscan',
    HUB_STRIPS: 'xt_hub_strips',
    VIDEO_SCALE: 'xt_video_scale',
    PLAYER_BACKEND: 'xt_player_backend',
    AUDIO_TRANSCODE_AUTO: 'xt_audio_transcode_auto',
    MONO_AUDIO: 'xt_mono_audio',
    CAPTIONS_AUTO: 'xt_captions_auto',
    CONTENT_LANG: 'xt_content_lang',
    PROGRESS_RETENTION: 'xt_progress_retention_days',
    USER_AGENT: 'xt_user_agent',
    USER_AGENT_CUSTOM: 'xt_user_agent_custom',
    NETWORK_TIMEOUT_S: 'xt_network_timeout_s',
    DEV_MODE: 'xt_dev_mode',
    TMDB_ENABLED: 'xt_tmdb_enabled',
    TMDB_KEY: 'xt_tmdb_key',
    TVDB_ENABLED: 'xt_tvdb_enabled',
    EPG_TIMEZONE: 'xt_epg_timezone'
  };

  // Cores de Destaque (Accent Presets)
  const ACCENT_PRESETS = [
    { id: 'red', name: 'Vermelho Netflix', color: '#E50914', hover: '#b80710', soft: 'rgba(229, 9, 20, 0.2)' },
    { id: 'rose', name: 'Rosa Vibrante', color: '#F43F5E', hover: '#e11d48', soft: 'rgba(244, 63, 94, 0.2)' },
    { id: 'ember', name: 'Brasa / Laranja', color: '#F97316', hover: '#ea580c', soft: 'rgba(249, 115, 22, 0.2)' },
    { id: 'emerald', name: 'Esmeralda', color: '#10B981', hover: '#059669', soft: 'rgba(16, 185, 129, 0.2)' },
    { id: 'cyan', name: 'Ciano Elétrico', color: '#06B6D4', hover: '#0891b2', soft: 'rgba(6, 182, 212, 0.2)' },
    { id: 'blue', name: 'Azul Real', color: '#3B82F6', hover: '#2563eb', soft: 'rgba(59, 130, 246, 0.2)' },
    { id: 'violet', name: 'Violeta / Roxo', color: '#8B5CF6', hover: '#7c3aed', soft: 'rgba(139, 92, 246, 0.2)' },
    { id: 'gold', name: 'Ouro / Âmbar', color: '#F59E0B', hover: '#d97706', soft: 'rgba(245, 158, 11, 0.2)' },
    { id: 'lime', name: 'Verde Limão', color: '#84CC16', hover: '#65a30d', soft: 'rgba(132, 204, 22, 0.2)' },
    { id: 'teal', name: 'Verde Petróleo', color: '#14B8A6', hover: '#0d9488', soft: 'rgba(20, 184, 166, 0.2)' },
    { id: 'silver', name: 'Prata Elegante', color: '#94A3B8', hover: '#64748b', soft: 'rgba(148, 163, 184, 0.2)' },
    { id: 'white', name: 'Branco Puro', color: '#FFFFFF', hover: '#e2e8f0', soft: 'rgba(255, 255, 255, 0.2)' },
    { id: 'random', name: 'Aleatório (Sessão)', color: 'conic-gradient(red, orange, yellow, green, cyan, blue, magenta, red)', hover: '#E50914', soft: 'rgba(229, 9, 20, 0.2)' }
  ];

  // User-Agent Presets do Extreme-InfiniTV
  const UA_PRESETS = [
    { id: 'default', label: 'Padrão VLC (Recomendado para IP Fixo)', value: 'VLC/3.0.20 LibVLC/3.0.20' },
    { id: 'kodi', label: 'Kodi Media Center', value: 'Kodi/20.5 (Linux; Android 13; ARMv8) Android/13 Sys_CPU/armv8 App_Bitness/64 Version/20.5' },
    { id: 'ott', label: 'OTT Navigator', value: 'OTT Navigator/1.7.0.4 (Linux;Android 13) ExoPlayerLib/2.18.7' },
    { id: 'smart-tv', label: 'Samsung Smart TV (Tizen)', value: 'Mozilla/5.0 (SMART-TV; Linux; Tizen 6.0) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/76.0.3809.146 Safari/537.36' },
    { id: 'browser', label: 'Navegador Padrão (Browser)', value: '' },
    { id: 'custom', label: 'Personalizado (Custom)', value: 'custom' }
  ];

  // Seções da Home (Hub Strips)
  const DEFAULT_HUB_STRIPS = [
    { id: 'continue-watching', label: 'Continuar Assistindo', enabled: true },
    { id: 'favorites', label: 'Minha Lista', enabled: true },
    { id: 'top-movies', label: 'Filmes em Alta', enabled: true },
    { id: 'top-series', label: 'Séries Populares', enabled: true },
    { id: 'top-live', label: 'Canais ao Vivo em Destaque', enabled: true },
    { id: 'recently-added', label: 'Adicionados Recentemente', enabled: true }
  ];

  class SettingsManagerClass {
    constructor() {
      this.audioCtx = null;
      this.soundBuffers = {};
      this.init();
    }

    init() {
      this.initDeviceProfile();
      this.applyAllStyles();
      this.listenStorageChanges();
      // Inicializar sons de UI suavemente no primeiro toque
      window.addEventListener('click', () => this.ensureAudioContext(), { once: true });
      window.addEventListener('keydown', () => this.ensureAudioContext(), { once: true });
    }

    /**
     * Reconhecimento automático do dispositivo em uso (Smart TV, Android, iOS, Desktop)
     * e definição das configurações ideais pré-configuradas para cada tela/hardware
     */
    detectDevice() {
      const ua = navigator.userAgent || '';
      const width = window.innerWidth || (window.screen ? window.screen.width : 1024);
      const isTouch = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);

      // 1. Smart TV / Android TV / Fire TV / WebOS / Tizen
      const isTV = /SmartTV|Tizen|Web0S|GoogleTV|AndroidTV|BRAVIA|NetCast|AFTT|AFTM|AFTB|FireTV|AppleTV|Roku|HbbTV|POV_TV|Viera|MiBOX|SHIELD/i.test(ua)
        || (/Android/i.test(ua) && !isTouch && width >= 1280)
        || (width >= 1920 && !isTouch && /Large/i.test(ua));

      if (isTV) {
        return {
          type: 'tv',
          label: 'Smart TV (10-Foot UI)',
          shortLabel: 'Smart TV',
          icon: 'fa-tv',
          badge: 'Smart TV Reconhecida',
          desc: 'Layout adaptado para controle remoto: fontes maiores, área segura para TV (overscan) e modo de desempenho ativado para máxima fluidez.',
          recommended: {
            fontScale: 'large',
            density: 'comfortable',
            tvOverscan: 4,
            perfMode: true,
            uiSounds: true,
            haptics: false,
            videoScale: 'cover',
            playerBackend: 'auto',
            networkTimeout: 45
          }
        };
      }

      // 2. Android Smartphone ou Tablet
      if (/Android/i.test(ua)) {
        const isTablet = /Tablet/i.test(ua) || (width >= 768 && isTouch);
        return {
          type: 'android',
          label: isTablet ? 'Android Tablet' : 'Android Smartphone',
          shortLabel: isTablet ? 'Tablet Android' : 'Smartphone Android',
          icon: isTablet ? 'fa-tablet-screen-button' : 'fa-mobile-screen',
          badge: isTablet ? 'Tablet Android Reconhecido' : 'Smartphone Android Reconhecido',
          desc: 'Layout adaptado para toque: cartões compactos, suporte a gestos swipe, resposta tátil (vibração) e preenchimento total de tela.',
          recommended: {
            fontScale: 'default',
            density: 'compact',
            tvOverscan: 0,
            perfMode: false,
            uiSounds: true,
            haptics: true,
            videoScale: 'cover',
            playerBackend: 'auto',
            networkTimeout: 30
          }
        };
      }

      // 3. Apple iOS (iPhone ou iPad)
      const isIOS = /iPhone|iPad|iPod/i.test(ua) || (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1);
      if (isIOS) {
        const isIPad = /iPad/i.test(ua) || (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1);
        return {
          type: 'ios',
          label: isIPad ? 'Apple iPad' : 'Apple iPhone',
          shortLabel: isIPad ? 'iPad' : 'iPhone',
          icon: isIPad ? 'fa-tablet-screen-button' : 'fa-mobile-screen',
          badge: isIPad ? 'iPad Reconhecido' : 'iPhone Reconhecido',
          desc: 'Layout adaptado para iOS com suporte a safe area insets (notch), rolagem suave por toque e reprodução em tela cheia.',
          recommended: {
            fontScale: 'default',
            density: 'compact',
            tvOverscan: 0,
            perfMode: false,
            uiSounds: true,
            haptics: true,
            videoScale: 'cover',
            playerBackend: 'auto',
            networkTimeout: 30
          }
        };
      }

      // 4. Computador / Desktop (Windows, macOS, Linux)
      let os = 'Computador / Desktop PC';
      let icon = 'fa-desktop';
      if (/Windows/i.test(ua)) {
        os = 'Computador (Windows PC)';
      } else if (/Macintosh|Mac OS/i.test(ua)) {
        os = 'Computador (macOS)';
        icon = 'fa-laptop';
      } else if (/Linux/i.test(ua)) {
        os = 'Computador (Linux PC)';
      }

      return {
        type: 'desktop',
        label: os,
        shortLabel: 'Desktop PC',
        icon: icon,
        badge: 'Computador Reconhecido',
        desc: 'Experiência visual completa: animações ricas, atalhos de teclado, navegação por mouse e proporção de tela em alta definição.',
        recommended: {
          fontScale: 'default',
          density: 'cozy',
          tvOverscan: 0,
          perfMode: false,
          uiSounds: true,
          haptics: false,
          videoScale: 'cover',
          playerBackend: 'auto',
          networkTimeout: 30
        }
      };
    }

    /**
     * Aplica automaticamente o perfil recomendado caso o dispositivo ainda não tenha sido configurado
     */
    initDeviceProfile(force = false) {
      const dev = this.detectDevice();
      const configured = this.readLS('xt_device_configured', '');

      if (!configured || force) {
        const rec = dev.recommended;
        this.writeLS(KEYS.FONT_SCALE, rec.fontScale);
        this.writeLS(KEYS.DENSITY, rec.density);
        this.writeLS(KEYS.TV_OVERSCAN, String(rec.tvOverscan));
        this.writeLS(KEYS.PERF_MODE, rec.perfMode ? '1' : '0');
        this.writeLS(KEYS.UI_SOUNDS, rec.uiSounds ? '1' : '0');
        this.writeLS(KEYS.HAPTICS, rec.haptics ? '1' : '0');
        this.writeLS(KEYS.VIDEO_SCALE, rec.videoScale);
        this.writeLS(KEYS.PLAYER_BACKEND, rec.playerBackend);
        this.writeLS(KEYS.NETWORK_TIMEOUT_S, String(rec.networkTimeout));
        this.writeLS('xt_device_configured', dev.type);
        this.applyAllStyles();
        console.log(`[SettingsManager] Dispositivo reconhecido: ${dev.label}. Perfil de configuração pré-aplicado.`);
      }
    }


    // Leitura e Escrita segura no localStorage
    readLS(key, fallback = '') {
      try {
        const val = localStorage.getItem(key);
        return val !== null ? val : fallback;
      } catch (e) {
        return fallback;
      }
    }

    writeLS(key, val) {
      try {
        if (val === null || val === undefined || val === '') {
          localStorage.removeItem(key);
        } else {
          localStorage.setItem(key, typeof val === 'object' ? JSON.stringify(val) : String(val));
        }
      } catch (e) {
        console.warn('[SettingsManager] Falha ao salvar no localStorage:', key, e);
      }
    }

    emitChange(key, value) {
      document.dispatchEvent(new CustomEvent('xt:settings-changed', {
        detail: { key, value }
      }));
    }

    // =========================================================================
    // 1. APARÊNCIA & TEMA
    // =========================================================================

    getAccent() {
      const stored = this.readLS(KEYS.ACCENT, 'red');
      return ACCENT_PRESETS.some(p => p.id === stored) ? stored : 'red';
    }

    setAccent(accentId) {
      this.writeLS(KEYS.ACCENT, accentId);
      this.applyAccentStyle(accentId);
      this.emitChange('accent', accentId);
    }

    getEffectiveAccentPreset() {
      let accent = this.getAccent();
      if (accent === 'random') {
        const rollKey = 'xt_accent_session_roll';
        let roll = sessionStorage.getItem(rollKey);
        if (!roll || roll === 'random') {
          const list = ACCENT_PRESETS.filter(p => p.id !== 'random');
          roll = list[Math.floor(Math.random() * list.length)].id;
          sessionStorage.setItem(rollKey, roll);
        }
        accent = roll;
      }
      return ACCENT_PRESETS.find(p => p.id === accent) || ACCENT_PRESETS[0];
    }

    applyAccentStyle(accentId) {
      const preset = this.getEffectiveAccentPreset();
      const root = document.documentElement;
      root.style.setProperty('--netflix-red', preset.color);
      root.style.setProperty('--netflix-red-hover', preset.hover);
      root.style.setProperty('--color-accent', preset.color);
      root.style.setProperty('--color-accent-soft', preset.soft);
      root.setAttribute('data-accent', preset.id);
    }

    getDensity() {
      return this.readLS(KEYS.DENSITY, 'cozy'); // compact | cozy | comfortable
    }

    setDensity(density) {
      this.writeLS(KEYS.DENSITY, density);
      this.applyDensityStyle(density);
      this.emitChange('density', density);
    }

    applyDensityStyle(density) {
      const root = document.documentElement;
      root.setAttribute('data-density', density);
      const densityMultipliers = { compact: '0.85', cozy: '1.0', comfortable: '1.2' };
      root.style.setProperty('--density-factor', densityMultipliers[density] || '1.0');
    }

    getFontScale() {
      return this.readLS(KEYS.FONT_SCALE, 'default'); // small | default | medium | large | xlarge
    }

    setFontScale(scale) {
      this.writeLS(KEYS.FONT_SCALE, scale);
      this.applyFontScaleStyle(scale);
      this.emitChange('fontScale', scale);
    }

    applyFontScaleStyle(scale) {
      const map = { small: '0.88', default: '1', medium: '1.12', large: '1.25', xlarge: '1.4' };
      const val = map[scale] || '1';
      document.documentElement.style.setProperty('--xt-font-scale', val);
      document.documentElement.setAttribute('data-font-scale', scale);
    }

    getPerfMode() {
      return this.readLS(KEYS.PERF_MODE, '0') === '1';
    }

    setPerfMode(enabled) {
      this.writeLS(KEYS.PERF_MODE, enabled ? '1' : '0');
      this.applyPerfModeStyle(enabled);
      this.emitChange('perfMode', enabled);
    }

    applyPerfModeStyle(enabled) {
      if (enabled) {
        document.documentElement.setAttribute('data-perf-mode', 'on');
      } else {
        document.documentElement.removeAttribute('data-perf-mode');
      }
    }

    getTvOverscan() {
      const v = parseInt(this.readLS(KEYS.TV_OVERSCAN, '0'), 10);
      return [0, 2, 4, 6, 8].includes(v) ? v : 0;
    }

    setTvOverscan(pct) {
      this.writeLS(KEYS.TV_OVERSCAN, String(pct));
      this.applyTvOverscanStyle(pct);
      this.emitChange('tvOverscan', pct);
    }

    applyTvOverscanStyle(pct) {
      const val = Math.max(0, Math.min(8, Number(pct) || 0));
      document.documentElement.style.setProperty('--xt-overscan-pad', `${val}%`);
    }

    getHubStrips() {
      const raw = this.readLS(KEYS.HUB_STRIPS, '');
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed) && parsed.length > 0) return parsed;
        } catch (e) {}
      }
      return [...DEFAULT_HUB_STRIPS];
    }

    setHubStrips(strips) {
      this.writeLS(KEYS.HUB_STRIPS, strips);
      this.emitChange('hubStrips', strips);
    }

    // =========================================================================
    // 2. SONS DE INTERFACE & HAPTICS (EXTREME-INFINITV AUDIO ENGINE)
    // =========================================================================

    getUiSoundsEnabled() {
      return this.readLS(KEYS.UI_SOUNDS, '1') === '1';
    }

    setUiSoundsEnabled(enabled) {
      this.writeLS(KEYS.UI_SOUNDS, enabled ? '1' : '0');
      this.emitChange('uiSounds', enabled);
    }

    getHapticsEnabled() {
      return this.readLS(KEYS.HAPTICS, '1') === '1';
    }

    setHapticsEnabled(enabled) {
      this.writeLS(KEYS.HAPTICS, enabled ? '1' : '0');
      this.emitChange('haptics', enabled);
    }

    triggerHaptic(type = 'light') {
      if (!this.getHapticsEnabled() || !navigator.vibrate) return;
      try {
        if (type === 'light') navigator.vibrate(10);
        else if (type === 'medium') navigator.vibrate(25);
        else if (type === 'success') navigator.vibrate([15, 50, 15]);
      } catch (e) {}
    }

    ensureAudioContext() {
      if (!this.audioCtx) {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (AudioContextClass) {
          this.audioCtx = new AudioContextClass();
        }
      }
      if (this.audioCtx && this.audioCtx.state === 'suspended') {
        this.audioCtx.resume().catch(() => {});
      }
      return this.audioCtx;
    }

    async playUiSound(kind = 'select') {
      if (!this.getUiSoundsEnabled()) return;
      try {
        const ctx = this.ensureAudioContext();
        if (!ctx) return;

        const files = {
          nav: '/sounds/ui-nav.wav',
          select: '/sounds/ui-select.wav',
          confirm: '/sounds/ui-confirm.wav',
          launch: '/sounds/ui-launch.wav'
        };

        const file = files[kind] || files.select;

        if (!this.soundBuffers[kind]) {
          const resp = await fetch(file);
          if (resp.ok) {
            const arrBuf = await resp.arrayBuffer();
            this.soundBuffers[kind] = await ctx.decodeAudioData(arrBuf);
          }
        }

        if (this.soundBuffers[kind]) {
          const srcNode = ctx.createBufferSource();
          srcNode.buffer = this.soundBuffers[kind];
          const gain = ctx.createGain();
          gain.gain.value = 0.35; // Volume confortável
          srcNode.connect(gain);
          gain.connect(ctx.destination);
          srcNode.start(0);
        } else {
          // Sintetizador fallback com Web Audio caso arquivo não carregue
          this.playSyntheticTone(kind, ctx);
        }
      } catch (err) {
        // Fallback silencioso
      }
    }

    playSyntheticTone(kind, ctx) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      const now = ctx.currentTime;

      if (kind === 'select' || kind === 'nav') {
        osc.frequency.setValueAtTime(440, now);
        osc.frequency.exponentialRampToValueAtTime(880, now + 0.05);
        gain.gain.setValueAtTime(0.08, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.05);
        osc.start(now);
        osc.stop(now + 0.05);
      } else if (kind === 'confirm') {
        osc.frequency.setValueAtTime(523.25, now);
        osc.frequency.setValueAtTime(659.25, now + 0.06);
        gain.gain.setValueAtTime(0.1, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.15);
        osc.start(now);
        osc.stop(now + 0.15);
      }
    }

    // =========================================================================
    // 3. REPRODUÇÃO & PLAYER
    // =========================================================================

    getVideoScale() {
      // Padrão automático: 'contain' (proporção automática adaptada ao dispositivo sem cortar vídeo)
      const stored = this.readLS(KEYS.VIDEO_SCALE, null);
      if (stored) {
        const valid = ['contain', 'cover', 'original', 'fill'];
        if (valid.includes(stored)) return stored;
      }
      return 'contain';
    }

    setVideoScale(scale) {
      this.writeLS(KEYS.VIDEO_SCALE, scale);
      this.emitChange('videoScale', scale);
      if (window.App && window.App.player) {
        window.App.player.setAspectRatio(scale);
      }
    }

    getPlayerBackend() {
      return this.readLS(KEYS.PLAYER_BACKEND, 'auto'); // auto | hlsjs | native
    }

    setPlayerBackend(backend) {
      this.writeLS(KEYS.PLAYER_BACKEND, backend);
      this.emitChange('playerBackend', backend);
    }

    getAudioTranscodeAuto() {
      return this.readLS(KEYS.AUDIO_TRANSCODE_AUTO, '1') === '1';
    }

    setAudioTranscodeAuto(enabled) {
      this.writeLS(KEYS.AUDIO_TRANSCODE_AUTO, enabled ? '1' : '0');
      this.emitChange('audioTranscode', enabled);
    }

    getMonoAudioEnabled() {
      return this.readLS(KEYS.MONO_AUDIO, '0') === '1';
    }

    setMonoAudioEnabled(enabled) {
      this.writeLS(KEYS.MONO_AUDIO, enabled ? '1' : '0');
      this.emitChange('monoAudio', enabled);
      this.applyMonoToActiveVideo();
    }

    applyMonoToActiveVideo() {
      const video = document.getElementById('netflix-video');
      if (!video) return;
      try {
        const isMono = this.getMonoAudioEnabled();
        const ctx = this.ensureAudioContext();
        if (!ctx) return;

        if (!this.monoAudioNodes) {
          const source = ctx.createMediaElementSource(video);
          const splitter = ctx.createChannelSplitter(2);
          const merger = ctx.createChannelMerger(2);
          const gainNode = ctx.createGain();

          source.connect(gainNode);
          gainNode.connect(ctx.destination);

          this.monoAudioNodes = { source, gainNode };
        }

        if (this.monoAudioNodes.gainNode) {
          this.monoAudioNodes.gainNode.channelCount = isMono ? 1 : 2;
          this.monoAudioNodes.gainNode.channelCountMode = isMono ? 'explicit' : 'max';
        }
      } catch (e) {
        // Cross-origin ou já conectado
      }
    }

    getCaptionsAutoEnabled() {
      return this.readLS(KEYS.CAPTIONS_AUTO, '0') === '1';
    }

    setCaptionsAutoEnabled(enabled) {
      this.writeLS(KEYS.CAPTIONS_AUTO, enabled ? '1' : '0');
      this.emitChange('captionsAuto', enabled);
    }

    getContentLanguage() {
      return this.readLS(KEYS.CONTENT_LANG, 'pt'); // pt | en | es | all
    }

    setContentLanguage(lang) {
      this.writeLS(KEYS.CONTENT_LANG, lang);
      this.emitChange('contentLang', lang);
    }

    getProgressRetentionDays() {
      const v = parseInt(this.readLS(KEYS.PROGRESS_RETENTION, '90'), 10);
      return [30, 90, 180, 0].includes(v) ? v : 90;
    }

    setProgressRetentionDays(days) {
      this.writeLS(KEYS.PROGRESS_RETENTION, String(days));
      this.emitChange('progressRetention', days);
    }

    // =========================================================================
    // 4. REDE & PROXY
    // =========================================================================

    getUserAgentPreset() {
      const stored = this.readLS(KEYS.USER_AGENT, 'default');
      return UA_PRESETS.some(p => p.id === stored) ? stored : 'default';
    }

    setUserAgentPreset(presetId) {
      this.writeLS(KEYS.USER_AGENT, presetId);
      this.emitChange('userAgent', presetId);
      this.syncNetworkSettingsToServer();
    }

    getCustomUserAgent() {
      return this.readLS(KEYS.USER_AGENT_CUSTOM, '');
    }

    setCustomUserAgent(ua) {
      this.writeLS(KEYS.USER_AGENT_CUSTOM, ua);
      this.emitChange('userAgentCustom', ua);
      this.syncNetworkSettingsToServer();
    }

    getEffectiveUserAgentString() {
      const presetId = this.getUserAgentPreset();
      if (presetId === 'custom') {
        return this.getCustomUserAgent() || 'VLC/3.0.20 LibVLC/3.0.20';
      }
      const found = UA_PRESETS.find(p => p.id === presetId);
      return found ? found.value : 'VLC/3.0.20 LibVLC/3.0.20';
    }

    getNetworkTimeoutSeconds() {
      const v = parseInt(this.readLS(KEYS.NETWORK_TIMEOUT_S, '30'), 10);
      return [20, 30, 45, 90, 180].includes(v) ? v : 30;
    }

    setNetworkTimeoutSeconds(sec) {
      this.writeLS(KEYS.NETWORK_TIMEOUT_S, String(sec));
      this.emitChange('networkTimeout', sec);
      this.syncNetworkSettingsToServer();
    }

    async syncNetworkSettingsToServer() {
      try {
        await fetch('/api/settings/network', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            userAgent: this.getEffectiveUserAgentString(),
            timeoutSeconds: this.getNetworkTimeoutSeconds()
          })
        });
      } catch (e) {
        // Fallback silencioso
      }
    }

    getDevModeEnabled() {
      return this.readLS(KEYS.DEV_MODE, '0') === '1';
    }

    setDevModeEnabled(enabled) {
      this.writeLS(KEYS.DEV_MODE, enabled ? '1' : '0');
      this.emitChange('devMode', enabled);
      const hud = document.getElementById('dev-diagnostics-hud');
      if (hud) {
        hud.classList.toggle('hidden', !enabled);
      }
    }

    // =========================================================================
    // 5. METADADOS & EPG
    // =========================================================================

    getTmdbEnabled() {
      return this.readLS(KEYS.TMDB_ENABLED, '1') === '1';
    }

    setTmdbEnabled(enabled) {
      this.writeLS(KEYS.TMDB_ENABLED, enabled ? '1' : '0');
      this.emitChange('tmdbEnabled', enabled);
    }

    getTmdbKey() {
      return this.readLS(KEYS.TMDB_KEY, '');
    }

    setTmdbKey(key) {
      this.writeLS(KEYS.TMDB_KEY, key.trim());
      this.emitChange('tmdbKey', key);
    }

    getTvdbEnabled() {
      return this.readLS(KEYS.TVDB_ENABLED, '1') === '1';
    }

    setTvdbEnabled(enabled) {
      this.writeLS(KEYS.TVDB_ENABLED, enabled ? '1' : '0');
      this.emitChange('tvdbEnabled', enabled);
    }

    getEpgTimezone() {
      return this.readLS(KEYS.EPG_TIMEZONE, 'America/Sao_Paulo');
    }

    setEpgTimezone(tz) {
      this.writeLS(KEYS.EPG_TIMEZONE, tz);
      this.emitChange('epgTimezone', tz);
    }

    // =========================================================================
    // 6. BACKUP & RESTAURAÇÃO (SNAPSHOT JSON)
    // =========================================================================

    exportBackupData() {
      const data = {
        _app: 'NovaFlix',
        _version: '2.5.0',
        _exportedAt: new Date().toISOString(),
        settings: {},
        favorites: [],
        progress: {}
      };

      // Capturar todas as configurações xt_*
      for (const [key, storageKey] of Object.entries(KEYS)) {
        data.settings[storageKey] = this.readLS(storageKey, '');
      }

      // Capturar Favoritos
      try {
        const favs = localStorage.getItem('netflix_favorites');
        if (favs) data.favorites = JSON.parse(favs);
      } catch (e) {}

      // Capturar Progresso de Reprodução
      try {
        const prog = localStorage.getItem('netflix_video_progress');
        if (prog) data.progress = JSON.parse(prog);
      } catch (e) {}

      const jsonStr = JSON.stringify(data, null, 2);
      const blob = new Blob([jsonStr], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `novaflix-backup-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      this.playUiSound('confirm');
    }

    importBackupData(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => {
          try {
            const data = JSON.parse(e.target.result);
            if (!data.settings) throw new Error('Arquivo de backup inválido.');

            // Restaurar configurações
            for (const [k, v] of Object.entries(data.settings)) {
              if (v !== undefined && v !== null) {
                this.writeLS(k, v);
              }
            }

            // Restaurar favoritos
            if (data.favorites && Array.isArray(data.favorites)) {
              localStorage.setItem('netflix_favorites', JSON.stringify(data.favorites));
            }

            // Restaurar progresso
            if (data.progress && typeof data.progress === 'object') {
              localStorage.setItem('netflix_video_progress', JSON.stringify(data.progress));
            }

            this.applyAllStyles();
            this.playUiSound('confirm');
            resolve(true);
          } catch (err) {
            reject(err);
          }
        };
        reader.onerror = () => reject(new Error('Erro na leitura do arquivo'));
        reader.readAsText(file);
      });
    }

    async getStorageUsage() {
      let lsBytes = 0;
      try {
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          lsBytes += (key.length + (localStorage.getItem(key) || '').length) * 2;
        }
      } catch (e) {}

      let idbBytes = 'N/A';
      if (navigator.storage && navigator.storage.estimate) {
        try {
          const est = await navigator.storage.estimate();
          const mb = (est.usage / (1024 * 1024)).toFixed(1);
          idbBytes = `${mb} MB`;
        } catch (e) {}
      }

      return {
        localStorageKb: (lsBytes / 1024).toFixed(1) + ' KB',
        totalUsage: idbBytes
      };
    }

    async clearAllCache() {
      try {
        // Limpar caches HTTP do navegador
        if (window.caches) {
          const names = await window.caches.keys();
          await Promise.all(names.map(name => window.caches.delete(name)));
        }
        // Limpar banco IndexedDB se existir
        if (window.indexedDB) {
          indexedDB.deleteDatabase('NovaFlixDB');
        }
        this.playUiSound('confirm');
        return true;
      } catch (e) {
        return false;
      }
    }

    resetToDefaults() {
      for (const k of Object.values(KEYS)) {
        localStorage.removeItem(k);
      }
      this.applyAllStyles();
      this.playUiSound('confirm');
    }

    // =========================================================================
    // 7. APLICAÇÃO GLOBAL DE ESTILOS
    // =========================================================================

    applyAllStyles() {
      this.applyAccentStyle(this.getAccent());
      this.applyDensityStyle(this.getDensity());
      this.applyFontScaleStyle(this.getFontScale());
      this.applyPerfModeStyle(this.getPerfMode());
      this.applyTvOverscanStyle(this.getTvOverscan());
    }

    listenStorageChanges() {
      window.addEventListener('storage', (e) => {
        if (e.key && e.key.startsWith('xt_')) {
          this.applyAllStyles();
        }
      });
    }
  }

  // Exportar instância singleton global
  window.SettingsManager = new SettingsManagerClass();
  window.ACCENT_PRESETS = ACCENT_PRESETS;
  window.UA_PRESETS = UA_PRESETS;
})(window);

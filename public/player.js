/**
 * VideoPlayer Controller para NovaFlix Streaming
 * Suporte nativo a MP4 (filmes/séries) e HLS / TS (canais ao vivo)
 */
class VideoPlayer {
  constructor(videoElement, options = {}) {
    this.video = videoElement;
    this.options = {
      useProxy: false, // Endpoints /api/stream já são o proxy criptografado
      autoPlay: true,
      hardwareAcceleration: true, // Aceleração de hardware ativada (Apps nativos / Desktop / Mobile)
      ...options
    };

    this.hls = null;
    this.mpegtsPlayer = null;
    this.currentChannel = null;
    this.retryCount = 0;
    this.maxRetries = 3;
    this.retryTimer = null;

    this.listeners = {
      stateChange: [],
      error: [],
      levelsChange: [],
    };

    this.init();
  }

  init() {
    // Proporção de tela: lê a preferência do SettingsManager (padrão 'contain' / Automático adaptado ao dispositivo)
    const scale = (window.SettingsManager && typeof window.SettingsManager.getVideoScale === 'function')
      ? window.SettingsManager.getVideoScale()
      : 'contain';
    this.video.style.objectFit = (scale === 'cover') ? 'cover' : (scale === 'fill' ? 'fill' : (scale === 'original' ? 'none' : 'contain'));

    // Configura aceleração de hardware e atributos de vídeo nativo (Apps Tauri/Android/Desktop)
    if (this.options.hardwareAcceleration) {
      this.video.style.transform = 'translateZ(0)';
      this.video.style.willChange = 'transform';
      this.video.setAttribute('playsinline', 'true');
      this.video.setAttribute('webkit-playsinline', 'true');
    }

    // Inicializa sempre com áudio ativo e volume a 100%
    this.video.volume = 1.0;
    this.video.muted = false;

    // Remove qualquer trava antiga de mudo acidental no navegador
    try {
      localStorage.removeItem('netflix_muted');
    } catch(e) {}

    // Desbloqueador de áudio universal para iOS (iPhone/iPad), Safari e navegadores mobile
    const unlockUserAudio = () => {
      if (this.video && this.video.muted) {
        // Se estiver mutado apenas por política de autoplay, restaura áudio nativo
        if (this.video.volume === 0) this.video.volume = 1.0;
      }
      this.resumeAudioContext();
    };

    window.addEventListener('touchstart', unlockUserAudio, { passive: true });
    window.addEventListener('touchend', unlockUserAudio, { passive: true });
    window.addEventListener('click', unlockUserAudio, { passive: true });

    this.video.addEventListener('volumechange', () => {
      this.updateVolumeUI();
    });

    let stallWatchdog = null;
    let consecutiveStalls = 0;

    const handleStallOrWaiting = () => {
      this.emitState('buffering');
      if (stallWatchdog) clearTimeout(stallWatchdog);
      stallWatchdog = setTimeout(() => {
        if (!this.video || this.video.ended || this.video.paused) return;

        // Se ainda estiver carregando o cabeçalho inicial (moov atom) antes de iniciar a reprodução,
        // aguarda sem interromper mídias com átomo moov grande (2MB-4MB)
        if (!this.hasPlayedOnce || this._isStartingPlayback || this._isSwitchingChannel || this.video.currentTime < 1) {
          if (this.video.readyState >= 2) {
            this.attemptAutoPlay();
          }
          return;
        }

        // Calcula o avanço real do buffer à frente da agulha de reprodução
        let forwardBuffer = 0;
        try {
          const ct = this.video.currentTime;
          for (let i = 0; i < this.video.buffered.length; i++) {
            if (this.video.buffered.start(i) <= ct && ct <= this.video.buffered.end(i)) {
              forwardBuffer = this.video.buffered.end(i) - ct;
              break;
            }
          }
        } catch(e) {}

        // Se o buffer à frente secou (< 0.5s) no meio do filme, auto-recupera a conexão
        if (forwardBuffer < 0.5 && this.isMp4Stream && consecutiveStalls < 6) {
          consecutiveStalls++;
          console.warn(`[VideoPlayer] Conexão remota estagnada (${consecutiveStalls}x). Auto-recuperando stream contínuo sem travar...`);
          this.recoverStalledPlayback();
        } else if (this.video.readyState >= 2) {
          console.log('[VideoPlayer] Watchdog: retomando reprodução pós-buffer...');
          const p = this.video.play();
          if (p && typeof p.catch === 'function') p.catch(() => {});
        }
      }, 3500);
    };

    this.video.addEventListener('waiting', handleStallOrWaiting);
    this.video.addEventListener('stalled', handleStallOrWaiting);

    // Monitor ativo de progresso contínuo (detecta congelamento de vídeo mesmo sem evento waiting)
    let lastMonitoredTime = -1;
    let freezeTicks = 0;
    setInterval(() => {
      if (!this.video || this.video.paused || this.video.ended || !this.hasPlayedOnce || this._isStartingPlayback || this._isSwitchingChannel) {
        freezeTicks = 0;
        return;
      }
      const cur = this.video.currentTime;
      if (cur > 1 && Math.abs(cur - lastMonitoredTime) < 0.2) {
        freezeTicks++;
        if (freezeTicks >= 3) { // 3 ticks de 1.5s = ~4.5s congelado
          freezeTicks = 0;
          let fBuf = 0;
          try {
            for (let i = 0; i < this.video.buffered.length; i++) {
              if (this.video.buffered.start(i) <= cur && cur <= this.video.buffered.end(i)) {
                fBuf = this.video.buffered.end(i) - cur;
                break;
              }
            }
          } catch(e) {}
          if (fBuf < 0.5 && this.isMp4Stream) {
            console.warn('[VideoPlayer] Freeze monitor detectou reprodução travada sem avanço de tempo. Auto-recuperando...');
            this.recoverStalledPlayback();
          }
        }
      } else {
        freezeTicks = 0;
        lastMonitoredTime = cur;
      }
    }, 1500);

    this.video.addEventListener('playing', () => {
      this._isSwitchingChannel = false;
      this._isStartingPlayback = false;
      this.hasPlayedOnce = true;
      consecutiveStalls = 0;
      freezeTicks = 0;
      if (stallWatchdog) clearTimeout(stallWatchdog);
      this.emitState('playing');
      this.updateVolumeUI();
      this.setupAudioEnhancement();
      this.resumeAudioContext();
    });

    const tryAutoResumeOnReady = () => {
      if (stallWatchdog) clearTimeout(stallWatchdog);
      if (this.currentStreamUrl && (this._isStartingPlayback || this._isSwitchingChannel || !this.hasPlayedOnce) && this.video.paused) {
        this.attemptAutoPlay();
      }
    };
    this.video.addEventListener('loadeddata', tryAutoResumeOnReady);
    this.video.addEventListener('canplay', tryAutoResumeOnReady);
    this.video.addEventListener('canplaythrough', tryAutoResumeOnReady);

    this.video.addEventListener('pause', () => {
      if (!this.video.ended && !this._isSwitchingChannel && !this._isStartingPlayback && !this.video.seeking && this.hasPlayedOnce) {
        this.emitState('paused');
      }
    });
    this.video.addEventListener('error', (e) => {
      if (!this.currentStreamUrl || !this.video.getAttribute('src')) {
        return;
      }
      console.warn('[VideoPlayer] Erro no elemento de vídeo:', this.video.error);
      if (this.video.hasAttribute('crossorigin')) {
        console.log('[VideoPlayer] Retentando reprodução sem crossorigin...');
        this.video.removeAttribute('crossorigin');
        this.video.load();
        this.attemptAutoPlay();
        return;
      }
      if (this.retryCount < this.maxRetries) {
        this.retryCount++;
        console.warn(`[VideoPlayer] Retentando conexão automática (${this.retryCount}/${this.maxRetries})...`);
        this.emitState('loading', 'Iniciando reprodução...');
        if (this.retryTimer) clearTimeout(this.retryTimer);
        this.retryTimer = setTimeout(() => {
          if (!this.currentStreamUrl) return;
          // Se já estava reproduzindo no meio do filme, recupera mantendo o ponto exato
          if (this.video && this.video.currentTime > 2) {
            this.recoverStalledPlayback();
          } else {
            this.playStream(this.currentStreamUrl, this.isMp4Stream, false, !this.isMp4Stream);
          }
        }, 500);
        return;
      }
      this.emitError('Não foi possível reproduzir este vídeo no seu navegador.');
    });
    this.video.addEventListener('ended', () => {
      this.emitState('ended');
      if (window.App && typeof window.App.onVideoEnded === 'function') {
        window.App.onVideoEnded();
      }
    });
  }

  on(event, callback) {
    if (this.listeners[event]) {
      this.listeners[event].push(callback);
    }
  }

  emitState(state, detail = null) {
    if (this.listeners.stateChange) {
      this.listeners.stateChange.forEach(cb => cb(state, detail));
    }
  }

  emitError(message, details = null) {
    if (this.listeners.error) {
      this.listeners.error.forEach(cb => cb(message, details));
    }
  }

  /**
   * Auto-recuperação transparente de conexão congelada:
   * Reconecta o socket de streaming mantendo o segundo exato onde o usuário estava assistindo.
   */
  recoverStalledPlayback() {
    if (!this.video || !this.currentStreamUrl) return;
    const resumeTime = Math.max(0, this.video.currentTime || 0);
    console.log(`[VideoPlayer] Auto-recuperando stream congelado no ponto ${resumeTime.toFixed(1)}s...`);

    const sep = this.currentStreamUrl.includes('?') ? '&' : '?';
    const freshUrl = `${this.currentStreamUrl}${sep}_rec=${Date.now()}`;

    const onLoaded = () => {
      try {
        if (resumeTime > 0) {
          this.video.currentTime = resumeTime;
        }
      } catch (e) {}
      const p = this.video.play();
      if (p && typeof p.catch === 'function') {
        p.catch(() => {});
      }
    };

    this.video.addEventListener('loadedmetadata', onLoaded, { once: true });
    this.video.src = freshUrl;
    this.video.load();
  }

  formatStreamUrl(url) {
    return url;
  }

  /**
   * Carrega e reproduz um canal, filme ou série com detecção de motor
   */
  /**
   * Carrega e reproduz um filme ou episódio de série com início instantâneo
   */
  loadChannel(channel) {
    if (!channel || !channel.url) return;

    this._isSwitchingChannel = true;
    this._isStartingPlayback = true;
    this.hasPlayedOnce = false;
    this.currentChannel = channel;
    this.retryCount = 0;
    if (this.retryTimer) clearTimeout(this.retryTimer);

    const isHls = channel.mediaType === 'hls' ||
                  channel.mediaType === 'm3u8' ||
                  channel.url.includes('.m3u8') ||
                  channel.url.includes('output=m3u8');

    this.playStream(channel.url, !isHls, false, isHls);
  }

  attemptAutoPlay() {
    if (!this.video || !this.currentStreamUrl) return;
    const playPromise = this.video.play();
    if (playPromise !== undefined && typeof playPromise.catch === 'function') {
      playPromise
        .then(() => {
          this._isSwitchingChannel = false;
          this._isStartingPlayback = false;
          this.hasPlayedOnce = true;
          this.emitState('playing');
          this.hideUnmutePrompt();
          this.updateVolumeUI();
          this.setupAudioEnhancement();
          this.resumeAudioContext();
        })
        .catch(err => {
          const errName = (err && err.name) ? err.name : '';
          // Se o navegador ainda estiver buscando os bytes iniciais / átomo moov (AbortError), aguarda canplay sem mutar e sem pausar
          if (errName === 'AbortError') {
            return;
          }
          // Somente se o navegador bloquear o áudio por política estrita de Autoplay (NotAllowedError)
          if (errName === 'NotAllowedError') {
            console.warn('Autoplay com áudio bloqueado pelo navegador. Iniciando com mudo:', err);
            this.video.muted = true;
            this.video.play()
              .then(() => {
                this._isSwitchingChannel = false;
                this._isStartingPlayback = false;
                this.hasPlayedOnce = true;
                this.emitState('playing');
                this.showUnmutePrompt();
                this.updateVolumeUI();
                this.setupAudioEnhancement();
                this.resumeAudioContext();
              })
              .catch(() => {
                if (this.video.readyState >= 3) {
                  this._isSwitchingChannel = false;
                  this._isStartingPlayback = false;
                  this.emitState('paused');
                }
              });
          }
        });
    }
  }

  /**
   * Executa a reprodução com aceleração máxima para VOD:
   * 1. HTML5 Video Nativo Direto (MP4 / VOD com Suporte a Range e CDN Instantânea)
   * 2. Hls.js com Buffer Adaptativo (para streams .m3u8 VOD)
   */
  playStream(streamUrl, isMp4 = true, isLiveTs = false, isHls = false) {
    this._isSwitchingChannel = true;
    this._isStartingPlayback = true;
    this.currentStreamUrl = streamUrl;
    this.isMp4Stream = isMp4;
    this.emitState('loading', 'Iniciando reprodução...');

    // Destrói instância HLS anterior se houver
    if (this.hls) {
      try { this.hls.destroy(); } catch (e) {}
      this.hls = null;
    }

    // 1. REPRODUÇÃO DIRETA DE MP4 (Filmes & Séries VOD - Início Automático)
    if (isMp4) {
      console.log('[Player Engine] HTML5 Video Nativo VOD Instantâneo:', streamUrl);
      this.video.removeAttribute('crossorigin');
      this.video.muted = false;
      this.video.volume = 1.0;
      this.hideUnmutePrompt();
      this.updateVolumeUI();

      this.video.preload = 'auto';
      this.video.src = streamUrl;
      this.video.load();

      // Auto-seleciona áudio em português e garante disparo de play ao receber metadados
      this.video.addEventListener('loadedmetadata', () => {
        this.autoSelectPortugueseAudio();
        if (this.video.paused && (this._isStartingPlayback || this._isSwitchingChannel || !this.hasPlayedOnce)) {
          this.attemptAutoPlay();
        }
      }, { once: true });

      this.attemptAutoPlay();
      return;
    }

    // 2. REPRODUÇÃO HLS M3U8 (VOD com Buffer Estendido)
    if (window.Hls && Hls.isSupported()) {
      console.log('[Player Engine] Hls.js com Buffer Estendido:', streamUrl);
      const hlsConfig = {
        debug: false,
        enableWorker: true,
        lowLatencyMode: true,
        backBufferLength: 60,
        maxBufferLength: 60, // 60s de buffer à frente (estilo YouTube)
        maxMaxBufferLength: 120,
        maxBufferSize: 60 * 1024 * 1024,
        manifestLoadingTimeOut: 20000,
        manifestLoadingMaxRetry: 4,
        levelLoadingTimeOut: 20000,
        fragLoadingTimeOut: 20000,
      };

      this.hls = new Hls(hlsConfig);
      this.hls.loadSource(streamUrl);
      this.hls.attachMedia(this.video);

      this.hls.on(Hls.Events.MANIFEST_PARSED, (event, data) => {
        this.emitState('ready');
        this.video.volume = 1.0;

        // Auto-seleciona áudio em português caso haja múltiplas faixas
        if (this.hls.audioTracks && this.hls.audioTracks.length > 1) {
          const ptIdx = this.hls.audioTracks.findIndex(t => {
            const str = ((t.name || '') + ' ' + (t.lang || '')).toLowerCase();
            return str.includes('por') || str.includes('dub') || str.includes('pt') || str.includes('bra');
          });
          if (ptIdx !== -1) {
            this.hls.audioTrack = ptIdx;
            console.log('[HLS Engine] Áudio em Português selecionado:', this.hls.audioTracks[ptIdx].name);
          }
        }

        this.video.play()
          .then(() => {
            this._isSwitchingChannel = false;
            this._isStartingPlayback = false;
            this.hasPlayedOnce = true;
            this.emitState('playing');
            this.hideUnmutePrompt();
            this.setupAudioEnhancement();
            this.resumeAudioContext();
          })
          .catch(e => {
            console.warn('Autoplay ao vivo bloqueado com áudio pelo navegador. Retentando mudo com aviso:', e);
            this.video.muted = true;
            this.video.play()
              .then(() => {
                this._isSwitchingChannel = false;
                this._isStartingPlayback = false;
                this.hasPlayedOnce = true;
                this.emitState('playing');
                this.showUnmutePrompt();
                this.updateVolumeUI();
              })
              .catch(err2 => {
                this._isSwitchingChannel = false;
                this._isStartingPlayback = false;
                console.warn('Autoplay ao vivo mudo também bloqueado:', err2);
                this.emitState('paused');
              });
          });
      });

      this.hls.on(Hls.Events.ERROR, (event, data) => {
        if (data.fatal) {
          console.warn('HLS Fatal Error:', data.type, data.details);

          if (data.details === 'manifestParsingError') {
            console.log('[Player Fallback] Alternando para reprodução direta...');
            this.hls.destroy();
            this.hls = null;
            this.video.src = streamUrl;
            this.video.play()
              .then(() => {
                this.emitState('playing');
                this.hideUnmutePrompt();
              })
              .catch(e => {
                console.warn('Direct fallback autoplay com áudio bloqueado:', e);
                this.video.muted = true;
                this.video.play()
                  .then(() => {
                    this.emitState('playing');
                    this.showUnmutePrompt();
                  })
                  .catch(() => this.emitState('paused'));
              });
            return;
          }

          switch (data.type) {
            case Hls.ErrorTypes.NETWORK_ERROR:
              this.handleNetworkError(streamUrl);
              break;
            case Hls.ErrorTypes.MEDIA_ERROR:
              console.log('Recuperando erro de mídia HLS...');
              this.hls.recoverMediaError();
              break;
            default:
              this.hls.destroy();
              this.emitError('Falha ao conectar com o canal', data.details);
              break;
          }
        }
      });

    } else if (this.video.canPlayType('application/vnd.apple.mpegurl') || this.video.canPlayType('video/mp2t')) {
      // Suporte nativo Safari iOS / Mac
      this.video.src = streamUrl;
      this.video.muted = false;
      this.video.volume = 1.0;
      this.video.play()
        .then(() => {
          this.emitState('playing');
          this.hideUnmutePrompt();
          this.updateVolumeUI();
        })
        .catch(e => {
          console.warn('Safari autoplay bloqueado:', e);
          this.video.muted = true;
          this.video.play().then(() => {
            this.emitState('playing');
            this.showUnmutePrompt();
            this.updateVolumeUI();
          }).catch(() => this.emitState('paused'));
        });
    } else {
      this.video.src = streamUrl;
      this.video.muted = false;
      this.video.volume = 1.0;
      this.video.play()
        .then(() => {
          this.emitState('playing');
          this.hideUnmutePrompt();
          this.updateVolumeUI();
        })
        .catch(e => {
          this.video.muted = true;
          this.video.play().then(() => {
            this.emitState('playing');
            this.showUnmutePrompt();
            this.updateVolumeUI();
          }).catch(() => this.emitState('paused'));
        });
    }
  }

  handleNetworkError(originalUrl) {
    if (this.retryCount < this.maxRetries) {
      this.retryCount++;
      // Padrão Enterprise Retry: 3 tentativas com backoff progressivo (2s, 4s e 8s)
      const delays = [2000, 4000, 8000];
      const delay = delays[this.retryCount - 1] || 8000;

      this.emitState('buffering', `Reconectando stream (${this.retryCount}/3) em ${delay / 1000}s...`);

      const spinnerEl = document.getElementById('player-buffering-spinner') || document.getElementById('netflix-spinner');
      if (spinnerEl) spinnerEl.classList.remove('hidden');

      this.retryTimer = setTimeout(() => {
        if (this.hls) {
          console.log(`[VideoPlayer] Retry HLS Network (${this.retryCount}/3)...`);
          this.hls.startLoad();
        } else {
          console.log(`[VideoPlayer] Retry Stream direto (${this.retryCount}/3)...`);
          this.playStream(originalUrl);
        }
      }, delay);
    } else {
      const spinnerEl = document.getElementById('player-buffering-spinner') || document.getElementById('netflix-spinner');
      if (spinnerEl) spinnerEl.classList.add('hidden');
      this.emitError('Não foi possível restabelecer a transmissão após 3 tentativas. Verifique a estabilidade da sua internet.');
    }
  }

  reload() {
    if (this.currentChannel) {
      this.loadChannel(this.currentChannel);
    }
  }

  togglePlay() {
    if (this.mpegtsPlayer) {
      if (this.video.paused) {
        try {
          const p = this.mpegtsPlayer.play();
          if (p && typeof p.catch === 'function') p.catch(e => console.warn('Mpegts resume:', e));
        } catch (e) {}
        if (this.video.paused) {
          try {
            const vp = this.video.play();
            if (vp && typeof vp.catch === 'function') vp.catch(() => {});
          } catch (e) {}
        }
      } else {
        if (this._isStartingPlayback || this._isSwitchingChannel) return;
        try { this.mpegtsPlayer.pause(); } catch (e) {}
        try { this.video.pause(); } catch (e) {}
      }
      return;
    }

    if (this.video.paused) {
      const p = this.video.play();
      if (p && typeof p.catch === 'function') {
        p.catch(err => {
          console.warn('Play pausado ou interrompido:', err);
          this.emitState('paused');
        });
      }
    } else {
      // Se ainda estiver inicializando ou trocando, previne pausa involuntária por cliques repetidos
      if (this._isStartingPlayback || this._isSwitchingChannel) {
        return;
      }
      this.video.pause();
    }
  }

  toggleMute() {
    this.video.muted = !this.video.muted;
    if (!this.video.muted && this.video.volume === 0) {
      this.video.volume = 1.0;
    }
    this.updateVolumeUI();
    if (!this.video.muted) {
      this.hideUnmutePrompt();
    }
    return this.video.muted;
  }

  setVolume(fraction) {
    const val = Math.max(0, Math.min(1, parseFloat(fraction)));
    this.video.volume = val;
    if (val > 0) {
      this.video.muted = false;
      this.hideUnmutePrompt();
    } else {
      this.video.muted = true;
    }
    this.updateVolumeUI();
  }

  unmute() {
    this.video.muted = false;
    if (this.video.volume === 0) {
      this.video.volume = 1.0;
    }
    this.hideUnmutePrompt();
    this.updateVolumeUI();
    this.resumeAudioContext();
  }

  updateVolumeUI() {
    const volIcon = document.getElementById('player-vol-icon');
    const volSlider = document.getElementById('player-vol-slider');
    const isMuted = this.video.muted || this.video.volume === 0;

    if (volIcon) {
      if (isMuted) {
        volIcon.className = 'fa-solid fa-volume-xmark text-netflix-red';
      } else if (this.video.volume < 0.5) {
        volIcon.className = 'fa-solid fa-volume-low text-slate-300';
      } else {
        volIcon.className = 'fa-solid fa-volume-high text-white';
      }
    }

    if (volSlider) {
      volSlider.value = isMuted ? 0 : this.video.volume;
    }
  }

  showUnmutePrompt() {
    const prompt = document.getElementById('player-unmute-prompt');
    if (prompt) prompt.classList.remove('hidden');
  }

  hideUnmutePrompt() {
    const prompt = document.getElementById('player-unmute-prompt');
    if (prompt) prompt.classList.add('hidden');
  }

  toggleFullscreen(containerElement = null) {
    const target = containerElement || this.video;
    if (!document.fullscreenElement) {
      if (target.requestFullscreen) {
        target.requestFullscreen();
      } else if (target.webkitRequestFullscreen) {
        target.webkitRequestFullscreen();
      }
    } else {
      if (document.exitFullscreen) {
        document.exitFullscreen();
      }
    }
  }

  async togglePiP() {
    if (document.pictureInPictureElement) {
      await document.exitPictureInPicture();
    } else if (this.video !== document.pictureInPictureElement && document.pictureInPictureEnabled) {
      await this.video.requestPictureInPicture();
    }
  }

  setAspectRatio(mode) {
    if (mode === 'cover') {
      this.video.style.objectFit = 'cover';
    } else if (mode === 'fill') {
      this.video.style.objectFit = 'fill';
    } else {
      this.video.style.objectFit = 'contain';
    }
  }

  /* ==============================================================================
     AUDIO ENHANCEMENT, DIALOGUE CLARITY & STEREO DOWNMIX ENGINE
     ============================================================================== */
  setupAudioEnhancement() {
    if (this._audioEnhancerInitialized) return;

    // Em dispositivos móveis (Android / iOS / Safari / Capacitor / WebView):
    // JAMAIS acoplar createMediaElementSource(this.video), pois:
    // 1. No iOS / Safari WebKit: createMediaElementSource causa som 100% mudo em mídias de streaming ou cross-origin.
    // 2. No Android e Mobile: o Web Audio API descarta o canal Central de conteúdos 5.1 surround, cancelando os diálogos e vozes.
    // 3. Os decodificadores nativos de hardware (AVPlayer / CoreAudio / ExoPlayer / MediaCodec) realizam o downmix estéreo 5.1 (ITU-R BS.775) com máxima fidelidade e clareza vocal.
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
    const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile/i.test(navigator.userAgent) || (window.innerWidth <= 768);
    const isNative = (window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function' && window.Capacitor.isNativePlatform()) ||
                     (window.location && (window.location.protocol === 'file:' || window.location.protocol === 'capacitor:'));

    if (isIOS || isSafari || isMobile || isNative) {
      console.log('[AudioEngine] Dispositivo móvel/iOS/Nativo detectado: utilizando decodificação de áudio nativa por hardware para diálogos nítidos e compatibilidade total.');
      return;
    }

    try {
      const AudioCtxClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtxClass) return;

      this.audioCtx = new AudioCtxClass();
      this.audioSource = this.audioCtx.createMediaElementSource(this.video);

      // 1. Equalizador Peaking Vocal (2200Hz com +4.5dB) para realce nítido de vozes e diálogos
      this.vocalFilter = this.audioCtx.createBiquadFilter();
      this.vocalFilter.type = 'peaking';
      this.vocalFilter.frequency.value = 2200;
      this.vocalFilter.Q.value = 1.2;
      this.vocalFilter.gain.value = 4.5;

      // 2. Compressor Dinâmico de Diálogo (Normalização Estilo Netflix/YouTube)
      // Traz vozes baixas para primeiro plano e impede que efeitos sonoros/música cubram as falas
      this.compressor = this.audioCtx.createDynamicsCompressor();
      this.compressor.threshold.value = -24;
      this.compressor.knee.value = 30;
      this.compressor.ratio.value = 8;
      this.compressor.attack.value = 0.003;
      this.compressor.release.value = 0.25;

      // 3. Força Downmixing Estéreo Limpo com Canal Central Preservado
      if (this.audioCtx.destination.maxChannelCount >= 2) {
        this.audioCtx.destination.channelCount = 2;
        this.audioCtx.destination.channelCountMode = 'explicit';
        this.audioCtx.destination.channelInterpretation = 'speakers';
      }

      this.audioSource.connect(this.vocalFilter);
      this.vocalFilter.connect(this.compressor);
      this.compressor.connect(this.audioCtx.destination);

      this._audioEnhancerInitialized = true;
      console.log('[AudioEngine] Realçador de Vozes e Diálogos ativado com sucesso.');
    } catch (e) {
      console.warn('[AudioEngine] Web Audio não pôde ser anexado (utilizando áudio nativo):', e.message);
    }
  }

  resumeAudioContext() {
    if (this.audioCtx && this.audioCtx.state === 'suspended') {
      this.audioCtx.resume().catch(() => {});
    }
  }

  autoSelectPortugueseAudio() {
    try {
      if (this.video && this.video.audioTracks && this.video.audioTracks.length > 1) {
        let found = false;
        for (let i = 0; i < this.video.audioTracks.length; i++) {
          const t = this.video.audioTracks[i];
          const str = ((t.label || '') + ' ' + (t.language || '')).toLowerCase();
          if (!found && (str.includes('por') || str.includes('dub') || str.includes('pt') || str.includes('bra'))) {
            t.enabled = true;
            found = true;
          } else {
            t.enabled = false;
          }
        }
        if (!found && this.video.audioTracks.length > 0) {
          this.video.audioTracks[0].enabled = true;
        }
      }
    } catch (e) {}
  }

  getAudioTracks() {
    if (this.hls && this.hls.audioTracks && this.hls.audioTracks.length > 0) {
      return this.hls.audioTracks.map((t, idx) => ({
        id: idx,
        name: t.name || t.lang || `Áudio ${idx + 1}`,
        lang: t.lang || '',
        selected: this.hls.audioTrack === idx
      }));
    }
    if (this.video && this.video.audioTracks && this.video.audioTracks.length > 0) {
      const tracks = [];
      for (let i = 0; i < this.video.audioTracks.length; i++) {
        const t = this.video.audioTracks[i];
        tracks.push({
          id: i,
          name: t.label || t.language || `Áudio ${i + 1}`,
          lang: t.language || '',
          selected: t.enabled
        });
      }
      return tracks;
    }
    return [];
  }

  setAudioTrackByIndex(index) {
    if (this.hls && this.hls.audioTracks && this.hls.audioTracks[index] !== undefined) {
      this.hls.audioTrack = index;
      return true;
    }
    if (this.video && this.video.audioTracks && this.video.audioTracks[index] !== undefined) {
      for (let i = 0; i < this.video.audioTracks.length; i++) {
        this.video.audioTracks[i].enabled = (i === index);
      }
      return true;
    }
    return false;
  }

  toggleDialogueBoost(enable) {
    if (!this.vocalFilter) return;
    this.vocalFilter.gain.value = enable ? 5.0 : 0.0;
  }

  destroy() {
    this._isSwitchingChannel = true;
    this._isStartingPlayback = false;
    this.currentStreamUrl = null;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.hls) {
      try { this.hls.destroy(); } catch (e) {}
      this.hls = null;
    }
    try {
      this.video.pause();
      this.video.removeAttribute('src');
      this.video.load();
    } catch (e) {}
  }
}

window.VideoPlayer = VideoPlayer;

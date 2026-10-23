const db = require('../services/db');
const playlistManager = require('../playlist-manager');
const streamTokenService = require('../services/stream-token-service');

function normalizeStr(str) {
  return (str || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

class CatalogController {
  /**
   * Catálogo Principal estruturado com carrosséis e banner principal (Filmes e Séries)
   */
  async getCatalog(req, res) {
    const filter = req.query.filter || 'ALL';
    const userAge = req.query.age ? parseInt(req.query.age, 10) : null;
    const isKids = req.query.kids === '1' || req.query.kids === 'true' || filter.toUpperCase() === 'KIDS' || (userAge !== null && userAge < 10);
    const allowAdult = (req.query.adult === '1' || req.query.adult === 'true' || filter.toUpperCase() === 'ADULT') && !isKids;

    try {
      // Utiliza o catálogo pré-estruturado em memória do playlistManager para performance < 10ms
      const data = playlistManager.getCatalog(filter, isKids, allowAdult, userAge);

      // Tokeniza as URLs de stream para segurança anti-roubo Enterprise
      if (data && data.trending) {
        data.trending = data.trending.map(it => ({
          ...it,
          tokenizedUrl: streamTokenService.tokenizeUrl(it.streamUrl, it.itemType)
        }));
      }

      res.json(data);
    } catch (err) {
      console.error('[CatalogController] Erro ao carregar catálogo:', err);
      res.status(500).json({ error: 'Erro ao carregar catálogo: ' + err.message });
    }
  }

  /**
   * Top 10 em Alta Diários (Carrossel Rotativo de Filmes e Séries)
   */
  async getTrending(req, res) {
    const filter = (req.query.filter || 'ALL').toUpperCase();
    const userAge = req.query.age ? parseInt(req.query.age, 10) : null;
    const isKids = req.query.kids === '1' || req.query.kids === 'true' || filter === 'KIDS' || (userAge !== null && userAge < 10);

    try {
      const trending = playlistManager.getDailyTop10(filter, isKids, false, userAge).map(it => ({
        ...it,
        tokenizedUrl: streamTokenService.tokenizeUrl(it.streamUrl, it.itemType)
      }));
      res.json({ success: true, trending });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  }

  /**
   * Paginação Server-Side e Grade Completa (Ver Tudo - Filmes, Séries e Conteúdos Adultos +18 para maiores)
   */
  async getCategoryItems(req, res) {
    const { type = 'all', group = '', page = 1, limit = 120, search = '' } = req.query;
    const isKids = req.query.kids === '1' || req.query.kids === 'true';
    const allowAdult = req.query.adult === '1' || req.query.adult === 'true';

    try {
      const data = playlistManager.getCategoryItems({
        type,
        group,
        page: parseInt(page, 10) || 1,
        limit: parseInt(limit, 10) || 120,
        search,
        isKidsMode: isKids,
        allowAdult: allowAdult && !isKids
      });

      // Tokeniza os itens para proteção anti-roubo
      if (data && data.items) {
        data.items = data.items.map(it => ({
          ...it,
          tokenizedUrl: streamTokenService.tokenizeUrl(it.streamUrl, it.itemType)
        }));
      }

      res.json(data);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }

  /**
   * Busca Inteligente: Retorna estritamente Filmes e Séries (Cards), incluindo Filmes e Séries Adultas (+18) quando permitido.
   * NUNCA retorna episódios soltos e NUNCA retorna canais ao vivo.
   * No painel ADM, retorna a listagem completa sem cortes artificiais de 60 itens.
   */
  async search(req, res) {
    const rawQuery = (req.query.q || '').trim();
    const typeFilter = (req.query.type || 'all').toLowerCase(); // 'all', 'movie', 'movie_general', 'series', 'adult', 'adult_movies', 'adult_series'
    const isKids = req.query.kids === '1' || req.query.kids === 'true';
    const isAdultFilter = ['adult', 'adult_movie', 'adult_movies', 'adult_series'].includes(typeFilter);
    const allowAdult = (req.query.adult === '1' || req.query.adult === 'true' || isAdultFilter) && !isKids;
    const qNorm = rawQuery ? normalizeStr(rawQuery) : '';

    const requestedLimit = parseInt(req.query.limit, 10) || (qNorm ? 250 : 600);
    const maxItems = Math.min(Math.max(requestedLimit, 30), 5000);

    const isMovieBrowseMode = ['movie', 'movies', 'movie_general', 'adult', 'adult_movie', 'adult_movies'].includes(typeFilter);
    const isSeriesBrowseMode = ['series', 'adult', 'adult_series'].includes(typeFilter);
    const isBrowseAllowed = isMovieBrowseMode || isSeriesBrowseMode || typeFilter === 'all';
    if (!qNorm && !isBrowseAllowed) {
      return res.json({ results: [], total: 0, totalAvailable: 0, totalMovies: 0, totalSeries: 0 });
    }

    const movies = playlistManager.movies || [];
    const series = playlistManager.series || [];

    const matchesItem = (item) => {
      if (!qNorm) return true;
      const nameNorm = normalizeStr(item.name || item.rawTitle || '');
      const groupNorm = normalizeStr(item.group || '');
      return nameNorm.includes(qNorm) || groupNorm.includes(qNorm);
    };

    const matchedMovies = [];
    const matchedSeries = [];
    let totalMoviesMatched = 0;
    let totalSeriesMatched = 0;

    // 1. Busca em Filmes (gerais e/ou adultos +18 conforme filtro)
    if (typeFilter === 'all' || isMovieBrowseMode) {
      for (let i = 0; i < movies.length; i++) {
        const m = movies[i];
        const isAdultMovie = Boolean(m.isAdult || playlistManager.isAdultGroup(m.group));

        if (['adult', 'adult_movie', 'adult_movies'].includes(typeFilter) && !isAdultMovie) continue;
        if (typeFilter === 'movie_general' && isAdultMovie) continue;
        if (isAdultMovie && !allowAdult) continue;
        if (isKids && (isAdultMovie || (!playlistManager.isKidsItem(m) && /terror|crime|sangue|massacre/i.test(m.group || '')))) continue;

        if (matchesItem(m)) {
          totalMoviesMatched++;
          if (matchedMovies.length < maxItems) {
            matchedMovies.push({
              ...m,
              itemType: 'movie',
              isAdult: isAdultMovie,
              rating: isAdultMovie ? '18' : (m.rating || '12'),
              tokenizedUrl: streamTokenService.tokenizeUrl(m.streamUrl, 'movie')
            });
          }
        }
      }
    }

    // 2. Busca em Séries (apenas cards das séries, incluindo Séries Adultas +18 quando permitido)
    if (typeFilter === 'all' || isSeriesBrowseMode) {
      for (let i = 0; i < series.length; i++) {
        const s = series[i];
        const isAdultSeries = Boolean(s.isAdult || playlistManager.isAdultGroup(s.group));

        if (['adult', 'adult_series'].includes(typeFilter) && !isAdultSeries) continue;
        if (typeFilter === 'series' && isAdultSeries && !allowAdult) continue;
        if (isAdultSeries && !allowAdult) continue;
        if (isKids && isAdultSeries) continue;

        if (matchesItem(s)) {
          totalSeriesMatched++;
          if (matchedSeries.length < maxItems) {
            matchedSeries.push({
              ...s,
              itemType: 'series',
              isAdult: isAdultSeries,
              rating: isAdultSeries ? '18' : (s.rating || '12'),
              tokenizedUrl: streamTokenService.tokenizeUrl(s.streamUrl, 'series')
            });
          }
        }
      }
    }

    let results = [];
    if (['movie', 'movies', 'movie_general', 'adult_movie', 'adult_movies'].includes(typeFilter)) {
      results = matchedMovies;
    } else if (['series', 'adult_series'].includes(typeFilter)) {
      results = matchedSeries;
    } else if (typeFilter === 'adult') {
      // No filtro Adultos (+18), exibe tanto as Séries Adultas (+18) quanto todos os Filmes Adultos (+18)
      results = [...matchedSeries, ...matchedMovies];
    } else {
      results = [...matchedMovies, ...matchedSeries];
    }

    const sliced = results.slice(0, maxItems);
    res.json({
      results: sliced,
      total: sliced.length,
      totalAvailable: totalMoviesMatched + totalSeriesMatched,
      totalMovies: totalMoviesMatched,
      totalSeries: totalSeriesMatched
    });
  }
}

module.exports = new CatalogController();

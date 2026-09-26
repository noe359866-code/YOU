#!/usr/bin/env node
/**
 * ============================================================================
 * maintenance.js — Mantenimiento integral de la tabla `torrents` (Supabase)
 * ============================================================================
 * Diseñado para ejecutarse en GitHub Actions (Node.js >= 20).
 *
 *   PASO 1 · FILTRO DE CONTENIDO ADULTO ......... elimina títulos explícitos/NSFW
 *   PASO 2 · FILTRO ANTI-FAKES POR TAMAÑO ....... movies < 150 MB, series < 30 MB
 *   PASO 3 · PURGADOR DE TORRENTS MUERTOS ....... seeders = 0 y updated_at > 30 días
 *   PASO 4 · PARSER / NORMALIZADOR DE TÍTULOS ... corrige type, season y episode
 *   PASO 5 · ENRIQUECEDOR DE IDs ............... AniList + Kitsu + TMDB/IMDb
 *   PASO 6 · DEDUPLICADOR INTELIGENTE .......... TOP 2 español + TOP 2 inglés
 *
 * Variables de entorno (ver .env.example):
 *   REQUERIDAS : SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *   OPCIONALES : TMDB_API_KEY, TABLE_NAME, DRY_RUN, BATCH_SIZE, DELETE_CHUNK,
 *                DEAD_TORRENT_DAYS, ANIME_MIN_SIZE_MB, MAX_LOOKUPS,
 *                MIN_SIMILARITY, TOP_N_PER_LANGUAGE, UPDATE_CONCURRENCY,
 *                MAX_ID_ATTEMPTS, IDS_RETRY_HOURS
 *
 * Uso:
 *   node maintenance.js                # ejecución real (los 6 pasos)
 *   DRY_RUN=true node maintenance.js   # simulación (no escribe en la BD)
 *   node maintenance.js --steps=2,3    # solo algunos pasos (o env STEPS=2,3)
 *   node maintenance.js --self-test    # pruebas del parser/clasificador/dedup
 * ============================================================================
 */

import { createClient } from '@supabase/supabase-js';
import fs from 'node:fs';
import assert from 'node:assert/strict';

/* ============================================================================
 * 0. CONFIGURACIÓN (variables de entorno)
 * ========================================================================== */

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const TMDB_API_KEY = process.env.TMDB_API_KEY || '';

const TABLE = process.env.TABLE_NAME || 'torrents';
const DRY_RUN = /^(1|true|yes)$/i.test(process.env.DRY_RUN || '');

const BATCH_SIZE = Number(process.env.BATCH_SIZE || 1000);        // filas por página al escanear
const DELETE_CHUNK = Number(process.env.DELETE_CHUNK || 500);     // ids por DELETE ... IN (...)
const DEAD_TORRENT_DAYS = Number(process.env.DEAD_TORRENT_DAYS || 30);
const ANIME_MIN_SIZE_MB = Number(process.env.ANIME_MIN_SIZE_MB || 0); // 0 = desactivado
const MAX_LOOKUPS = Number(process.env.MAX_LOOKUPS || 400);       // tope de llamadas a APIs externas
const MIN_SIMILARITY = Number(process.env.MIN_SIMILARITY || 0.5); // umbral de similitud (0..1)
const TOP_N_PER_LANGUAGE = Number(process.env.TOP_N_PER_LANGUAGE || 2); // TOP 2 ES / TOP 2 EN
const UPDATE_CONCURRENCY = Number(process.env.UPDATE_CONCURRENCY || 8);
const MAX_ID_ATTEMPTS = Number(process.env.MAX_ID_ATTEMPTS || 5);   // lookups máx. por fila
const IDS_RETRY_HOURS = Number(process.env.IDS_RETRY_HOURS || 24);  // ventana de reintento
const HTTP_TIMEOUT_MS = Number(process.env.HTTP_TIMEOUT_MS || 15000); // timeout por request

// Selector de pasos: `node maintenance.js --steps=2,3` o STEPS=2,3 (vacío = los 6)
const STEPS_ARG = (process.argv.find((a) => a.startsWith('--steps=')) || '').slice('--steps='.length);
const ONLY_STEPS = new Set(
  (STEPS_ARG || process.env.STEPS || '')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n >= 1 && n <= 6)
);

const MB = 1024 * 1024;
const MOVIE_MIN_BYTES = 150 * MB;   // movies por debajo de 150 MB → fake
const SERIES_MIN_BYTES = 30 * MB;   // series por debajo de 30 MB → fake

/** Cliente Supabase (perezoso, para que --self-test no requiera credenciales). */
let _supabase = null;
function db() {
  if (!_supabase) {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      throw new Error('Faltan SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY (ver .env.example)');
    }
    // Service role key: operaciones de mantenimiento (UPDATE/DELETE) sin RLS.
    _supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return _supabase;
}

/* ============================================================================
 * CONSTANTES LÉXICAS (palabras clave, grupos de release, regex de limpieza)
 * ========================================================================== */

/**
 * PALABRAS CLAVE DE CONTENIDO ADULTO.
 * Se comparan sobre el título NORMALIZADO (minúsculas, sin acentos) con
 * bordes de palabra para evitar falsos positivos (p.ej. "Sex Education"
 * NO dispara nada porque "sex" a secas está excluido deliberadamente,
 * y "javascript" no dispara "jav").
 */
const ADULT_WORDS = [
  // núcleo
  'porno', 'porn', 'pornografia', 'xxx', 'nsfw', 'hentai', 'eroge', 'jav', 'r18',
  'erotica', 'erotic', 'erotico', 'eroticos',
  // estudios / portales adultos (alta precisión)
  'playboy', 'hustler', 'brazzers', 'realitykings', 'bangbros', 'xvideos', 'xhamster',
  'onlyfans', 'only fans', 'naughty america',
  // vocabulario explícito (español)
  'desnuda', 'desnudo', 'desnudas', 'desnudos', 'follando', 'masturbacion', 'masturbandose',
];

/** Formas acentuadas adicionales para el pre-filtro SQL (ilike es acento-sensible). */
const ADULT_PREFILTER_EXTRA = ['erótica', 'erótico', 'eróticos', 'pornografía', 'masturbación'];

/** Variantes "surface" para el pre-filtro SQL (superconjunto del filtro JS). */
const ADULT_PREFILTER = [...new Set([...ADULT_WORDS, ...ADULT_PREFILTER_EXTRA])];

/** Regex final de adulto sobre texto normalizado (bordes no alfanuméricos). */
const ADULT_RE = new RegExp(
  `(?:^|[^a-z0-9])(?:${ADULT_WORDS.map(escapeRe).join('|')})(?:[^a-z0-9]|$)`
);

/** Grupos de release de anime/fansub (normalizados a minúsculas). */
const ANIME_GROUPS = new Set([
  'subsplease', 'erai-raws', 'erai raws', 'erai', 'horriblesubs', 'horrible subs',
  'judas', 'ember', 'commie', 'lostyears', 'lost years', 'moozzi2', 'moozzi',
  'toonshub', 'animekaizoku', 'animepahe', 'yameii', 'animencode', 'asw',
]);

/** Grupos de release de cine/series (refuerzan la clasificación como 'movie'). */
const MOVIE_GROUPS = new Set([
  'yts', 'yify', 'rarbg', 'sparks', 'evo', 'tgx', 'ipt', 'axxo', 'flx', 'amzn', 'nf',
]);

/* ============================================================================
 * UTILIDADES GENERALES
 * ========================================================================== */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chunk = (arr, n) => {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Minúsculas + sin acentos (para comparaciones robustas). */
function normalizeText(s) {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

/** Similitud de Sørensen–Dice sobre conjuntos de palabras (0..1). */
function similarity(a, b) {
  const ta = new Set(normalizeText(a).split(/[^a-z0-9]+/).filter(Boolean));
  const tb = new Set(normalizeText(b).split(/[^a-z0-9]+/).filter(Boolean));
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return (2 * inter) / (ta.size + tb.size);
}

/** ¿El resultado de una API es un match aceptable para el título buscado? */
function isGoodMatch(candidate, search) {
  const c = normalizeText(candidate);
  const s = normalizeText(search);
  if (!c || !s) return false;
  if (c.includes(s) || s.includes(c)) return true;
  return similarity(c, s) >= MIN_SIMILARITY;
}

function log(...args) { console.log(...args); }
function logWarn(...args) { console.warn('⚠️ ', ...args); }
function logErr(...args) { console.error('❌', ...args); }

/** Pool de concurrencia limitada (para updates / llamadas HTTP en paralelo). */
async function mapPool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * fetch JSON con reintentos ante 429/5xx y respeto de Retry-After.
 * Devuelve { ok, status, body } — no lanza en errores HTTP "esperables".
 */
async function httpJson(url, options = {}, retries = 3) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        ...options,
        headers: { Accept: 'application/json', 'User-Agent': 'torrents-maintenance/1.0', ...(options.headers || {}) },
        // Timeout duro por request: un socket colgado no puede congelar el job
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
      if (res.status === 429 && attempt < retries) {
        const waitSec = Number(res.headers.get('retry-after') || 2) || 2;
        logWarn(`429 en ${new URL(url).host}, reintentando en ${waitSec}s...`);
        await sleep(waitSec * 1000);
        continue;
      }
      if (res.status >= 500 && attempt < retries) {
        await sleep(800 * 2 ** attempt);
        continue;
      }
      const body = res.ok ? await res.json() : null;
      return { ok: res.ok, status: res.status, body };
    } catch (err) {
      if (attempt < retries) { await sleep(800 * 2 ** attempt); continue; }
      return { ok: false, status: 0, body: null, error: err };
    }
  }
  return { ok: false, status: 0, body: null };
}

/* ============================================================================
 * HELPERS DE BASE DE DATOS (Supabase / PostgREST)
 * ========================================================================== */

/**
 * Escanea la tabla por páginas estables (ORDER BY id) — seguro frente a
 * updates que no cambian el orden (no borra filas durante el escaneo).
 */
async function* scanBatches(columns, apply = (q) => q) {
  let from = 0;
  for (;;) {
    let q = db().from(TABLE).select(columns);
    q = apply(q).order('id', { ascending: true }).range(from, from + BATCH_SIZE - 1);
    const { data, error } = await q;
    if (error) throw error;
    if (!data || data.length === 0) return;
    yield data;
    if (data.length < BATCH_SIZE) return;
    from += BATCH_SIZE;
  }
}

/** Borra por lista de ids en chunks. En DRY_RUN solo informa. */
async function deleteByIds(ids) {
  if (!ids.length) return 0;
  if (DRY_RUN) {
    log(`   [DRY_RUN] se eliminarían ${ids.length} registros`);
    return ids.length;
  }
  let deleted = 0;
  for (const part of chunk(ids, DELETE_CHUNK)) {
    const { data, error } = await db().from(TABLE).delete().in('id', part).select('id');
    if (error) throw error;
    deleted += data ? data.length : 0;
  }
  return deleted;
}

/**
 * Borra todos los registros que cumplan un filtro, en lotes seguros:
 * SELECT id (limit) → DELETE IN (...) → repetir hasta agotar.
 * En DRY_RUN hace un COUNT y no toca nada.
 */
async function deleteByFilter(buildQuery) {
  if (DRY_RUN) {
    let q = db().from(TABLE).select('id', { count: 'exact', head: true });
    const { count, error } = await buildQuery(q);
    if (error) throw error;
    log(`   [DRY_RUN] se eliminarían ${count ?? 0} registros`);
    return count ?? 0;
  }
  let deleted = 0;
  for (;;) {
    let q = db().from(TABLE).select('id');
    const { data, error } = await buildQuery(q).limit(DELETE_CHUNK);
    if (error) throw error;
    if (!data || data.length === 0) break;
    const n = await deleteByIds(data.map((r) => r.id));
    if (n === 0) break; // red de seguridad anti-bucle infinito
    deleted += n;
    if (data.length < DELETE_CHUNK) break;
  }
  return deleted;
}

/** Aplica un UPDATE puntual por id (o lo simula en DRY_RUN). */
async function applyPatch(id, patch) {
  if (DRY_RUN) {
    log(`   [DRY_RUN] UPDATE id=${id}`, patch);
    return true;
  }
  const { error } = await db().from(TABLE).update(patch).eq('id', id);
  if (error) throw error;
  return true;
}

/* ============================================================================
 * PASO 4 (núcleo) — PARSER DE TÍTULOS
 * Detecta tipo (movie/series/anime), grupo de release, año y
 * extrae/corrige season, episode y absolute_episode.
 * ========================================================================== */

/** Normaliza un imdb_id al formato del CHECK `^tt[0-9]+$`; null si no cuadra. */
function normImdbId(v) {
  if (v == null) return null;
  const m = String(v).trim().toLowerCase().match(/^(?:tt)?(\d+)$/);
  return m ? `tt${m[1]}` : null;
}

/** '4k' → '2160p', etc. (columna `quality` varchar(20)). */
function mapQuality(res) {
  const r = String(res).toLowerCase();
  if (r === '4k') return '2160p';
  if (r === '8k') return '4320p';
  return r;
}

/** Cómdec normalizado (columna `codec` varchar(20)). */
function mapCodec(raw) {
  const c = String(raw).toLowerCase();
  if (/^(x264|h264|h\.264|avc)$/.test(c)) return 'H264';
  if (/^(x265|h265|h\.265|hevc)$/.test(c)) return 'H265';
  if (c === 'av1') return 'AV1';
  if (c === 'xvid') return 'XVID';
  if (c === 'divx') return 'DIVX';
  if (c === 'vp9') return 'VP9';
  return null;
}

/** Formato HDR (columna `hdr_format` varchar(20)); admite combos DV|HDR10. */
function mapHdrFormat({ dv, hdr10plus, hdr10, hlg, hdr }) {
  if (dv && hdr10plus) return 'DV|HDR10+';
  if (dv && hdr10) return 'DV|HDR10';
  if (dv) return 'DV';
  if (hdr10plus) return 'HDR10+';
  if (hdr10) return 'HDR10';
  if (hlg) return 'HLG';
  if (hdr) return 'HDR';
  return null;
}

/** ¿El contenido de un corchete es "ruido" de release y NO un grupo? */
function isNoiseGroup(raw) {
  const g = normalizeText(raw).replace(/[\s._-]+/g, '');
  return /^(?:\d{3,4}p|[48]k|uhd|fhd|webdl|webrip|bluray|bdrip|brrip|hdtv|dvdrip|dvd|remux|hdr10p?|hdr|hlg|dv|dovi|x26[45]|h26[45]|hevc|avc|xvid|divx|av1|10bit|8bit|hi10p|aac|ac3|eac3|ddp?[\d.]*|dtshd|dts|truehd|atmos|flac|mp3|opus|\d+(?:\.\d)?ch|ma\d\.\d|multi|multiaudio|dual|dualaudio|castellano|latino|spanish|english|eng|espanol|vose|vo|sub|subs|subbed|subtitulado|batch|complete|proper|repack|extended|unrated|uncut|imax|complete|season\d+|ep\d+)$/.test(g);
}

/**
 * parseTitle(rawTitle, signals) → {
 *   type, confident, season, episode, absolute_episode, year,
 *   quality, codec, hdr_format, release_group, group
 * }
 *  - `signals.hasAnimeIds` = true cuando la fila ya tiene kitsu/anilist/mal.
 *  - `confident` = true cuando hay señales claras (grupo fansub, SxxExx, etc.)
 *  - Los campos no detectados quedan en null (nunca se clobberan en la BD).
 */
function parseTitle(rawTitle = '', signals = {}) {
  const title = String(rawTitle);
  const norm = normalizeText(title);
  const out = {
    type: null,
    confident: false,
    season: null,
    episode: null,
    absolute_episode: null,
    year: null,
    quality: null,
    codec: null,
    hdr_format: null,
    release_group: null,
    group: null,
  };

  // ── Año (para búsqueda en APIs y para descartar falsos "episodios") ───────
  const yearM = title.match(/\b(19\d{2}|20[0-2]\d)\b/);
  if (yearM) out.year = Number(yearM[1]);

  // ── Calidad (resolución), codec y HDR → columnas del esquema ──────────────
  const qM = title.match(/\b(480p|576p|720p|1080p|2160p|4320p|4k|8k)\b/i);
  if (qM) out.quality = mapQuality(qM[1]);
  const cM = title.match(/\b(x26[45]|h\.?26[45]|hevc|avc|xvid|divx|av1|vp9)\b/i);
  if (cM) out.codec = mapCodec(cM[1]);
  out.hdr_format = mapHdrFormat({
    dv: /\b(dv|dovi|dolby[ .]?vision)\b/i.test(title),
    hdr10plus: /\bhdr10\+/i.test(title), // sin \b final: "HDR10+." no casa con \b tras '+'
    hdr10: /\bhdr10\b/i.test(title),
    hlg: /\bhlg\b/i.test(title),
    hdr: /\bhdr\b/i.test(title),
  });

  // ── Grupo de release: [Grupo] {Grupo} o sufijo -Grupo ─────────────────────
  const bracketRaw = [...title.matchAll(/[\[{]([^\]}\n]{1,40})[\]}]/g)].map((m) => m[1].trim());
  const bracketGroups = bracketRaw.map((g) => normalizeText(g).trim());
  const suffixM = title.match(/-([A-Za-z0-9 ]{2,20})$/);
  const suffixGroup = suffixM ? normalizeText(suffixM[1]).trim() : null;
  const allGroups = [...bracketGroups, suffixGroup].filter(Boolean);
  out.group = allGroups[0] || null;

  // `release_group` (columna): primer candidato que NO sea ruido (1080p, DV…)
  const rawCandidates = [...bracketRaw, suffixM ? suffixM[1].trim() : null].filter(Boolean);
  out.release_group = rawCandidates.find((g) => !isNoiseGroup(g))?.slice(0, 100) ?? null;

  const hasAnimeGroup = allGroups.some((g) => ANIME_GROUPS.has(g) || ANIME_GROUPS.has(g.replace(/\s+/g, '-')));
  const hasMovieGroup = allGroups.some((g) => MOVIE_GROUPS.has(g));

  // ── Señales léxicas de anime ─────────────────────────────────────────────
  const hasAnimeWords = /\b(anime|ova|ona|fansub|bd\s?batch)\b/.test(norm);
  // ── IDs de anime ya presentes en la fila (señal fuerte de anime) ─────────
  const hasAnimeIds = signals.hasAnimeIds === true;

  // ── Patrones de temporada/episodio (en orden de prioridad) ───────────────
  // 1) S02E09 / S2.E09 / s2e9
  // 2) 2x09
  // 3) "Season 2 Episode 9" / "Temporada 2 Episodio 9"
  // 4) "S2 - 09" (formato anime)
  // 5) "Episode 12" / "Episodio 12"
  // 6) " - 12 [1080p]" (anime bare) / " - 12v2"
  let kind = null;
  let m = null;

  const PATTERNS = [
    { kind: 'sxxexx', re: /s(\d{1,2})[\s._-]*e(\d{1,4})(?!\d)/i },
    { kind: 'nxnn', re: /(?<![\dA-Za-z])(\d{1,2})x(\d{2,4})(?!\d)/ }, // evita "1920x1080"
    { kind: 'seasonx', re: /(?:season|temporada)[\s._-]*(\d{1,2})[\s._-]*(?:episode|episodio|ep)[\s._-]*(\d{1,4})(?!\d)/i },
    { kind: 's_dash', re: /s(\d{1,2})[\s._]*-[\s._]*(\d{1,4})(?:v\d)?(?!\d)/i }, // "S2 - 09" / "S2.-.09"
    { kind: 'ep_only', re: /(?:episode|episodio)[\s._-]*(\d{1,4})(?!\d)/i },
    // bare anime con corchete: " - 27 [1080p]" / ".-.1090.[" → hallmark fansub (anime por sí solo)
    { kind: 'anime_bare', re: /[\s._]*-[\s._]*(\d{1,4})(?:v\d)?(?!\d)[\s._]*\[/ },
    // bare anime al final o con paréntesis: " - 27 (" / " - 27" → solo en contexto anime
    { kind: 'anime_bare', re: /[\s._]*-[\s._]*(\d{1,4})(?:v\d)?(?!\d)[\s._]*(?:\(|$)/, requiresAnime: true },
  ];

  for (const p of PATTERNS) {
    const mm = title.match(p.re);
    if (!mm) continue;
    if (p.requiresAnime && !(hasAnimeGroup || hasAnimeWords || hasAnimeIds)) continue;
    kind = p.kind;
    m = mm;
    break;
  }

  if (m) {
    if (kind === 'sxxexx' || kind === 'nxnn' || kind === 'seasonx' || kind === 's_dash') {
      out.season = Number(m[1]);
      out.episode = Number(m[2]);
    } else {
      // ep_only / anime_bare → sin marca de temporada
      out.episode = Number(m[1]);
    }
  }

  // ── absolute_episode (anime con numeración global) ────────────────────────
  // "Show - 27 [1080p]" → abs 27 ; "S01E05" de anime → abs 5
  const isAnimeish = hasAnimeGroup || hasAnimeWords || hasAnimeIds || kind === 'anime_bare';
  if (isAnimeish && out.episode != null) {
    if (kind === 'anime_bare' || kind === 'ep_only' || kind === 's_dash') {
      out.absolute_episode = out.episode;
    } else if (out.season === 1) {
      out.absolute_episode = out.episode;
    }
  }

  // ── Decisión de tipo ─────────────────────────────────────────────────────
  if (isAnimeish) {
    out.type = 'anime';
    out.confident = true;
  } else if (out.episode != null) {
    out.type = 'series';
    out.confident = true;
  } else if (hasMovieGroup) {
    out.type = 'movie';
    out.confident = true;
  } else {
    out.type = 'movie';          // heurística por defecto
    out.confident = false;       // no sobrescribe un tipo ya almacenado
  }

  // Temporada por defecto cuando hay episodio pero no hubo marca de temporada
  if (out.episode != null && out.season == null) out.season = 1;

  return out;
}

/**
 * Construye el parche de corrección para una fila, comparando lo parseado
 * con lo almacenado. Solo se corrige lo que el parser detectó con confianza;
 * nunca se borran valores existentes por ausencia de patrón.
 */
function buildTitlePatch(row) {
  const hasAnimeIds = row.kitsu_id != null || row.anilist_id != null || row.mal_id != null;
  const parsed = parseTitle(row.title, { hasAnimeIds });

  const patch = {};
  if (parsed.confident && parsed.type && parsed.type !== row.type) patch.type = parsed.type;
  if (parsed.season != null && parsed.season !== (row.season ?? null)) patch.season = parsed.season;
  if (parsed.episode != null && parsed.episode !== (row.episode ?? null)) patch.episode = parsed.episode;
  if (parsed.absolute_episode != null && parsed.absolute_episode !== (row.absolute_episode ?? null)) {
    patch.absolute_episode = parsed.absolute_episode;
  }

  // Metadatos de release derivados del título (columnas del esquema).
  // Solo se escriben valores detectados; nunca se clobbera con null.
  if (parsed.release_group && parsed.release_group !== (row.release_group ?? null)) {
    patch.release_group = parsed.release_group.slice(0, 100);
  }
  if (parsed.quality && parsed.quality !== (row.quality ?? null)) patch.quality = parsed.quality;
  if (parsed.codec && parsed.codec !== (row.codec ?? null)) patch.codec = parsed.codec;
  if (parsed.hdr_format && parsed.hdr_format !== (row.hdr_format ?? null)) patch.hdr_format = parsed.hdr_format;
  return patch;
}

/**
 * Limpia un título de release para obtener un título de OBRA apto para buscar
 * en AniList / Kitsu / TMDB: quita grupos, años, resoluciones, códecs,
 * idiomas, marcadores de episodio y calidad.
 */
function cleanTitleForSearch(raw) {
  const fallback = String(raw ?? '').replace(/[\[{][^\]}]*[\]}]/g, ' ').replace(/\s+/g, ' ').trim();
  let t = ` ${String(raw ?? '')} `;

  t = t.replace(/[\[{][^\]}]*[\]}]/g, ' ');                       // [SubsPlease] {YTS}
  t = t.replace(/\([^)]*\)/g, ' ');                                // (2019) (1080p)
  t = t.replace(/-[A-Za-z][A-Za-z0-9]*\s*$/, ' ');                 // sufijo -GrupoDeRelease (-YTS, -NTb)
  t = t.replace(/\bs\d{1,2}[\s._-]*e\d{1,3}\b/gi, ' ');            // S02E09
  t = t.replace(/\b\d{1,2}x\d{2,3}\b/gi, ' ');                     // 2x09
  t = t.replace(/\b(?:season|temporada)[\s._-]*\d{1,2}[\s._-]*(?:episode|episodio|ep)[\s._-]*\d{1,3}\b/gi, ' ');
  t = t.replace(/\bs\d{1,2}\s*-\s*\d{1,3}(?:v\d)?/gi, ' ');        // S2 - 09
  t = t.replace(/[\s._]*-[\s._]*\d{1,4}(?:v\d)?(?=[\s._]|$)/gi, ' '); // " - 27" / ".-.1090."
  t = t.replace(/\b(480p|720p|1080p|2160p|4k|8k|uhd|fhd|hd|sd)\b/gi, ' ');
  t = t.replace(/\b(hdr10\+?|hdr|dv|dovi|dolby\s?vision|remux|web[-\s.]?dl|webrip|bluray|blu-ray|bdrip|brrip|hdtv|dvdrip|dvdscr|dvd|camrip|hdcam|hdrip)\b/gi, ' ');
  t = t.replace(/\b(x26[45]|h\.?26[45]|hevc|avc|xvid|divx|av1|10bit|8bit|hi10p)\b/gi, ' ');
  t = t.replace(/\b(aac|ac3|eac3|dd[p+]?\d*(?:\.\d)?|dts(?:-hd)?|truehd|atmos|flac|mp3|opus)\b/gi, ' ');
  t = t.replace(/\b(multi(?:\s?audio)?|dual(?:\s?audio)?|dubbed|castellano|latino|spanish|espanol|eng(?:lish)?|ingles|vose|vo|sub(?:s|bed|titulado)?|proper|repack|extended|unrated|uncut|imax|complete|batch)\b/gi, ' ');
  t = t.replace(/\b(19\d{2}|20[0-2]\d)\b/g, ' ');                  // años (2049 queda fuera)
  t = t.replace(/[-._\u2013\u2014]+/g, ' ');
  t = t.replace(/\s+/g, ' ').trim();

  // Si la limpieza dejó casi nada (p.ej. la película "1917"), usar el título base.
  return t.split(/\s+/).filter(Boolean).length >= 2 ? t : fallback;
}

/* ============================================================================
 * CLASIFICADOR DE IDIOMA (para el deduplicador)
 *   'spanish' → Castellano, Latino, VOSE / Subtitulado, Dual, Multi (incluyen ES)
 *   'english' → Inglés / VO por defecto
 * ========================================================================== */

const RE_SP_TITLE = /\b(castellano|latino|spanish|espanol|spa|esp|vose|subtitulado|sub\s?esp|dual|multi(?:\s?audio)?|truefrench|espagnol)\b/;
const RE_EN_TITLE = /\b(english|eng|ingles|sub\s?en)\b/;
const RE_SP_AUDIO = /\b(castellano|latino|spanish|espanol|spa|vose|dual|multi(?:\s?audio)?|es)\b/;
const RE_EN_AUDIO = /\b(english|eng|ingles|en)\b/;

function classifyLanguage(row) {
  const title = normalizeText(row.title || '');

  // 1) Señales en el propio título
  if (RE_SP_TITLE.test(title)) return 'spanish';
  if (RE_EN_TITLE.test(title)) return 'english';

  // 2) Señales en el array `audio` (p.ej. ['es','en'], ['Español Latino'], ['AC3'])
  const audioArr = Array.isArray(row.audio) ? row.audio : row.audio ? [row.audio] : [];
  for (const rawEntry of audioArr) {
    const entry = normalizeText(rawEntry).replace(/[^a-z0-9]+/g, ' ').trim();
    if (!entry) continue;
    // código exacto 'es' / 'es la' / 'spa' …
    if (/^(es|es la|esla|spa|esp)$/.test(entry) || RE_SP_AUDIO.test(entry)) return 'spanish';
    if (/^(en|en us|en gb|eng)$/.test(entry) || RE_EN_AUDIO.test(entry)) return 'english';
  }

  // 3) Por defecto: inglés (versión original / VOSE no marcada)
  return 'english';
}

/* ============================================================================
 * PASO 5 (núcleo) — PROVEEDORES DE METADATOS
 *   PÚBLICOS (sin API key): AniList · Kitsu · TVMaze · IMDb (sugerencias)
 *   PRIVADO  (tu API key vía secret): TMDB
 * Cada proveedor devuelve { ...ids, _source, _confidence } o null.
 * ========================================================================== */

/** Contador global de llamadas a APIs externas (para respetar MAX_LOOKUPS). */
const lookups = { count: 0 };
function budgetLeft() { return lookups.count < MAX_LOOKUPS; }

/** AniList GraphQL → { anilist_id, mal_id } (público) */
async function anilistLookup(search) {
  if (!budgetLeft()) return null;
  lookups.count++;
  const query = `query ($search: String) {
    Media(search: $search, type: ANIME) {
      id
      idMal
      title { romaji english }
    }
  }`;
  const res = await httpJson('https://graphql.anilist.co', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables: { search } }),
  });
  await sleep(900); // cortesía: AniList limita a ~30 req/min
  const media = res.body?.data?.Media;
  if (!res.ok || !media) return null;
  const bestTitle = media.title?.romaji || media.title?.english || '';
  if (bestTitle && !isGoodMatch(bestTitle, search)) return null;
  return {
    anilist_id: media.id,
    mal_id: media.idMal ?? null,
    _source: 'anilist',
    _confidence: bestTitle ? similarity(bestTitle, search) : MIN_SIMILARITY,
  };
}

/** Kitsu JSON:API → { kitsu_id } (público; ids numéricos → bigint OK) */
async function kitsuLookup(search) {
  if (!budgetLeft()) return null;
  lookups.count++;
  const url = `https://kitsu.io/api/edge/anime?filter[text]=${encodeURIComponent(search)}&page[limit]=5`;
  const res = await httpJson(url, { headers: { Accept: 'application/vnd.api+json' } });
  await sleep(400);
  if (!res.ok || !Array.isArray(res.body?.data)) return null;
  for (const item of res.body.data) {
    const t = item?.attributes?.canonicalTitle || item?.attributes?.titles?.en || '';
    if (isGoodMatch(t, search)) {
      const id = Number(item.id); // kitsu_id es bigint en el esquema
      if (!Number.isFinite(id)) return null;
      return { kitsu_id: id, _source: 'kitsu', _confidence: similarity(t, search) };
    }
  }
  return null;
}

/**
 * TVMaze → { imdb_id } vía show.externals.imdb (público, sin API key).
 * Solo contenido de TV (series y anime emitiendo/en catálogo TV).
 */
async function tvmazeLookup(search, year) {
  if (!budgetLeft()) return null;
  lookups.count++;
  const url = `https://api.tvmaze.com/search/shows?q=${encodeURIComponent(search)}`;
  const res = await httpJson(url);
  await sleep(350); // cortesía TVMaze (fair-use)
  if (!res.ok || !Array.isArray(res.body)) return null;
  for (const item of res.body.slice(0, 5)) {
    const show = item?.show || {};
    const t = show.name || '';
    if (!isGoodMatch(t, search)) continue;
    // Coherencia de año (premiered) cuando ambos lo tienen
    const pYear = show.premiered ? Number(String(show.premiered).slice(0, 4)) : null;
    if (year && pYear && Math.abs(pYear - Number(year)) > 1) continue;
    const imdb = normImdbId(show.externals?.imdb); // formato tt[0-9]+ del CHECK
    if (!imdb) continue;
    return { imdb_id: imdb, _source: 'tvmaze', _confidence: similarity(t, search) };
  }
  return null;
}

/**
 * IMDb público (endpoint de sugerencias de imdb.com, sin API key) → { imdb_id }.
 * Devuelve además el tipo (`qid`: movie, tvSeries, tvMiniSeries…) que usamos
 * como coherencia: una película no se empareja con una serie y viceversa.
 */
async function imdbLookup(search, year, type) {
  if (!budgetLeft()) return null;
  lookups.count++;
  const key = search.trim().toLowerCase().replace(/\s+/g, ' ');
  const first = encodeURIComponent(key.charAt(0) || 'a');
  const url = `https://v2.sg.media-imdb.com/suggestion/${first}/${encodeURIComponent(key)}.json`;
  const res = await httpJson(url);
  await sleep(250);
  if (!res.ok || !Array.isArray(res.body?.d)) return null;

  const movieTypes = new Set(['movie', 'tvmovie', 'video', 'short', 'tvspecial', 'tvshort']);
  const tvTypes = new Set(['tvseries', 'tvminiseries']);
  const want = new Set([
    ...(type === 'movie' || type === 'anime' ? [...movieTypes] : []),
    ...(type === 'series' || type === 'anime' ? [...tvTypes] : []),
  ]);

  for (const item of res.body.d.slice(0, 8)) {
    const qid = String(item.qid || item.q || '').toLowerCase().replace(/[\s._-]/g, '');
    if (!want.has(qid)) continue;
    const t = item.l || '';
    if (!isGoodMatch(t, search)) continue;
    if (year && item.y && Math.abs(Number(item.y) - Number(year)) > 1) continue;
    const imdb = normImdbId(item.id);
    if (!imdb) continue;
    return { imdb_id: imdb, _source: 'imdb', _confidence: similarity(t, search) };
  }
  return null;
}

/**
 * TMDB → { tmdb_id, imdb_id } (search + external_ids).
 * series/anime → search/tv; movie → search/movie; anime sin match → prueba cine.
 */
async function tmdbLookup(search, type, year) {
  if (!TMDB_API_KEY || !budgetLeft()) return null;
  const isTvLike = type === 'series' || type === 'anime';

  const trySearch = async (path, yearParam) => {
    lookups.count++;
    const params = new URLSearchParams({ api_key: TMDB_API_KEY, query: search, include_adult: 'false' });
    if (year && yearParam) params.set(yearParam, String(year));
    const res = await httpJson(`https://api.themoviedb.org/3/${path}?${params}`);
    await sleep(250);
    if (!res.ok || !Array.isArray(res.body?.results)) return null;
    for (const r of res.body.results.slice(0, 5)) {
      const t = r.title || r.name || '';
      if (isGoodMatch(t, search)) return r;
    }
    return null;
  };

  // Búsqueda principal (con año si lo hay); si no hay match, un reintento sin año.
  let hit = await trySearch(isTvLike ? 'search/tv' : 'search/movie', isTvLike ? 'first_air_date_year' : 'year');
  if (!hit && year) hit = await trySearch(isTvLike ? 'search/tv' : 'search/movie', null);
  // Anime sin match en TV → probar como película (anime films)
  if (!hit && type === 'anime') {
    hit = await trySearch('search/movie', year ? 'year' : null);
    if (!hit && year) hit = await trySearch('search/movie', null);
  }
  if (!hit) return null;

  const kind = hit.name ? 'tv' : 'movie';
  const hitTitle = hit.title || hit.name || '';
  lookups.count++;
  const ext = await httpJson(
    `https://api.themoviedb.org/3/${kind}/${hit.id}/external_ids?api_key=${TMDB_API_KEY}`
  );
  await sleep(250);
  return {
    tmdb_id: hit.id,
    imdb_id: normImdbId(ext.body?.imdb_id),
    _source: 'tmdb',
    _confidence: hitTitle ? similarity(hitTitle, search) : MIN_SIMILARITY,
  };
}

/* ============================================================================
 * RESUMEN / GITHUB_STEP_SUMMARY
 * ========================================================================== */

const summary = {
  '1 · Adulto': 0,
  '2 · Anti-fakes': 0,
  '3 · Muertos': 0,
  '4 · Títulos corregidos': 0,
  '5 · Registros enriquecidos': 0,
  '6 · Duplicados': 0,
};

function writeGithubSummary(timing) {
  if (!process.env.GITHUB_STEP_SUMMARY) return;
  const rows = Object.entries(summary)
    .map(([k, v]) => `| ${k} | ${v} |`)
    .join('\n');
  const md = `## 🧹 Mantenimiento de \`${TABLE}\`${DRY_RUN ? ' *(DRY_RUN — sin escrituras)*' : ''}\n\n| Paso | Registros afectados |\n|---|---|\n${rows}\n\n⏱ Duración total: ${timing}\n`;
  try { fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md); } catch { /* noop */ }
}

/* ============================================================================
 * PASO 1 — FILTRO DE CONTENIDO ADULTO
 * Estrategia optimizada:
 *   a) Pre-filtro SQL con ILIKE (superconjunto) por lotes de keywords.
 *   b) Refino en JS con bordes de palabra sobre texto normalizado
 *      (evita falsos positivos tipo "javascript" ⊃ "jav").
 *   c) DELETE por ids en chunks.
 * ========================================================================== */
async function step1_removeAdultContent() {
  const candidates = new Map(); // id -> title
  const kwChunks = chunk(ADULT_PREFILTER, 6);

  for (const kwChunk of kwChunks) {
    const orClause = kwChunk.map((k) => `title.ilike.%${k}%`).join(',');
    for await (const batch of scanBatches('id, title', (q) => q.or(orClause))) {
      for (const row of batch) candidates.set(row.id, row.title ?? '');
    }
  }

  const doomed = [];
  for (const [id, title] of candidates) {
    const norm = normalizeText(title);
    if (ADULT_RE.test(norm)) doomed.push(id);
  }

  const deleted = await deleteByIds(doomed);
  summary['1 · Adulto'] = deleted;
  log(`   ${candidates.size} candidatos pre-filtrados → ${deleted} confirmados y eliminados`);
  return deleted;
}

/* ============================================================================
 * PASO 2 — FILTRO ANTI-FAKES POR TAMAÑO
 *   movie  < 150 MB  → fuera
 *   series <  30 MB  → fuera
 *   anime  < ANIME_MIN_SIZE_MB (opcional, 0 = desactivado)
 * ========================================================================== */
async function step2_removeFakeSizes() {
  let total = 0;

  total += await deleteByFilter((q) =>
    q.eq('type', 'movie').not('size_bytes', 'is', null).lt('size_bytes', MOVIE_MIN_BYTES)
  );

  total += await deleteByFilter((q) =>
    q.eq('type', 'series').not('size_bytes', 'is', null).lt('size_bytes', SERIES_MIN_BYTES)
  );

  if (ANIME_MIN_SIZE_MB > 0) {
    total += await deleteByFilter((q) =>
      q.eq('type', 'anime').not('size_bytes', 'is', null).lt('size_bytes', ANIME_MIN_SIZE_MB * MB)
    );
  }

  summary['2 · Anti-fakes'] = total;
  log(`   movies < 150 MB + series < 30 MB${ANIME_MIN_SIZE_MB ? ` + anime < ${ANIME_MIN_SIZE_MB} MB` : ''} → ${total} eliminados`);
  return total;
}

/* ============================================================================
 * PASO 3 — PURGADOR DE TORRENTS MUERTOS
 *   seeders = 0 Y updated_at con más de 30 días de antigüedad → fuera
 * ========================================================================== */
async function step3_purgeDeadTorrents() {
  const cutoff = new Date(Date.now() - DEAD_TORRENT_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const deleted = await deleteByFilter((q) =>
    q.eq('seeders', 0).not('updated_at', 'is', null).lt('updated_at', cutoff)
  );
  summary['3 · Muertos'] = deleted;
  log(`   seeders = 0 y updated_at < ${cutoff} → ${deleted} eliminados`);
  return deleted;
}

/* ============================================================================
 * PASO 4 — ANALIZADOR Y NORMALIZADOR DE TÍTULOS
 * Recorre la tabla, parsea cada título y corrige type / season / episode
 * únicamente donde el parser encontró valores mejores.
 * ========================================================================== */
async function step4_normalizeTitles() {
  const patches = [];
  for await (const batch of scanBatches(
    'id, type, title, season, episode, absolute_episode, kitsu_id, anilist_id, mal_id, release_group, quality, codec, hdr_format'
  )) {
    for (const row of batch) {
      const patch = buildTitlePatch(row);
      if (Object.keys(patch).length > 0) patches.push({ id: row.id, title: row.title, patch });
    }
  }

  await mapPool(patches, UPDATE_CONCURRENCY, async ({ id, title, patch }) => {
    log(`   ↻ "${String(title).slice(0, 70)}" →`, patch);
    await applyPatch(id, patch);
  });

  summary['4 · Títulos corregidos'] = patches.length;
  log(`   ${patches.length} registros corregidos (type / season / episode / absolute_episode)`);
  return patches.length;
}

/* ============================================================================
 * PASO 5 — ENRIQUECEDOR DE IDs CON APIs PÚBLICAS
 * Huérfanos (IDs faltantes) → título limpio → proveedores según tipo:
 *   anime  → AniList + Kitsu (+ TVMaze/IMDb/TMDB)
 *   series → TVMaze + IMDb (+ TMDB)
 *   movie  → IMDb (+ TMDB)
 * Rellena tmdb_id / imdb_id / anilist_id / kitsu_id / mal_id SIN sobrescribir.
 * Libro de control `ids_*` del esquema:
 *   · ids_checked_at  → última vez que se intentó (ventana IDS_RETRY_HOURS)
 *   · ids_attempts    → nº de intentos (se rinde con MAX_ID_ATTEMPTS)
 *   · ids_source      → proveedores que aportaron IDs (p.ej. 'anilist+tvmaze')
 *   · ids_confidence  → mejor similitud del match aceptado (0..1)
 * ========================================================================== */
async function step5_enrichMetadata() {
  if (!TMDB_API_KEY) {
    logWarn('TMDB_API_KEY no configurada: TMDB se omite (AniList/Kitsu/TVMaze/IMDb siguen activos).');
  }

  const provCache = new Map(); // "prov|type|search|year" → promesa de resultado (incluye nulls)
  const cached = (key, fn) => {
    if (!provCache.has(key)) provCache.set(key, fn());
    return provCache.get(key);
  };

  const updates = [];
  let rowsConsidered = 0;
  let enriched = 0;
  let skippedRecent = 0;
  let skippedGivenUp = 0;

  outer:
  for await (const batch of scanBatches(
    'id, type, title, tmdb_id, imdb_id, anilist_id, kitsu_id, mal_id, ids_checked_at, ids_attempts',
    (q) => q.or('imdb_id.is.null,tmdb_id.is.null,anilist_id.is.null,kitsu_id.is.null')
  )) {
    for (const row of batch) {
      rowsConsidered++;

      // ── Libro de control: reintentos acotados y ventana temporal ──────────
      const attempts = Number(row.ids_attempts ?? 0);
      if (attempts >= MAX_ID_ATTEMPTS) { skippedGivenUp++; continue; }
      if (row.ids_checked_at &&
          Date.now() - Date.parse(row.ids_checked_at) < IDS_RETRY_HOURS * 3600_000) {
        skippedRecent++;
        continue;
      }
      if (!budgetLeft()) {
        logWarn(`Presupuesto de lookups agotado (MAX_LOOKUPS=${MAX_LOOKUPS}).`);
        break outer;
      }

      const search = cleanTitleForSearch(row.title);
      if (!search) continue;
      const yearM = String(row.title).match(/\b(19\d{2}|20[0-2]\d)\b/);
      const year = yearM ? Number(yearM[1]) : null;

      // ── Merge de resultados: solo IDs vacíos, con fuente y confianza ──────
      const found = {};
      const sources = [];
      let confidence = null;
      const take = (res) => {
        if (!res) return;
        const { _source, _confidence, ...fields } = res;
        let contributed = false;
        for (const [k, v] of Object.entries(fields)) {
          if (v != null && found[k] == null && row[k] == null) {
            found[k] = v;
            contributed = true;
          }
        }
        if (contributed) {
          sources.push(_source);
          confidence = Math.max(confidence ?? 0, _confidence ?? 0);
        }
      };

      // ── Proveedores según tipo y huecos (orden: públicos → TMDB) ──────────
      const isAnime = row.type === 'anime';
      const isTvLike = isAnime || row.type === 'series';
      const k = (p) => `${p}|${row.type}|${search}|${year ?? ''}`;

      if (isAnime && (row.anilist_id == null || row.mal_id == null)) {
        take(await cached(k('anilist'), () => anilistLookup(search)));
      }
      if (isAnime && row.kitsu_id == null) {
        take(await cached(k('kitsu'), () => kitsuLookup(search)));
      }
      if (isTvLike && row.imdb_id == null && found.imdb_id == null) {
        take(await cached(k('tvmaze'), () => tvmazeLookup(search, year)));
      }
      if (row.imdb_id == null && found.imdb_id == null) {
        take(await cached(k('imdb'), () => imdbLookup(search, year, row.type)));
      }
      if (TMDB_API_KEY && (row.tmdb_id == null || (row.imdb_id == null && found.imdb_id == null))) {
        take(await cached(k('tmdb'), () => tmdbLookup(search, row.type, year)));
      }

      // ── Parche: IDs nuevos + libro de control ids_* (siempre se registra) ─
      const patch = {};
      if (found.tmdb_id != null) patch.tmdb_id = found.tmdb_id;
      if (found.imdb_id != null) patch.imdb_id = found.imdb_id;
      if (found.anilist_id != null) patch.anilist_id = found.anilist_id;
      if (found.kitsu_id != null) patch.kitsu_id = found.kitsu_id;
      if (found.mal_id != null) patch.mal_id = found.mal_id;

      patch.ids_checked_at = new Date().toISOString();
      patch.ids_attempts = attempts + 1;
      if (sources.length) {
        patch.ids_source = sources.join('+').slice(0, 100);
        patch.ids_confidence = Number(confidence.toFixed(4));
        enriched++;
      }

      updates.push({ id: row.id, title: row.title, patch });
    }
  }

  await mapPool(updates, UPDATE_CONCURRENCY, async ({ id, title, patch }) => {
    const idsOnly = Object.keys(patch).filter((key) => key.endsWith('_id')).length > 0;
    if (idsOnly) log(`   ✚ "${String(title).slice(0, 60)}" →`, patch);
    await applyPatch(id, patch);
  });

  summary['5 · Registros enriquecidos'] = enriched;
  log(`   ${rowsConsidered} huérfanos revisados · ${enriched} enriquecidos · ${updates.length} con intento registrado`);
  log(`   omitidos: ${skippedRecent} recientes (<${IDS_RETRY_HOURS}h) · ${skippedGivenUp} rendidos (>=${MAX_ID_ATTEMPTS} intentos)`);
  log(`   ${lookups.count} llamadas a APIs (cache: ${provCache.size} resultados distintos)`);
  return enriched;
}

/* ============================================================================
 * PASO 6 — DEDUPLICADOR INTELIGENTE (TOP 2 ESPAÑOL / TOP 2 INGLÉS)
 *   Clave de obra: MAPA DE ALIAS entre identificadores (union-find). Si una
 *   fila porta imdb_id Y tmdb_id, entonces imdb:ttX ≡ tmdb:Y y todas las
 *   copias que traigan cualquiera de los dos caen en el MISMO grupo
 *   (ídem anilist ↔ mal). Identificador canónico por prioridad:
 *   imdb > tmdb > anilist > mal. Clave final = canónico + season + episode.
 *   Idioma: 'spanish' (Castellano/Latino/VOSE/Dual/Multi) vs 'english'
 *   Orden: seeders ↓, size_bytes ↓, updated_at ↓
 *   Regla estricta: conservar TOP 2 por idioma; el resto se elimina.
 * ========================================================================== */

/**
 * planDedup(rows, topN) → { doomedIds, groups, skippedNoId }
 * Función pura (auto-testeable): calcula qué ids sobran según la regla
 * TOP N por idioma dentro de cada obra+episodio, cruzando alias de IDs.
 */
function planDedup(rows, topN = TOP_N_PER_LANGUAGE) {
  const RANK = { imdb: 0, tmdb: 1, anilist: 2, mal: 3 };
  const tokensOf = (row) => [
    row.imdb_id ? `imdb:${row.imdb_id}` : null,
    row.tmdb_id != null ? `tmdb:${row.tmdb_id}` : null,
    row.anilist_id != null ? `anilist:${row.anilist_id}` : null,
    row.mal_id != null ? `mal:${row.mal_id}` : null,
  ].filter(Boolean);

  // ── union-find mínimo sobre identificadores ───────────────────────────────
  const parent = new Map();
  const find = (x) => {
    if (!parent.has(x)) parent.set(x, x);
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r);
    let cur = x; // compresión de caminos
    while (parent.get(cur) !== r) {
      const nxt = parent.get(cur);
      parent.set(cur, r);
      cur = nxt;
    }
    return r;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  const rowTokens = new Map(); // row.id -> tokens
  let skippedNoId = 0;
  for (const row of rows) {
    const toks = tokensOf(row);
    if (!toks.length) { skippedNoId++; continue; }
    rowTokens.set(row.id, toks);
    // Una fila que porta varios IDs los vincula: imdb:ttX ≡ tmdb:Y ≡ mal:Z…
    for (let i = 1; i < toks.length; i++) union(toks[0], toks[i]);
  }

  // mejor token por componente (prioridad imdb > tmdb > anilist > mal)
  const rankOf = (t) => RANK[t.slice(0, t.indexOf(':'))];
  const best = new Map(); // root -> token canónico
  for (const toks of rowTokens.values()) {
    for (const t of toks) {
      const r = find(t);
      const cur = best.get(r);
      if (!cur || rankOf(t) < rankOf(cur)) best.set(r, t);
    }
  }

  // ── agrupar por canónico + season + episode ───────────────────────────────
  const groups = new Map();
  for (const row of rows) {
    const toks = rowTokens.get(row.id);
    if (!toks) continue;
    const canon = best.get(find(toks[0]));
    const key = `${canon}|${row.season ?? '*'}|${row.episode ?? '*'}`;
    if (!groups.has(key)) groups.set(key, { spanish: [], english: [] });
    groups.get(key)[classifyLanguage(row)].push(row);
  }

  // Orden determinista: más seeders primero; empates → mayor tamaño y más reciente.
  const byQuality = (a, b) =>
    (Number(b.seeders ?? 0) - Number(a.seeders ?? 0)) ||
    (Number(b.size_bytes ?? 0) - Number(a.size_bytes ?? 0)) ||
    (new Date(b.updated_at ?? 0) - new Date(a.updated_at ?? 0));

  const doomedIds = [];
  for (const bucket of groups.values()) {
    for (const lang of ['spanish', 'english']) {
      bucket[lang].sort(byQuality);
      for (const row of bucket[lang].slice(topN)) doomedIds.push(row.id);
    }
  }
  return { doomedIds, groups, skippedNoId };
}

async function step6_deduplicate() {
  const rows = [];
  for await (const batch of scanBatches(
    'id, imdb_id, tmdb_id, anilist_id, mal_id, season, episode, title, audio, seeders, size_bytes, updated_at, type'
  )) {
    rows.push(...batch);
  }

  const { doomedIds, groups, skippedNoId } = planDedup(rows);

  let groupsTouched = 0;
  for (const [key, bucket] of groups) {
    const excess =
      bucket.spanish.length - Math.min(bucket.spanish.length, TOP_N_PER_LANGUAGE) +
      bucket.english.length - Math.min(bucket.english.length, TOP_N_PER_LANGUAGE);
    if (excess > 0) {
      groupsTouched++;
      const sample = bucket.spanish[0]?.title || bucket.english[0]?.title || key;
      log(`   🗑 "${String(sample).slice(0, 60)}" [${key}] → ${excess} excedentes`);
    }
  }

  const deleted = await deleteByIds(doomedIds);
  summary['6 · Duplicados'] = deleted;
  log(`   ${groups.size} grupos de obra+episodio con alias cruzados (${skippedNoId} filas sin ningún ID, omitidas)`);
  log(`   ${groupsTouched} grupos con excedentes → ${deleted} eliminados (se conservan TOP ${TOP_N_PER_LANGUAGE} ES + TOP ${TOP_N_PER_LANGUAGE} EN)`);
  return deleted;
}

/* ============================================================================
 * SELF-TEST (parser + clasificador de idioma) — sin credenciales ni red
 * ========================================================================== */
function runSelfTest() {
  log('▶ Self-test del parser y clasificador de idioma...\n');

  // ── Parser ───────────────────────────────────────────────────────────────
  let p = parseTitle('[SubsPlease] Sousou no Frieren - 27 [1080p][Batch]');
  assert.equal(p.type, 'anime', 'grupo SubsPlease → anime');
  assert.equal(p.episode, 27, 'anime bare → episodio 27');
  assert.equal(p.absolute_episode, 27, 'anime bare → absolute 27');
  assert.equal(p.season, 1, 'sin marca de temporada → 1');

  p = parseTitle('[Erai-raws] Spy x Family S2 - 09 [720p]');
  assert.equal(p.type, 'anime', 'grupo Erai-raws → anime');
  assert.equal(p.season, 2, 'S2 - 09 → season 2');
  assert.equal(p.episode, 9, 'S2 - 09 → episode 9');

  p = parseTitle('Breaking.Bad.S02E09.1080p.WEB-DL.DDP5.1.x264-NTb');
  assert.equal(p.type, 'series', 'S02E09 → series');
  assert.equal(p.season, 2);
  assert.equal(p.episode, 9);

  p = parseTitle('Game.of.Thrones.1x09.720p.HDTV');
  assert.equal(p.type, 'series', '1x09 → series');
  assert.equal(p.season, 1);
  assert.equal(p.episode, 9);

  p = parseTitle('The.Matrix.1999.1080p.BluRay.x264-YTS');
  assert.equal(p.type, 'movie', 'película → movie');
  assert.equal(p.year, 1999, 'año detectado');
  assert.equal(p.episode, null, 'sin episodios');

  p = parseTitle('Severance S01E03 2160p WEB-DL');
  assert.equal(p.type, 'series');
  assert.equal(p.season, 1);
  assert.equal(p.episode, 3);

  p = parseTitle('Bleach - 366v2 [1080p] [Judas]');
  assert.equal(p.type, 'anime');
  assert.equal(p.episode, 366);

  // "1920x1080" NO debe leerse como episodio 1x08…
  p = parseTitle('Open.Range.2023.1920x1080.WEB-DL');
  assert.equal(p.type, 'movie', 'resolución 1920x1080 no es 1x08');
  assert.equal(p.episode, null);

  // Fansub con separadores ".-." y episodio de 4 dígitos (One Piece, Conan…)
  p = parseTitle('One.Piece.-.1090.[1080p]');
  assert.equal(p.type, 'anime', 'estilo fansub con corchete → anime');
  assert.equal(p.episode, 1090, 'episodio absoluto de 4 dígitos');
  assert.equal(p.absolute_episode, 1090);

  // Película con guion no debe confundirse con episodio
  p = parseTitle('Spider-Man.No.Way.Home.2021.1080p.BluRay.x264-YTS');
  assert.equal(p.type, 'movie');
  assert.equal(p.episode, null, 'guion de título no es episodio');

  // ── Limpieza de títulos ──────────────────────────────────────────────────
  assert.equal(cleanTitleForSearch('The.Matrix.1999.1080p.BluRay.x264-YTS'), 'The Matrix');
  assert.equal(cleanTitleForSearch('[SubsPlease] Sousou no Frieren - 27 [1080p]'), 'Sousou no Frieren');

  // ── Metadatos de release → columnas quality / codec / hdr_format / group ─
  p = parseTitle('The.Last.of.Us.S01E09.2160p.WEB-DL.DV.HDR10+.DDP5.1.Atmos.x265-NTb');
  assert.equal(p.quality, '2160p', 'calidad/resolución');
  assert.equal(p.codec, 'H265', 'codec normalizado');
  assert.equal(p.hdr_format, 'DV|HDR10+', 'combo HDR');
  assert.equal(p.release_group, 'NTb', 'grupo desde sufijo');

  p = parseTitle('[SubsPlease] Frieren - 27 [1080p]');
  assert.equal(p.release_group, 'SubsPlease', 'grupo desde corchete (case original)');
  assert.equal(p.quality, '1080p');
  assert.equal(p.release_group !== '1080p', true, 'la resolución no es release_group');

  // ── Clasificador de idioma ───────────────────────────────────────────────
  assert.equal(classifyLanguage({ title: 'Dune.2021.Castellano.1080p', audio: [] }), 'spanish');
  assert.equal(classifyLanguage({ title: 'Dune.2021.Latino.1080p', audio: [] }), 'spanish');
  assert.equal(classifyLanguage({ title: 'Dune.2021.VOSE.1080p', audio: [] }), 'spanish');
  assert.equal(classifyLanguage({ title: 'Dune.2021.Subtitulado.1080p', audio: [] }), 'spanish');
  assert.equal(classifyLanguage({ title: 'Dune.2021.DUAL.1080p', audio: [] }), 'spanish');
  assert.equal(classifyLanguage({ title: 'Dune.2021.1080p', audio: ['es', 'ac3'] }), 'spanish');
  assert.equal(classifyLanguage({ title: 'Dune.2021.1080p', audio: ['en'] }), 'english');
  assert.equal(classifyLanguage({ title: 'Dune.2021.English.1080p', audio: [] }), 'english');
  assert.equal(classifyLanguage({ title: 'Dune.2021.1080p', audio: ['ac3', 'eac3'] }), 'english');
  assert.equal(classifyLanguage({ title: 'One.Piece.-.1090.[1080p]', audio: [] }), 'english');

  // ── Adulto: bordes de palabra (sin falsos positivos) ─────────────────────
  const adult = (t) => ADULT_RE.test(normalizeText(t));
  assert.ok(adult('Movie.Porno.2020.1080p'), 'porno detectado');
  assert.ok(adult('Algo.XXX.1080p'), 'xxx detectado');
  assert.ok(adult('Some.Hentai.OVA - 01'), 'hentai detectado');
  assert.ok(!adult('JavaScript.The.Movie.2020'), '"javascript" no dispara "jav"');
  assert.ok(!adult('Sex.Education.S01E01'), 'contenido legítimo conservado');

  // ── Similitud de matching ────────────────────────────────────────────────
  assert.ok(isGoodMatch('Sousou no Frieren', 'Sousou no Frieren'));
  assert.ok(!isGoodMatch('Completely Different Show', 'Sousou no Frieren'));

  // ── imdb_id normalizado al CHECK ^tt[0-9]+$ ──────────────────────────────
  assert.equal(normImdbId('tt0133093'), 'tt0133093');
  assert.equal(normImdbId('0133093'), 'tt0133093');
  assert.equal(normImdbId('TT999'), 'tt999');
  assert.equal(normImdbId('garbage'), null, 'imdb inválido → null (evita violar el CHECK)');

  // ── Deduplicador: alias de identificadores (union-find) ────────────────────
  const plan = planDedup([
    { id: 1, imdb_id: 'tt1', tmdb_id: 10, anilist_id: null, mal_id: null, season: 1, episode: 1, title: 'A S01E01 Castellano', audio: [], seeders: 100 },
    { id: 2, imdb_id: null, tmdb_id: 10, anilist_id: null, mal_id: null, season: 1, episode: 1, title: 'A S01E01 English', audio: [], seeders: 90 },
    { id: 3, imdb_id: 'tt1', tmdb_id: null, anilist_id: null, mal_id: null, season: 1, episode: 1, title: 'A S01E01 VOSE', audio: [], seeders: 80 },
    { id: 4, imdb_id: 'tt1', tmdb_id: null, anilist_id: null, mal_id: null, season: 1, episode: 1, title: 'A S01E01 Dual', audio: [], seeders: 70 },
    { id: 5, imdb_id: 'tt1', tmdb_id: null, anilist_id: null, mal_id: null, season: 1, episode: 1, title: 'A S01E01 Latino', audio: [], seeders: 60 },
    { id: 6, imdb_id: null, tmdb_id: null, anilist_id: null, mal_id: null, season: 1, episode: 1, title: 'sin ids', audio: [], seeders: 50 },
  ], 2);
  assert.equal(plan.groups.size, 1, 'imdb:tt1 y tmdb:10 son la MISMA obra (alias)');
  assert.deepEqual([...plan.doomedIds].sort((a, b) => a - b), [4, 5], 'TOP 2 spanish → 4 y 5 sobran');
  assert.equal(plan.skippedNoId, 1, 'fila sin ningún ID → omitida');

  // anilist ↔ mal unidos a través de una fila que porta ambos
  const plan2 = planDedup([
    { id: 1, imdb_id: null, tmdb_id: null, anilist_id: 77, mal_id: 88, season: null, episode: 5, title: '[SubsPlease] X - 05 [1080p]', audio: [], seeders: 10 },
    { id: 2, imdb_id: null, tmdb_id: null, anilist_id: null, mal_id: 88, season: null, episode: 5, title: 'X - 05 [Judas]', audio: [], seeders: 9 },
    { id: 3, imdb_id: null, tmdb_id: null, anilist_id: 77, mal_id: null, season: null, episode: 5, title: 'X - 05 [EMBER]', audio: [], seeders: 8 },
  ], 2);
  assert.equal(plan2.groups.size, 1, 'anilist:77 ≡ mal:88 (mismo grupo)');
  assert.deepEqual([...plan2.doomedIds], [3], 'TOP 2 english por defecto → 3 sobra');

  log('\n✔ Self-test superado (parser + limpieza + idioma + adulto + matching + dedup).');
}

/* ============================================================================
 * MAIN — orquestación paso a paso
 * ========================================================================== */

function banner(n, total, titulo) {
  log('\n' + '='.repeat(70));
  log(`🧹  PASO ${n}/${total} — ${titulo}`);
  log('='.repeat(70));
}

async function main() {
  const t0 = Date.now();

  if (process.argv.includes('--self-test')) {
    runSelfTest();
    return;
  }

  db(); // valida credenciales temprano

  const allSteps = [
    { n: 1, titulo: 'FILTRO DE CONTENIDO ADULTO', fn: step1_removeAdultContent },
    { n: 2, titulo: 'FILTRO ANTI-FAKES POR TAMAÑO', fn: step2_removeFakeSizes },
    { n: 3, titulo: 'PURGADOR DE TORRENTS MUERTOS', fn: step3_purgeDeadTorrents },
    { n: 4, titulo: 'ANALIZADOR Y NORMALIZADOR DE TÍTULOS', fn: step4_normalizeTitles },
    { n: 5, titulo: 'ENRIQUECEDOR DE IDs (AniList / Kitsu / TVMaze / IMDb / TMDB)', fn: step5_enrichMetadata },
    { n: 6, titulo: `DEDUPLICADOR (TOP ${TOP_N_PER_LANGUAGE} ES / TOP ${TOP_N_PER_LANGUAGE} EN)`, fn: step6_deduplicate },
  ];
  const toRun = allSteps.filter((s) => ONLY_STEPS.size === 0 || ONLY_STEPS.has(s.n));

  log('='.repeat(70));
  log(`🧹  MANTENIMIENTO DE \`${TABLE}\` ${DRY_RUN ? '· MODO DRY_RUN (SIN ESCRITURAS)' : ''}`);
  log(`    Supabase: ${SUPABASE_URL}`);
  log(`    TMDB: ${TMDB_API_KEY ? 'configurada' : 'NO configurada'} · MAX_LOOKUPS=${MAX_LOOKUPS}`);
  if (ONLY_STEPS.size) log(`    Selector activo → solo pasos: ${toRun.map((s) => s.n).join(', ')}`);
  log('='.repeat(70));

  // Un paso que falla NO aborta el pipeline: se registra y se continúa
  // (los pasos son idempotentes; un reintento puntual --steps=N basta).
  const failures = [];
  for (const step of toRun) {
    banner(step.n, 6, step.titulo);
    const s0 = Date.now();
    try {
      await step.fn();
    } catch (err) {
      failures.push(step.titulo);
      summary['⚠ Pasos fallidos'] = failures.length;
      logErr(`El paso ${step.n} falló (se continúa con los siguientes):`, err);
    }
    log(`   ⏱ ${((Date.now() - s0) / 1000).toFixed(1)}s`);
  }

  const timing = `${((Date.now() - t0) / 1000).toFixed(1)}s`;
  log('\n' + '='.repeat(70));
  log('📊  RESUMEN' + (DRY_RUN ? ' (DRY_RUN)' : ''));
  log('='.repeat(70));
  for (const [k, v] of Object.entries(summary)) log(`   ${k}: ${v}`);
  if (failures.length) logErr(`   Pasos con error: ${failures.join(' · ')}`);
  log(`\n   ⏱ Duración total: ${timing}`);
  log('='.repeat(70));

  writeGithubSummary(timing);

  // Exit code ≠ 0 para que GitHub Actions lo marque como fallido si algo falló.
  if (failures.length) process.exitCode = 1;
}

main().catch((err) => {
  logErr('El mantenimiento falló:', err);
  process.exitCode = 1;
});

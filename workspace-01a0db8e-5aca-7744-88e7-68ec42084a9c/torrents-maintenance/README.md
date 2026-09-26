# 🧹 torrents-maintenance

Mantenimiento integral de la tabla `torrents` en **Supabase**, pensado para
ejecutarse en **GitHub Actions** con Node.js ≥ 20.

## Pasos (en orden)

| # | Paso | Qué hace |
|---|------|----------|
| 1 | **Filtro de contenido adulto** | Elimina títulos con palabras clave explícitas (porno, xxx, nsfw, hentai, estudios adultos…). Pre-filtro SQL (`ILIKE`) + refino en JS con bordes de palabra → sin falsos positivos ("Sex Education", "JavaScript"). |
| 2 | **Filtro anti-fakes por tamaño** | `movie` con `size_bytes < 150 MB` → fuera. `series` con `size_bytes < 30 MB` → fuera. (Umbral opcional para `anime` vía `ANIME_MIN_SIZE_MB`.) |
| 3 | **Purgador de torrents muertos** | `seeders = 0` **y** `updated_at` con más de 30 días → fuera. |
| 4 | **Parser de títulos** | Detecta `movie` / `series` / `anime` por patrones y grupos de release (`[SubsPlease]`, `[Erai-raws]`, `S02E09`, `1x09`, `S2 - 09`, `S2.-.09`, `- 27 [1080p]`…). Extrae/corrige `season`, `episode`, `absolute_episode` **y** los metadatos de release del título: `release_group`, `quality`, `codec`, `hdr_format`. |
| 5 | **Enriquecedor de IDs** | Huérfanos → título limpio (sin años/resoluciones/calidades) → proveedores por tipo: **AniList** (`anilist_id`, `mal_id`) + **Kitsu** (`kitsu_id`) para anime; **TVMaze** (`imdb_id` vía `externals`) para TV; **IMDb público** (`imdb_id` + coherencia de tipo); **TMDB** (`tmdb_id` + `imdb_id`) con tu API key. Solo rellena campos vacíos y registra el intento en las columnas `ids_*`. |
| 6 | **Deduplicador TOP 2 ES / TOP 2 EN** | Agrupa por obra con **mapa de alias** (union-find: `imdb` ≡ `tmdb` ≡ `anilist` ≡ `mal` cuando una fila vincula varios IDs) + `season` + `episode`. Clasifica idioma (**spanish** = Castellano/Latino/VOSE/Subtitulado/Dual/Multi · **english** = inglés/VO). Ordena por `seeders` ↓ y conserva **2 + 2**; elimina el resto. |

## Fuentes de metadatos

| Fuente | Acceso | IDs que aporta | Ámbito |
|--------|--------|----------------|--------|
| **AniList** (GraphQL) | 🌐 público | `anilist_id`, `mal_id` | anime |
| **Kitsu** (JSON:API) | 🌐 público | `kitsu_id` | anime |
| **TVMaze** | 🌐 público | `imdb_id` (vía `show.externals`) | series / anime (TV) |
| **IMDb** (sugerencias de imdb.com) | 🌐 público | `imdb_id` + coherencia de tipo | todos |
| **TMDB** | 🔑 **tu API key** (secret `TMDB_API_KEY`) | `tmdb_id` + `imdb_id` (external_ids) | todos |

### Libro de control `ids_*` (columnas de tu tabla)

El paso 5 mantiene trazabilidad de cada lookup y controla los reintentos:

| Columna | Uso |
|---------|-----|
| `ids_checked_at` | última vez que se intentó enriquecer la fila (ventana `IDS_RETRY_HOURS`) |
| `ids_attempts` | nº de intentos; al llegar a `MAX_ID_ATTEMPTS` la fila se rinde |
| `ids_source` | proveedores que aportaron IDs (p. ej. `anilist+kitsu`, `tvmaze`) |
| `ids_confidence` | mejor similitud (0..1) de los matches aceptados |

## Instalación

```bash
npm install
cp .env.example .env   # completa credenciales (solo para uso local)
```

## Uso

```bash
node maintenance.js --self-test    # pruebas del parser/clasificador/dedup (sin BD)
DRY_RUN=true node maintenance.js   # simulación: informa pero no escribe
node maintenance.js                # ejecución real (los 6 pasos)
node maintenance.js --steps=2,3    # solo anti-fakes y purga de muertos
```

## GitHub Actions

1. Sube este proyecto como repo (o copia `.github/workflows/torrents-maintenance.yml`
   y `maintenance.js` + `package.json` + `package-lock.json` a la raíz de tu repo).
2. Define los **Secrets** del repositorio:
   - `SUPABASE_URL` — URL del proyecto Supabase.
   - `SUPABASE_SERVICE_ROLE_KEY` — Service Role Key (necesaria para `UPDATE`/`DELETE`).
   - `TMDB_API_KEY` — tu API key **privada** de [themoviedb.org](https://www.themoviedb.org/settings/api).
   > AniList, Kitsu, TVMaze e IMDb son públicos: no requieren secret.
3. El workflow corre **una vez al día** (cron `0 6 * * *` UTC) y admite
   ejecución manual (`workflow_dispatch`) con `dry_run` y `max_lookups`.
4. El job publica un resumen en la pestaña **Summary** de la ejecución.

## Variables de entorno

| Variable | Default | Descripción |
|----------|---------|-------------|
| `SUPABASE_URL` | — | **Requerida.** URL del proyecto. |
| `SUPABASE_SERVICE_ROLE_KEY` | — | **Requerida.** Service Role Key. |
| `TMDB_API_KEY` | — | API key privada de TMDB (único proveedor con clave). |
| `TABLE_NAME` | `torrents` | Tabla a mantener. |
| `DRY_RUN` | `false` | `true` = simulación sin escrituras. |
| `BATCH_SIZE` | `1000` | Páginas de escaneo. |
| `DELETE_CHUNK` | `500` | Ids por `DELETE ... IN (...)`. |
| `DEAD_TORRENT_DAYS` | `30` | Antigüedad para purgar muertos. |
| `ANIME_MIN_SIZE_MB` | `0` | Umbral de peso para anime (0 = off). |
| `MAX_LOOKUPS` | `400` | Tope de llamadas a APIs externas por run. |
| `MIN_SIMILARITY` | `0.5` | Similitud mínima para aceptar matches externos. |
| `TOP_N_PER_LANGUAGE` | `2` | Top N por idioma en el deduplicador. |
| `UPDATE_CONCURRENCY` | `8` | Updates concurrentes a Supabase. |
| `MAX_ID_ATTEMPTS` | `5` | Intentos máx. de enriquecimiento por fila. |
| `IDS_RETRY_HOURS` | `24` | Horas antes de reintentar una fila chequeada. |
| `HTTP_TIMEOUT_MS` | `15000` | Timeout duro por request a APIs externas. |
| `STEPS` / `--steps=` | *(vacío)* | Ejecutar solo algunos pasos (ej: `1,2,3`). |

## Decisiones de diseño

- **Sin falsos positivos léxicos**: el filtro adulto compara sobre texto
  normalizado (minúsculas/sin acentos) con bordes no alfanuméricos;
  "javascript" no matchea "jav" y "Sex Education" queda intacto.
- **`1920x1080` nunca es un episodio**: el patrón `1x09` exige bordes
  no numéricos.
- **Año de 4 dígitos prudente**: solo `1900–2029` se interpreta como año
  (así "Blade Runner 2049" no pierde su título).
- **Dual / Multi → grupo `spanish`**: incluyen audio castellano/latino.
  VOSE y Subtitulado también van a `spanish` (según especificación).
- **Deduplicación conservadora**: solo se elimina el excedente por encima de
  los 2 mejores de cada idioma dentro de la misma obra + temporada + episodio.
  Las filas sin ningún ID de obra se omiten (no se arriesga un falso match).
  Las copias de la misma obra se unifican aunque traigan IDs distintos gracias
  al mapa de alias (union-find) — p.ej. una copia con `imdb_id` y otra solo con
  `tmdb_id` acaban en el mismo grupo.
- **Pipeline a prueba de fallos**: cada paso corre aislado; si uno falla (p.ej.
  un corte de red en el enriquecedor) los demás continúan y el job termina con
  exit code ≠ 0 + informe del paso fallido. Para reintentar solo ese paso:
  `--steps=5` (o el input `steps_filter` del workflow).
- **Timeout duro por request** (`HTTP_TIMEOUT_MS`): un endpoint colgado no puede
  congelar el job hasta el timeout global del runner.
- **Nunca se sobrescriben IDs existentes** en el paso 5, y `updated_at` jamás
  se toca a mano (la purga de muertos depende de su semántica).
- **Rate-limit amable**: respeto de `Retry-After` ante 429, backoff ante 5xx,
  pausas por proveedor y caché por título limpio para no repetir búsquedas.
- **DRY_RUN** en todo el pipeline para probar contra producción sin miedo.
- **Alineado con tu esquema**: `imdb_id` siempre se normaliza a `^tt[0-9]+$`
  (CHECK), `kitsu_id`/`anilist_id`/`mal_id`/`tmdb_id` se guardan como `bigint`,
  `type` ∈ `movie|series|anime`, y se rellenan `release_group` / `quality` /
  `codec` / `hdr_format` desde el título sin pisar datos ya cargados.
- **Reintentos acotados vía `ids_*`**: cada intento queda registrado
  (`ids_checked_at`, `ids_attempts`, `ids_source`, `ids_confidence`) y una fila
  se abandona tras `MAX_ID_ATTEMPTS` intentos o se difiere `IDS_RETRY_HOURS`
  horas — el cron diario avanza incrementalmente sin martillear las APIs.

> Nota: el trigger `update_torrents_updated_at` refresca `updated_at` en cada
> UPDATE; como la purga de muertos corre en el paso 3 (antes de cualquier
> escritura) y las filas enriquecidas dejan de reintentarse, el efecto sobre
> la semántica de "muertos" es mínimo.

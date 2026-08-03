/// <reference path="../pb_data/types.d.ts" />
/**
 * Pipeline review + intake endpoints (PocketBase JSVM hooks).
 *
 * ⚠️ КЛЮЧЕВОЕ ОГРАНИЧЕНИЕ PocketBase JSVM (выстрадано отладкой):
 *   Каждый handler routerAdd выполняется в ОТДЕЛЬНОМ изолированном goja-рантайме
 *   и НЕ видит ничего из верхнего уровня файла — ни функций-хелперов, ни
 *   переменных, ни замыканий (даже `action` из forEach). Поэтому ВСЁ, что нужно
 *   обработчику, должно быть ОПИСАНО ВНУТРИ него. Доступны только инъецированные
 *   глобалы: $app, $dbx, $apis, Record, e, console, и т.п.
 *
 * Прочее, что выяснили про эту сборку:
 *   - record.getBool/getString паникуют на уровне Go → используем record.get(field).
 *   - findRecordsByFilter/findFirstRecordByFilter паникуют → используем
 *     $app.findAllRecords(collection, $dbx.hashExp({...})).
 *   - new BadRequestError/ForbiddenError ненадёжны → отвечаем e.json(status,{...}).
 *
 * Эндпоинты:
 *   GET  /api/pipeline/review
 *   POST /api/pipeline/review/{id}/approve
 *   POST /api/pipeline/review/{id}/reject
 *   POST /api/pipeline/review/{id}/note  {note}
 *   POST /api/pipeline/review/{id}/tags  {tags:[id,...]}
 *   GET  /api/pipeline/review/{id}/screenshot  (streams staged cover)
 *   POST /api/pipeline/submit  {source_url, type?}
 */

console.log("[pipeline] hook loaded: v8 (2026-05-21, fully inlined handlers)");

// ── GET /api/pipeline/review ────────────────────────────────────────────────
routerAdd("GET", "/api/pipeline/review", (e) => {
  console.log("[pipeline/review] hit; auth?", !!e.auth);
  const v = e.auth ? e.auth.get("isModerator") : null;
  if (!(v === true || v == true || v === 1 || String(v) === "true")) {
    return e.json(403, { message: "moderators only" });
  }
  try {
    const recs = $app.findAllRecords(
      "game_pipeline_state",
      $dbx.hashExp({ state: "awaiting_review" })
    );
    const n = recs ? recs.length : 0;
    console.log("[pipeline/review] found", n, "records");
    const items = [];
    for (let i = 0; i < n; i++) {
      const r = recs[i];
      let description = "";
      try {
        const data = r.get("data");
        description = (data && data.metadata && data.metadata.description) || "";
      } catch (_) {}

      // ── dedup verdict (baked at s06b, dedup v3) — surface so the moderator
      // doesn't approve a likely duplicate blindly. All reads guarded: the goja
      // handler runs isolated and a missing/typed field must never 500 the list.
      let reviewReasons = [];
      try {
        const rr = r.get("review_reasons");
        if (rr) { for (let j = 0; j < rr.length; j++) reviewReasons.push(String(rr[j])); }
      } catch (_) {}
      let dedupNote = "";
      try { dedupNote = r.get("dedup_note") || ""; } catch (_) {}
      let moderatorNote = "";
      try { moderatorNote = r.get("moderator_note") || ""; } catch (_) {}
      let dedupCandidate = "";
      try { dedupCandidate = r.get("dedup_candidate") || ""; } catch (_) {}
      let dedupCandidateTitle = "";
      if (dedupCandidate) {
        try {
          const g = $app.findRecordById("games", dedupCandidate);
          if (g) dedupCandidateTitle = g.get("title") || "";
        } catch (_) {}  // candidate may be gone — show the id, not a crash
      }

      // Cover screenshot filename (staged at s06b as game_pipeline_state.image).
      // The collection is superuser-only, so the browser can't fetch the file
      // directly — the /screenshot endpoint below streams it. We only pass the
      // filename so the frontend knows a screenshot exists.
      let image = "";
      try { image = r.get("image") || ""; } catch (_) {}

      // Resolved catalog tags (relation, staged at s06b). Expand to {id,name}
      // so the moderator sees + edits them with the shared tag selector.
      let tags = [];
      try {
        const tids = r.get("tags");
        if (tids) {
          for (let j = 0; j < tids.length; j++) {
            const tid = String(tids[j]);
            let name = tid;
            try { const t = $app.findRecordById("tags", tid); if (t) name = t.get("name") || tid; } catch (_) {}
            tags.push({ id: tid, name: name });
          }
        }
      } catch (_) {}

      // Original link the game was harvested from (source_url preferred).
      let sourceUrl = "";
      try { sourceUrl = r.get("source_url") || ""; } catch (_) {}
      let originalUrl = "";
      try { originalUrl = r.get("original_url") || ""; } catch (_) {}
      let nsfw = false;
      try { const nv = r.get("nsfw"); nsfw = (nv === true || nv == true || nv === 1 || String(nv) === "true"); } catch (_) {}

      // Community-предложение (/add-next): кто предложил — и флаг для сортировки,
      // такие игры модератор должен видеть в начале списка.
      let submitterUid = "";
      let submitter = "";
      try {
        submitterUid = String(r.get("submitted_by") || "");
        if (submitterUid) {
          const u = $app.findRecordById("users", submitterUid);
          if (u) submitter = String(u.get("name") || u.get("username") || "");
        }
      } catch (_) {}
      let created = "";
      try { created = String(r.get("created") || ""); } catch (_) {}

      items.push({
        id: r.id,
        slug: r.get("slug"),
        title: r.get("title"),
        author: r.get("author"),
        type: r.get("type"),
        hosted_url: r.get("hosted_url"),
        description: description,
        publish_mode: r.get("publish_mode") || "",
        review_reasons: reviewReasons,
        dedup_note: dedupNote,
        dedup_candidate: dedupCandidate,
        dedup_candidate_title: dedupCandidateTitle,
        moderator_note: moderatorNote,
        image: image,
        tags: tags,
        source_url: sourceUrl,
        original_url: originalUrl,
        nsfw: nsfw,
        community: submitterUid !== "",
        submitter: submitter,
        created: created,
      });
    }
    // Предложенное пользователями — в начало (внутри групп FIFO по created).
    items.sort(function (a, b) {
      if (a.community !== b.community) return a.community ? -1 : 1;
      return a.created < b.created ? -1 : 1;
    });
    return e.json(200, { items: items });
  } catch (err) {
    console.log("[pipeline/review] list failed —", String(err));
    return e.json(500, { message: "review list failed: " + String(err) });
  }
}, $apis.requireAuth());

// ── POST /api/pipeline/review/{id}/approve ───────────────────────────────────
routerAdd("POST", "/api/pipeline/review/{id}/approve", (e) => {
  console.log("[pipeline/approve] hit; auth?", !!e.auth);
  const v = e.auth ? e.auth.get("isModerator") : null;
  if (!(v === true || v == true || v === 1 || String(v) === "true")) {
    return e.json(403, { message: "moderators only" });
  }
  try {
    const id = e.request.pathValue("id");
    const recs = $app.findAllRecords("game_pipeline_state", $dbx.hashExp({ id: id }));
    const r = recs && recs.length ? recs[0] : null;
    if (!r) return e.json(404, { message: "record not found" });
    if (r.get("state") !== "awaiting_review") {
      return e.json(400, { message: "game is not awaiting review (state=" + r.get("state") + ")" });
    }
    r.set("state", "approved");
    $app.save(r);
    console.log("[pipeline/approve]", r.get("slug"), "-> approved");
    return e.json(200, { ok: true, state: "approved" });
  } catch (err) {
    console.log("[pipeline/approve] failed —", String(err));
    return e.json(500, { message: "approve failed: " + String(err) });
  }
}, $apis.requireAuth());

// ── POST /api/pipeline/review/{id}/reject ────────────────────────────────────
routerAdd("POST", "/api/pipeline/review/{id}/reject", (e) => {
  console.log("[pipeline/reject] hit; auth?", !!e.auth);
  const v = e.auth ? e.auth.get("isModerator") : null;
  if (!(v === true || v == true || v === 1 || String(v) === "true")) {
    return e.json(403, { message: "moderators only" });
  }
  try {
    const id = e.request.pathValue("id");
    const recs = $app.findAllRecords("game_pipeline_state", $dbx.hashExp({ id: id }));
    const r = recs && recs.length ? recs[0] : null;
    if (!r) return e.json(404, { message: "record not found" });
    if (r.get("state") !== "awaiting_review") {
      return e.json(400, { message: "game is not awaiting review (state=" + r.get("state") + ")" });
    }
    r.set("state", "rejected");
    $app.save(r);
    console.log("[pipeline/reject]", r.get("slug"), "-> rejected");
    return e.json(200, { ok: true, state: "rejected" });
  } catch (err) {
    console.log("[pipeline/reject] failed —", String(err));
    return e.json(500, { message: "reject failed: " + String(err) });
  }
}, $apis.requireAuth());

// ── POST /api/pipeline/review/{id}/note ──────────────────────────────────────
// Save a moderator's free-text note on the queue row (dedup v3). Lets the author
// later audit another human moderator's calls. Independent of approve/reject so
// a note can be left without changing state.
routerAdd("POST", "/api/pipeline/review/{id}/note", (e) => {
  const v = e.auth ? e.auth.get("isModerator") : null;
  if (!(v === true || v == true || v === 1 || String(v) === "true")) {
    return e.json(403, { message: "moderators only" });
  }
  try {
    const id = e.request.pathValue("id");
    let note = "";
    try { const body = e.requestInfo().body; note = (body && body.note) || ""; } catch (_) {}
    const recs = $app.findAllRecords("game_pipeline_state", $dbx.hashExp({ id: id }));
    const r = recs && recs.length ? recs[0] : null;
    if (!r) return e.json(404, { message: "record not found" });
    r.set("moderator_note", String(note));
    $app.save(r);
    console.log("[pipeline/note]", r.get("slug"), "note saved");
    return e.json(200, { ok: true, moderator_note: String(note) });
  } catch (err) {
    console.log("[pipeline/note] failed —", String(err));
    return e.json(500, { message: "note save failed: " + String(err) });
  }
}, $apis.requireAuth());

// ── POST /api/pipeline/review/{id}/tags ──────────────────────────────────────
// Replace the staged tag set on the queue row. These are the catalog `tags`
// relation ids; publication_queue.go copies them onto games at publish, so
// fixing tags here fixes the published card. Body: { tags: [id, ...] }.
routerAdd("POST", "/api/pipeline/review/{id}/tags", (e) => {
  const v = e.auth ? e.auth.get("isModerator") : null;
  if (!(v === true || v == true || v === 1 || String(v) === "true")) {
    return e.json(403, { message: "moderators only" });
  }
  try {
    const id = e.request.pathValue("id");
    let tagIds = [];
    try {
      const body = e.requestInfo().body;
      const raw = body && body.tags;
      if (raw) { for (let i = 0; i < raw.length; i++) tagIds.push(String(raw[i])); }
    } catch (_) {}
    const recs = $app.findAllRecords("game_pipeline_state", $dbx.hashExp({ id: id }));
    const r = recs && recs.length ? recs[0] : null;
    if (!r) return e.json(404, { message: "record not found" });
    r.set("tags", tagIds);
    $app.save(r);
    console.log("[pipeline/tags]", r.get("slug"), "tags saved:", tagIds.length);
    return e.json(200, { ok: true, tags: tagIds });
  } catch (err) {
    console.log("[pipeline/tags] failed —", String(err));
    return e.json(500, { message: "tags save failed: " + String(err) });
  }
}, $apis.requireAuth());

// ── GET /api/pipeline/review/{id}/screenshot ─────────────────────────────────
// Stream the staged cover screenshot (game_pipeline_state.image). The collection
// is superuser-only, so moderators (regular authed users) can't read the file
// via /api/files — we proxy it here after the isModerator check, reading it with
// the app's own filesystem. Fetched with an Authorization header (authedFetch),
// so it can't be a plain <img src>; the frontend turns the blob into an objectURL.
routerAdd("GET", "/api/pipeline/review/{id}/screenshot", (e) => {
  const v = e.auth ? e.auth.get("isModerator") : null;
  if (!(v === true || v == true || v === 1 || String(v) === "true")) {
    return e.json(403, { message: "moderators only" });
  }
  try {
    const id = e.request.pathValue("id");
    const recs = $app.findAllRecords("game_pipeline_state", $dbx.hashExp({ id: id }));
    const r = recs && recs.length ? recs[0] : null;
    if (!r) return e.json(404, { message: "record not found" });
    const filename = r.get("image");
    if (!filename) return e.json(404, { message: "no screenshot staged" });

    const fsys = $app.newFilesystem();
    try {
      const fileKey = r.baseFilesPath() + "/" + filename;
      const reader = fsys.getReader(fileKey);
      // .webp cover in practice; fall back generically on odd names.
      const ct = /\.png$/i.test(filename) ? "image/png"
        : /\.jpe?g$/i.test(filename) ? "image/jpeg"
        : "image/webp";
      e.stream(200, ct, reader);
    } finally {
      try { fsys.close(); } catch (_) {}
    }
    return;
  } catch (err) {
    console.log("[pipeline/screenshot] failed —", String(err));
    return e.json(500, { message: "screenshot failed: " + String(err) });
  }
}, $apis.requireAuth());

// ── POST /api/pipeline/submit ────────────────────────────────────────────────
// Открыт для всех залогиненных (страница /add-next). Модератор → сразу "queued";
// обычный юзер → "suggested" (ручной гейт автора в /moderator/suggestions),
// лимит 10 ссылок/сутки. Дедуп: очередь пайплайна + каталог (original_link /
// iframe_url). Требует поля схемы: state+="suggested", submitted_by (relation→users).
routerAdd("POST", "/api/pipeline/submit", (e) => {
  console.log("[pipeline/submit] hit; auth?", !!e.auth);
  if (!e.auth) return e.json(401, { message: "login required" });
  const v = e.auth.get("isModerator");
  const isMod = (v === true || v == true || v === 1 || String(v) === "true");
  try {
    const body = (e.requestInfo() && e.requestInfo().body) || {};
    const url = String(body.source_url || "").trim();
    const kind = String(body.kind || "") === "static" ? "static" : "interactive";
    // Галочка «оригинальная игра» (автор выкладывает свою новинку, не репост).
    // В multipart значения приходят строками — нормализуем.
    const original = body.original === true || body.original === "true" || body.original === "1";
    console.log("[pipeline/submit] url =", url, "kind =", kind, "orig?", original, "mod?", isMod);

    // Статика: либо imgchest-ссылка, либо multipart-пачка картинок в поле
    // "pages" (лягут в cyoa_pages записи — воркер скачает их оттуда).
    // ~95MB суммарно: Cloudflare режет тела запросов около 100MB.
    let pages = [];
    if (kind === "static") {
      try { pages = e.findUploadedFiles("pages") || []; } catch (_) { pages = []; }
      if (pages.length) {
        if (pages.length > 100) {
          return e.json(400, { message: "Too many images (max 100). Upload the pack to imgchest.com and paste the link instead." });
        }
        let totalBytes = 0;
        for (let i = 0; i < pages.length; i++) {
          try { totalBytes += pages[i].size || 0; } catch (_) {}
        }
        if (totalBytes > 95 * 1024 * 1024) {
          return e.json(400, { message: "Upload too big (~95 MB max total). Upload the pack to imgchest.com and paste the link instead." });
        }
      } else {
        const ih = url.match(/^https?:\/\/([^/:?#]+)/i);
        const ihost = ih ? ih[1].toLowerCase() : "";
        if (!(ihost === "imgchest.com" || ihost.slice(-14) === ".imgchest.com")) {
          return e.json(400, { message: "For a static CYOA paste an imgchest.com link or attach the page images." });
        }
      }
    }
    // У upload-заявки ссылки может не быть — все URL-проверки/дедупы только при её наличии.
    const hasUrl = !!url;

    if (hasUrl || kind !== "static") {
      if (!/^https?:\/\//i.test(url) || url.length > 2000) {
        return e.json(400, { message: "Please paste a valid http(s) link." });
      }
      // Дичь на входе: пайплайн ходит по этим URL ночью — локалхост/сырые IP режем.
      const hm = url.match(/^https?:\/\/([^/:?#]+)/i);
      const rawHost = hm ? hm[1].toLowerCase() : "";
      if (!rawHost || rawHost.indexOf(".") === -1 || rawHost === "localhost" ||
          rawHost.slice(-6) === ".local" || /^[0-9.]+$/.test(rawHost) || rawHost.indexOf("[") !== -1) {
        return e.json(400, { message: "That link doesn't look like a public website URL." });
      }
    }

    // Канонизация как в state_pb._canonical_url: снять wayback-префикс, срезать
    // query/fragment и dir/index.html, убрать хвостовой слэш. Регистр ПУТИ
    // сохраняем (neocities регистрозависим) — воркер потом перезапишет
    // original_url тем же алгоритмом, формы обязаны совпасть.
    let canon = url.replace(/^https?:\/\/web\.archive\.org\/web\/[^/]+\//i, "");
    canon = canon.replace(/[#?].*$/, "");
    canon = canon.replace(/\/index\.(html?|php|aspx?)$/i, "");
    canon = canon.replace(/\/+$/, "");
    canon = canon.replace(/^(https?:\/\/[^/]+)/i, function (mm) { return mm.toLowerCase(); });

    // 1) дедуп против очереди пайплайна (LOWER с обеих сторон: старые записи
    // могли сохранить другой регистр пути). Upload-заявка без URL дедупится
    // позже по title на review-гейте (s06b static dedup) — тут нечем.
    let dup = null;
    if (hasUrl) try {
      const dups = $app.findAllRecords(
        "game_pipeline_state",
        $dbx.exp(
          "LOWER(original_url) = {:c} OR LOWER(RTRIM(source_url, '/')) = {:c}",
          { c: canon.toLowerCase() }
        )
      );
      dup = dups && dups.length ? dups[0] : null;
    } catch (_) { dup = null; }
    if (dup) {
      const dstate = String(dup.get("state") || "");
      console.log("[pipeline/submit] duplicate (queue, state=" + dstate + ") ->", dup.get("slug"));
      let gameId = "";
      try { gameId = String(dup.get("game") || ""); } catch (_) {}
      if (dstate === "published" && gameId) {
        return e.json(200, { ok: true, duplicate: true, where: "catalog", game_id: gameId, slug: dup.get("slug") });
      }
      if (dstate === "dismissed" || dstate === "rejected") {
        // уже смотрели и осознанно отклонили — не молчать «в очереди», а сказать честно
        return e.json(200, { ok: true, duplicate: true, where: "declined", slug: dup.get("slug") });
      }
      return e.json(200, { ok: true, duplicate: true, where: "queue", slug: dup.get("slug") });
    }

    // 2) дедуп против каталога: games.original_link / games.iframe_url.
    // Ищем по хвосту без схемы (host/path), LIKE с экранированием % и _.
    if (hasUrl) try {
      const needle = canon.replace(/^https?:\/\//, "").replace(/([%_\\])/g, "\\$1");
      const gdups = $app.findAllRecords(
        "games",
        $dbx.exp(
          "LOWER(original_link) LIKE {:p} ESCAPE '\\' OR LOWER(iframe_url) LIKE {:p} ESCAPE '\\'",
          { p: "%" + needle + "%" }
        )
      );
      if (gdups && gdups.length) {
        console.log("[pipeline/submit] duplicate (catalog) ->", gdups[0].id);
        return e.json(200, {
          ok: true, duplicate: true, where: "catalog",
          game_id: gdups[0].id, title: gdups[0].get("title") || "",
        });
      }
    } catch (err) {
      console.log("[pipeline/submit] catalog dedup skipped —", String(err));
    }

    // 3) rate-limit для обычных юзеров: 10 ссылок в сутки (UTC)
    if (!isMod) {
      try {
        const mine = $app.findAllRecords(
          "game_pipeline_state", $dbx.hashExp({ submitted_by: e.auth.id })
        );
        const today = (new Date()).toISOString().slice(0, 10);
        let n = 0;
        for (let i = 0; i < mine.length; i++) {
          try {
            if (String(mine[i].get("created")).slice(0, 10) === today) n++;
          } catch (_) {}
        }
        if (n >= 10) {
          return e.json(429, { message: "Daily limit reached (10 links per day). Come back tomorrow!" });
        }
      } catch (err) {
        console.log("[pipeline/submit] rate-limit check failed —", String(err));
      }
    }

    // slug из URL (host + последний сегмент пути). goja НЕ имеет URL — парсим
    // регэкспом. У upload-заявки URL нет — slug из имени первого файла.
    let slugBase;
    if (hasUrl) {
      const m = url.match(/^https?:\/\/([^/]+)(\/[^?#]*)?/i);
      const hostname = m ? m[1] : "site";
      const pathname = m && m[2] ? m[2] : "/";
      const host = hostname.split(".")[0] || "site";
      const segs = pathname.split("/").filter(function (s) { return s; });
      const last = segs.length ? segs[segs.length - 1] : "root";
      slugBase = (host + "__" + last)
        .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
    } else {
      let fn = "pack";
      try { fn = String(pages[0].originalName || pages[0].name || "pack"); } catch (_) {}
      slugBase = ("upload__" + fn.replace(/\.[a-z0-9]+$/i, ""))
        .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "upload--pack";
    }

    // slug уникален в схеме: разные URL могут дать один host+last-segment,
    // save() тогда 500-ит. Подбираем свободный суффикс.
    let slug = slugBase;
    try {
      for (let i = 2; i <= 50; i++) {
        const taken = $app.findAllRecords("game_pipeline_state", $dbx.hashExp({ slug: slug }));
        if (!taken || !taken.length) break;
        slug = slugBase + "-" + i;
      }
    } catch (_) {}

    // Рейтинг = теги каталога: SFW/Ecchi/NSFW/Extreme. Пусто = "not sure"
    // (старые клиенты). Храним в канонном регистре тегов.
    const RATINGS = { SFW: "SFW", ECCHI: "Ecchi", NSFW: "NSFW", EXTREME: "Extreme" };
    const type = String(body.type || "").toUpperCase();
    const normType = RATINGS[type] || "";
    const note = String(body.note || "").slice(0, 500);

    const state = isMod ? "queued" : "suggested";
    // upload-заявка: псевдо-URL, чтобы unique-индекс original_url не коллизил
    // на пустых строках; slug уникален → уникален и псевдо-URL.
    const srcUrl = hasUrl ? url : "upload://" + slug;
    const srcCanon = hasUrl ? canon : "upload://" + slug;
    const col = $app.findCollectionByNameOrId("game_pipeline_state");
    const r = new Record(col);
    r.set("slug", slug);
    r.set("source_url", srcUrl);
    r.set("original_url", srcCanon);
    r.set("state", state);
    r.set("type", normType);
    r.set("error", "");
    r.set("submitted_by", e.auth.id);
    if (pages.length) r.set("cyoa_pages", pages);
    r.set("data", {
      source_url: srcUrl, kind: kind, type: normType, state: state, original: original,
      submitted_via: pages.length ? "form-upload" : "form", user_note: note,
    });
    $app.save(r);
    console.log("[pipeline/submit] created", slug, "state=", state);
    // id нужен фронту для дозагрузки страниц частями (submit/{id}/pages) —
    // так пачка картинок обходит ~100MB-лимит Cloudflare на ОДИН запрос.
    return e.json(200, { ok: true, id: r.id, slug: slug, state: state });
  } catch (err) {
    console.log("[pipeline/submit] failed —", String(err));
    return e.json(500, { message: "submit failed: " + String(err) });
  }
}, $apis.requireAuth());

// ── POST /api/pipeline/submit/{id}/pages ─────────────────────────────────────
// Дозагрузка страниц static-заявки частями: Cloudflare режет тела запросов
// ~100MB, поэтому фронт шлёт пачку картинок батчами. Первый батч создаёт
// запись через /submit, остальные append'ятся сюда ("cyoa_pages+").
// Только владелец заявки, только пока она в suggested (до модер-гейта).
routerAdd("POST", "/api/pipeline/submit/{id}/pages", (e) => {
  if (!e.auth) return e.json(401, { message: "login required" });
  try {
    const id = e.request.pathValue("id");
    let r = null;
    try { r = $app.findRecordById("game_pipeline_state", id); } catch (_) {}
    if (!r) return e.json(404, { message: "submission not found" });
    if (String(r.get("submitted_by")) !== String(e.auth.id)) {
      return e.json(403, { message: "not your submission" });
    }
    if (String(r.get("state")) !== "suggested") {
      return e.json(409, { message: "submission is already being processed" });
    }
    let pages = [];
    try { pages = e.findUploadedFiles("pages") || []; } catch (_) { pages = []; }
    if (!pages.length) return e.json(400, { message: "no images in this batch" });
    const existing = r.get("cyoa_pages") || [];
    const have = Array.isArray(existing) ? existing.length : (existing ? 1 : 0);
    if (have + pages.length > 300) {
      return e.json(400, { message: "too many pages (max 300 total)" });
    }
    r.set("cyoa_pages+", pages);
    $app.save(r);
    const total = (r.get("cyoa_pages") || []).length;
    console.log("[pipeline/submit-pages]", r.get("slug"), "+", pages.length, "=", total);
    return e.json(200, { ok: true, pages: total });
  } catch (err) {
    console.log("[pipeline/submit-pages] failed —", String(err));
    return e.json(500, { message: "append failed: " + String(err) });
  }
}, $apis.requireAuth());

// ── GET /api/pipeline/my-submissions ─────────────────────────────────────────
// Ссылки текущего юзера + публичный статус (внутренние state наружу не отдаём).
routerAdd("GET", "/api/pipeline/my-submissions", (e) => {
  if (!e.auth) return e.json(401, { message: "login required" });
  try {
    let recs = [];
    try {
      recs = $app.findAllRecords("game_pipeline_state", $dbx.hashExp({ submitted_by: e.auth.id }));
    } catch (_) { recs = []; }
    const items = [];
    for (let i = 0; i < recs.length; i++) {
      const r = recs[i];
      const st = String(r.get("state") || "");
      let status = "processing";
      if (st === "suggested") status = "pending";
      else if (st === "queued") status = "queued";
      else if (st === "awaiting_review" || st === "approved") status = "review";
      else if (st === "published") status = "published";
      else if (st === "failed") status = "failed";
      else if (st === "dismissed" || st === "rejected") status = "declined";
      let detail = "";
      try { detail = String(r.get("moderator_note") || ""); } catch (_) {}
      let gameId = "";
      try { gameId = String(r.get("game") || ""); } catch (_) {}
      let created = "";
      try { created = String(r.get("created") || ""); } catch (_) {}
      items.push({
        id: r.id,
        url: r.get("source_url") || "",
        title: r.get("title") || "",
        status: status,
        detail: detail,
        game_id: gameId,
        created: created,
      });
    }
    items.sort(function (a, b) { return a.created < b.created ? 1 : -1; });
    return e.json(200, { items: items });
  } catch (err) {
    console.log("[pipeline/my-submissions] failed —", String(err));
    return e.json(500, { message: "failed: " + String(err) });
  }
}, $apis.requireAuth());

// ── GET /api/pipeline/suggestions/public ─────────────────────────────────────
// Публичная лента ОЧЕРЕДИ СООБЩЕСТВА (submitted_by != "", без имён приславших).
// Раньше count считал весь пайплайн (420+ ночного харвеста) при списке из 100 —
// цифра и список расходились. Теперь count = только предложенное людьми;
// общий бэклог сайта уезжает отдельным числом pipeline_total.
routerAdd("GET", "/api/pipeline/suggestions/public", (e) => {
  try {
    const IN_FLIGHT = "state IN ('suggested','queued','downloaded','parsed','optimized','described','screenshotted','uploaded','awaiting_review','approved')";
    let recs = [];
    try {
      recs = $app.findAllRecords(
        "game_pipeline_state",
        $dbx.exp(IN_FLIGHT + " AND submitted_by != ''")
      );
    } catch (_) { recs = []; }
    let pipelineTotal = 0;
    try {
      const all = $app.findAllRecords("game_pipeline_state", $dbx.exp(IN_FLIGHT));
      pipelineTotal = all ? all.length : 0;
    } catch (_) {}
    const items = [];
    for (let i = 0; i < recs.length; i++) {
      const r = recs[i];
      const st = String(r.get("state") || "");
      let status = "processing";
      if (st === "suggested") status = "pending";
      else if (st === "queued") status = "queued";
      else if (st === "awaiting_review" || st === "approved") status = "review";
      let created = "";
      try { created = String(r.get("created") || ""); } catch (_) {}
      items.push({
        title: r.get("title") || "",
        url: r.get("source_url") || "",
        status: status,
        created: created,
      });
    }
    items.sort(function (a, b) { return a.created < b.created ? 1 : -1; });
    return e.json(200, {
      count: items.length,
      items: items.slice(0, 50),
      pipeline_total: pipelineTotal,
    });
  } catch (err) {
    console.log("[pipeline/suggestions/public] failed —", String(err));
    return e.json(500, { message: "failed: " + String(err) });
  }
});

// ── GET /api/pipeline/suggestions ────────────────────────────────────────────
// Модераторский список предложенных ссылок (state=suggested) на ручной гейт.
routerAdd("GET", "/api/pipeline/suggestions", (e) => {
  const v = e.auth ? e.auth.get("isModerator") : null;
  if (!(v === true || v == true || v === 1 || String(v) === "true")) {
    return e.json(403, { message: "moderators only" });
  }
  try {
    let recs = [];
    try {
      recs = $app.findAllRecords("game_pipeline_state", $dbx.hashExp({ state: "suggested" }));
    } catch (_) { recs = []; }
    const items = [];
    for (let i = 0; i < recs.length; i++) {
      const r = recs[i];
      let submitter = "";
      try {
        const uid = String(r.get("submitted_by") || "");
        if (uid) {
          const u = $app.findRecordById("users", uid);
          if (u) submitter = String(u.get("name") || u.get("username") || "");
        }
      } catch (_) {}
      let note = "";
      let modNote = "";
      let isOriginal = false;
      let dataKind = "";
      try {
        const raw = r.get("data");
        if (raw) {
          // json-поле приходит как types.JSONRaw ([]byte): String(raw) даёт текст.
          // JSON.parse(JSON.stringify(raw)) на байтах ломается — не использовать.
          let d = null;
          try { d = JSON.parse(String(raw)); } catch (_) {}
          if (!d && typeof raw === "object") d = raw;
          note = String((d && d.user_note) || "");
          modNote = String((d && d.mod_note) || "");
          isOriginal = !!(d && d.original);
          dataKind = String((d && d.kind) || "");
        }
      } catch (_) {}
      let created = "";
      try { created = String(r.get("created") || ""); } catch (_) {}

      // Подсказка «возможный дубль в каталоге» — тот же LIKE-чек, что на submit.
      // Обычно submit такое режет сам, но каталог мог пополниться после
      // предложения (гонка с ночным конвейером) — модератору видно сразу.
      let dupGameId = "";
      let dupGameTitle = "";
      try {
        const canonTail = String(r.get("original_url") || "")
          .replace(/^https?:\/\//, "").toLowerCase();
        if (canonTail) {
          const needle = canonTail.replace(/([%_\\])/g, "\\$1");
          const gdups = $app.findAllRecords(
            "games",
            $dbx.exp(
              "LOWER(original_link) LIKE {:p} ESCAPE '\\' OR LOWER(iframe_url) LIKE {:p} ESCAPE '\\'",
              { p: "%" + needle + "%" }
            )
          );
          if (gdups && gdups.length) {
            dupGameId = gdups[0].id;
            dupGameTitle = String(gdups[0].get("title") || "");
          }
        }
      } catch (_) {}

      items.push({
        id: r.id,
        slug: r.get("slug") || "",
        url: r.get("source_url") || "",
        type: r.get("type") || "",
        note: note,
        mod_note: modNote,
        original: isOriginal,
        kind: dataKind,
        submitter: submitter,
        created: created,
        dup_game_id: dupGameId,
        dup_game_title: dupGameTitle,
      });
    }
    // Инбокс модератора: старые сверху (FIFO — кто раньше предложил, того раньше смотрят).
    items.sort(function (a, b) { return a.created < b.created ? -1 : 1; });
    return e.json(200, { items: items });
  } catch (err) {
    console.log("[pipeline/suggestions] failed —", String(err));
    return e.json(500, { message: "failed: " + String(err) });
  }
}, $apis.requireAuth());

// ── POST /api/pipeline/suggestions/{id}/approve ──────────────────────────────
// suggested → queued (ночной воркер подхватит).
routerAdd("POST", "/api/pipeline/suggestions/{id}/approve", (e) => {
  const v = e.auth ? e.auth.get("isModerator") : null;
  if (!(v === true || v == true || v === 1 || String(v) === "true")) {
    return e.json(403, { message: "moderators only" });
  }
  try {
    const id = e.request.pathValue("id");
    const recs = $app.findAllRecords("game_pipeline_state", $dbx.hashExp({ id: id }));
    const r = recs && recs.length ? recs[0] : null;
    if (!r) return e.json(404, { message: "record not found" });
    if (String(r.get("state")) !== "suggested") {
      return e.json(400, { message: "not a pending suggestion (state=" + r.get("state") + ")" });
    }
    r.set("state", "queued");
    // data.state — косметическое зеркало; чиним best-effort, не падаем.
    // json-поле = types.JSONRaw ([]byte): парсим через String(raw); если разбор
    // не удался — data НЕ трогаем (кривой r.set затёр бы source_url и note).
    try {
      const raw = r.get("data");
      let d = null;
      try { d = JSON.parse(String(raw)); } catch (_) {}
      if (!d && raw && typeof raw === "object" && !Array.isArray(raw)) d = raw;
      if (d && typeof d === "object" && !Array.isArray(d)) {
        d.state = "queued";
        r.set("data", d);
      }
    } catch (_) {}
    $app.save(r);
    console.log("[pipeline/suggestions/approve]", r.get("slug"), "-> queued");
    return e.json(200, { ok: true, state: "queued" });
  } catch (err) {
    console.log("[pipeline/suggestions/approve] failed —", String(err));
    return e.json(500, { message: "approve failed: " + String(err) });
  }
}, $apis.requireAuth());

// ── POST /api/pipeline/suggestions/{id}/decline ──────────────────────────────
// suggested → dismissed; причина в moderator_note (уезжает юзеру в my-submissions).
routerAdd("POST", "/api/pipeline/suggestions/{id}/decline", (e) => {
  const v = e.auth ? e.auth.get("isModerator") : null;
  if (!(v === true || v == true || v === 1 || String(v) === "true")) {
    return e.json(403, { message: "moderators only" });
  }
  try {
    const id = e.request.pathValue("id");
    let reason = "";
    try { const body = e.requestInfo().body; reason = String((body && body.reason) || ""); } catch (_) {}
    const recs = $app.findAllRecords("game_pipeline_state", $dbx.hashExp({ id: id }));
    const r = recs && recs.length ? recs[0] : null;
    if (!r) return e.json(404, { message: "record not found" });
    if (String(r.get("state")) !== "suggested") {
      return e.json(400, { message: "not a pending suggestion (state=" + r.get("state") + ")" });
    }
    r.set("state", "dismissed");
    if (reason) r.set("moderator_note", reason.slice(0, 500));
    $app.save(r);
    console.log("[pipeline/suggestions/decline]", r.get("slug"), "-> dismissed");
    return e.json(200, { ok: true, state: "dismissed" });
  } catch (err) {
    console.log("[pipeline/suggestions/decline] failed —", String(err));
    return e.json(500, { message: "decline failed: " + String(err) });
  }
}, $apis.requireAuth());

// ── POST /api/pipeline/suggestions/{id}/update ───────────────────────────────
// Модератор правит классификацию прямо в инбоксе, ДО апрува:
//   • type      — рейтинг (SFW/Ecchi/NSFW/Extreme), едет в тег+nsfw-гейт (s06b).
//   • original  — «Fresh» (авторский релиз) → data.original → games.original_release.
//   • mod_note  — приватная заметка НОЧНОМУ АГЕНТУ, живёт в data (НЕ moderator_note:
//     то уезжает сабмиттеру в my-submissions). Едет с игрой по пайплайну.
// Схему PB не трогаем — всё в существующих полях type + data(JSON).
routerAdd("POST", "/api/pipeline/suggestions/{id}/update", (e) => {
  const v = e.auth ? e.auth.get("isModerator") : null;
  if (!(v === true || v == true || v === 1 || String(v) === "true")) {
    return e.json(403, { message: "moderators only" });
  }
  try {
    const id = e.request.pathValue("id");
    let body = {};
    try { body = e.requestInfo().body || {}; } catch (_) {}
    const recs = $app.findAllRecords("game_pipeline_state", $dbx.hashExp({ id: id }));
    const r = recs && recs.length ? recs[0] : null;
    if (!r) return e.json(404, { message: "record not found" });
    if (String(r.get("state")) !== "suggested") {
      return e.json(400, { message: "not a pending suggestion (state=" + r.get("state") + ")" });
    }

    // Рейтинг: одно из 4 канонических значений (см. s06b_review_gate ratings).
    let newType = "";
    if (typeof body.type === "string" && body.type) {
      const RATINGS = ["SFW", "Ecchi", "NSFW", "Extreme"];
      for (let i = 0; i < RATINGS.length; i++) {
        if (RATINGS[i].toUpperCase() === body.type.toUpperCase()) { newType = RATINGS[i]; break; }
      }
      if (!newType) return e.json(400, { message: "bad type (SFW/Ecchi/NSFW/Extreme)" });
    }

    // Правки едут в data(JSON) + денормализованную колонку type. Пайплайн грузит
    // entry из data, но колонка type ∈ _PROMOTED и имеет приоритет (state_pb),
    // а queue_audit читает data.type напрямую — держим оба в синхроне (как submit).
    // Разбор JSONRaw тем же безопасным способом, что и approve (кривой r.set затёр
    // бы source_url/user_note).
    const hasOrig = Object.prototype.hasOwnProperty.call(body, "original");
    const hasNote = Object.prototype.hasOwnProperty.call(body, "mod_note");
    if (newType || hasOrig || hasNote) {
      let d = null;
      try {
        const raw = r.get("data");
        try { d = JSON.parse(String(raw)); } catch (_) {}
        if (!d && raw && typeof raw === "object" && !Array.isArray(raw)) d = raw;
      } catch (_) {}
      if (!d || typeof d !== "object" || Array.isArray(d)) d = {};
      if (newType) { d.type = newType; r.set("type", newType); }
      if (hasOrig) d.original = (body.original === true || body.original === "true" || body.original === 1);
      if (hasNote) d.mod_note = String(body.mod_note || "").slice(0, 1000);
      r.set("data", d);
    }

    $app.save(r);

    // Отдаём актуальное состояние обратно панели (перечитываем data).
    let outOrig = false, outNote = "";
    try {
      const raw2 = r.get("data");
      let d2 = null;
      try { d2 = JSON.parse(String(raw2)); } catch (_) {}
      if (!d2 && raw2 && typeof raw2 === "object") d2 = raw2;
      if (d2) { outOrig = !!d2.original; outNote = String(d2.mod_note || ""); }
    } catch (_) {}
    console.log("[pipeline/suggestions/update]", r.get("slug"), "type=", r.get("type"), "orig=", outOrig, "note?", outNote ? "y" : "n");
    return e.json(200, { ok: true, type: r.get("type") || "", original: outOrig, mod_note: outNote });
  } catch (err) {
    console.log("[pipeline/suggestions/update] failed —", String(err));
    return e.json(500, { message: "update failed: " + String(err) });
  }
}, $apis.requireAuth());

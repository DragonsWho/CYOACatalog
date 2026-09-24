// Pipeline review + intake endpoints (PocketBase JSVM). ⚠️ JSVM ISOLATION (learned the hard way):
// every routerAdd handler runs in its OWN goja runtime and sees NOTHING from file top level — no
// helpers, vars, or closures (not even `action` from a forEach). Everything a handler needs must be
// defined INSIDE it; only injected globals ($app, $dbx, $apis, Record, e, console…) exist. Also in
// this build: record.getBool/getString panic at Go level → use record.get(field);
// findRecordsByFilter/findFirstRecordByFilter panic → use $app.findAllRecords(collection,
// $dbx.hashExp({...})); new BadRequestError/ForbiddenError unreliable → answer
// e.json(status,{...}).

/// <reference path="../pb_data/types.d.ts" />

console.log("[pipeline] hook loaded: v10 (2026-09-24, /meta open to queue perm)");

routerAdd("GET", "/api/pipeline/review", (e) => {
  console.log("[pipeline/review] hit; auth?", !!e.auth);
  const v = e.auth ? e.auth.get("isModerator") : null;
  if (!(v === true || v == true || v === 1 || String(v) === "true")) {
    return e.json(403, { message: "moderators only" });
  }
  // `review` permission (registry: mod_perms.go). No row → legacy full access. Inlined on purpose:
  // JSVM isolates can't see shared helpers.
  try {
    const pr = $app.findFirstRecordByFilter(
      "mod_permissions", "user = {:u}", { u: e.auth.id });
    if (pr) {
      // TRAP: the json field arrives as raw types.JSONRaw (no .length), not an array. Read via
      // string + JSON.parse; if parsing fails, allow — don't lock a person out over field format.
      let list = null;
      try {
        const parsed = JSON.parse(String(pr.get("perms")));
        if (parsed && parsed.length !== undefined) list = parsed;
      } catch (parseErr) {
        list = null;
      }
      if (list) {
        let allowed = false;
        for (let i = 0; i < list.length; i++) {
          if (list[i] === "*" || list[i] === "review") allowed = true;
        }
        if (!allowed) return e.json(403, { message: "no \"review\" permission" });
      }
    }
  } catch (permErr) {
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

      // Dedup verdict (baked at s06b) shown so the moderator doesn't blindly approve a likely
      // duplicate. All reads guarded: a missing/typed field must never 500 the list.
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
        } catch (_) {}
      }

      // game_pipeline_state is superuser-only, so the browser can't fetch the file; /screenshot
      // below streams it. Only the filename is passed.
      let image = "";
      try { image = r.get("image") || ""; } catch (_) {}

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

      // `authors` relation is the source of truth; text `author` stays for list search and rows
      // without the relation yet.
      let authors = [];
      try {
        const aids = r.get("authors");
        if (aids) {
          for (let j = 0; j < aids.length; j++) {
            const aid = String(aids[j]);
            let name = aid;
            try { const a = $app.findRecordById("authors", aid); if (a) name = a.get("name") || aid; } catch (_) {}
            authors.push({ id: aid, name: name });
          }
        }
      } catch (_) {}

      // `aliases` may not exist in game_pipeline_state yet (added by the author by hand) →
      // has_aliases:false and the frontend hides the input instead of silently losing typed text.
      let aliases = "";
      let hasAliases = false;
      try {
        const av = r.get("aliases");
        if (av !== undefined) { hasAliases = true; aliases = String(av || ""); }
      } catch (_) {}

      let sourceUrl = "";
      try { sourceUrl = r.get("source_url") || ""; } catch (_) {}
      let originalUrl = "";
      try { originalUrl = r.get("original_url") || ""; } catch (_) {}
      let nsfw = false;
      try { const nv = r.get("nsfw"); nsfw = (nv === true || nv == true || nv === 1 || String(nv) === "true"); } catch (_) {}

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
        authors: authors,
        aliases: aliases,
        has_aliases: hasAliases,
        source_url: sourceUrl,
        original_url: originalUrl,
        nsfw: nsfw,
        community: submitterUid !== "",
        submitter: submitter,
        created: created,
      });
    }
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

routerAdd("POST", "/api/pipeline/review/{id}/approve", (e) => {
  console.log("[pipeline/approve] hit; auth?", !!e.auth);
  const v = e.auth ? e.auth.get("isModerator") : null;
  if (!(v === true || v == true || v === 1 || String(v) === "true")) {
    return e.json(403, { message: "moderators only" });
  }
  // `review` permission (registry: mod_perms.go). No row → legacy full access. Inlined on purpose:
  // JSVM isolates can't see shared helpers.
  try {
    const pr = $app.findFirstRecordByFilter(
      "mod_permissions", "user = {:u}", { u: e.auth.id });
    if (pr) {
      // TRAP: the json field arrives as raw types.JSONRaw (no .length), not an array. Read via
      // string + JSON.parse; if parsing fails, allow — don't lock a person out over field format.
      let list = null;
      try {
        const parsed = JSON.parse(String(pr.get("perms")));
        if (parsed && parsed.length !== undefined) list = parsed;
      } catch (parseErr) {
        list = null;
      }
      if (list) {
        let allowed = false;
        for (let i = 0; i < list.length; i++) {
          if (list[i] === "*" || list[i] === "review") allowed = true;
        }
        if (!allowed) return e.json(403, { message: "no \"review\" permission" });
      }
    }
  } catch (permErr) {
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

routerAdd("POST", "/api/pipeline/review/{id}/reject", (e) => {
  console.log("[pipeline/reject] hit; auth?", !!e.auth);
  const v = e.auth ? e.auth.get("isModerator") : null;
  if (!(v === true || v == true || v === 1 || String(v) === "true")) {
    return e.json(403, { message: "moderators only" });
  }
  // `review` permission (registry: mod_perms.go). No row → legacy full access. Inlined on purpose:
  // JSVM isolates can't see shared helpers.
  try {
    const pr = $app.findFirstRecordByFilter(
      "mod_permissions", "user = {:u}", { u: e.auth.id });
    if (pr) {
      // TRAP: the json field arrives as raw types.JSONRaw (no .length), not an array. Read via
      // string + JSON.parse; if parsing fails, allow — don't lock a person out over field format.
      let list = null;
      try {
        const parsed = JSON.parse(String(pr.get("perms")));
        if (parsed && parsed.length !== undefined) list = parsed;
      } catch (parseErr) {
        list = null;
      }
      if (list) {
        let allowed = false;
        for (let i = 0; i < list.length; i++) {
          if (list[i] === "*" || list[i] === "review") allowed = true;
        }
        if (!allowed) return e.json(403, { message: "no \"review\" permission" });
      }
    }
  } catch (permErr) {
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

routerAdd("POST", "/api/pipeline/review/{id}/note", (e) => {
  const v = e.auth ? e.auth.get("isModerator") : null;
  if (!(v === true || v == true || v === 1 || String(v) === "true")) {
    return e.json(403, { message: "moderators only" });
  }
  // `review` permission (registry: mod_perms.go). No row → legacy full access. Inlined on purpose:
  // JSVM isolates can't see shared helpers.
  try {
    const pr = $app.findFirstRecordByFilter(
      "mod_permissions", "user = {:u}", { u: e.auth.id });
    if (pr) {
      // TRAP: the json field arrives as raw types.JSONRaw (no .length), not an array. Read via
      // string + JSON.parse; if parsing fails, allow — don't lock a person out over field format.
      let list = null;
      try {
        const parsed = JSON.parse(String(pr.get("perms")));
        if (parsed && parsed.length !== undefined) list = parsed;
      } catch (parseErr) {
        list = null;
      }
      if (list) {
        let allowed = false;
        for (let i = 0; i < list.length; i++) {
          if (list[i] === "*" || list[i] === "review") allowed = true;
        }
        if (!allowed) return e.json(403, { message: "no \"review\" permission" });
      }
    }
  } catch (permErr) {
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

routerAdd("POST", "/api/pipeline/review/{id}/tags", (e) => {
  const v = e.auth ? e.auth.get("isModerator") : null;
  if (!(v === true || v == true || v === 1 || String(v) === "true")) {
    return e.json(403, { message: "moderators only" });
  }
  // `review` permission (registry: mod_perms.go). No row → legacy full access. Inlined on purpose:
  // JSVM isolates can't see shared helpers.
  try {
    const pr = $app.findFirstRecordByFilter(
      "mod_permissions", "user = {:u}", { u: e.auth.id });
    if (pr) {
      // TRAP: the json field arrives as raw types.JSONRaw (no .length), not an array. Read via
      // string + JSON.parse; if parsing fails, allow — don't lock a person out over field format.
      let list = null;
      try {
        const parsed = JSON.parse(String(pr.get("perms")));
        if (parsed && parsed.length !== undefined) list = parsed;
      } catch (parseErr) {
        list = null;
      }
      if (list) {
        let allowed = false;
        for (let i = 0; i < list.length; i++) {
          if (list[i] === "*" || list[i] === "review") allowed = true;
        }
        if (!allowed) return e.json(403, { message: "no \"review\" permission" });
      }
    }
  } catch (permErr) {
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

// Shared metadata edit: set ONLY the keys sent (GameMetaEditor sends a diff). Same contract as
// catalog /api/custom/games/{id}/edit so one editor works on both queue rows and published cards.
// ⚠️ All inline (isolated goja runtime).
routerAdd("POST", "/api/pipeline/review/{id}/meta", (e) => {
  const v = e.auth ? e.auth.get("isModerator") : null;
  if (!(v === true || v == true || v === 1 || String(v) === "true")) {
    return e.json(403, { message: "moderators only" });
  }
  // `review` permission (registry: mod_perms.go) edits any row. `queue` alone edits rows already in
  // the publication queue (approved / publish_failed / dismissed): /moderator/queue uses this same
  // editor, and moderators without `review` got 403 on every tag change there. No row → legacy full
  // access. Inlined on purpose: JSVM isolates can't see shared helpers.
  let queueOnly = false;
  try {
    const pr = $app.findFirstRecordByFilter(
      "mod_permissions", "user = {:u}", { u: e.auth.id });
    if (pr) {
      // TRAP: the json field arrives as raw types.JSONRaw (no .length), not an array. Read via
      // string + JSON.parse; if parsing fails, allow — don't lock a person out over field format.
      let list = null;
      try {
        const parsed = JSON.parse(String(pr.get("perms")));
        if (parsed && parsed.length !== undefined) list = parsed;
      } catch (parseErr) {
        list = null;
      }
      if (list) {
        let review = false;
        let queue = false;
        for (let i = 0; i < list.length; i++) {
          if (list[i] === "*" || list[i] === "review") review = true;
          if (list[i] === "queue") queue = true;
        }
        if (!review && !queue) return e.json(403, { message: "no \"review\" or \"queue\" permission" });
        queueOnly = !review;
      }
    }
  } catch (permErr) {
  }
  try {
    const id = e.request.pathValue("id");
    let body = {};
    try { body = e.requestInfo().body || {}; } catch (_) {}
    const recs = $app.findAllRecords("game_pipeline_state", $dbx.hashExp({ id: id }));
    const r = recs && recs.length ? recs[0] : null;
    if (!r) return e.json(404, { message: "record not found" });
    if (queueOnly) {
      const st = String(r.get("state") || "");
      if (st !== "approved" && st !== "publish_failed" && st !== "dismissed") {
        return e.json(403, { message: "no \"review\" permission for a game in state " + st });
      }
    }

    const out = { ok: true };
    let touched = false;

    if (body.title !== undefined && body.title !== null) {
      const t = String(body.title).trim();
      if (!t) return e.json(400, { message: "title cannot be empty" });
      if (t.length > 300) return e.json(400, { message: "title is too long" });
      r.set("title", t);
      out.title = t;
      touched = true;
    }

    // Rewrite text `author` from the selected relation names: review list shows and searches by it;
    // the two fields must not drift.
    if (body.authors !== undefined && body.authors !== null) {
      const ids = [];
      const names = [];
      const seen = {};
      for (let i = 0; i < body.authors.length; i++) {
        const aid = String(body.authors[i] || "").trim();
        if (!aid || seen[aid] === true) continue;
        let a = null;
        try { a = $app.findRecordById("authors", aid); } catch (_) {}
        if (!a) return e.json(400, { message: "unknown author id: " + aid });
        seen[aid] = true;
        ids.push(aid);
        names.push(String(a.get("name") || ""));
      }
      if (ids.length > 12) return e.json(400, { message: "too many authors" });
      r.set("authors", ids);
      r.set("author", names.join(", "));
      out.authors = ids;
      out.author = names.join(", ");
      touched = true;
    }

    if (body.tags !== undefined && body.tags !== null) {
      const tagIds = [];
      const seenT = {};
      for (let i = 0; i < body.tags.length; i++) {
        const tid = String(body.tags[i] || "").trim();
        if (!tid || seenT[tid] === true) continue;
        seenT[tid] = true;
        tagIds.push(tid);
      }
      r.set("tags", tagIds);
      out.tags = tagIds;
      touched = true;
    }

    // Aliases: one per line, commas are NOT separators (common in CYOA titles). Same normalization
    // as normalizeAliases() (game_edits.go) and normalizeGameAliases() (src/utils/aliases.ts) — all
    // three must agree.
    if (body.aliases !== undefined && body.aliases !== null) {
      let hasAliases = false;
      try { hasAliases = r.get("aliases") !== undefined; } catch (_) {}
      if (!hasAliases) {
        return e.json(400, { message: "aliases field is not in the schema yet" });
      }
      const titleLower = String(r.get("title") || "").trim().toLowerCase();
      const lines = String(body.aliases).replace(/\r\n/g, "\n").split("\n");
      const kept = [];
      const seenA = {};
      for (let i = 0; i < lines.length; i++) {
        const val = lines[i].trim();
        if (!val) continue;
        const k = val.toLowerCase();
        if (seenA[k] === true || k === titleLower) continue;
        seenA[k] = true;
        kept.push(val);
      }
      const norm = kept.join("\n");
      if (norm.length > 2000) return e.json(400, { message: "aliases are too long" });
      r.set("aliases", norm);
      out.aliases = norm;
      touched = true;
    }

    if (!touched) return e.json(200, out);
    $app.save(r);
    console.log("[pipeline/meta]", r.get("slug"), "meta saved");
    return e.json(200, out);
  } catch (err) {
    console.log("[pipeline/meta] failed —", String(err));
    return e.json(500, { message: "meta save failed: " + String(err) });
  }
}, $apis.requireAuth());

// Moderators (regular authed users) can't read superuser-only files via /api/files — proxy after
// the isModerator check. Fetched with Authorization (authedFetch), so not a plain <img src>; the
// frontend makes an objectURL.
routerAdd("GET", "/api/pipeline/review/{id}/screenshot", (e) => {
  const v = e.auth ? e.auth.get("isModerator") : null;
  if (!(v === true || v == true || v === 1 || String(v) === "true")) {
    return e.json(403, { message: "moderators only" });
  }
  // `review` permission (registry: mod_perms.go). No row → legacy full access. Inlined on purpose:
  // JSVM isolates can't see shared helpers.
  try {
    const pr = $app.findFirstRecordByFilter(
      "mod_permissions", "user = {:u}", { u: e.auth.id });
    if (pr) {
      // TRAP: the json field arrives as raw types.JSONRaw (no .length), not an array. Read via
      // string + JSON.parse; if parsing fails, allow — don't lock a person out over field format.
      let list = null;
      try {
        const parsed = JSON.parse(String(pr.get("perms")));
        if (parsed && parsed.length !== undefined) list = parsed;
      } catch (parseErr) {
        list = null;
      }
      if (list) {
        let allowed = false;
        for (let i = 0; i < list.length; i++) {
          if (list[i] === "*" || list[i] === "review") allowed = true;
        }
        if (!allowed) return e.json(403, { message: "no \"review\" permission" });
      }
    }
  } catch (permErr) {
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

// Open to any logged-in user (/add-next). Moderator → "queued" directly; regular user → "suggested"
// (author's manual gate at /moderator/suggestions), 10 links/day. Dedup: pipeline queue + catalog
// (original_link / iframe_url).
routerAdd("POST", "/api/pipeline/submit", (e) => {
  console.log("[pipeline/submit] hit; auth?", !!e.auth);
  if (!e.auth) return e.json(401, { message: "login required" });
  const v = e.auth.get("isModerator");
  const isMod = (v === true || v == true || v === 1 || String(v) === "true");
  try {
    const body = (e.requestInfo() && e.requestInfo().body) || {};
    const url = String(body.source_url || "").trim();
    const kind = String(body.kind || "") === "static" ? "static" : "interactive";
    const original = body.original === true || body.original === "true" || body.original === "1";
    console.log("[pipeline/submit] url =", url, "kind =", kind, "orig?", original, "mod?", isMod);

    // ~95MB total: Cloudflare cuts request bodies around 100MB.
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
    const hasUrl = !!url;

    if (hasUrl || kind !== "static") {
      if (!/^https?:\/\//i.test(url) || url.length > 2000) {
        return e.json(400, { message: "Please paste a valid http(s) link." });
      }
      // The pipeline visits these URLs at night — reject localhost/raw IPs.
      const hm = url.match(/^https?:\/\/([^/:?#]+)/i);
      const rawHost = hm ? hm[1].toLowerCase() : "";
      if (!rawHost || rawHost.indexOf(".") === -1 || rawHost === "localhost" ||
          rawHost.slice(-6) === ".local" || /^[0-9.]+$/.test(rawHost) || rawHost.indexOf("[") !== -1) {
        return e.json(400, { message: "That link doesn't look like a public website URL." });
      }
    }

    // Canonicalize like state_pb._canonical_url: strip wayback prefix, query/fragment,
    // dir/index.html, trailing slash. KEEP path case (neocities is case-sensitive) — the worker
    // later rewrites original_url with the same algorithm; the forms must match.
    let canon = url.replace(/^https?:\/\/web\.archive\.org\/web\/[^/]+\//i, "");
    canon = canon.replace(/[#?].*$/, "");
    canon = canon.replace(/\/index\.(html?|php|aspx?)$/i, "");
    canon = canon.replace(/\/+$/, "");
    canon = canon.replace(/^(https?:\/\/[^/]+)/i, function (mm) { return mm.toLowerCase(); });

    // LOWER on both sides: old rows may have stored a different path case. URL-less upload
    // submissions are deduped later by title at the review gate (s06b static dedup).
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
        return e.json(200, { ok: true, duplicate: true, where: "declined", slug: dup.get("slug") });
      }
      return e.json(200, { ok: true, duplicate: true, where: "queue", slug: dup.get("slug") });
    }

    // LIKE on host/path tail is only a rough candidate filter: substring also matches other games
    // deeper on the same domain (neocities root matched .../bleach/ — different CYOAs of one
    // author). Every candidate is confirmed by the canonical key (same as
    // utils/catalog_check.norm_url: host without www + path without
    // query/fragment/index.html/trailing slash).
    if (hasUrl) try {
      // Isolated handler (see header) — helper must live inside it.
      const normKey = function (u) {
        if (!u) return "";
        let s = String(u).trim();
        for (let i = 0; i < 10; i++) {
          const wm = s.match(/^https?:\/\/web\.archive\.org\/web\/\d+(?:[a-z]{2,3}_)?\/(https?:\/\/.*)$/i);
          if (!wm) break;
          s = wm[1];
        }
        s = s.replace(/^[a-z][a-z0-9+.\-]*:\/\//i, "").replace(/[#?].*$/, "");
        const cut = s.indexOf("/");
        let host = (cut === -1 ? s : s.slice(0, cut)).toLowerCase().split(":")[0];
        if (host.indexOf("www.") === 0) host = host.slice(4);
        let path = cut === -1 ? "" : s.slice(cut);
        try { path = decodeURIComponent(path); } catch (_) {}
        path = path.replace(/\/index\.(html?|php|aspx?)$/i, "/").replace(/\/+$/, "");
        return host ? (host + path).toLowerCase() : "";
      };
      const wantKey = normKey(canon);
      const needle = canon
        .replace(/^https?:\/\//, "").replace(/^www\./i, "")
        .toLowerCase().replace(/([%_\\])/g, "\\$1");
      const gdups = $app.findAllRecords(
        "games",
        $dbx.exp(
          "LOWER(original_link) LIKE {:p} ESCAPE '\\' OR LOWER(iframe_url) LIKE {:p} ESCAPE '\\'",
          { p: "%" + needle + "%" }
        )
      );
      const gn = gdups ? gdups.length : 0;
      for (let i = 0; i < gn; i++) {
        let same = false;
        try {
          same = wantKey && (normKey(gdups[i].get("original_link")) === wantKey ||
                             normKey(gdups[i].get("iframe_url")) === wantKey);
        } catch (_) {}
        if (same) {
          console.log("[pipeline/submit] duplicate (catalog) ->", gdups[i].id);
          return e.json(200, {
            ok: true, duplicate: true, where: "catalog",
            game_id: gdups[i].id, title: gdups[i].get("title") || "",
          });
        }
      }
      if (gn) {
        console.log("[pipeline/submit] catalog LIKE: " + gn +
          " candidate(s) on the same host, none is this page —", canon);
      }
    } catch (err) {
      console.log("[pipeline/submit] catalog dedup skipped —", String(err));
    }

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

    // goja has NO URL class — parse with regex.
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

    // slug is unique in the schema: different URLs can yield the same host+last-segment and save()
    // 500s. Pick a free suffix.
    let slug = slugBase;
    try {
      for (let i = 2; i <= 50; i++) {
        const taken = $app.findAllRecords("game_pipeline_state", $dbx.hashExp({ slug: slug }));
        if (!taken || !taken.length) break;
        slug = slugBase + "-" + i;
      }
    } catch (_) {}

    const RATINGS = { SFW: "SFW", ECCHI: "Ecchi", NSFW: "NSFW", EXTREME: "Extreme" };
    const type = String(body.type || "").toUpperCase();
    const normType = RATINGS[type] || "";
    const note = String(body.note || "").slice(0, 500);

    const state = isMod ? "queued" : "suggested";
    // Upload submission: pseudo-URL so the unique original_url index doesn't collide on empty
    // strings.
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
    // id lets the frontend upload pages in batches (submit/{id}/pages) — under CF's ~100MB
    // per-request limit.
    return e.json(200, { ok: true, id: r.id, slug: slug, state: state });
  } catch (err) {
    console.log("[pipeline/submit] failed —", String(err));
    return e.json(500, { message: "submit failed: " + String(err) });
  }
}, $apis.requireAuth());

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

// Public COMMUNITY queue feed (submitted_by != "", no submitter names). count = human suggestions
// only (the old whole-pipeline count, 420+ nightly harvest, disagreed with a 100-item list);
// backlog goes separately as pipeline_total.
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

routerAdd("GET", "/api/pipeline/suggestions", (e) => {
  const v = e.auth ? e.auth.get("isModerator") : null;
  if (!(v === true || v == true || v === 1 || String(v) === "true")) {
    return e.json(403, { message: "moderators only" });
  }
  // `review` permission (registry: mod_perms.go). No row → legacy full access. Inlined on purpose:
  // JSVM isolates can't see shared helpers.
  try {
    const pr = $app.findFirstRecordByFilter(
      "mod_permissions", "user = {:u}", { u: e.auth.id });
    if (pr) {
      // TRAP: the json field arrives as raw types.JSONRaw (no .length), not an array. Read via
      // string + JSON.parse; if parsing fails, allow — don't lock a person out over field format.
      let list = null;
      try {
        const parsed = JSON.parse(String(pr.get("perms")));
        if (parsed && parsed.length !== undefined) list = parsed;
      } catch (parseErr) {
        list = null;
      }
      if (list) {
        let allowed = false;
        for (let i = 0; i < list.length; i++) {
          if (list[i] === "*" || list[i] === "review") allowed = true;
        }
        if (!allowed) return e.json(403, { message: "no \"review\" permission" });
      }
    }
  } catch (permErr) {
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
          // json field arrives as types.JSONRaw ([]byte): String(raw) gives text.
          // JSON.parse(JSON.stringify(raw)) breaks on bytes — don't.
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

      // Possible catalog duplicate hint: same check as submit, but the catalog may have grown since
      // (race with the nightly conveyor).
      let dupGameId = "";
      let dupGameTitle = "";
      try {
        const normKey = function (u) {
          if (!u) return "";
          let s = String(u).trim();
          for (let i = 0; i < 10; i++) {
            const wm = s.match(/^https?:\/\/web\.archive\.org\/web\/\d+(?:[a-z]{2,3}_)?\/(https?:\/\/.*)$/i);
            if (!wm) break;
            s = wm[1];
          }
          s = s.replace(/^[a-z][a-z0-9+.\-]*:\/\//i, "").replace(/[#?].*$/, "");
          const cut = s.indexOf("/");
          let host = (cut === -1 ? s : s.slice(0, cut)).toLowerCase().split(":")[0];
          if (host.indexOf("www.") === 0) host = host.slice(4);
          let path = cut === -1 ? "" : s.slice(cut);
          try { path = decodeURIComponent(path); } catch (_) {}
          path = path.replace(/\/index\.(html?|php|aspx?)$/i, "/").replace(/\/+$/, "");
          return host ? (host + path).toLowerCase() : "";
        };
        const wantKey = normKey(r.get("original_url") || "");
        if (wantKey) {
          const needle = wantKey.replace(/([%_\\])/g, "\\$1");
          const gdups = $app.findAllRecords(
            "games",
            $dbx.exp(
              "LOWER(original_link) LIKE {:p} ESCAPE '\\' OR LOWER(iframe_url) LIKE {:p} ESCAPE '\\'",
              { p: "%" + needle + "%" }
            )
          );
          const gn = gdups ? gdups.length : 0;
          for (let i = 0; i < gn; i++) {
            let same = false;
            try {
              same = normKey(gdups[i].get("original_link")) === wantKey ||
                     normKey(gdups[i].get("iframe_url")) === wantKey;
            } catch (_) {}
            if (same) {
              dupGameId = gdups[i].id;
              dupGameTitle = String(gdups[i].get("title") || "");
              break;
            }
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
    items.sort(function (a, b) { return a.created < b.created ? -1 : 1; });
    return e.json(200, { items: items });
  } catch (err) {
    console.log("[pipeline/suggestions] failed —", String(err));
    return e.json(500, { message: "failed: " + String(err) });
  }
}, $apis.requireAuth());

routerAdd("POST", "/api/pipeline/suggestions/{id}/approve", (e) => {
  const v = e.auth ? e.auth.get("isModerator") : null;
  if (!(v === true || v == true || v === 1 || String(v) === "true")) {
    return e.json(403, { message: "moderators only" });
  }
  // `review` permission (registry: mod_perms.go). No row → legacy full access. Inlined on purpose:
  // JSVM isolates can't see shared helpers.
  try {
    const pr = $app.findFirstRecordByFilter(
      "mod_permissions", "user = {:u}", { u: e.auth.id });
    if (pr) {
      // TRAP: the json field arrives as raw types.JSONRaw (no .length), not an array. Read via
      // string + JSON.parse; if parsing fails, allow — don't lock a person out over field format.
      let list = null;
      try {
        const parsed = JSON.parse(String(pr.get("perms")));
        if (parsed && parsed.length !== undefined) list = parsed;
      } catch (parseErr) {
        list = null;
      }
      if (list) {
        let allowed = false;
        for (let i = 0; i < list.length; i++) {
          if (list[i] === "*" || list[i] === "review") allowed = true;
        }
        if (!allowed) return e.json(403, { message: "no \"review\" permission" });
      }
    }
  } catch (permErr) {
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
    // data.state is a cosmetic mirror, fixed best-effort. If JSONRaw parsing fails, DON'T touch
    // data (a bad r.set would wipe source_url and note).
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

routerAdd("POST", "/api/pipeline/suggestions/{id}/decline", (e) => {
  const v = e.auth ? e.auth.get("isModerator") : null;
  if (!(v === true || v == true || v === 1 || String(v) === "true")) {
    return e.json(403, { message: "moderators only" });
  }
  // `review` permission (registry: mod_perms.go). No row → legacy full access. Inlined on purpose:
  // JSVM isolates can't see shared helpers.
  try {
    const pr = $app.findFirstRecordByFilter(
      "mod_permissions", "user = {:u}", { u: e.auth.id });
    if (pr) {
      // TRAP: the json field arrives as raw types.JSONRaw (no .length), not an array. Read via
      // string + JSON.parse; if parsing fails, allow — don't lock a person out over field format.
      let list = null;
      try {
        const parsed = JSON.parse(String(pr.get("perms")));
        if (parsed && parsed.length !== undefined) list = parsed;
      } catch (parseErr) {
        list = null;
      }
      if (list) {
        let allowed = false;
        for (let i = 0; i < list.length; i++) {
          if (list[i] === "*" || list[i] === "review") allowed = true;
        }
        if (!allowed) return e.json(403, { message: "no \"review\" permission" });
      }
    }
  } catch (permErr) {
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

// Moderator edits classification in the inbox BEFORE approval: type (rating → tag + nsfw gate at
// s06b); original ("Fresh" author release → data.original → games.original_release); mod_note —
// private note to the NIGHT AGENT, in data (NOT moderator_note: that one goes to the submitter). PB
// schema untouched — only existing fields type + data(JSON).
routerAdd("POST", "/api/pipeline/suggestions/{id}/update", (e) => {
  const v = e.auth ? e.auth.get("isModerator") : null;
  if (!(v === true || v == true || v === 1 || String(v) === "true")) {
    return e.json(403, { message: "moderators only" });
  }
  // `review` permission (registry: mod_perms.go). No row → legacy full access. Inlined on purpose:
  // JSVM isolates can't see shared helpers.
  try {
    const pr = $app.findFirstRecordByFilter(
      "mod_permissions", "user = {:u}", { u: e.auth.id });
    if (pr) {
      // TRAP: the json field arrives as raw types.JSONRaw (no .length), not an array. Read via
      // string + JSON.parse; if parsing fails, allow — don't lock a person out over field format.
      let list = null;
      try {
        const parsed = JSON.parse(String(pr.get("perms")));
        if (parsed && parsed.length !== undefined) list = parsed;
      } catch (parseErr) {
        list = null;
      }
      if (list) {
        let allowed = false;
        for (let i = 0; i < list.length; i++) {
          if (list[i] === "*" || list[i] === "review") allowed = true;
        }
        if (!allowed) return e.json(403, { message: "no \"review\" permission" });
      }
    }
  } catch (permErr) {
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

    let newType = "";
    if (typeof body.type === "string" && body.type) {
      const RATINGS = ["SFW", "Ecchi", "NSFW", "Extreme"];
      for (let i = 0; i < RATINGS.length; i++) {
        if (RATINGS[i].toUpperCase() === body.type.toUpperCase()) { newType = RATINGS[i]; break; }
      }
      if (!newType) return e.json(400, { message: "bad type (SFW/Ecchi/NSFW/Extreme)" });
    }

    // Edits go to data(JSON) AND the denormalized `type` column: pipeline loads entries from data
    // but `type` is in _PROMOTED and wins (state_pb), while queue_audit reads data.type directly —
    // keep both in sync.
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

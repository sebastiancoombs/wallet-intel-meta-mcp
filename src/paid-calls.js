// Shared X-PAYMENT-RESPONSE capture helper.
//
// Mount AFTER paymentMiddleware. Captures every paid response (success or
// post-settlement handler error), decodes the base64 X-PAYMENT-RESPONSE
// header, and inserts a row into the shared `paid_calls` D1 table for the
// dashboard's per-endpoint attribution + error-rate tracking.
//
// The capture is fire-and-forget via `executionCtx.waitUntil` so a slow or
// failing D1 write never blocks the buyer's response.

function decodeXpr(xpr) {
  if (!xpr) return null;
  try {
    let raw;
    if (typeof atob === "function") {
      raw = atob(xpr);
    } else {
      raw = Buffer.from(xpr, "base64").toString("utf8");
    }
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function paidCallsCapture({ service, priceByPath }) {
  return async (c, next) => {
    await next();
    const xpr = c.res.headers.get("X-PAYMENT-RESPONSE");
    if (!xpr) return;
    const decoded = decodeXpr(xpr);
    if (!decoded) return;

    const path = c.req.path;
    const atomic = priceByPath?.[path] ?? 0;
    const status = c.res.status ?? 0;
    const success = decoded.success === true ? 1 : 0;
    const ok = status >= 200 && status < 300 ? 1 : 0;
    const ts = Math.floor(Date.now() / 1000);
    const iso = new Date(ts * 1000).toISOString();

    const db = c.env?.PAID_CALLS_DB;
    if (!db) {
      console.warn(`[paid-calls] PAID_CALLS_DB binding missing — skipping capture`);
      return;
    }

    const insert = db
      .prepare(
        `INSERT INTO paid_calls
           (ts, iso_ts, service, endpoint, status_code, ok, atomic_amount, network, tx_hash, payer_addr, success)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        ts,
        iso,
        service,
        path,
        status,
        ok,
        Number(atomic) || 0,
        decoded.network ?? null,
        decoded.transaction ?? null,
        decoded.payer ?? null,
        success
      );
    const ec = c.executionCtx;
    if (ec?.waitUntil) {
      ec.waitUntil(
        insert.run().catch((err) =>
          console.warn(`[paid-calls] insert failed`, err)
        )
      );
    } else {
      insert.run().catch((err) => console.warn(`[paid-calls] insert failed`, err));
    }
  };
}

// Mount a public GET endpoint so the snapshot script + dashboard can read
// recent paid calls. Public-readable: data already on chain, plus we want
// the snapshot generator (no shared secret) to fetch without auth setup.
export function mountPaidCallsAdmin(app, { route = "/v1/admin/paid_calls", service = null } = {}) {
  const scopedService = service;

  app.get(route, async (c) => {
    const db = c.env?.PAID_CALLS_DB;
    if (!db) return c.json({ error: "no_db_binding" }, 500);

    const sinceParam = c.req.query("since_unix");
    const limitParam = c.req.query("limit");
    const limit = Math.max(1, Math.min(parseInt(limitParam ?? "500", 10) || 500, 5000));
    let sql =
      `SELECT ts, iso_ts, service, endpoint, status_code, ok, atomic_amount,
              network, tx_hash, payer_addr, success
         FROM paid_calls
        WHERE service = ?`;
    const binds = [scopedService];
    if (sinceParam) {
      const since = parseInt(sinceParam, 10);
      if (Number.isFinite(since)) {
        sql += ` AND ts >= ?`;
        binds.push(since);
      }
    }
    sql += ` ORDER BY ts DESC LIMIT ?`;
    binds.push(limit);

    try {
      const { results } = await db.prepare(sql).bind(...binds).all();
      return c.json({
        ok: true,
        service: scopedService,
        count: results.length,
        rows: results,
      });
    } catch (err) {
      return c.json({ ok: false, error: String(err?.message || err) }, 500);
    }
  });

  // Lightweight summary endpoint for quick dashboard polls.
  app.get(`${route}/summary`, async (c) => {
    const db = c.env?.PAID_CALLS_DB;
    if (!db) return c.json({ error: "no_db_binding" }, 500);
    try {
      const since = Math.floor(Date.now() / 1000) - 86400 * 7; // 7-day window
      const { results } = await db
        .prepare(
          `SELECT service, endpoint,
                  COUNT(*)             AS hits,
                  SUM(ok)              AS ok_hits,
                  SUM(1 - ok)          AS err_hits,
                  SUM(atomic_amount)   AS atomic_total,
                  MIN(ts)              AS first_ts,
                  MAX(ts)              AS last_ts
             FROM paid_calls
            WHERE ts >= ? AND service = ?
            GROUP BY service, endpoint
            ORDER BY hits DESC`
        )
        .bind(since, scopedService)
        .all();
      return c.json({ ok: true, service: scopedService, since_unix: since, rows: results });
    } catch (err) {
      return c.json({ ok: false, error: String(err?.message || err) }, 500);
    }
  });
}

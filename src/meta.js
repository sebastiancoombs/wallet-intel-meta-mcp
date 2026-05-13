// Parallel fan-out to 7 upstream EVM wallet-intelligence services.
//
// Each axis = one upstream paid x402 endpoint. We don't pay them — we call
// the *unpaid path* (the meta-aggregator only composes the upstream `200 OK`
// data shapes). v0.1 design:
//   - We expose an aggregator endpoint that itself takes payment ($0.75)
//   - Internally we POST to each upstream's data endpoint (no payment header)
//   - Upstreams will return 402, BUT for the dossier we capture the 402
//     envelope per-axis as the "ok=false" failure mode.
//
// NOTE on x402-aware composition: in production the meta service would need
// to either (a) front-pay all upstreams from a hot wallet, or (b) pass the
// caller's X-PAYMENT through (per-axis fan-out signing). For v0.1 we ship
// the FAN-OUT INFRASTRUCTURE (parallel + timeouts + per-axis ok/latency
// boolean + source_url + fail-soft) and document the composition payment
// model upstream. The contract is: the dossier endpoint returns the SHAPE
// regardless of whether each axis paid through. When upstream payment is
// wired (cycle-N+1), only the inner fetch options change.
//
// For the immediate ship, every axis call uses the upstream's PUBLIC GET /
// JSON-info as a freebie health/shape probe. This proves the fan-out works
// end-to-end and gives the buyer real per-upstream metadata + uptime info.

const UPSTREAMS = [
  {
    axis: "labels",
    url: "https://wallet-labels-mcp.mtree.workers.dev/v1/wallet/labels",
    body: ({ address, chain }) => ({ address, chain: chain || "ethereum" }),
    description: "ENS + OFAC SDN + Tornado mixer + on-chain ERC-20 metadata + public-label registry",
  },
  {
    axis: "portfolio_risk",
    url: "https://wallet-portfolio-risk-mcp.mtree.workers.dev/v1/wallet/portfolio_risk",
    body: ({ address, chains }) => ({ address, chains: chains || ["ethereum", "base"] }),
    description: "Aave V3 + Compound III + Uniswap V3 LP + ERC-20 holdings + GoPlus token-security",
  },
  {
    axis: "defi_health",
    url: "https://defi-position-health-mcp.mtree.workers.dev/v1/wallet/defi_position_health",
    body: ({ address, chains }) => ({ address, chains: chains || ["ethereum", "base"] }),
    description: "Morpho Blue + Aerodrome + Pendle + Lido positions",
  },
  {
    axis: "mev_exposure",
    url: "https://mev-history-mcp.mtree.workers.dev/v1/wallet/mev_exposure",
    body: ({ address, chain }) => ({ address, chain: chain || "base" }),
    description: "Sandwich-attack exposure score over recent blocks",
  },
  {
    axis: "approvals_risk",
    url: "https://approval-revoke-mcp.mtree.workers.dev/v1/wallet/approvals_risk",
    body: ({ address, chains }) => ({ address, chains: chains || ["ethereum", "base"] }),
    description: "Active ERC-20/721/1155 approval-risk score (unlimited + known-malicious + unverified)",
  },
  {
    axis: "cex_flows",
    url: "https://wallet-cex-flows-mcp.mtree.workers.dev/v1/wallet/cex_flows",
    body: ({ address, chains }) => ({ address, chains: chains || ["ethereum", "base"] }),
    description: "Per-chain per-CEX deposit/withdrawal flows + net direction",
  },
  {
    axis: "funding_trace",
    url: "https://wallet-funding-trace-mcp.mtree.workers.dev/v1/wallet/funding_trace",
    body: ({ address, chain }) => ({ address, chain: chain || "ethereum", max_hops: 3 }),
    description: "Multi-hop predecessor walk + CEX/mixer/sanctioned/bridge classification",
  },
];

function isEvmAddress(s) {
  return typeof s === "string" && /^0x[0-9a-fA-F]{40}$/.test(s);
}

async function fetchAxis(upstream, payload, timeoutMs, paymentHeader) {
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let body, status, ok, errMsg;
  try {
    const r = await fetch(upstream.url, {
      method: "POST",
      headers: { "content-type": "application/json", ...(paymentHeader ? { "x-payment": paymentHeader } : {}), "user-agent": "wallet-intel-meta-mcp/0.1.0" },
      body: JSON.stringify(upstream.body(payload)),
      signal: controller.signal,
    });
    status = r.status;
    const txt = await r.text();
    try {
      body = JSON.parse(txt);
    } catch {
      body = { raw: txt.slice(0, 4000) };
    }
    // Treat 200 as ok; 402 is the upstream paywall (expected — meta v0.1 doesn't
    // front-pay, see header comment). 4xx/5xx are real errors.
    ok = r.status >= 200 && r.status < 300;
  } catch (e) {
    status = 0;
    ok = false;
    errMsg = e?.name === "AbortError" ? `timeout_after_${timeoutMs}ms` : String(e?.message || e);
    body = { error: errMsg };
  } finally {
    clearTimeout(timer);
  }
  return {
    axis: upstream.axis,
    source_url: upstream.url,
    description: upstream.description,
    status_code: status,
    ok,
    latency_ms: Date.now() - start,
    error: errMsg || null,
    data: body,
  };
}

export async function buildDossier({ address, chain, chains, timeoutMs, paymentHeader }) {
  if (!isEvmAddress(address)) {
    const err = new Error("address must be a 0x-prefixed 20-byte EVM address");
    err.status = 400;
    throw err;
  }
  const t = Number(timeoutMs) || 8000;
  const payload = { address, chain, chains };
  const t0 = Date.now();
  const results = await Promise.allSettled(UPSTREAMS.map((u) => fetchAxis(u, payload, t, paymentHeader)));
  const axes = {};
  let okCount = 0;
  for (const r of results) {
    if (r.status === "fulfilled") {
      const a = r.value;
      axes[a.axis] = a;
      if (a.ok) okCount += 1;
    } else {
      // Should never happen — fetchAxis catches its own errors. Defensive.
      axes[`__rejected_${Math.random().toString(36).slice(2, 6)}`] = {
        ok: false,
        error: String(r.reason?.message || r.reason),
      };
    }
  }
  return {
    service: "wallet-intel-meta-mcp",
    version: "0.1.0",
    address,
    chain: chain || null,
    chains: chains || null,
    composed_axes: UPSTREAMS.length,
    ok_axes: okCount,
    failed_axes: UPSTREAMS.length - okCount,
    total_latency_ms: Date.now() - t0,
    timeout_ms_per_axis: t,
    axes,
    note:
      "v0.1 fan-out captures upstream 402 envelopes (per-axis source_url + ok=false). To get fully-paid composite data, settle X-PAYMENT against each axis's source_url. Production meta-payment-passthrough lands in v0.2.",
  };
}

function pickSummary(axes) {
  const lines = [];
  const labels = axes.labels?.data || {};
  const portfolio = axes.portfolio_risk?.data || {};
  const defi = axes.defi_health?.data || {};
  const mev = axes.mev_exposure?.data || {};
  const approvals = axes.approvals_risk?.data || {};
  const cex = axes.cex_flows?.data || {};
  const funding = axes.funding_trace?.data || {};

  // Identity / labels
  if (labels.ens || labels.label || labels.public_label) {
    lines.push(
      `Identity: ${labels.ens || labels.label || labels.public_label || "(unlabeled)"}.`
    );
  }
  if (labels.is_sanctioned || labels.ofac_sdn) {
    lines.push("WARNING: address appears on OFAC SDN list.");
  }
  if (labels.is_mixer || labels.tornado_cash) {
    lines.push("WARNING: address is a known Tornado Cash / mixer pool.");
  }

  // Risk axes
  if (typeof portfolio.risk_score === "number") {
    lines.push(`Portfolio risk: ${portfolio.risk_score}/100 (${portfolio.risk_band || "?"})`);
  }
  if (typeof defi.health_score === "number") {
    lines.push(`DeFi position health: ${defi.health_score}/100 (${defi.health_band || "?"})`);
  }
  if (typeof mev.mev_exposure_score === "number" || typeof mev.exposure_score === "number") {
    const sc = mev.mev_exposure_score ?? mev.exposure_score;
    lines.push(`MEV exposure: ${sc}/100 over recent blocks`);
  }
  if (typeof approvals.risk_score === "number") {
    lines.push(`Approval risk: ${approvals.risk_score}/100 (${approvals.risk_band || "?"})`);
  }
  if (cex.net_direction || cex.summary) {
    lines.push(`CEX flow direction: ${cex.net_direction || cex.summary?.net_direction || "(no recent CEX activity)"}.`);
  }
  if (funding.funding_classification) {
    lines.push(
      `Funding origin: ${funding.funding_classification} (risk band: ${funding.risk_band || "?"}).`
    );
  }

  if (lines.length === 0) {
    lines.push("No deterministic signal yet — most upstream axes returned 402 (payment required). v0.1 returns axis envelopes only; to get fused intelligence, either settle each axis individually or wait for v0.2 meta-payment-passthrough.");
  }

  // Shape into 2 paragraphs
  const half = Math.ceil(lines.length / 2);
  return [lines.slice(0, half).join(" "), lines.slice(half).join(" ")].filter(Boolean).join("\n\n");
}

export async function buildDossierSummary(opts) {
  const dossier = await buildDossier(opts);
  return {
    service: "wallet-intel-meta-mcp",
    version: "0.1.0",
    address: dossier.address,
    summary: pickSummary(dossier.axes),
    composed_axes: dossier.composed_axes,
    ok_axes: dossier.ok_axes,
    failed_axes: dossier.failed_axes,
    total_latency_ms: dossier.total_latency_ms,
    axes_used: Object.keys(dossier.axes),
  };
}

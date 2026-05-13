import { Hono } from "hono";
import { paymentMiddleware } from "x402-hono";
import { paidCallsCapture, mountPaidCallsAdmin } from "./paid-calls.js";
import { unknownRouteCapture, mountUnknownRoutesAdmin } from "./unknown-routes.js";
import { createFacilitatorConfig } from "@coinbase/x402";
import { buildDossier, buildDossierSummary } from "./meta.js";
import { mcpHandler, mcpInfoHandler } from "./mcp.js";

import agentCard from "./static/.well-known/agent-card.json" with { type: "json" };
import mcpManifest from "./static/.well-known/mcp.json" with { type: "json" };
import aiPlugin from "./static/.well-known/ai-plugin.json" with { type: "json" };
import openapiYaml from "./static/openapi.yaml";
import agentDiscoveryHtml from "./static/agent-discovery.html";

const PAY_TO = process.env.PAY_TO_ADDRESS;
const NETWORK = process.env.X402_NETWORK || "base";
const FACILITATOR_URL = process.env.X402_FACILITATOR_URL;
const CDP_API_KEY_ID = process.env.CDP_API_KEY_ID;
const CDP_API_KEY_SECRET = process.env.CDP_API_KEY_SECRET;
const UPSTREAM_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS) || 8000;

const FACILITATOR =
  CDP_API_KEY_ID && CDP_API_KEY_SECRET
    ? createFacilitatorConfig(CDP_API_KEY_ID, CDP_API_KEY_SECRET)
    : FACILITATOR_URL
    ? { url: FACILITATOR_URL }
    : undefined;

const SERVICE_SLUG = "wallet-intel-meta-mcp";
const PRICE_BY_PATH = {
  "/v1/wallet/dossier": 750000,
  "/v1/wallet/dossier_summary": 500000,
};

const PAID_GET_PATHS = new Set([]);

const app = new Hono();

function serviceBaseUrl(c) {
  const proto = c.req.header("x-forwarded-proto") || "https";
  const host = c.req.header("host") || `${SERVICE_SLUG}.mtree.workers.dev`;
  return `${proto}://${host}`;
}

function endpointInfo(c, path) {
  const amount = PRICE_BY_PATH[path];
  if (!amount) return null;
  return {
    service: SERVICE_SLUG,
    endpoint: path,
    method: "POST",
    price: `$${(amount / 1_000_000).toFixed(3)}`,
    atomic_amount: amount,
    network: NETWORK,
    pay_to: PAY_TO || null,
    hint: "POST this path with an x402 payment. GET/HEAD are metadata checks and are intentionally unpaid.",
  };
}

// Agent compatibility layer — keep common discovery / availability checks from
// falling into the 404 telemetry bucket. Agents do not all know our exact
// filenames or slash policy, so be liberal on read-only metadata paths.
app.use(async (c, next) => {
  const method = c.req.method.toUpperCase();
  const path = c.req.path;
  const normalized = path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;

  if (method === "OPTIONS") return c.text("", 204);

  if (method === "GET" && ["/.well-known/x402", "/.well-known/x402.json"].includes(normalized)) {
    return c.json({
      service: SERVICE_SLUG,
      x402: true,
      network: NETWORK,
      pay_to: PAY_TO || null,
      endpoints: Object.fromEntries(
        Object.entries(PRICE_BY_PATH).map(([p, amount]) => [
          `POST ${p}`,
          { price: `$${(amount / 1_000_000).toFixed(3)}`, atomic_amount: amount, network: NETWORK },
        ])
      ),
      discovery: {
        service: serviceBaseUrl(c),
        agent_card: `${serviceBaseUrl(c)}/.well-known/agent-card.json`,
        mcp: `${serviceBaseUrl(c)}/.well-known/mcp.json`,
        openapi: `${serviceBaseUrl(c)}/openapi.yaml`,
      },
    });
  }

  if (method === "GET" && ["/openapi.json", "/swagger.json", "/v3/api-docs", "/api-docs", "/api/docs"].includes(normalized)) {
    return c.text(openapiYaml, 200, { "content-type": "application/yaml" });
  }


  if (method === "GET" && PAID_GET_PATHS.has(normalized) && path !== normalized) {
    const qs = new URL(c.req.url).search;
    return c.redirect(`${normalized}${qs}`, 308);
  }

  if ((method === "HEAD" || (method === "GET" && !PAID_GET_PATHS.has(normalized))) && PRICE_BY_PATH[normalized]) {
    const info = endpointInfo(c, normalized);
    if (method === "HEAD") {
      return c.body(null, 204, {
        "x-money-tree-service": SERVICE_SLUG,
        "x-money-tree-endpoint": normalized,
        "x-money-tree-price-usdc": info.price,
        "x-money-tree-network": NETWORK,
        "link": `<${serviceBaseUrl(c)}/openapi.yaml>; rel="service-desc"`,
      });
    }
    return c.json(info);
  }

  return next();
});


app.get("/healthz", (c) =>
  c.json({
    ok: true,
    service: "wallet-intel-meta-mcp",
    composed_axes: 7,
    upstream_timeout_ms: UPSTREAM_TIMEOUT_MS,
  })
);

// Discovery surfaces — UNPAID. Mounted before the paywall.
app.get("/.well-known/agent-card.json", (c) => c.json(agentCard));
app.get("/.well-known/mcp.json", (c) => c.json(mcpManifest));
app.get("/.well-known/ai-plugin.json", (c) => c.json(aiPlugin));
app.get("/openapi.yaml", (c) =>
  c.text(openapiYaml, 200, { "content-type": "application/yaml" })
);
app.get("/agent-discovery", (c) => c.html(agentDiscoveryHtml));

// MCP transport — unpaid (catalog discovery).
app.get("/mcp", mcpInfoHandler);
app.post("/mcp", mcpHandler);

app.get("/", (c) =>
  c.json({
    service: "wallet-intel-meta-mcp",
    version: "0.1.0",
    description:
      "x402 META-aggregator: composes 7 EVM wallet-intelligence services in parallel into one wallet dossier (labels, portfolio risk, DeFi health, MEV exposure, approvals risk, CEX flows, funding trace). Single call, fail-soft per axis. No signup, no API key — pay USDC on Base.",
    composed_axes: {
      labels: "ENS + OFAC SDN + Tornado mixer registry + ERC-20 metadata + public-label registry",
      portfolio_risk: "Aave V3 + Compound III + Uniswap V3 LP + ERC-20 holdings + GoPlus token-security",
      defi_health: "Morpho Blue + Aerodrome + Pendle + Lido positions",
      mev_exposure: "Sandwich-attack exposure score over recent blocks",
      approvals_risk: "Active ERC-20/721/1155 approval-risk score",
      cex_flows: "Per-chain per-CEX deposit/withdrawal flows + net direction",
      funding_trace: "Multi-hop predecessor walk + CEX/mixer/sanctioned/bridge classification",
    },
    endpoints: {
      "POST /v1/wallet/dossier": { price: "$0.75", network: NETWORK, axes: 7 },
      "POST /v1/wallet/dossier_summary": { price: "$0.50", network: NETWORK, axes: 7 },
    },
    chains_supported: ["ethereum", "base", "arbitrum", "optimism", "polygon"],
    pay_to: PAY_TO || null,
    repo: "https://github.com/sebastiancoombs/wallet-intel-meta-mcp",
  })
);

if (PAY_TO) {
  app.use(paidCallsCapture({ service: SERVICE_SLUG, priceByPath: PRICE_BY_PATH }));
  app.use(
    paymentMiddleware(
      PAY_TO,
      {
        "POST /v1/wallet/dossier": {
          price: "$0.75",
          network: NETWORK,
          config: {
            description:
              "Composite wallet dossier — fan-out to 7 EVM wallet-intelligence services in parallel: labels (ENS/OFAC/mixers), portfolio_risk (Aave/Compound/UniV3/holdings), defi_health (Morpho/Aerodrome/Pendle/Lido), mev_exposure, approvals_risk, cex_flows, funding_trace. Returns per-axis source_url + ok + latency_ms. Fail-soft: per-axis errors don't fail the dossier.",
            discoverable: true,
            inputSchema: {
              bodyType: "json",
              bodyFields: {
                address: { type: "string", description: "EVM address (0x… 20 bytes)", example: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045" },
                chain: { type: "string", description: "Single-chain axes: ethereum/base/arbitrum/optimism/polygon", example: "ethereum" },
                chains: { type: "array", description: "Multi-chain axes (default ['ethereum','base'])", example: ["ethereum", "base"] },
              },
            },
            outputSchema: {
              example: {
                service: "wallet-intel-meta-mcp",
                address: "0xd8dA…",
                composed_axes: 7,
                ok_axes: 7,
                failed_axes: 0,
                total_latency_ms: 2400,
                axes: {
                  labels: { source_url: "https://wallet-labels-mcp.mtree.workers.dev/v1/wallet/labels", ok: true, latency_ms: 320, status_code: 200, data: {} },
                  portfolio_risk: { source_url: "https://wallet-portfolio-risk-mcp.mtree.workers.dev/v1/wallet/portfolio_risk", ok: true, latency_ms: 1800, status_code: 200, data: {} },
                },
              },
            },
          },
        },
        "POST /v1/wallet/dossier_summary": {
          price: "$0.50",
          network: NETWORK,
          config: {
            description:
              "Plain-English 2-paragraph summary derived from the 7 dossier axes. Faster than full dossier — for triage / human-readable agent output. Same fan-out, lighter return shape.",
            discoverable: true,
            inputSchema: {
              bodyType: "json",
              bodyFields: {
                address: { type: "string", description: "EVM address (0x… 20 bytes)", example: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045" },
                chain: { type: "string", description: "Single-chain axes default", example: "ethereum" },
                chains: { type: "array", description: "Multi-chain axes default", example: ["ethereum", "base"] },
              },
            },
            outputSchema: {
              example: {
                service: "wallet-intel-meta-mcp",
                address: "0xd8dA…",
                summary: "Identity: vitalik.eth. Portfolio risk: 28/100 (low). DeFi position health: 84/100 (healthy). MEV exposure: 12/100 over recent blocks.\n\nApproval risk: 18/100 (low). CEX flow direction: balanced. Funding origin: clean (risk band: clean).",
                composed_axes: 7,
                ok_axes: 7,
                failed_axes: 0,
              },
            },
          },
        },
      },
      FACILITATOR
    )
  );
  // Capture X-PAYMENT-RESPONSE → paid_calls D1.

  console.log(
    `[startup] facilitator=${
      CDP_API_KEY_ID && CDP_API_KEY_SECRET
        ? "coinbase-cdp"
        : FACILITATOR_URL || "x402.org-default"
    } upstream_timeout_ms=${UPSTREAM_TIMEOUT_MS}`
  );
} else {
  console.warn("[startup] PAY_TO_ADDRESS not set — running in UNPAID mode.");
}

app.post("/v1/wallet/dossier", async (c) => {
  let body;
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }
  const { address, chain, chains } = body || {};
  try {
    const out = await buildDossier({ address, chain, chains, timeoutMs: UPSTREAM_TIMEOUT_MS, paymentHeader: c.req.header("x-payment") });
    return c.json(out);
  } catch (e) {
    const status = e.status || 500;
    return c.json({ error: "dossier_failed", message: String(e.message || e) }, status);
  }
});

app.post("/v1/wallet/dossier_summary", async (c) => {
  let body;
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }
  const { address, chain, chains } = body || {};
  try {
    const out = await buildDossierSummary({ address, chain, chains, timeoutMs: UPSTREAM_TIMEOUT_MS, paymentHeader: c.req.header("x-payment") });
    return c.json(out);
  } catch (e) {
    const status = e.status || 500;
    return c.json({ error: "dossier_summary_failed", message: String(e.message || e) }, status);
  }
});

mountPaidCallsAdmin(app, { service: SERVICE_SLUG });
mountUnknownRoutesAdmin(app);

// 404 catch-all (must be LAST).
app.notFound(unknownRouteCapture({ service: SERVICE_SLUG }));

export { app };

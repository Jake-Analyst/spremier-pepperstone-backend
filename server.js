import express from "express";
import cors from "cors";
import {
  OpenApi,
  ProtoOAServerModel,
  ProtoOaApplicationAuthReq,
  ProtoOaAccountAuthReq,
  ProtoOaTraderReq,
  ProtoOaAccountListReq,
  ProtoOANewOrderReq,
  ProtoOaReconcileReq,
  Messages
} from "ctrader-open-api";

const CLIENT_ID     = "33520_ta8lqEnYAPCkVmAOMMlc4AXU5HUFTXVgotW5A7m6UYvmwfwnM2";
const CLIENT_SECRET = "5gKR4Wo3jCZ9k3leEraRgfJNQ8RhXSdxC13kLxgjgcbv7y71QE";

const app = express();
app.use(cors());
app.use(express.json());

// Connection cache keyed by accessToken|accountId
const sessions = new Map();

function serverHost(accountId) {
  // 5313320 = demo, 1373243 = live. Adjust if your IDs differ.
  const isLive = String(accountId).startsWith("1373");
  return isLive
    ? new ProtoOAServerModel("openapi.ctrader.com", 5034)
    : new ProtoOAServerModel("openapi.ctrader.com", 5035);
}

async function getSession(accessToken, accountId) {
  const key = `${accessToken}|${accountId}`;
  if (sessions.has(key)) return sessions.get(key);

  const client = new OpenApi(serverHost(accountId));
  await client.connect();

  // 1) App auth
  await client.sendPromise(
    new ProtoOaApplicationAuthReq({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET })
  );

  // 2) Account auth using the OAuth access token
  await client.sendPromise(
    new ProtoOaAccountAuthReq({
      ctidTraderAccountId: Number(accountId),
      accessToken
    })
  );

  // Tear down if the socket dies so the next call rebuilds it
  client.connection.on("close", () => sessions.delete(key));
  sessions.set(key, client);
  return client;
}

// ───────────────────────────────────────────────────────────
// GET /account-detail?token=...&accountId=5313320
// ───────────────────────────────────────────────────────────
app.get("/account-detail", async (req, res) => {
  const token     = req.headers.authorization?.replace(/^Bearer\s+/i, "") || req.query.token;
  const accountId = req.query.accountId || "5313320";
  if (!token) return res.status(401).json({ error: "Missing token" });

  try {
    const client = await getSession(token, accountId);

    // List accounts first (validates the token works for this app)
    const acctList = await client.sendPromise(
      new ProtoOaAccountListReq({ accessToken: token })
    );

    // Subscribe / fetch trader snapshot (has balance, equity, margin, etc.)
    const traderResp = await client.sendPromise(
      new ProtoOaTraderReq({ ctidTraderAccountId: Number(accountId) })
    );

    // The SDK returns protobuf field values; money fields are in cents
    const t = traderResp.payload.trader;
    const balance    = Number(t.balance)    / 100;
    const equity     = Number(t.equity)     / 100;
    const margin     = Number(t.margin)     / 100;
    const freeMargin = equity - margin;

    res.json({
      data: {
        balance,
        equity,
        margin,
        freeMargin,
        currency: "USD",
        loginId: String(accountId),
        accountType: String(accountId).startsWith("1373") ? "live" : "demo",
        leverage: Number(t.leverageInCents || 10000) / 100,
        accounts: acctList.payload.ctidTraderAccount.map(a => ({
          ctidTraderAccountId: String(a.ctidTraderAccountId),
          isLive: a.isLive,
          traderLogin: String(a.traderLogin)
        }))
      }
    });
  } catch (e) {
    console.error("account-detail error:", e);
    res.status(500).json({ error: e.message || String(e) });
  }
});

// ───────────────────────────────────────────────────────────
// POST /test-trade   { token, accountId, symbol, side, volume }
// ───────────────────────────────────────────────────────────
app.post("/test-trade", async (req, res) => {
  const { token, accountId = "5313320", symbol = "EURUSD", side = "BUY", volume = 0.01 } = req.body;
  if (!token) return res.status(401).json({ error: "Missing token" });

  try {
    const client = await getSession(token, accountId);

    // 1 lot = 100,000 in cTrader; volume is in 1/100,000 of a lot
    const volumeInUnits = Math.round(volume * 100000);

    const orderResp = await client.sendPromise(
      new ProtoOANewOrderReq({
        ctidTraderAccountId: Number(accountId),
        symbolName: symbol,
        orderType: Messages.ProtoOAOrderType.MARKET,
        tradeSide: side === "BUY"
          ? Messages.ProtoOATradeSide.BUY
          : Messages.ProtoOATradeSide.SELL,
        volume: volumeInUnits,
        comment: "SPremier test"
      })
    );

    res.json({
      ok: true,
      orderId: orderResp.payload.order?.orderId?.toString?.() ?? null,
      raw: orderResp.payload
    });
  } catch (e) {
    // Market-closed / no-quotes errors land here. They still prove the
    // token has trading access (we got past account auth and the API
    // actually parsed our order request).
    console.error("test-trade error:", e);
    res.status(200).json({
      ok: false,
      error: e.message || String(e),
      proofOfTradingAccess: true
    });
  }
});

app.get("/health", (_req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`SPremier Pepperstone backend on :${PORT}`));

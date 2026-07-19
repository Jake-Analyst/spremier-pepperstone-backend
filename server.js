const express = require("express");
const cors = require("cors");
const ctrader = require("ctrader-open-api");

// Extract the classes from the loaded module
const { 
  OpenApi, 
  ProtoOAServerModel, 
  ProtoOaApplicationAuthReq, 
  ProtoOaAccountAuthReq, 
  ProtoOaTraderReq, 
  ProtoOaAccountListReq, 
  ProtoOANewOrderReq, 
  ProtoOaReconcileReq, 
  Messages 
} = ctrader;

const CLIENT_ID     = "33520_ta8lqEnYAPCkVmAOMMlc4AXU5HUFTXVgotW5A7m6UYvmwfwnM2";
const CLIENT_SECRET = "5gKR4Wo3jCZ9k3leEraRgfJNQ8RhXSdxC13kLxgjgcbv7y71QE";

const app = express();
app.use(cors());
app.use(express.json());

const sessions = new Map();

function serverHost(accountId) {
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

  await client.sendPromise(
    new ProtoOaApplicationAuthReq({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET })
  );

  await client.sendPromise(
    new ProtoOaAccountAuthReq({
      ctidTraderAccountId: Number(accountId),
      accessToken
    })
  );

  client.connection.on("close", () => sessions.delete(key));
  sessions.set(key, client);
  return client;
}

app.get("/health", (_req, res) => res.json({ ok: true }));

app.get("/account-detail", async (req, res) => {
  const token     = req.headers.authorization?.replace(/^Bearer\s+/i, "") || req.query.token;
  const accountId = req.query.accountId || "5313320";
  if (!token) return res.status(401).json({ error: "Missing token" });

  try {
    const client = await getSession(token, accountId);
    const traderResp = await client.sendPromise(
      new ProtoOaTraderReq({ ctidTraderAccountId: Number(accountId) })
    );

    const t = traderResp.payload.trader;
    const balance    = Number(t.balance)    / 100;
    const equity     = Number(t.equity)     / 100;
    const margin     = Number(t.margin)     / 100;
    const freeMargin = equity - margin;

    res.json({
      data: {
        balance, equity, margin, freeMargin,
        currency: "USD",
        loginId: String(accountId),
        accountType: String(accountId).startsWith("1373") ? "live" : "demo",
        leverage: Number(t.leverageInCents || 10000) / 100
      }
    });
  } catch (e) {
    console.error("account-detail error:", e.message);
    res.status(500).json({ error: e.message || String(e) });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`SPremier Pepperstone backend on :${PORT}`));

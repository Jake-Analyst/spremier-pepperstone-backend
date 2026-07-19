const express = require("express");
const cors = require("cors");
const grpc = require("@grpc/grpc-js");
const protoLoader = require("@grpc/proto-loader");
const crypto = require("crypto");

const CLIENT_ID = "33520_ta8lqEnYAPCkVmAOMMlc4AXU5HUFTXVgotW5A7m6UYvmwfwnM2";
const CLIENT_SECRET = "5gKR4Wo3jCZ9k3leEraRgfJNQ8RhXSdxC13kLxgjgcbv7y71QE";

// Load Protobufs
const packageDefinition = protoLoader.loadSync(
  ["protos/OpenApi.proto", "protos/OpenApiModel.proto", "protos/OpenApiMessages.proto"],
  { keepCase: true, longs: String, enums: String, defaults: true, oneofs: true, includeDirs: ["protos"] }
);
const proto = grpc.loadPackageDefinition(packageDefinition).OpenApi;

const responseTypes = {
  "ProtoOaApplicationAuthReq": "ProtoOaApplicationAuthRes",
  "ProtoOaAccountAuthReq": "ProtoOaAccountAuthRes",
  "ProtoOaTraderReq": "ProtoOaTraderRes",
  "ProtoOaAccountListReq": "ProtoOaAccountListRes",
  "ProtoOANewOrderReq": "ProtoOANewOrderRes",
  "ProtoOaReconcileReq": "ProtoOaReconcileRes",
  "ProtoOaClosePositionReq": "ProtoOaClosePositionRes"
};

const app = express();
app.use(cors());
app.use(express.json());

const sessions = new Map();

async function getSession(accessToken, accountId) {
  const key = `${accessToken}|${accountId}`;
  if (sessions.has(key) && sessions.get(key).ready) return sessions.get(key);

  const isLive = String(accountId).startsWith("1373");
  const host = isLive ? "openapi.ctrader.com:5034" : "openapi.ctrader.com:5035";
  const client = new proto.OpenApi(host, grpc.credentials.createSsl());
  
  const session = { client, call: null, pendingRequests: {}, ready: false, sendMessage: null };
  sessions.set(key, session);

  session.call = client.rpc();
  
  session.call.on("data", (protoPayload) => {
    const clientMsgId = protoPayload.clientMsgId;
    if (clientMsgId && session.pendingRequests[clientMsgId]) {
      const req = session.pendingRequests[clientMsgId];
      const responseType = responseTypes[req.payloadType];
      if (responseType && proto[responseType]) {
        const actualMsg = proto[responseType].decode(protoPayload.payload);
        req.resolve(actualMsg);
      } else {
        req.resolve(protoPayload.payload);
      }
      delete session.pendingRequests[clientMsgId];
    }
  });

  session.call.on("error", (err) => {
    console.error("Stream error:", err);
    sessions.delete(key);
  });

  session.call.on("end", () => sessions.delete(key));

  session.sendMessage = function(payloadType, msg) {
    return new Promise((resolve, reject) => {
      const clientMsgId = crypto.randomUUID();
      session.pendingRequests[clientMsgId] = { resolve, reject, payloadType };
      
      const MsgType = proto[payloadType];
      if (!MsgType) return reject("Invalid message type: " + payloadType);
      
      const innerMsgInstance = MsgType.create(msg);
      const innerMsgBuffer = MsgType.encode(innerMsgInstance).finish();
      
      session.call.write({ payload: innerMsgBuffer, clientMsgId });
    });
  };

  await session.sendMessage("ProtoOaApplicationAuthReq", { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
  await session.sendMessage("ProtoOaAccountAuthReq", { ctidTraderAccountId: Number(accountId), accessToken });
  
  session.ready = true;
  return session;
}

app.get("/health", (_req, res) => res.json({ ok: true }));

app.get("/account-detail", async (req, res) => {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, "") || req.query.token;
  const accountId = req.query.accountId || "5313320";
  if (!token) return res.status(401).json({ error: "Missing token" });

  try {
    const session = await getSession(token, accountId);
    const traderResp = await session.sendMessage("ProtoOaTraderReq", { ctidTraderAccountId: Number(accountId) });

    const t = traderResp.trader;
    const balance = Number(t.balance) / 100;
    const equity = Number(t.equity) / 100;
    const margin = Number(t.margin) / 100;
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
    console.error("account-detail error:", e.message || e);
    res.status(500).json({ error: e.message || String(e) });
  }
});

app.post("/test-trade", async (req, res) => {
  const { token, accountId = "5313320", symbol = "EURUSD", side = "BUY", volume = 0.01 } = req.body;
  if (!token) return res.status(401).json({ error: "Missing token" });

  try {
    const session = await getSession(token, accountId);
    const volumeInUnits = Math.round(volume * 100000);

    const orderResp = await session.sendMessage("ProtoOANewOrderReq", {
      ctidTraderAccountId: Number(accountId),
      symbolName: symbol,
      orderType: 1, // 1 = MARKET
      tradeSide: side === "BUY" ? 1 : 2, // 1 = BUY, 2 = SELL
      volume: volumeInUnits,
      comment: "SPremier test"
    });

    res.json({ ok: true, orderId: orderResp.order?.orderId?.toString() || null });
  } catch (e) {
    console.error("test-trade error:", e.message || e);
    res.status(200).json({ ok: false, error: e.message || String(e), proofOfTradingAccess: true });
  }
});

app.get("/positions", async (req, res) => {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, "") || req.query.token;
  const accountId = req.query.accountId || "5313320";
  if (!token) return res.status(401).json({ error: "Missing token" });

  try {
    const session = await getSession(token, accountId);
    const resp = await session.sendMessage("ProtoOaReconcileReq", { ctidTraderAccountId: Number(accountId) });

    const positions = resp.position.map(p => ({
      positionId: p.positionId.toString(),
      symbol: p.symbolName,
      volume: Number(p.volume) / 100000,
      side: p.tradeSide === 1 ? "BUY" : "SELL",
      openPrice: Number(p.price) / 100000
    }));

    res.json({ data: positions });
  } catch (e) {
    console.error("positions error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post("/close-position", async (req, res) => {
  const { token, accountId = "5313320", positionId, volume } = req.body;
  if (!token || !positionId) return res.status(400).json({ error: "Missing token or positionId" });

  try {
    const session = await getSession(token, accountId);
    await session.sendMessage("ProtoOaClosePositionReq", {
      ctidTraderAccountId: Number(accountId),
      positionId: positionId,
      volume: Math.round(volume * 100000)
    });
    res.json({ ok: true });
  } catch (e) {
    console.error("close-position error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`SPremier Pepperstone backend on :${PORT}`));

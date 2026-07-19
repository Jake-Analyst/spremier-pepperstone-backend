const express = require("express");
const cors = require("cors");
const grpc = require("@grpc/grpc-js");
const protoLoader = require("@grpc/proto-loader");
const protobuf = require("protobufjs");
const crypto = require("crypto");

const CLIENT_ID = "33520_ta8lqEnYAPCkVmAOMMlc4AXU5HUFTXVgotW5A7m6UYvmwfwnM2";
const CLIENT_SECRET = "5gKR4Wo3jCZ9k3leEraRgfJNQ8RhXSdxC13kLxgjgcbv7y71QE";

// Load protos for gRPC client
const packageDefinition = protoLoader.loadSync(
  ["protos/OpenApi.proto"],
  { keepCase: true, longs: String, enums: String, defaults: true, oneofs: true }
);
const proto = grpc.loadPackageDefinition(packageDefinition).OpenApi;

// Load protos for serialization
const root = protobuf.loadSync("protos/OpenApi.proto");
const messages = {
  ProtoOaApplicationAuthReq: root.lookupType("OpenApi.ProtoOaApplicationAuthReq"),
  ProtoOaApplicationAuthRes: root.lookupType("OpenApi.ProtoOaApplicationAuthRes"),
  ProtoOaAccountAuthReq: root.lookupType("OpenApi.ProtoOaAccountAuthReq"),
  ProtoOaAccountAuthRes: root.lookupType("OpenApi.ProtoOaAccountAuthRes"),
  ProtoOaTraderReq: root.lookupType("OpenApi.ProtoOaTraderReq"),
  ProtoOaTraderRes: root.lookupType("OpenApi.ProtoOaTraderRes"),
  ProtoOANewOrderReq: root.lookupType("OpenApi.ProtoOANewOrderReq"),
  ProtoOANewOrderRes: root.lookupType("OpenApi.ProtoOANewOrderRes"),
  ProtoOAReconcileReq: root.lookupType("OpenApi.ProtoOAReconcileReq"),
  ProtoOAReconcileRes: root.lookupType("OpenApi.ProtoOAReconcileRes"),
  ProtoOaClosePositionReq: root.lookupType("OpenApi.ProtoOaClosePositionReq"),
  ProtoOaClosePositionRes: root.lookupType("OpenApi.ProtoOaClosePositionRes"),
  ProtoOaErrorRes: root.lookupType("OpenApi.ProtoOaErrorRes")
};

const payloadTypes = {
  "ProtoOaApplicationAuthReq": 2101,
  "ProtoOaAccountAuthReq": 2103,
  "ProtoOaTraderReq": 2113,
  "ProtoOANewOrderReq": 2121,
  "ProtoOaReconcileReq": 2125,
  "ProtoOaClosePositionReq": 2127,
  "ProtoOaErrorRes": 2147
};

const responseTypes = {
  "ProtoOaApplicationAuthReq": "ProtoOaApplicationAuthRes",
  "ProtoOaAccountAuthReq": "ProtoOaAccountAuthRes",
  "ProtoOaTraderReq": "ProtoOaTraderRes",
  "ProtoOANewOrderReq": "ProtoOANewOrderRes",
  "ProtoOaReconcileReq": "ProtoOAReconcileRes",
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
      
      if (protoPayload.payloadType === payloadTypes["ProtoOaErrorRes"]) {
        const error = messages["ProtoOaErrorRes"].decode(protoPayload.payload);
        req.reject(new Error(error.description || "Unknown cTrader API Error"));
      } else {
        const responseType = responseTypes[req.payloadType];
        if (responseType && messages[responseType]) {
          const actualMsg = messages[responseType].decode(protoPayload.payload);
          req.resolve(actualMsg);
        } else {
          req.resolve({ success: true });
        }
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
      
      const MsgType = messages[payloadType];
      if (!MsgType) return reject("Invalid message type: " + payloadType);
      
      const innerMsgInstance = MsgType.create(msg);
      const innerMsgBuffer = MsgType.encode(innerMsgInstance).finish();
      
      session.call.write({
        payloadType: payloadTypes[payloadType],
        payload: Buffer.from(innerMsgBuffer),
        clientMsgId: clientMsgId
      });
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
        currency: t.currency || "USD",
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

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`SPremier Pepperstone backend on :${PORT}`));

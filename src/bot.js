import dotenv from "dotenv"; dotenv.config();
import fetch from "node-fetch";
import stringify from "json-stringify-deterministic";
import elliptic from "elliptic";          // CommonJS default import
import sha3 from "js-sha3";               // CommonJS default import
import { v4 as uuidv4 } from "uuid";

const { ec: EC } = elliptic;
const { keccak256 } = sha3;
const ecSecp256k1 = new EC("secp256k1");

const BASE = "https://api-galaswap.gala.com";

const WALLET = process.env.WALLET_ADDRESS;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const SIGNER_PUBLIC_KEY = process.env.SIGNER_PUBLIC_KEY || "";
const PAIRS = (process.env.PAIRS || "GALA>SILK,GALA>GUSDC").split(",").map(s=>s.trim()).filter(Boolean);
const MIN_EDGE_BPS = Number(process.env.MIN_EDGE_BPS || "30");
const MAX_NOTIONAL_USD = Number(process.env.MAX_NOTIONAL_USD || "250");
const MAX_USES_PER_TRADE = Number(process.env.MAX_USES_PER_TRADE || "3");
const MIN_PER_USE_USD = Number(process.env.MIN_PER_USE_USD || "1");
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

if (!WALLET || !PRIVATE_KEY) {
  console.error("Please set WALLET_ADDRESS and PRIVATE_KEY in .env");
  process.exit(1);
}

function headers(extra={}) { return { "Content-Type": "application/json", ...extra }; }
async function safeJson(res) { const t = await res.text(); try { return JSON.parse(t); } catch { return { _raw: t }; } }
async function get(path) {
  const url = `${BASE}${path}`;
  const res = await fetch(url);
  const json = await safeJson(res);
  if (!res.ok) throw new Error(`GET ${url} => ${res.status}: ${JSON.stringify(json)}`);
  return json;
}
async function post(path, body, { walletAddress } = {}) {
  const url = `${BASE}${path}`;
  const res = await fetch(url, { method:"POST", headers: headers(walletAddress ? { "X-Wallet-Address": walletAddress } : {}), body: JSON.stringify(body) });
  const json = await safeJson(res);
  if (!res.ok) throw new Error(`POST ${url} => ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

function toClassFromSymbol(symbol) {
  const parts = symbol.includes("|") ? symbol.split("|") : symbol.split("$");
  if (parts.length === 1) return { collection: symbol, category: "Unit", type: "none", additionalKey: "none" };
  if (parts.length !== 4) throw new Error(`Bad token class symbol: ${symbol}`);
  const [collection, category, type, additionalKey] = parts;
  return { collection, category, type, additionalKey };
}
function classStr(tc) { return [tc.collection, tc.category, tc.type, tc.additionalKey].join("|"); }
function qtyNum(q) { return typeof q === "string" ? Number(q) : Number(q || 0); }
function edgeBps(bid, ref) { if (!ref || ref <= 0) return 0; return (10000 * (bid - ref)) / ref; }
function uniqueKey() { return `galaconnect-operation-${uuidv4()}`; }

async function getTokensMap() {
  const tokens = await get("/v1/tokens");
  const list = tokens.tokens || [];
  const map = new Map();
  for (const t of list) {
    const key = `${t.collection}|${t.category}|${t.type}|${t.additionalKey}`;
    map.set(key, t);
  }
  return map;
}

async function ensureSignerPublicKey() {
  if (SIGNER_PUBLIC_KEY) return SIGNER_PUBLIC_KEY;
  const pk = await post("/galachain/api/asset/public-key-contract/GetPublicKey", { user: WALLET });
  if (typeof pk === "string") return pk;
  if (pk?.publicKey) return pk.publicKey;
  if (pk?.Data?.publicKey) return pk.Data.publicKey;
  throw new Error("Could not get signerPublicKey");
}

function signDerBase64(obj, privateKeyHex) {
  const toSign = { ...obj }; delete toSign.signature;
  const json = stringify(toSign);
  const hash = Buffer.from(keccak256.digest(Buffer.from(json)));
  const key = Buffer.from(String(privateKeyHex).replace(/^0x/, ""), "hex");
  let sig = ecSecp256k1.sign(hash, key);
  if (sig.s.cmp(ecSecp256k1.curve.n.shrn(1)) > 0) { sig.s = ecSecp256k1.curve.n.sub(sig.s); sig.recoveryParam = sig.recoveryParam === 1 ? 0 : 1; }
  return Buffer.from(sig.toDER()).toString("base64");
}

async function fetchBestSwap(giveSym, getSym) {
  const offeredTokenClass = toClassFromSymbol(`${giveSym}|Unit|none|none`);
  const wantedTokenClass  = toClassFromSymbol(`${getSym}|Unit|none|none`);
  const resp = await post("/v1/FetchAvailableTokenSwaps", { offeredTokenClass, wantedTokenClass });
  const list = resp?.results || [];
  if (!list.length) return null;
  const s = list[0]; // best first
  const give = qtyNum(s.wanted?.[0]?.quantity); // what WE give per use
  const get  = qtyNum(s.offered?.[0]?.quantity); // what WE receive per use
  const price = get / give;
  return { s, price, givePerUse: give, getPerUse: get };
}

async function maybeTrade(pair, tokensMap, signerPublicKey) {
  const [giveSym, getSym] = pair.split(">").map(s=>s.trim());
  const best = await fetchBestSwap(giveSym, getSym);
  if (!best) { console.log(`No swaps found for ${pair}`); return; }

  if (best.s.offeredBy === WALLET) { console.log(`Skip own swap for ${pair}`); return; }

  // Token classes + USD prices
  const classOffered = classStr(best.s.offered?.[0]?.tokenInstance || {});
  const classWanted  = classStr(best.s.wanted?.[0]?.tokenInstance || {});
  const usdOffered = tokensMap.get(classOffered)?.currentPrices?.usd || null;   // value we RECEIVE per unit
  const usdWanted  = tokensMap.get(classWanted )?.currentPrices?.usd || null;   // value we PAY per unit

  if (!usdOffered || !usdWanted) {
    console.log(`Missing USD price(s) for ${pair} — skipping.`);
    return;
  }

  // Reference price (what 1 wanted is "worth" in offered, via USD)
  const refPrice = usdOffered / usdWanted;         // expected get/give if fairly priced
  const edge = edgeBps(best.price, refPrice);      // in bps

  // Per-use USD economics
  const perUseValueOutUsd = best.getPerUse  * usdOffered;   // what we receive
  const perUseValueInUsd  = best.givePerUse * usdWanted;    // what we pay
  const perUsePnLUsd      = perUseValueOutUsd - perUseValueInUsd;

  // Decide uses: cap, and avoid dust
  const perUseNotionalUsd = perUseValueInUsd;   // notional based on what we pay
  if (!perUseNotionalUsd || perUseNotionalUsd < MIN_PER_USE_USD) {
    console.log(`Skip ${pair}: per-use notional ${perUseNotionalUsd?.toFixed?.(6)} < MIN_PER_USE_USD ${MIN_PER_USE_USD}`);
    return;
  }

  let usesToTake = 1n;
  if (MAX_NOTIONAL_USD > 0) {
    const maxByNotional = Math.max(1, Math.floor(MAX_NOTIONAL_USD / perUseNotionalUsd));
    usesToTake = BigInt(maxByNotional);
  }

  // respect remaining uses on the posted swap
  const remainingUses = BigInt(best.s.uses) - BigInt(best.s.usesSpent || "0");
  if (usesToTake > remainingUses) usesToTake = remainingUses;
  // hard cap
  if (usesToTake > BigInt(MAX_USES_PER_TRADE)) usesToTake = BigInt(MAX_USES_PER_TRADE);
  if (usesToTake < 1n) usesToTake = 1n;

  // Compute fee (GALA) -> USD
  const galaKey = "GALA|Unit|none|none";
  const galaUsd = tokensMap.get(galaKey)?.currentPrices?.usd || 0;

  const feeProbe = {
    swapDtos: [{
      swapRequestId: best.s.swapRequestId,
      uses: String(usesToTake),
      expectedTokenSwap: { wanted: best.s.wanted, offered: best.s.offered }
    }]
  };
  const feeResp = await post("/v1/BatchFillTokenSwap/fee", feeProbe, { walletAddress: WALLET });
  const feeInGala = (feeResp?.fees || []).reduce((acc, f) => acc + Number(f.feeInGala || f.fee || 0), 0);
  const feeUsd = feeInGala * galaUsd;

  // Total PnL = per-use PnL * uses - fee
  const totalPnLUsd = perUsePnLUsd * Number(usesToTake) - feeUsd;

  console.log(`Check ${pair}`, {
    price: best.price,
    refPrice,
    edgeBps: edge?.toFixed?.(2),
    perUseValueOutUsd: perUseValueOutUsd.toFixed(6),
    perUseValueInUsd: perUseValueInUsd.toFixed(6),
    perUsePnLUsd: perUsePnLUsd.toFixed(6),
    uses: String(usesToTake),
    feeInGala,
    feeUsd: feeUsd.toFixed(6),
    totalPnLUsd: totalPnLUsd.toFixed(6)
  });

  // Require edge threshold AND positive USD PnL after fee
  if (edge < MIN_EDGE_BPS) {
    console.log(`Skip ${pair}: edge ${edge?.toFixed?.(2)} bps < MIN_EDGE_BPS ${MIN_EDGE_BPS}`);
    return;
  }
  if (totalPnLUsd <= 0) {
    console.log(`Skip ${pair}: total PnL after fees is not positive (${totalPnLUsd.toFixed(6)} USD).`);
    return;
  }

  // Prepare DTO for signing
  const dto = {
    swapDtos: [{
      swapRequestId: best.s.swapRequestId,
      uses: String(usesToTake),
      expectedTokenSwap: { wanted: best.s.wanted, offered: best.s.offered }
    }],
    uniqueKey: uniqueKey(),
    signerPublicKey: SIGNER_PUBLIC_KEY || await ensureSignerPublicKey()
  };

  if (DRY_RUN) {
    console.log("[DRY_RUN] Would accept swap", { pair, uses: String(usesToTake) });
    return;
  }

  const signature = signDerBase64(dto, PRIVATE_KEY);
  const resp = await post("/v1/BatchFillTokenSwap", { ...dto, signature }, { walletAddress: WALLET });
  console.log("Submitted", { pair, txid: resp?.Data?.txid || resp?.txid || resp?.Data });
}

async function main(){
  console.log("Connect bot (patched) starting…", {
    dryRun: DRY_RUN,
    pairs: PAIRS,
    minEdgeBps: MIN_EDGE_BPS,
    maxNotionalUsd: MAX_NOTIONAL_USD,
    maxUsesPerTrade: MAX_USES_PER_TRADE,
    minPerUseUsd: MIN_PER_USE_USD
  });

  const signerPublicKey = SIGNER_PUBLIC_KEY || await ensureSignerPublicKey();
  const tokensMap = await getTokensMap();

  for (const pair of PAIRS) {
    try { await maybeTrade(pair, tokensMap, signerPublicKey); }
    catch (e) { console.error(`Error on ${pair}:`, e.message); }
  }
  console.log("Done.");
}

main().catch(e=>console.error("Fatal:", e.message));

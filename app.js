// Spot vs Perp — live data, dual source: Binance (primary) + OKX (fallback).
// Runs entirely in the browser, no API key needed. If Binance is unreachable
// (geo-block / outage), the dashboard automatically switches to OKX and the
// status badge shows which source is live.

const COINS = [
  { base: "BTC", name: "Bitcoin",  dec: 2 },
  { base: "ETH", name: "Ethereum", dec: 2 },
  { base: "SOL", name: "Solana",   dec: 2 },
  { base: "BNB", name: "BNB",      dec: 1 },
  { base: "XRP", name: "XRP",      dec: 4 },
  { base: "DOGE", name: "Dogecoin", dec: 4 },
];

const REFRESH_MS = 5000;

// ---------- Binance ----------
const B_SPOT = "https://api.binance.com/api/v3/ticker/24hr?symbols=" +
  encodeURIComponent(JSON.stringify(COINS.map(c => c.base + "USDT")));
const B_PERP = "https://fapi.binance.com/fapi/v1/ticker/24hr";
const B_FUND = "https://fapi.binance.com/fapi/v1/premiumIndex";
const B_OI = s => "https://fapi.binance.com/fapi/v1/openInterest?symbol=" + s;
const B_KLINES = s => "https://api.binance.com/api/v3/klines?symbol=" + s + "&interval=1h&limit=100";

// ---------- OKX ----------
const O_SPOT = "https://www.okx.com/api/v5/market/tickers?instType=SPOT";
const O_SWAP = "https://www.okx.com/api/v5/market/tickers?instType=SWAP";
const O_FUND = base => "https://www.okx.com/api/v5/public/funding-rate?instId=" + base + "-USDT-SWAP";
const O_OI = base => "https://www.okx.com/api/v5/public/open-interest?instType=SWAP&instId=" + base + "-USDT-SWAP";
const O_CANDLES = base => "https://www.okx.com/api/v5/market/candles?instId=" + base + "-USDT&bar=1H&limit=100";

const state = {
  spot: {}, perp: {}, funding: {}, oi: {},
  source: null, klinesSource: null, selected: null,
};
let lastOk = null;

const $ = id => document.getElementById(id);
const fmtPrice = (v, dec) => Number(v).toLocaleString("en-US", { minimumFractionDigits: dec, maximumFractionDigits: dec });
const fmtPct = v => (v >= 0 ? "+" : "") + v.toFixed(2) + "%";
const cls = v => (v > 0 ? "up" : v < 0 ? "down" : "flat");

function fmtUsd(v) {
  const n = Number(v);
  if (n >= 1e9) return "$" + (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return "$" + (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return "$" + (n / 1e3).toFixed(1) + "K";
  return "$" + n.toFixed(0);
}

function fmtCountdown(ms) {
  if (!ms || ms <= 0) return "—";
  const s = Math.floor(ms / 1000);
  const h = String(Math.floor(s / 3600)).padStart(2, "0");
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const sec = String(s % 60).padStart(2, "0");
  return h + ":" + m + ":" + sec;
}

function setStatus(ok, text) {
  $("live-dot").className = "dot " + (ok ? "on" : "off");
  $("status-text").textContent = text;
}

// ---------- loaders: each returns normalized {spot, perp, funding, oi} ----------

async function loadBinance() {
  const [spotRes, perpRes, fundRes] = await Promise.all([
    fetch(B_SPOT), fetch(B_PERP), fetch(B_FUND),
  ]);
  if (!spotRes.ok || !perpRes.ok || !fundRes.ok) throw new Error("Binance HTTP error");
  const spot = await spotRes.json();
  const perp = await perpRes.json();
  const funding = await fundRes.json();
  // Binance geo-block returns {code:0, msg:"Service unavailable..."} instead of arrays.
  if (!Array.isArray(spot) || !Array.isArray(perp) || !Array.isArray(funding)) {
    throw new Error("Binance unavailable from this location");
  }
  const out = { spot: {}, perp: {}, funding: {}, oi: {} };
  spot.forEach(t => { out.spot[t.symbol] = { lastPrice: Number(t.lastPrice), change: Number(t.priceChangePercent) }; });
  perp.forEach(t => {
    if (t.symbol.endsWith("USDT")) {
      out.perp[t.symbol] = { lastPrice: Number(t.lastPrice), change: Number(t.priceChangePercent) };
    }
  });
  funding.forEach(t => {
    if (t.symbol.endsWith("USDT")) {
      out.funding[t.symbol] = {
        markPrice: Number(t.markPrice),
        rate: Number(t.lastFundingRate),
        nextFundingTime: Number(t.nextFundingTime),
      };
    }
  });
  // Open interest per symbol (best effort — a failure here must not block the table).
  await Promise.all(COINS.map(async c => {
    try {
      const r = await fetch(B_OI(c.base + "USDT"));
      if (!r.ok) return;
      const d = await r.json();
      if (d.openInterest && out.funding[c.base + "USDT"]) {
        out.oi[c.base + "USDT"] = Number(d.openInterest) * out.funding[c.base + "USDT"].markPrice;
      }
    } catch (e) { /* keep missing */ }
  }));
  return out;
}

async function loadOKX() {
  const [spotRes, swapRes] = await Promise.all([fetch(O_SPOT), fetch(O_SWAP)]);
  if (!spotRes.ok || !swapRes.ok) throw new Error("OKX HTTP error");
  const spotJson = await spotRes.json();
  const swapJson = await swapRes.json();
  if (spotJson.code !== "0" || swapJson.code !== "0") throw new Error("OKX API error");
  const out = { spot: {}, perp: {}, funding: {}, oi: {} };
  const byInst = (arr, instId) => arr.find(t => t.instId === instId);

  COINS.forEach(c => {
    const s = byInst(spotJson.data, c.base + "-USDT");
    const p = byInst(swapJson.data, c.base + "-USDT-SWAP");
    if (s) {
      const last = Number(s.last), open = Number(s.open24h);
      out.spot[c.base + "USDT"] = { lastPrice: last, change: open ? (last - open) / open * 100 : 0 };
    }
    if (p) {
      const last = Number(p.last), open = Number(p.open24h);
      out.perp[c.base + "USDT"] = { lastPrice: last, change: open ? (last - open) / open * 100 : 0 };
      // Mark price: OKX tickers have no markPx, use the swap last price.
      out.funding[c.base + "USDT"] = { markPrice: last, rate: null, nextFundingTime: null };
    }
  });

  await Promise.all(COINS.map(async c => {
    try {
      const r = await fetch(O_FUND(c.base));
      if (r.ok) {
        const d = await r.json();
        const f = d.data && d.data[0];
        if (f && out.funding[c.base + "USDT"]) {
          out.funding[c.base + "USDT"].rate = Number(f.fundingRate);
          out.funding[c.base + "USDT"].nextFundingTime = Number(f.nextFundingTime);
        }
      }
    } catch (e) { /* keep missing */ }
    try {
      const r = await fetch(O_OI(c.base));
      if (r.ok) {
        const d = await r.json();
        const o = d.data && d.data[0];
        if (o && o.oiUsd) out.oi[c.base + "USDT"] = Number(o.oiUsd);
      }
    } catch (e) { /* keep missing */ }
  }));
  return out;
}

async function loadAll() {
  let data = null, source = null;
  try {
    data = await loadBinance();
    source = "Binance";
  } catch (e) {
    try {
      data = await loadOKX();
      source = "OKX";
    } catch (e2) {
      setStatus(false, "Koneksi putus — mencoba lagi…");
      return;
    }
  }
  state.spot = data.spot;
  state.perp = data.perp;
  state.funding = data.funding;
  state.oi = data.oi;
  state.source = source;
  state.klinesSource = source;
  lastOk = new Date();
  setStatus(true, "LIVE • " + source + " • update " + lastOk.toLocaleTimeString("id-ID"));
  render();
}

// ---------- render ----------

function render() {
  const tbody = $("rows");
  tbody.innerHTML = "";

  let fundingSum = 0, fundingN = 0;

  COINS.forEach(c => {
    const sym = c.base + "USDT";
    const s = state.spot[sym], p = state.perp[sym], f = state.funding[sym];
    if (!s || !p || !f) return;

    const spotPx = s.lastPrice;
    const markPx = f.markPrice;
    const premium = (markPx - spotPx) / spotPx * 100;
    const fundRate = f.rate === null || f.rate === undefined ? null : f.rate * 100;
    if (fundRate !== null) { fundingSum += fundRate; fundingN++; }
    const oiUsd = state.oi[sym] === undefined ? null : state.oi[sym];

    const tr = document.createElement("tr");
    tr.dataset.symbol = sym;
    if (state.selected === sym) tr.classList.add("selected");
    tr.innerHTML =
      "<td><b>" + c.base + "</b><span class='cname'>" + c.name + "</span></td>" +
      "<td class='num'>" + fmtPrice(spotPx, c.dec) + "</td>" +
      "<td class='num'>" + fmtPrice(markPx, c.dec) + "</td>" +
      "<td class='num " + cls(premium) + "'>" + fmtPct(premium) + "</td>" +
      "<td class='num " + cls(s.change) + "'>" + fmtPct(s.change) + "</td>" +
      "<td class='num " + cls(p.change) + "'>" + fmtPct(p.change) + "</td>" +
      "<td class='num " + (fundRate === null ? "" : cls(fundRate)) + "'>" + (fundRate === null ? "—" : fundRate.toFixed(4) + "%") + "</td>" +
      "<td class='num countdown' data-sym='" + sym + "'>" + fmtCountdown(f.nextFundingTime - Date.now()) + "</td>" +
      "<td class='num'>" + (oiUsd === null ? "—" : fmtUsd(oiUsd)) + "</td>";
    tr.addEventListener("click", () => selectCoin(sym, c));
    tbody.appendChild(tr);
  });

  const btcSym = "BTCUSDT";
  const btcS = state.spot[btcSym], btcF = state.funding[btcSym];
  const btcPremium = (btcS && btcF)
    ? (btcF.markPrice - btcS.lastPrice) / btcS.lastPrice * 100 : null;
  const avgFunding = fundingN ? fundingSum / fundingN : null;
  const totalOi = COINS.reduce((sum, c) => sum + (state.oi[c.base + "USDT"] || 0), 0);

  $("summary-cards").innerHTML =
    card("BTC Premium (perp − spot)", btcPremium === null ? "—" : fmtPct(btcPremium), cls(btcPremium || 0)) +
    card("Rata-rata Funding (8j)", avgFunding === null ? "—" : avgFunding.toFixed(4) + "%", cls(avgFunding || 0)) +
    card("Total Open Interest (6 koin)", totalOi ? fmtUsd(totalOi) : "—", "") +
    card("Sumber data", state.source || "—", "");
}

function card(label, value, valueClass) {
  return "<div class='card'><div class='clabel'>" + label + "</div>" +
    "<div class='cvalue " + valueClass + "'>" + value + "</div></div>";
}

// ---------- chart ----------

async function fetchCloses(sym, source) {
  const base = sym.replace("USDT", "");
  if (source === "Binance") {
    const r = await fetch(B_KLINES(sym));
    if (!r.ok) throw new Error("HTTP " + r.status);
    const klines = await r.json();
    if (!Array.isArray(klines)) throw new Error("Binance klines unavailable");
    return klines.map(k => Number(k[4]));
  }
  const r = await fetch(O_CANDLES(base));
  if (!r.ok) throw new Error("HTTP " + r.status);
  const d = await r.json();
  if (d.code !== "0" || !Array.isArray(d.data)) throw new Error("OKX candles unavailable");
  return d.data.map(k => Number(k[4])).reverse(); // OKX returns newest first
}

async function selectCoin(sym, coin) {
  state.selected = sym;
  render();
  $("chart-panel").classList.remove("hidden");
  $("chart-title").textContent = coin.base + " / USDT — grafik 1 jam (spot)";
  const canvas = $("chart");
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#8b949e";
  ctx.font = "14px sans-serif";
  ctx.fillText("Memuat grafik…", 20, 30);
  let closes = null;
  const sources = [state.klinesSource, state.klinesSource === "Binance" ? "OKX" : "Binance"];
  for (const src of sources) {
    try { closes = await fetchCloses(sym, src); break; } catch (e) { /* try the other source */ }
  }
  if (!closes || !closes.length) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#f85149";
    ctx.font = "14px sans-serif";
    ctx.fillText("Grafik gagal dimuat — coba lagi.", 20, 30);
    return;
  }
  drawChart(ctx, canvas, closes);
}

function drawChart(ctx, canvas, data) {
  const W = canvas.width, H = canvas.height, pad = { l: 70, r: 20, t: 24, b: 28 };
  const min = Math.min.apply(null, data), max = Math.max.apply(null, data);
  const span = (max - min) || 1;
  const x = i => pad.l + (W - pad.l - pad.r) * i / (data.length - 1);
  const y = v => pad.t + (H - pad.t - pad.b) * (1 - (v - min) / span);

  ctx.clearRect(0, 0, W, H);
  ctx.strokeStyle = "#21262d"; ctx.lineWidth = 1;
  ctx.fillStyle = "#8b949e"; ctx.font = "12px sans-serif";
  [0, 0.5, 1].forEach(f => {
    const v = min + span * f, yy = y(v);
    ctx.beginPath(); ctx.moveTo(pad.l, yy); ctx.lineTo(W - pad.r, yy); ctx.stroke();
    ctx.fillText(v.toLocaleString("en-US", { maximumFractionDigits: 4 }), 8, yy + 4);
  });
  const up = data[data.length - 1] >= data[0];
  ctx.strokeStyle = up ? "#3fb950" : "#f85149";
  ctx.lineWidth = 2;
  ctx.beginPath();
  data.forEach((v, i) => { i === 0 ? ctx.moveTo(x(i), y(v)) : ctx.lineTo(x(i), y(v)); });
  ctx.stroke();
  const lx = x(data.length - 1), ly = y(data[data.length - 1]);
  ctx.fillStyle = up ? "#3fb950" : "#f85149";
  ctx.beginPath(); ctx.arc(lx, ly, 4, 0, Math.PI * 2); ctx.fill();
  ctx.font = "bold 13px sans-serif";
  ctx.fillText(data[data.length - 1].toLocaleString("en-US"), Math.max(pad.l, lx - 90), Math.max(16, ly - 10));
}

$("chart-close").addEventListener("click", () => {
  state.selected = null;
  $("chart-panel").classList.add("hidden");
  render();
});

// Clock + funding countdowns tick every second.
setInterval(() => {
  $("clock").textContent = new Date().toLocaleTimeString("id-ID");
  document.querySelectorAll(".countdown").forEach(td => {
    const sym = td.dataset.sym;
    const f = state.funding[sym];
    td.textContent = f ? fmtCountdown(f.nextFundingTime - Date.now()) : "—";
  });
}, 1000);

loadAll();
setInterval(loadAll, REFRESH_MS);

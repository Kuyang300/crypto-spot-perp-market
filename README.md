# Spot vs Perp — Crypto Market Live

Dashboard web yang nunjukin harga **spot vs perpetual futures** berdampingan, live dari Binance.

Live: https://kuyang300.github.io/crypto-spot-perp-market/

## Fitur

- Harga spot vs harga mark perpetual, berdampingan
- Premium perp − spot (%) — ketahuan perp lagi mahal atau murah dari spot
- Perubahan 24 jam spot dan perp
- Funding rate (per 8 jam) + hitung mundur ke funding berikutnya
- Open interest perpetual (USDT)
- Grafik 1 jam (100 candle) — klik baris koin mana saja
- Refresh otomatis tiap 5 detik, tanpa API key

## Koin

BTC, ETH, SOL, BNB, XRP, DOGE (pasangan USDT).

## Data

Binance Public API (utama), tanpa API key:

- Spot: `api.binance.com/api/v3/ticker/24hr`
- Perp: `fapi.binance.com/fapi/v1/ticker/24hr`
- Funding: `fapi.binance.com/fapi/v1/premiumIndex`
- Open interest: `fapi.binance.com/fapi/v1/openInterest`
- Grafik: `api.binance.com/api/v3/klines`

Kalau Binance tidak bisa dijangkau dari lokasi browser (geo-block / down),
dashboard otomatis pindah ke **OKX Public API** dan badge status nunjukin
sumber yang lagi dipakai:

- Spot + swap: `www.okx.com/api/v5/market/tickers`
- Funding: `www.okx.com/api/v5/public/funding-rate`
- Open interest: `www.okx.com/api/v5/public/open-interest`
- Grafik: `www.okx.com/api/v5/market/candles`

## Jalankan lokal

Buka `index.html` di browser, atau serve statis:

```bash
python3 -m http.server 8000
# buka http://localhost:8000
```

## Catatan

Bukan saran trading. Funding rate positif = long bayar short; negatif = short bayar long.

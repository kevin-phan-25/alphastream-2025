import express from "express";
import cors from "cors";
import axios from "axios";
import puppeteer from "puppeteer";

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 8080;

let data = {
  equity: 100000,
  dailyPnL: "+$0.00",
  positions: [],
  tradeLog: [],
  dailyMaxLossHit: false,
  dry_mode: process.env.DRY_MODE === "true" || true
};

let lastScanTime = null;

// ---------------- Puppeteer Scraper ----------------
async function getTopGainers(existingPositions) {
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
      timeout: 60000
    });

    const page = await browser.newPage();
    await page.goto("https://finance.yahoo.com/gainers", { waitUntil: "networkidle2" });
    await page.waitForSelector("table tbody tr", { timeout: 15000 });

    const gainers = await page.evaluate((existing) => {
      const rows = Array.from(document.querySelectorAll("table tbody tr")).slice(0, 50);
      const results = [];
      for (const row of rows) {
        const cells = row.querySelectorAll("td");
        const symbol = cells[0]?.innerText.trim();
        const price = parseFloat(cells[2]?.innerText.replace(/,/g, "")) || 0;
        const changeText = cells[3]?.innerText.trim() || "";
        const change = parseFloat(changeText.replace("%", "")) || 0;
        const volumeText = cells[5]?.innerText.trim() || "";
        let volume = 0;
        if (volumeText.includes("M")) volume = parseFloat(volumeText) * 1e6;
        else if (volumeText.includes("K")) volume = parseFloat(volumeText) * 1e3;
        else volume = parseFloat(volumeText.replace(/,/g, "")) || 0;

        if (!symbol || !changeText.includes("+")) continue;
        if (
          change >= 7.5 &&
          volume >= 800000 &&
          price >= 8 &&
          price <= 350 &&
          !existing.some(p => p.symbol === symbol)
        ) {
          results.push({ symbol, price, change });
        }
      }
      return results.slice(0, 8);
    }, existingPositions);

    lastScanTime = new Date().toLocaleTimeString();
    console.log("Top Gainers:", gainers);
    return gainers;

  } catch (err) {
    console.error("Error scraping Yahoo with Puppeteer:", err);
    return [];
  } finally {
    if (browser) await browser.close();
  }
}

// ---------------- Bot Scan Function ----------------
async function runScan() {
  if (data.dailyMaxLossHit) return;

  const newGainers = await getTopGainers(data.positions);

  newGainers.forEach(g => {
    // Check if already in positions
    if (!data.positions.some(p => p.symbol === g.symbol) && data.positions.length < 5) {
      const entryPrice = g.price;
      const qty = Math.floor(10000 / entryPrice); // Example: $10k per trade
      data.positions.push({
        symbol: g.symbol,
        entry: entryPrice,
        current: entryPrice,
        qty
      });
      data.tradeLog.push({
        type: "ENTRY",
        symbol: g.symbol,
        price: entryPrice,
        qty,
        reason: "Nuclear Momentum",
        pnl: null,
        timestamp: new Date().toLocaleTimeString()
      });
    }
  });

  // Update dailyPnL
  let pnl = 0;
  data.positions.forEach(p => {
    const currentPrice = p.current; // In real bot, update from live price feed
    pnl += (currentPrice - p.entry) * p.qty;
  });
  data.dailyPnL = pnl >= 0 ? `+$${pnl.toFixed(2)}` : `-$${Math.abs(pnl).toFixed(2)}`;

  // Check max loss
  if (pnl < -2000) data.dailyMaxLossHit = true; // Example daily max loss
}

// ---------------- Routes ----------------
app.get("/", (req, res) => {
  res.json({ ...data, lastScan: lastScanTime, status: "ONLINE" });
});

app.post("/scan", async (req, res) => {
  await runScan();
  res.json({ status: "SCAN_TRIGGERED", lastScan: lastScanTime });
});

// Health check for Cloud Run
app.get("/healthz", (req, res) => {
  res.send("OK");
});

// ---------------- Start Server ----------------
app.listen(PORT, () => {
  console.log(`AlphaStream v83 running on port ${PORT}`);
  console.log(`Dry mode: ${data.dry_mode}`);
});

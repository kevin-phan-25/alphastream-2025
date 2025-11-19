// predictor/predictor.js
// simple online logistic regression (SGD) with feature standardization
import fs from "fs";
import path from "path";

export default class Predictor {
  constructor({ modelPath = "./predictor/model.json", learn = true } = {}) {
    this.modelPath = modelPath;
    this.learnMode = learn;
    this.weights = {};   // feature -> weight
    this.mean = {};      // running mean for normalization
    this.var = {};       // running var (for std)
    this.count = 0;
    this.lastEntryFeatures = {}; // symbol -> features snapshot for later learning
    this._load();
  }

  // pick numeric feature list and vectorize
  _featuresToVector(features) {
    // choose a fixed list of features we expect
    const keys = ["vwapDistPct","adx","atr","ema9","ema21","ema200","slope9pct"];
    const vec = [];
    for (const k of keys) {
      const v = Number(features[k] ?? 0);
      // update online mean/var if learning
      if (this.learnMode) {
        this.count += 1;
        const prevMean = this.mean[k] ?? 0;
        const delta = v - prevMean;
        const newMean = prevMean + delta / this.count;
        const prevVar = this.var[k] ?? 0;
        const newVar = prevVar + delta*(v - newMean);
        this.mean[k] = newMean;
        this.var[k] = newVar;
      }
      // standardize using current mean/variance (avoid zero)
      const sdev = Math.sqrt((this.var[k] || 0) / Math.max(1, this.count - 1)) || 1.0;
      vec.push((v - (this.mean[k] || 0)) / sdev);
    }
    return { vec, keys };
  }

  _sigmoid(x){ return 1/(1+Math.exp(-x)); }

  predictScore(features) {
    const { vec, keys } = this._featuresToVector(features);
    // compute dot product
    let sum = this.weights.bias || 0;
    for (let i=0;i<vec.length;i++){
      const k = keys[i];
      const w = this.weights[k] ?? 0;
      sum += w * vec[i];
    }
    return this._sigmoid(sum);
  }

  // call when we place an entry (store features by symbol)
  onNewEntry(features){
    if (!features || !features.symbol) return;
    this.lastEntryFeatures[features.symbol] = features;
  }

  // call when a completed trade outcome is available: tradeRecord {symbol, entry, exit, pnl, pnlPct, ts}
  onTradeOutcome(tradeRecord){
    if (!this.learnMode) return;
    if (!tradeRecord || !tradeRecord.symbol) return;
    const features = this.lastEntryFeatures[tradeRecord.symbol];
    if (!features) return;
    // label = 1 if profitable, 0 otherwise
    const label = (tradeRecord.pnl > 0) ? 1 : 0;
    this._sgdUpdate(features, label);
    delete this.lastEntryFeatures[tradeRecord.symbol];
  }

  _sgdUpdate(features, label) {
    const lr = 0.05; // learning rate (tune)
    const { vec, keys } = this._featuresToVector(features);
    let sum = this.weights.bias || 0;
    for (let i=0;i<vec.length;i++){
      const k = keys[i];
      sum += (this.weights[k] || 0) * vec[i];
    }
    const pred = this._sigmoid(sum);
    const error = label - pred;
    // update bias
    this.weights.bias = (this.weights.bias || 0) + lr * error;
    for (let i=0;i<vec.length;i++){
      const k = keys[i];
      this.weights[k] = (this.weights[k] || 0) + lr * error * vec[i];
    }
  }

  saveModel(){
    try {
      const dir = path.dirname(this.modelPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.modelPath, JSON.stringify({
        weights: this.weights,
        mean: this.mean,
        var: this.var,
        count: this.count
      }, null, 2));
    } catch(e){ console.warn("MODEL_SAVE_FAIL", e?.message || e); }
  }

  _load(){
    try {
      if (fs.existsSync(this.modelPath)) {
        const raw = JSON.parse(fs.readFileSync(this.modelPath,"utf8"));
        this.weights = raw.weights || {};
        this.mean = raw.mean || {};
        this.var = raw.var || {};
        this.count = raw.count || 0;
      }
    } catch(e){ console.warn("MODEL_LOAD_FAIL", e?.message || e); }
  }

  versionInfo(){ return { learnMode: this.learnMode, weightsCount: Object.keys(this.weights).length }; }
  metaSummary(){ return { mean: this.mean, count: this.count }; }
}

# predictor/main.py — LightGBM Predictor v24 (2025) — Cloud Run Ready
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from typing import List
import lightgbm as lgb
import joblib
import os
import numpy as np
from google.cloud import storage

app = FastAPI(title="AlphaStream v24 Predictor")

MODEL_PATH = "/tmp/gapper_lgb_v24.txt"
SCALER_PATH = "/tmp/scaler_v24.pkl"
BUCKET = os.getenv("MODEL_BUCKET", "alphastream-models")

# Download model & scaler on startup
def download_model():
    try:
        client = storage.Client()
        bucket = client.bucket(BUCKET)
        # Latest model
        blobs = list(bucket.list_blobs(prefix="models/"))
        if blobs:
            latest = max(blobs, key=lambda x: x.updated or x.time_created)
            latest.download_to_filename(MODEL_PATH)
            print(f"Downloaded model: {latest.name}")
        # Scaler
        scaler_blob = bucket.blob("scalers/scaler_v24.pkl")
        if scaler_blob.exists():
            scaler_blob.download_to_filename(SCALER_PATH)
            print("Downloaded scaler")
    except Exception as e:
        print(f"Model download failed: {e}")

# Load on startup
download_model()

class PredictRequest(BaseModel):
    features: List[float]

@app.get("/health")
async def health():
    return {"status": "OK", "model": os.path.exists(MODEL_PATH)}

@app.post("/predict")
async def predict(req: PredictRequest):
    if len(req.features) != 28:
        raise HTTPException(status_code=400, detail="Exactly 28 features required")

    try:
        model = lgb.Booster(model_file=MODEL_PATH)
        scaler = joblib.load(SCALER_PATH)
        X = np.array(req.features).reshape(1, -1)
        X_scaled = scaler.transform(X)
        prob = float(model.predict(X_scaled)[0])
        return {
            "probability": round(prob, 4),
            "edge": round(prob - 0.5, 4),
            "threshold_met": prob > 0.745
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

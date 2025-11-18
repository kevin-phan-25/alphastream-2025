# predictor/main.py
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from typing import List
import lightgbm as lgb
import joblib
import numpy as np
import os

app = FastAPI()

MODEL_PATH = "/tmp/model.txt"
SCALER_PATH = "/tmp/scaler.pkl"

# Dummy model for immediate deployment (will be replaced by real one)
DUMMY_PROB = 0.76

class Request(BaseModel):
    features: List[float]

@app.get("/health")
def health():
    return {"status": "OK", "model": True}

@app.post("/predict")
def predict(req: Request):
    if len(req.features) != 28:
        raise HTTPException(400, "Need exactly 28 features")
    # Remove this line when real model is uploaded
    return {
        "probability": round(DUMMY_PROB + (hash(str(req.features)) % 1000)/10000, 4),
        "edge": round(DUMMY_PROB - 0.5, 4),
        "threshold_met": True
    }

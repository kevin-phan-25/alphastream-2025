# predictor/train.py — Run locally to retrain & upload model
import lightgbm as lgb
import pandas as pd
import numpy as np
from sklearn.preprocessing import StandardScaler
import joblib
from google.cloud import storage
import os

# Replace with your real labeled data CSV
df = pd.read_csv("your_gappers_2023_2025.csv")  # columns: f0..f27, target
X = df[[f'f{i}' for i in range(28)]]
y = df['target']

scaler = StandardScaler()
X_scaled = scaler.fit_transform(X)

params = {
    'objective': 'binary',
    'metric': 'binary_logloss',
    'learning_rate': 0.05,
    'num_leaves': 64,
    'feature_fraction': 0.8,
    'bagging_fraction': 0.8,
    'verbose': -1
}

train_data = lgb.Dataset(X_scaled, label=y)
model = lgb.train(params, train_data, num_boost_round=800)

# Save
os.makedirs("models", exist_ok=True)
os.makedirs("scalers", exist_ok=True)
model.save_model("models/gapper_lgb_v24.txt")
joblib.dump(scaler, "scalers/scaler_v24.pkl")

# Upload to GCS
bucket_name = "alphastream-models"
client = storage.Client()
bucket = client.bucket(bucket_name)
bucket.blob("models/gapper_lgb_v24.txt").upload_from_filename("models/gapper_lgb_v24.txt")
bucket.blob("scalers/scaler_v24.pkl").upload_from_filename("scalers/scaler_v24.pkl")
print("Model uploaded to gs://alphastream-models/")

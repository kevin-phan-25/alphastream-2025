# Dockerfile for Cloud Run
FROM node:18-slim

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --only=production
COPY . .

ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "index.js"]

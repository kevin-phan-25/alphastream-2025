FROM node:20-slim

WORKDIR /app

# Install OS dependencies your bot might need
RUN apt-get update && apt-get install -y \
    gconf-service \
    libasound2 \
    libgconf-2-4 \
    libappindicator1 \
    libnss3 \
    libxss1 \
    libgtk-3-0 \
    libgbm1 \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install --only=production

COPY . .

EXPOSE 8080
CMD ["npm", "start"]

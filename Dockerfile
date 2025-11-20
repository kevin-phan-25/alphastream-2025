# Use Debian-based Node image
FROM node:20-slim

WORKDIR /app

# Install the libraries your bot or npm dependencies need
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

# Copy package files and install dependencies
COPY package*.json ./
RUN npm install --only=production

# Copy app code
COPY . .

EXPOSE 8080
CMD ["npm", "start"]

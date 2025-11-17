# Use Node 18 slim for smaller image
FROM node:18-slim

# Install dumb-init for signal handling
RUN apt-get update && apt-get install -y dumb-init && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy package files first (for caching)
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production && npm cache clean --force

# Copy source code
COPY . .

# Create non-root user (Cloud Run best practice)
RUN addgroup --gid 1001 nodejs && adduser --uid 1001 --ingroup nodejs nodejs
USER nodejs

# Expose port
EXPOSE 8080

# Use dumb-init to forward signals
ENTRYPOINT ["dumb-init", "--"]
CMD ["npm", "start"]

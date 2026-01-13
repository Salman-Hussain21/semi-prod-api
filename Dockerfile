FROM node:18-alpine

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install --production

# Copy application files
COPY worker.js ./

# Expose port (Back4App will set this via env)
EXPOSE 8080

# Start the application
CMD ["node", "worker.js"]

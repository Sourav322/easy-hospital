# Use official Node.js LTS image
FROM node:20-alpine

# Set working directory
WORKDIR /app

# Copy backend package files first (for layer caching)
COPY backend/package*.json ./backend/

# Install backend dependencies
RUN cd backend && npm install --production

# Copy the rest of the project
COPY . .

# Expose the port Railway will use
EXPOSE 5000

# Start the server
CMD ["node", "backend/server.js"]

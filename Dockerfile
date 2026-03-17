FROM node:20-alpine

# Root working dir
WORKDIR /app

# Step 1: Copy only package files (faster build)
COPY backend/package*.json ./backend/

# Step 2: Install dependencies
WORKDIR /app/backend
RUN npm install --production

# Step 3: Copy full project
WORKDIR /app
COPY . .

# Railway uses dynamic port
ENV PORT=3000
EXPOSE 3000

# Start server
CMD ["node", "backend/server.js"]

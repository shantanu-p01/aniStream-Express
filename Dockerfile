# Stage 1: Build dependencies
FROM node:20.18-alpine AS build

# Install necessary build tools for canvas and ffmpeg
RUN apk add --no-cache \
    ffmpeg \
    build-base \
    cairo-dev \
    jpeg-dev \
    pango-dev \
    giflib-dev \
    librsvg-dev

WORKDIR /app

# Copy package.json and install dependencies
COPY package.json package-lock.json /app/
RUN npm ci

# Copy application source code
COPY . /app

# Stage 2: Production runtime
FROM node:20.18-alpine

WORKDIR /app

# Install runtime dependencies
RUN apk add --no-cache \
    ffmpeg \
    cairo \
    jpeg \
    pango \
    giflib \
    librsvg

# Copy built application and dependencies from build stage
COPY --from=build /app /app

# Install only production dependencies
RUN npm prune --production

EXPOSE 5000

CMD ["node", "server.js"]
# Stage 1: Build dependencies
FROM node:20.18-slim AS build

# Install necessary build tools for canvas and ffmpeg
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    build-essential \
    libcairo2-dev \
    libjpeg-dev \
    libpango1.0-dev \
    libgif-dev \
    librsvg2-dev \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json /app
RUN npm install

# Copy the application source code
COPY . /app

# Stage 2: Production runtime
FROM node:20.18-slim

WORKDIR /app

# Install ffmpeg in the runtime image
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# Copy only the necessary files from the build stage
COPY --from=build /app /app

EXPOSE 5000

CMD ["node", "server.js"]
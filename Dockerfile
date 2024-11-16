FROM node:20.18

# Install dependencies for canvas (if necessary) and ffmpeg
RUN apt-get update && apt-get install -y \
    ffmpeg \
    libcairo2-dev \
    libjpeg-dev \
    libpango1.0-dev \
    libgif-dev \
    librsvg2-dev

WORKDIR /app
COPY package.json /app
RUN npm install
COPY . /app

EXPOSE 5000
CMD ["node", "server.js"]

# Taiwan Voice Recorder — Railway 部署用
FROM node:20-slim

# 安裝 ffmpeg
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 先複製 package 檔以利用 Docker layer 快取
COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

# Railway 會注入 PORT 環境變數;DATA_DIR 指向掛載的 Volume
ENV NODE_ENV=production

EXPOSE 3000
CMD ["node", "server.js"]

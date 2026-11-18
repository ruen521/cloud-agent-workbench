FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git python3 \
    && rm -rf /var/lib/apt/lists/* \
    && install -d -o node -g node /data
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
ENV NODE_ENV=production DATA_DIR=/data HOST=0.0.0.0 PORT=3000
USER node
EXPOSE 3000
CMD ["node", "src/server.js"]

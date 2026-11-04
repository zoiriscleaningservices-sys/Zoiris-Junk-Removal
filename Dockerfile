# Production container for Zoiris Junk Removal — Public Site + Private Owner Command Center & CRM
FROM node:24-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build && npm prune --omit=dev

ENV NODE_ENV=production
ENV ZOIRIS_HOST=0.0.0.0
ENV ZOIRIS_PORT=4500
ENV ZOIRIS_DATA_DIR=/var/data/zoiris-private

RUN mkdir -p /var/data/zoiris-private

EXPOSE 4500

CMD ["node", "server/index.mjs"]

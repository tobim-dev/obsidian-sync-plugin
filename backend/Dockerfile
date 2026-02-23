FROM node:20-bookworm-slim AS build
WORKDIR /app

COPY package.json tsconfig.json ./
RUN npm install

COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:20-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8787
ENV DB_PATH=/data/sync.db

COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

VOLUME ["/data"]
EXPOSE 8787
CMD ["node", "dist/index.js"]

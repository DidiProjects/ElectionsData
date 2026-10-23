FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# The worker has no runtime dependencies: only the compiled output ships.
FROM node:22-alpine
ENV NODE_ENV=production \
    OUTPUT_DIR=/data/output
WORKDIR /app
COPY package.json ./
COPY --from=build /app/dist ./dist
RUN mkdir -p /data/output && chown -R node:node /data
USER node
LABEL app=elections-data-worker project=elections-data
CMD ["node", "dist/main.js"]

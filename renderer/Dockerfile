FROM node:22-slim

ENV NODE_ENV=production
ENV PORT=8080
ENV NODE_OPTIONS=--max-old-space-size=768

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY server.mjs ./

EXPOSE 8080
CMD ["npm", "start"]

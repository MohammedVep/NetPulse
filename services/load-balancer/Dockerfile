FROM node:22-alpine

WORKDIR /app

COPY . .

RUN npm ci
RUN npm run build --workspace @netpulse/load-balancer

ENV NODE_ENV=production
EXPOSE 8080

CMD ["node", "services/load-balancer/dist/index.js"]

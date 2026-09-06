FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY --chown=node:node src ./src
RUN mkdir -p /data/uploads && chown -R node:node /app /data
USER node
EXPOSE 8080
CMD ["npm","start"]
